import { applyArtists, type ArtistCounters } from './artist/apply.ts';
import { classify, type ClassifyCounters } from './classify/classify.ts';
import { numberCollidingRecords, type CollisionNameCounters } from './classify/collision-name.ts';
import { nameShelfRecords, type ShelfNameCounters } from './classify/shelf-name.ts';
import { applyCues, type CueCounters } from './cue/engine.ts';
import type { DatabaseSync } from './db/index.ts';
import { recordStageFailure, type Stage } from './db/issue.ts';
import type { Probe } from './probe/ffprobe.ts';
import { scan, type ScanCounters } from './scan/scan.ts';
import { SETTLE_MS } from './scan/settle.ts';
import { applyPlaylists, type PlaylistFileCounters } from './playlist/import.ts';
import { rebuildSearchIndex, type SearchCounters } from './search/index.ts';
import type { WalkResult } from './scan/walk.ts';
import { applyTags, type TagCounters } from './tags/apply.ts';

/**
 * What one invocation produced, stage by stage.
 *
 * Gathered into a value rather than passed as six positional arguments: the
 * chain grows a stage at a time, and each one would otherwise edit the call
 * site and every line of the report to thread one more counter through.
 */
export interface RunSummary {
  scan: ScanCounters;
  classify: ClassifyCounters;
  tags: TagCounters;
  cues: CueCounters;
  playlists: PlaylistFileCounters;
  artists: ArtistCounters;
  shelves: ShelfNameCounters;
  collisions: CollisionNameCounters;
  search: SearchCounters;
}

/**
 * Swappable so orchestration can be tested without a filesystem, ffprobe, or
 * real bytes. Threaded through to the stages that take each one; absent, every
 * stage falls back to the real thing.
 */
export interface RunOptions {
  walk?: (rootPath: string) => WalkResult;
  /**
   * Read every file again, whether or not the ledger says it has not moved.
   *
   * Forwarded to `scan` and to nothing else, because nothing else needs to know:
   * every stage downstream decides whether to re-read a file by asking the
   * ledger, and a full scan is the ledger being emptied before the walk.
   */
  full?: boolean;
  probe?: (absPath: string) => Probe;
  readBytes?: (absPath: string) => Uint8Array;
  /**
   * The half-write window, in milliseconds; `0` is no gate at all.
   *
   * Forwarded to `scan` and to nothing else, exactly as `full` is. Absent means
   * the production window (`SETTLE_MS`) — a caller that says nothing gets the
   * contract — and the seam is here for the tests that scan a fixture they have
   * just written: they are asking about a stage, not about time, and a suite
   * that pays five seconds a run to say so is a suite nobody runs. The gate's
   * cost is real and the point of it is real, which is why the number is a
   * caller's and not a constant the suite has to live with.
   */
  settleMs?: number;
}

/**
 * Run the chain over the given roots, and settle the run's status.
 *
 * The order is the one the priority depends on: the classifier names albums
 * from the folder, tags have their say next, and the cue has the last word on
 * what a record is called. The artist stage reads all three.
 *
 * The run id comes from `scan`, and later stages stamp their rows with it — so
 * `scan` is not optional and not reorderable. Everything after it is: each
 * stage derives its own rows from the present and clears them itself, which is
 * what makes a rerun after a failure reach the state a clean run would.
 */
export function runStages(
  db: DatabaseSync,
  rootPaths: string[],
  options: RunOptions = {},
): RunSummary {
  // **The one place the half-write gate is asked for.** `scan` takes the window
  // rather than assuming one, because waiting is a cost and only the caller
  // knows whether it can be paid; this is production's only scan, so this is
  // where the contract's clause becomes true of a real run. See `settle.ts`.
  //
  // The production window unless a caller names another, and the caller that
  // does is a test: `settleMs` is the seam `walk` and `probe` already are, and
  // a suite that pays the window on every fixture it has just written is a
  // suite that measures the gate rather than the stage it asked about.
  const scanCounters = scan(db, rootPaths, {
    walk: options.walk,
    full: options.full,
    settleMs: options.settleMs ?? SETTLE_MS,
  });
  const runId = scanCounters.scanRunId;

  // Which stage is running, so a throw can be recorded against its name. Held
  // in a local rather than threaded through four wrapped calls: the stages
  // answer with different counters, and a table of them would need a union per
  // entry to say what it returns.
  let stage: Stage = 'classify';

  try {
    const classified = classify(db);

    stage = 'tags';
    const tags = applyTags(db, { probe: options.probe, readBytes: options.readBytes });

    stage = 'cues';
    const cues = applyCues(db, { probe: options.probe, readBytes: options.readBytes });

    // After `cues` and not before it: an imported playlist names songs, and
    // songs are what the cue stage writes. A `.m3u` read earlier would have no
    // tracks to point at and would import an empty list every time.
    stage = 'playlists';
    const playlists = applyPlaylists(db, { readBytes: options.readBytes });

    stage = 'artists';
    const artists = applyArtists(db);

    // After every stage that names anything, and before the index that copies
    // the names: a record's shelf is the last thing its name gains, because it
    // is the only stage that can read the artist a shelf's name is measured
    // against. See `shelf-name.ts`.
    stage = 'shelves';
    const shelves = nameShelfRecords(db);

    // Last of the naming stages, and it has to be last: it numbers the records
    // that would otherwise read identically, and a qualifier added after it would
    // give the two names apart on its own — leaving the number describing a
    // difference that is no longer the whole of it.
    stage = 'collisions';
    const collisions = numberCollidingRecords(db);

    // Last, and it has to be: the index is a copy of what the stages above
    // settled, so indexing before the cue had its last word on a title would
    // publish the title it overruled.
    stage = 'search';
    const searchIndex = rebuildSearchIndex(db);

    // The planner's statistics are derived from the data as plainly as any row
    // here is, and this run is the only thing that knows the data has changed.
    // Nothing had ever refreshed them, so `sqlite_stat1` did not exist and
    // SQLite guessed — and on this collection it guessed that the cover route's
    // folder lookup should scan every file in the root rather than use the
    // index naming exactly those two columns: measured 12.6 ms against 0.02 ms
    // per call, on a route a client calls once per artist on screen.
    stage = 'planner';
    db.exec('ANALYZE');

    return {
      scan: scanCounters,
      classify: classified,
      tags,
      cues,
      playlists,
      artists,
      shelves,
      collisions,
      search: searchIndex,
    };
  } catch (err) {
    try {
      recordStageFailure(db, runId, stage, err);
    } catch {
      // The failure is already on its way to the caller. A trace that cannot be
      // written must not replace the reason it was being written for.
    }
    throw err;
  } finally {
    // The run's own end, not the walk's.
    //
    // `scan` stamps `finished_at` when its walk is done, which is right for the
    // walk and wrong for the row it is written on: the chain then spends most of
    // the run — classify, tags, cues, artists, the index — after that stamp, so
    // a twelve-root run recorded 0.238 s against 38.8 s of work. Nothing could
    // measure a run's duration from these columns (task:2756).
    //
    // `status` is left where `scan` put it: this says when the run ended, not
    // whether it succeeded, and the failure path above has already written what
    // went wrong.
    db.prepare('UPDATE scan_run SET finished_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      runId,
    );
  }
}
