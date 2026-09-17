import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { withTransaction, type DatabaseSync } from '../db/index.ts';
import { clearIssues, recordStageFailure, type Stage } from '../db/issue.ts';
import { movedSince } from '../db/ledger.ts';
import { prepareSweep, SWEPT_BY_SCAN } from '../db/sweep.ts';
import type { FileKind } from './kinds.ts';
import { stillMoving } from './settle.ts';
import { walkRoot, type WalkResult } from './walk.ts';

/** This stage's name in `issue.stage`. Bound to the insert and to the clear. */
const STAGE: Stage = 'scan';

export interface ScanOptions {
  /** Override the filesystem walk. Exists so orchestration can be tested. */
  walk?: (rootPath: string) => WalkResult;
  now?: () => Date;
  /**
   * Called once per batch, after that batch has been committed. **A test seam.**
   *
   * Like `walk` above, and for the same kind of reason: it stands for a caller
   * that could not otherwise exist. What it exposes is the one promise this
   * stage makes to every other writer on the file — that it lets go of the write
   * lock between batches — and that promise cannot be observed from outside. The
   * scan is synchronous, so a second connection cannot be driven while it runs;
   * the only place a caller can stand between two commits is inside the loop,
   * which is here.
   *
   * Nothing in production passes it: `runStages` (`run.ts`) forwards `walk`
   * alone. It is where a progress report would hang if one is ever wanted —
   * `getScanStatus` says whether a scan is running and nothing about how far it
   * has got.
   */
  onBatch?: (rowsInBatch: number) => void;
  /**
   * Read every file again, whether or not it looks unchanged.
   *
   * The ordinary scan trusts size and mtime, which is what makes a rescan of a
   * library that has not changed cost seconds rather than minutes. **This is the
   * answer for when that trust is the wrong question** — a reader that changed
   * its mind about a format, a file edited within the same second and to the
   * same length, an operator who wants to be sure. It is done by emptying the
   * ledger before the walk: every file is then one nothing was observed about,
   * which is the same state as a file that has just appeared, and every stage
   * downstream re-reads it for the same reason.
   *
   * Deliberately all-or-nothing rather than a filter. A partial full scan is a
   * thing an operator would have to reason about; "read everything again" is
   * not.
   */
  full?: boolean;
  /**
   * How long a file must have been quiet to be recorded; `0` is no gate at all.
   *
   * **Zero means the gate is not entered, not that it is entered with a window
   * of zero** — `stillMoving` returns before it looks at a file. **And zero is
   * the default, which is not the safe direction**, and the reason is that only
   * the caller knows whether it can afford to wait: a file inside the window is
   * waited out before it is read (`scan/settle.ts`), so a scan that meets one
   * costs up to this much wall clock — worth it after a copy, and pure loss for
   * the hundreds of scans the suite runs to test things that have nothing to do
   * with time. `RunOptions.settleMs` is how a caller reaches this without
   * editing production's window, and `runStages` is the one path that scans in
   * production: it asks for `SETTLE_MS` unless it is told otherwise.
   */
  settleMs?: number;
}

/**
 * What a scan saw, so the run can be reported without asking the database.
 *
 * `files` is the total this run **recorded** and `byKind` breaks it down; the
 * two are asserted to agree, which is what makes "no silent loss" checkable
 * rather than a promise. It is not the total the walk handed over: the half-write
 * gate stands between the two, and what it held back is counted in `skipped` and
 * named in the run's issues.
 */
export interface ScanCounters {
  scanRunId: number;
  roots: number;
  /** The roots as recorded: canonical, and deduplicated within the run. */
  rootPaths: string[];
  /**
   * What each root gave, so an empty one is visible without the database.
   *
   * A directory that holds nothing and a path misspelled both printed as a bare
   * `root <path>` — the difference was in the database and in the dump only, and
   * an operator reading stdout could not tell a typo from an empty folder
   * (task:2756). Both are reported; only one of them is worth going to look at.
   */
  perRoot: { path: string; folders: number; files: number }[];
  /** Files whose size or mtime moved since the previous scan left its ledger. */
  changed: number;
  /** Files the filesystem reports exactly as the previous scan found them. */
  unchanged: number;
  folders: number;
  files: number;
  audioFiles: number;
  byKind: Record<FileKind, number>;
  skipped: number;
  /** Directories dropped by name, which are not in the collection. */
  ignored: number;
  /** Audio files beneath those directories — the ones the guess was wrong about. */
  ignoredAudio: number;
  issues: number;
}

const ALL_KINDS: readonly FileKind[] = ['audio', 'cue', 'image', 'nfo', 'log', 'playlist', 'other'];

/** Directory holding `relPath`, in forward-slash terms; '' for a top-level entry. */
function parentOf(relPath: string): string {
  const cut = relPath.lastIndexOf('/');
  return cut === -1 ? '' : relPath.slice(0, cut);
}

/** A diagnostic raised while settling a root, to be filed against the run. */
interface RootIssue {
  kind: 'root_path_canonicalised' | 'root_duplicate_collapsed' | 'root_nested';
  severity: 'info' | 'warn';
  detail: string;
}

/**
 * Is `inner` a strict subdirectory of `outer`?
 *
 * Both are canonical keys from `rootKey`, so case and separators are already
 * settled the platform's way. The separator is not a nicety: a bare prefix test
 * reads `C:\Music Hall` as living under `C:\Music`, which is the difference
 * between the finding this exists for and a false alarm on every sibling.
 */
function below(outer: string, inner: string): boolean {
  return inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/**
 * The filesystem's own answer for a root, so that one directory is one root.
 *
 * `path.resolve` alone would settle separators and `.`/`..` but stop there:
 * `C:/x` and `C:\x` name one directory, `C:\x` and `c:\x` name one directory on
 * a filesystem that folds case, and a junction names a directory that may
 * already be configured. `realpath` settles all three, which is why root
 * identity asks the filesystem instead of trusting the typed string.
 *
 * A root that is not on disk cannot be resolved at all. That degrades to the
 * resolved path and lets the walk report the miss, exactly as it did before.
 */
function canonicalRoot(rawPath: string): string {
  const absolute = resolve(rawPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Comparison key for a stored root path, canonicalisation included.
 *
 * Applied to a path already in the table, this answers "is this the same
 * directory?" for rows written back when the typed string was the identity —
 * a trailing separator, a `.` segment, a junction, a different case. Asking
 * the filesystem of the stored path is the point: those rows have no other way
 * of being recognised as the same place.
 *
 * Case is folded on top only where the filesystem folds it, for the paths
 * `realpath` could not answer for: on a case-sensitive volume `/music` and
 * `/Music` really are two directories, and merging them would destroy the
 * distinction the contract exists to protect.
 */
export function rootKey(rootPath: string): string {
  const canonical = canonicalRoot(rootPath);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * The id of `path`'s root, created if it is new.
 *
 * A root is the identity every album hangs off, so this is the one place that
 * has to be certain two spellings of one directory never become two rows.
 * Rows written before canonicalisation are healed in place: the surviving twin
 * is the one already holding the canonical path, or the oldest rewritten to
 * it, and the rest are dropped. Their derived rows go with them under
 * `ON DELETE CASCADE`, and the walk that follows puts them back under the
 * surviving root — safe precisely because everything below `root` is derived
 * from the filesystem.
 *
 * A root that merely *contains* another is a different case and is not healed:
 * the two are different directories, so both stay, and the doubling they cause
 * is reported instead. Collapsing them would delete a root the operator
 * configured.
 */
function upsertRoot(
  db: DatabaseSync,
  path: string,
  nowIso: string,
  nestedReported: Set<string>,
): { id: number; issues: RootIssue[] } {
  const rows = db.prepare('SELECT id, path FROM root ORDER BY id').all() as {
    id: number;
    path: string;
  }[];

  const key = rootKey(path);
  const twins = rows.filter((row) => rootKey(row.path) === key);

  // One directory read twice. The contract holds two roots apart on purpose —
  // two copies of an album are two albums, and acceptance checks exactly that —
  // and a root sitting *inside* another is not two copies. Nothing downstream
  // can see it: both albums have tracks, so `unaccounted` reads the collection
  // as healthy and only the file count is quietly larger than the disk. The
  // pair is reported and both roots stay: collapsing them would delete a root
  // the operator configured (task:2709).
  //
  // Both roots stay, which is why the pair is found twice — once from each side
  // — and why `nestedReported` exists. On a second scan both are already in the
  // table, and without it the reader would be told the same fact about the same
  // two directories twice. The set is the run's, like the cue engine's sets for
  // a report that is about a record rather than a file.
  const nested: RootIssue[] = [];
  for (const row of rows) {
    const other = rootKey(row.path);
    // The same directory is the twin case below, and it is reported there.
    if (other === key) continue;

    // Which of the two is the inner one. Read from both ends, so the finding
    // does not depend on which root the scan met first — and named in the same
    // order whichever end raised it, or the two discoveries would describe one
    // relationship as two different ones.
    const isInner = below(other, key);
    const isOuter = below(key, other);
    if (!isInner && !isOuter) continue;

    const outerKey = isInner ? other : key;
    const innerKey = isInner ? key : other;
    const pair = `${outerKey}\u0000${innerKey}`;
    if (nestedReported.has(pair)) continue;
    nestedReported.add(pair);

    const outer = isInner ? row.path : path;
    const inner = isInner ? path : row.path;
    nested.push({
      kind: 'root_nested',
      severity: 'warn',
      detail: `${inner} is inside ${outer}, which is also a root — everything below it is read twice, once under each`,
    });
  }

  // A row already holding the canonical path is the one to keep: it needs no
  // rewrite, and its derived rows are the ones this scan is about to touch
  // anyway. Finding it is not a reason to stop — a twin beside it is still the
  // same directory, and leaving that one in place is the doubling this exists
  // to prevent.
  const survivor = rows.find((row) => row.path === path) ?? twins[0];

  if (survivor === undefined) {
    const inserted = db
      .prepare('INSERT INTO root (path, created_at) VALUES (?, ?)')
      .run(path, nowIso);
    return { id: Number(inserted.lastInsertRowid), issues: nested };
  }

  const issues: RootIssue[] = [...nested];

  if (survivor.path !== path) {
    db.prepare('UPDATE root SET path = ? WHERE id = ?').run(path, survivor.id);
    issues.push({
      kind: 'root_path_canonicalised',
      severity: 'info',
      detail: `${survivor.path} → ${path}`,
    });
  }

  // The twins' own diagnostics describe this same directory, so they move to
  // the survivor rather than blocking the delete on the foreign key.
  const repoint = db.prepare('UPDATE issue SET root_id = ? WHERE root_id = ?');
  const drop = db.prepare('DELETE FROM root WHERE id = ?');
  for (const redundant of twins) {
    if (redundant.id === survivor.id) continue;
    repoint.run(survivor.id, redundant.id);
    drop.run(redundant.id);
    issues.push({
      kind: 'root_duplicate_collapsed',
      severity: 'warn',
      detail: `${redundant.path} was the same directory as ${path}; its rows were dropped and re-read by this scan`,
    });
  }

  return { id: survivor.id, issues };
}

/**
 * How many rows one transaction carries.
 *
 * Measured, because this number is the whole of what the stage promises: on the
 * live collection a batch of five hundred holds the write lock **12 ms at the
 * median and 96 ms at its worst**, across the thirty batches of one run. The
 * budget it is held to is the 250 ms a listener's save waits with
 * (`busy_timeout`, `db/index.ts`) — so a save can lose the race for one batch
 * and still get in on the next.
 *
 * Rows and not files: one file writes two of them (`insertFile` and the ledger
 * row beside it), so five hundred rows is two hundred and fifty files.
 */
const ROWS_PER_TRANSACTION = 500;

/**
 * Write `rows`, a transaction at a time.
 *
 * Each batch is committed before the next begins, which is the whole of what
 * this is for: the lock is held for a batch rather than for the stage, so a
 * listener's save waiting on it gets in between them.
 *
 * A batch that throws unwinds only itself — what came before it stays, and the
 * run is marked `failed` with its reason filed. That is the recovery the stages
 * already promise (`run.ts`): a rerun after a failure reaches the state a clean
 * run would.
 */
function inBatches<T>(
  db: DatabaseSync,
  rows: readonly T[],
  write: (row: T) => void,
  onBatch?: (rowsInBatch: number) => void,
): void {
  for (let start = 0; start < rows.length; start += ROWS_PER_TRANSACTION) {
    const batch = rows.slice(start, start + ROWS_PER_TRANSACTION);
    withTransaction(db, () => {
      for (const row of batch) write(row);
    });
    onBatch?.(batch.length);
  }
}

/**
 * Read the given roots into the meta layer.
 *
 * This stage records what is on disk and nothing more — no tag reading, no cue
 * parsing, no classification. It is a faithful inventory, and the classifier
 * layers on top of it.
 *
 * Files are matched by (root, relative path), so rescanning updates rows in
 * place and keeps `first_seen_run_id` pointing at the run that found them.
 */
export function scan(db: DatabaseSync, rootPaths: string[], options: ScanOptions = {}): ScanCounters {
  const walk = options.walk ?? walkRoot;
  const now = options.now ?? ((): Date => new Date());

  // One directory is one root: the same directory named twice in one run —
  // by a second spelling or a second argument — is walked once.
  const roots = [...new Set(rootPaths.map(canonicalRoot))];

  const startedAt = now().toISOString();
  const run = db
    .prepare('INSERT INTO scan_run (started_at, status, roots_json) VALUES (?, ?, ?)')
    .run(startedAt, 'running', JSON.stringify(roots));
  const scanRunId = Number(run.lastInsertRowid);

  // The ledger is emptied first, so that every file the walk meets is one
  // nothing was observed about — which is the same state as a file that has
  // just appeared, and is what makes `full` reach every stage downstream
  // without any of them knowing this option exists. Before the walk and not
  // after: a run that dies halfway leaves part of the library due for a
  // re-read, and a re-read is the safe direction to be wrong in.
  if (options.full === true) db.exec('DELETE FROM scan_state');

  // One finding per pair of overlapping roots, whatever order the scan met them
  // in — see `upsertRoot`.
  const nestedReported = new Set<string>();

  const byKind = Object.fromEntries(ALL_KINDS.map((k) => [k, 0])) as Record<FileKind, number>;
  let folders = 0;
  let files = 0;
  const perRoot: { path: string; folders: number; files: number }[] = [];
  let audioFiles = 0;
  let skipped = 0;
  let ignored = 0;
  let ignoredAudio = 0;
  let issues = 0;
  let changed = 0;
  let unchanged = 0;

  const finish = (status: string): void => {
    db.prepare('UPDATE scan_run SET finished_at = ?, status = ? WHERE id = ?').run(
      now().toISOString(),
      status,
      scanRunId,
    );
  };

  // Everything that can throw lives inside the guard, statement preparation
  // included. A prepare compiles against the live schema, so a table it cannot
  // find throws there — and it used to run before the `try`, which left
  // `scan_run` saying `running` with nothing to correct it: the row is inserted
  // before the transaction, so no rollback reaches it, and the stages after this
  // one never run to file the failure either. `recordStageFailure` is what
  // writes it down; the run id it needs is the one this function returns, which
  // is exactly what a caller does not have when this throws.
  try {
    // **Written in batches, and the batching is the point of this stage's shape.**
    //
    // The scan and the server are two connections to one file, and SQLite gives
    // one writer at a time. This stage used to open a single transaction around
    // everything — every root, every folder, every file — and hold the write
    // lock from its first row to its last: measured on the live collection,
    // **1854 ms** for 11 541 files, against a `busy_timeout` of 250 ms
    // (`db/index.ts`). A listener's save arriving anywhere in those 1854 ms was
    // refused, and the save that matters most arrives exactly then: people
    // listen to music while a scan runs.
    //
    // Half of that window was not writing at all. `walk` reads the filesystem —
    // 929 ms of the 1854 — and reading a disk needs no write lock, so the walk
    // now happens with nothing open. What is left to write goes in batches, each
    // its own `BEGIN IMMEDIATE` (`db/index.ts` has why that word is
    // load-bearing), so the lock is let go between them and a save waiting on it
    // gets in.
    //
    // **The run is no longer one transaction, and that is the trade.**
    //
    // A failure part-way through a root leaves the batches before it committed
    // instead of unwinding the root. What it does not leave is a root half-swept:
    // `sweep` runs last, in a transaction of its own, so a run that dies before
    // reaching it has taken nothing away. Recovery is the one the stages already
    // promise — `run.ts`: "a rerun after a failure reaches the state a clean run
    // would" — and the run is marked `failed` with its reason filed.
    //
    // The other half of the trade is what a *reader* sees. Nothing this stage
    // wrote used to be visible until its single `COMMIT`, so a client browsing
    // during a run browsed the library as it was before the run. Now each batch
    // is visible as it commits, so the same client sees the root being walked in
    // its new state and the roots after it in the old one — a library that is
    // part-way, which is a true description of it. The sweep staying whole per
    // root is what keeps that from being a library that is *wrong*: no row is
    // taken away until everything under that root has been written.

    // The stamp is the whole point of the upsert: a folder seen this run has to
    // say so, or the sweep below deletes it as something that is no longer there.
    const insertFolder = db.prepare(
      `INSERT INTO folder (root_id, rel_path, parent_rel_path, last_seen_run_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (root_id, rel_path) DO UPDATE SET last_seen_run_id = excluded.last_seen_run_id`,
    );

    // Letting go of what vanished, and the predicate that decides it, live in
    // `db/sweep.ts` — the scan only says which tables are its to empty.
    const sweep = prepareSweep(db, SWEPT_BY_SCAN);

    // first_seen_run_id is deliberately absent from the UPDATE branch: it is
    // what makes "when did this file first appear" answerable after a rescan.
    const insertFile = db.prepare(
      `INSERT INTO file (root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms,
                         first_seen_run_id, last_seen_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (root_id, rel_path) DO UPDATE SET
         folder_rel_path  = excluded.folder_rel_path,
         name             = excluded.name,
         kind             = excluded.kind,
         ext              = excluded.ext,
         size             = excluded.size,
         mtime_ms         = excluded.mtime_ms,
         last_seen_run_id = excluded.last_seen_run_id`,
    );

    const selectScanState = db.prepare(
      'SELECT rel_path, size, mtime_ms FROM scan_state WHERE root_id = ?',
    );
    const upsertScanState = db.prepare(
      `INSERT INTO scan_state (root_id, rel_path, size, mtime_ms, last_seen_run_id, changed)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (root_id, rel_path) DO UPDATE SET
         size             = excluded.size,
         mtime_ms         = excluded.mtime_ms,
         last_seen_run_id = excluded.last_seen_run_id,
         changed          = excluded.changed`,
    );

    const insertIssue = db.prepare(
      `INSERT INTO issue (scan_run_id, stage, root_id, rel_path, kind, severity, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // Only the derived kinds, because this stage files both sorts of row. The
    // root-settlement issues are events and stay — a healed spelling, a twin
    // that was dropped, both of which happen once — while a skipped walk, an
    // ignored directory and a root that sits inside another are read again
    // every run, from the filesystem and from the configured root set, and
    // would otherwise leave one more row behind on every scan. `db/issue.ts`
    // has the rule.
    withTransaction(db, () => {
      clearIssues(db, STAGE, { kind: 'walk_skipped' });
      clearIssues(db, STAGE, { kind: 'walk_ignored_audio' });
      clearIssues(db, STAGE, { kind: 'walk_ignored' });
      clearIssues(db, STAGE, { kind: 'root_nested' });
    });

    for (const rootPath of roots) {
      // The root and whatever registering it found. Small, quick, and has to be
      // in place before any row below can name it.
      const root = withTransaction(db, () => {
        const registered = upsertRoot(db, rootPath, startedAt, nestedReported);
        for (const rootIssue of registered.issues) {
          insertIssue.run(
            scanRunId,
            STAGE,
            registered.id,
            null,
            rootIssue.kind,
            rootIssue.severity,
            rootIssue.detail,
          );
          issues += 1;
        }
        return registered;
      });

      // With nothing open. This is the filesystem, and the write lock is not for
      // the filesystem — it is the longest part of the stage and it now holds up
      // nobody.
      //
      // **Read before the walk and handed to the gate, which is the walk's own
      // clock and not this line's.** The gate asks whether a file was quiet when
      // the walk met it, and a walk of a real collection takes seconds — so the
      // reading taken *after* it would make the first file met the oldest in the
      // run rather than the freshest, and a file a copy was halfway through when
      // the walk passed it would be recorded at the size it had reached by then.
      const walkedAtMs = now().getTime();
      const result = walk(rootPath);

      // **The half-write gate.** A file the disk has not been quiet about for
      // five seconds is not a file yet, so this run does not record it. The rule
      // and the number are `scan/settle.ts`'s, which are also the watcher's — the
      // same clause of the contract, held the same way on both paths.
      //
      // **Reported as skipped and held back from the sweep, and those are two
      // different statements.** Skipped is what the issue is recorded from, so
      // `GET /issues` says why the file is not in the library this run. Held is
      // what the sweep is told, and it is the *opposite* of the amnesty a skipped
      // path otherwise gets: a file being rewritten in place keeps the rows the
      // previous run gave it, and does not come out of the sweep claiming this
      // run stands behind it — because it does not, and every stage selects its
      // work by exactly that claim. Handing it over as `kept` was the bug this
      // shape fixes: the file was read, and the tags of half a song landed in
      // `file_tag`. A file that was not there before has no rows to keep, so it
      // simply arrives on a later scan, once it has stopped moving.
      const held = new Set(stillMoving(rootPath, result.files, walkedAtMs, options.settleMs ?? 0));
      for (const relPath of held) {
        result.skipped.push({
          relPath,
          reason: 'still being written: its size or mtime moved between two looks',
        });
      }
      const walked = held.size === 0 ? result.files : result.files.filter((f) => !held.has(f.relPath));

      // The amnesty is what the walk met and could not look into; what the gate
      // held back is not it. Split here rather than filtered at the sweep, so
      // that a path cannot be in both lists and neither list can grow a second
      // meaning later.
      const amnesty = result.skipped.filter((skip) => !held.has(skip.relPath));
      const withheld = result.skipped.filter((skip) => held.has(skip.relPath));

      // **The count is what this run recorded, not what the walk handed over.**
      // The two differ only when the gate held something, and that difference is
      // the whole point — but it is legible in `skipped` and in the issue, not
      // here, so this reads as "0 files" for a root where everything was held
      // exactly as it does for an empty directory.
      perRoot.push({ path: rootPath, folders: result.folders.length, files: walked.length });

      // The ledger as the previous run left it. Reading it before this run
      // writes its own is the only moment the comparison still means anything:
      // afterwards the file row and the ledger hold the same observation.
      const previous = new Map(
        (selectScanState.all(root.id) as { rel_path: string; size: number; mtime_ms: number }[]).map(
          (row) => [row.rel_path, row],
        ),
      );

      inBatches(
        db,
        result.folders,
        (folder) => {
          insertFolder.run(root.id, folder, parentOf(folder), scanRunId);
          folders += 1;
        },
        options.onBatch,
      );

      inBatches(
        db,
        walked,
        (file) => {
          const moved = movedSince(previous.get(file.relPath), file);
          if (moved) changed += 1;
          else unchanged += 1;

          insertFile.run(
            root.id,
            file.relPath,
            file.folderRelPath,
            file.name,
            file.kind,
            file.ext,
            file.size,
            file.mtimeMs,
            scanRunId,
            scanRunId,
          );
          upsertScanState.run(
            root.id,
            file.relPath,
            file.size,
            file.mtimeMs,
            scanRunId,
            moved ? 1 : 0,
          );
          files += 1;
          byKind[file.kind] += 1;
          if (file.kind === 'audio') audioFiles += 1;
        },
        options.onBatch,
      );

      // What the walk met but did not walk, and the end of the root — the last
      // transaction of this root, with the sweep in it. `sweep` is the stage's
      // only destructive step, and it goes in the same commit as the rows it
      // judges rather than after them; the reason is in the comment at the top
      // of this function.
      withTransaction(db, () => {
        for (const skip of result.skipped) {
          insertIssue.run(
            scanRunId,
            STAGE,
            root.id,
            skip.relPath,
            'walk_skipped',
            'warn',
            skip.reason,
          );
          skipped += 1;
          issues += 1;
        }

        // An ignored directory is a guess made from a name, and it stays ignored:
        // a Synology thumbnail tree is not a collection, and walking one into the
        // result invents a phantom album per track. What may not stay silent is
        // that the guess was made, or that it was made about music — `#recycle`
        // holds whatever was deleted. Both are counted either way, so `files N`
        // can be reconciled with the filesystem.
        for (const dir of result.ignored) {
          ignored += 1;
          ignoredAudio += dir.audio;

          if (dir.audio === 0) continue;

          insertIssue.run(
            scanRunId,
            STAGE,
            root.id,
            dir.relPath,
            'walk_ignored_audio',
            'warn',
            `ignored by name, but it holds ${dir.audio} audio file(s) — they are not in the collection`,
          );
          issues += 1;
        }

        // The count itself, once for the root. Each directory above says what it
        // is only when the guess was wrong about music; the guess being made at
        // all is what a reader reconciling `files N` with the filesystem needs,
        // and it was on stdout alone — gone by the time anyone opens the database.
        // Aggregated rather than one row per directory because the tree a NAS
        // writes holds hundreds of entries, and the report is about one root.
        if (result.ignored.length > 0) {
          const dirs = result.ignored.length;
          const beneath = dirs === 1 ? 'it' : 'them';
          const audio = result.ignored.reduce((sum, dir) => sum + dir.audio, 0);

          insertIssue.run(
            scanRunId,
            STAGE,
            root.id,
            null,
            'walk_ignored',
            'info',
            `ignored ${dirs} ${dirs === 1 ? 'directory' : 'directories'} by name; ${
              audio === 0
                ? `no audio beneath ${beneath}`
                : `${audio} audio file(s) beneath ${beneath} are not in the collection`
            }`,
          );
          issues += 1;
        }

        // A root nobody could read reports no folders and no files — which reads
        // exactly like an empty collection, with the run still calling itself ok.
        // The walk says so as a skip at '', and a path of '' would keep nothing:
        // what has to survive is the whole root, and no path below it was seen to
        // name. So the root is left alone entirely rather than handed a keep-list.
        const rootUnreadable = result.skipped.some((skip) => skip.relPath === '');

        // Only for the roots actually walked: a root nobody scanned has not been
        // seen to lose anything, and its rows are not ours to drop.
        if (!rootUnreadable) {
          sweep.run(
            root.id,
            scanRunId,
            amnesty.map((skip) => skip.relPath),
            withheld.map((skip) => skip.relPath),
          );
        }
      });
    }
  } catch (err) {
    // Nothing to unwind here, and that is worth saying rather than guarding: a
    // batch that threw was already rolled back by `withTransaction`, which is
    // the only thing in this function that opens a transaction. A rollback here
    // would be a second one, and a rollback with nothing to roll back throws.
    try {
      recordStageFailure(db, scanRunId, STAGE, err);
    } catch {
      // The failure is already on its way to the caller. A trace that cannot be
      // written must not replace the reason it was being written for.
    }
    finish('failed');
    throw err;
  }

  finish('ok');

  return {
    scanRunId,
    roots: roots.length,
    rootPaths: roots,
    perRoot,
    changed,
    unchanged,
    folders,
    files,
    audioFiles,
    byKind,
    skipped,
    ignored,
    ignoredAudio,
    issues,
  };
}
