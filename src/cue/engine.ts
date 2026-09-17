import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { recordTitle } from '../classify/folder-name.ts';
import { discMarker, pairKey } from '../classify/roles.ts';
import type { DatabaseSync } from '../db/index.ts';
import { clearIssues, type Stage } from '../db/issue.ts';
import { current, ledgerEntry, unmoved } from '../db/ledger.ts';
import { PROBE_METHOD, probeFile, type Probe } from '../probe/ffprobe.ts';
import type { FileKind } from '../scan/kinds.ts';
import type { WalkedFile } from '../scan/walk.ts';
import { CERTAIN, CONFIDENT, decodeText, type DecodedText } from '../text/encoding.ts';
import { isSiteName } from '../text/site-name.ts';
import { basenameOf, folderOf, rootBasenameOf } from '../util/names.ts';
import { audioNamedBy, chooseCue, type CueCandidate } from './match.ts';
import { parseCue, type UnrecognizedLine } from './parse.ts';
import { planAlbum, type AlbumShape } from './plan.ts';

/** This stage's name in `issue.stage`. Bound to the insert and to the clear. */
const STAGE: Stage = 'cues';

export interface CueCounters {
  albums: number;
  cues: number;
  tracks: number;
  probed: number;
  /** Durations answered from `audio_probe` instead of spawning ffprobe. */
  probesReused: number;
  probeFailures: number;
  byShape: Record<AlbumShape, number>;
  issues: number;
}

export interface EngineDeps {
  /** Swappable so tests need neither ffprobe nor real audio. */
  probe?: (absPath: string) => Probe;
  readBytes?: (absPath: string) => Uint8Array;
}

/**
 * A cue candidate that has already been read off disk and decoded.
 *
 * Carrying the decode result on the candidate keeps it attached to the cue it
 * describes, rather than in a side table the caller must keep in step with
 * `chooseCue`'s answer.
 */
type ReadCandidate = CueCandidate & { decoded: DecodedText };

interface FileRow {
  rel_path: string;
  name: string;
  kind: string;
  ext: string;
  size: number;
  mtime_ms: number;
}

function toWalkedFile(row: FileRow, folderRelPath: string): WalkedFile {
  return {
    relPath: row.rel_path,
    folderRelPath,
    name: row.name,
    kind: row.kind as FileKind,
    ext: row.ext,
    size: row.size,
    mtimeMs: row.mtime_ms,
  };
}

/**
 * Read the cues, work out what each album's tracks are, and write them down.
 *
 * An album is identified by a path, and that path means one of two things:
 * a *folder* (an ordinary album, or a disc that is a CD subfolder) or a single
 * *audio file* — a disc of a release ripped flat, where each disc is one image
 * plus its own cue. Both are handled here, and for the file case the cue is the
 * one sharing the image's stem.
 *
 * Probing stays narrow: ffprobe is spawned only for the image behind a cue
 * split, whose closing track no cue can bound. A folder of separate files needs
 * no probe at all, so a 50k-file scan does not spawn 50k processes to learn
 * something it already knows.
 *
 * The whole pass runs in one transaction. A single malformed cue must not leave
 * a half-written meta layer behind for the next stage to read.
 *
 * The ledger buys back the probe, not the read: a cue is still read and decoded
 * on every pass. That is a deliberate line rather than an oversight — cues are
 * small text files, while ffprobe is a process spawn per album, and the spawn
 * was the cost worth avoiding. Widening the ledger to cover the read would mean
 * trusting stored parse results against a file the walk did not re-read.
 */
export function applyCues(db: DatabaseSync, deps: EngineDeps = {}): CueCounters {
  const probe = deps.probe ?? ((absPath: string): Probe => probeFile(absPath));
  // Bytes, not a string: reading a CP1251 cue as UTF-8 yields replacement
  // characters and a plausible-looking album that is quietly wrong.
  const readBytes = deps.readBytes ?? ((absPath: string): Uint8Array => readFileSync(absPath));

  const byShape: Record<AlbumShape, number> = { 'image-cue': 0, 'tracks-cue': 0, 'tracks-only': 0 };
  const counters = {
    albums: 0,
    cues: 0,
    tracks: 0,
    probed: 0,
    probesReused: 0,
    probeFailures: 0,
    issues: 0,
  };

  const roots = db.prepare('SELECT id, path FROM root ORDER BY id').all() as {
    id: number;
    path: string;
  }[];
  const latestRun = (db.prepare('SELECT MAX(id) AS id FROM scan_run').get() as { id: number | null })
    .id;

  const selectAlbums = db.prepare('SELECT rel_path FROM album WHERE root_id = ? ORDER BY rel_path');
  // Every cue the root holds, so the ones no album ever read can be told apart
  // from the ones it did — see the reports after the album loop.
  const selectRootCues = db.prepare(
    "SELECT rel_path FROM file WHERE root_id = ? AND kind = 'cue' ORDER BY rel_path",
  );
  // An album whose path names an actual file is a disc of a flat release; one
  // naming a folder is an ordinary album. The test is "is there a file here",
  // NOT "is there a folder here" — a root that is itself an album has rel_path
  // '', and the walk never creates a folder row for the root.
  const selectFileRow = db.prepare('SELECT 1 AS present FROM file WHERE root_id = ? AND rel_path = ?');
  const selectFolderFiles = db.prepare(
    `SELECT rel_path, name, kind, ext, size, mtime_ms
     FROM file WHERE root_id = ? AND folder_rel_path = ? ORDER BY rel_path`,
  );
  // The files that are an album's own identity. A flat box keys each disc on the
  // image it lives in, and the box's own album must not claim those images a
  // second time — see where a folder's audio is collected below.
  const selectAlbumFiles = db.prepare(
    "SELECT rel_path FROM album WHERE root_id = ? AND rel_path <> ''",
  );
  const selectAlbumId = db.prepare(
    'SELECT id, release_id, title_source FROM album WHERE root_id = ? AND rel_path = ?',
  );
  const selectReleaseSource = db.prepare('SELECT title_source FROM release WHERE id = ?');
  const selectFileId = db.prepare('SELECT id FROM file WHERE root_id = ? AND rel_path = ?');

  // What a file says its own title is. Read one value per name: a file with two
  // TITLE lines has stated two answers to one question, and the first is the
  // one rippers write and the one a reader expects.
  const selectTagValue = db.prepare(
    'SELECT value FROM file_tag WHERE file_id = ? AND name = ? ORDER BY position LIMIT 1',
  );

  /**
   * A whole-file track's length, taken from whatever already measured the file.
   *
   * Trusted when it was re-derived on this run, or when the filesystem says the
   * file has not moved since it was. That is deliberately looser than the
   * ledger rule guarding the *closing* segment of a cue split, and the
   * difference is blast radius: a wrong bound there truncates audio silently,
   * while a wrong whole-file length misreports a number and is corrected by the
   * next scan.
   */
  const selectFileDuration = db.prepare(
    `SELECT ap.duration_ms AS duration_ms
       FROM audio_probe ap
       JOIN file f ON f.id = ap.file_id
       LEFT JOIN scan_state ss ON ${ledgerEntry('f', 'ss')}
      WHERE ap.file_id = ? AND ap.probe_ok = 1 AND ap.probe_method = ?
        AND (f.tags_read_run_id = ? OR ${unmoved('ss')})`,
  );

  // A cue names the record it belongs to. For an ordinary album that is the
  // album; for a disc of a release it names the *release*, while the disc keeps
  // the name its own file carries — three ASOT discs share one cue TITLE, so
  // taking it for each disc would name all three identically.
  const updateAlbumTitle = db.prepare('UPDATE album SET title = ?, title_source = ? WHERE id = ?');
  const updateReleaseTitle = db.prepare(
    'UPDATE release SET title = ?, title_source = ? WHERE id = ?',
  );

  /**
   * Is this name still the placeholder the classifier put there?
   *
   * The rule the whole priority chain rests on. An album title is never empty,
   * so "write it if there is nothing there" can never fire — and a name a cue
   * or a tag has already given is not something a *later* stage may overwrite.
   * A tag fills `folder` and nothing else.
   */
  const placeholder = (source: string | null | undefined): boolean =>
    source === null || source === undefined || source === 'folder';

  /**
   * The track a cue names, written where its id already is.
   *
   * `track` is keyed `UNIQUE (album_id, ordinal)` — the record and the place on
   * it — so a second run updates the row the first one wrote instead of deleting
   * it and writing a new one. That is not tidiness: a client keeps its playlist,
   * its stars and its play counts by track id, and a stage that renumbered every
   * track on every scan broke all three without saying anything. Artists, albums
   * and folders were already written this way (`ON CONFLICT DO UPDATE`); the
   * tracks were the ones the cue stage rewrote from nothing.
   */
  const upsertTrack = db.prepare(
    `INSERT INTO track (album_id, ordinal, title, title_source, file_id, segment_start_ms, segment_end_ms, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (album_id, ordinal) DO UPDATE SET
       title            = excluded.title,
       title_source     = excluded.title_source,
       file_id          = excluded.file_id,
       segment_start_ms = excluded.segment_start_ms,
       segment_end_ms   = excluded.segment_end_ms,
       duration_ms      = excluded.duration_ms`,
  );

  const deleteTracks = db.prepare('DELETE FROM track WHERE album_id = ?');

  /**
   * The tracks of a record this pass no longer names.
   *
   * Swept by the ordinals to *keep*, not by "everything past the last one": a
   * plan drops a track whose file the scan could not name (`trackFile ===
   * undefined` below), which leaves a hole in the numbering rather than a
   * shorter list — and a hole is exactly what an `ordinal > n` sweep would
   * leave standing. The statement is cached by arity because the number of
   * ordinals is the only thing that varies between records.
   */
  const sweeps = new Map<number, ReturnType<typeof db.prepare>>();
  const deleteStaleTracks = (albumId: number, ordinals: readonly number[]): void => {
    if (ordinals.length === 0) {
      deleteTracks.run(albumId);
      return;
    }

    let sweep = sweeps.get(ordinals.length);
    if (sweep === undefined) {
      sweep = db.prepare(
        `DELETE FROM track
          WHERE album_id = ?
            AND ordinal NOT IN (${ordinals.map(() => '?').join(', ')})`,
      );
      sweeps.set(ordinals.length, sweep);
    }
    sweep.run(albumId, ...ordinals);
  };

  const upsertCue = db.prepare(
    `INSERT INTO cue (file_id, audio_file_id, catalog, rem_json, encoding, encoding_confidence, performer, title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (file_id) DO UPDATE SET
       audio_file_id       = excluded.audio_file_id,
       catalog             = excluded.catalog,
       rem_json            = excluded.rem_json,
       encoding            = excluded.encoding,
       encoding_confidence = excluded.encoding_confidence,
       performer           = excluded.performer,
       title               = excluded.title`,
  );
  const clearCue = db.prepare('UPDATE cue SET audio_file_id = NULL WHERE file_id = ?');
  const selectCueId = db.prepare('SELECT id FROM cue WHERE file_id = ?');
  const deleteCueTracks = db.prepare('DELETE FROM cue_track WHERE cue_id = ?');
  const insertCueTrack = db.prepare(
    `INSERT INTO cue_track (cue_id, file_index, ordinal, title, performer, index00_ms, index01_ms,
                            index00_file_index, index01_file_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // The answer here is always ffprobe's: this stage has nothing else to ask,
  // and it asks only where the tag stage left no usable row. Naming it is what
  // keeps the column's two values apart — `'container'` is a statement the
  // file's own bytes make, and a number ffprobe produced is not one, whether it
  // read a length the container states or worked one out from the size and the
  // bitrate (task:2724).
  const upsertProbe = db.prepare(
    `INSERT INTO audio_probe (file_id, duration_ms, codec, sample_rate, channels, bitrate, probe_ok, probe_err, duration_source, probe_method)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (file_id) DO UPDATE SET
       duration_ms     = excluded.duration_ms,
       codec           = excluded.codec,
       sample_rate     = excluded.sample_rate,
       channels        = excluded.channels,
       bitrate         = excluded.bitrate,
       probe_ok        = excluded.probe_ok,
       probe_err       = excluded.probe_err,
       duration_source = excluded.duration_source,
       probe_method    = excluded.probe_method`,
  );

  // A duration already measured is still true while the file it describes has
  // not moved — which is what the ledger's verdict is for. It is asked for with
  // its currency: a stored whole-file length is forgiven a stale verdict, but
  // this one bounds a cue split, where being wrong truncates audio.
  const selectUsableProbe = db.prepare(
    `SELECT ap.duration_ms AS duration_ms
       FROM audio_probe ap
       JOIN file f ON f.id = ap.file_id
       JOIN scan_state ss ON ${ledgerEntry('f', 'ss')}
      WHERE f.root_id = ? AND f.rel_path = ?
        AND ${unmoved('ss')}
        AND ${current('ss')}
        AND ap.probe_ok = 1
        AND ap.probe_method = ?`,
  );

  const insertIssue = db.prepare(
    `INSERT INTO issue (scan_run_id, stage, root_id, rel_path, kind, severity, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const recordIssue = (
    rootId: number,
    relPath: string,
    kind: string,
    detail: string,
    severity: 'info' | 'warn' = 'warn',
  ): void => {
    insertIssue.run(latestRun, STAGE, rootId, relPath, kind, severity, detail);
    counters.issues += 1;
  };

  // A cue sitting above the audio it describes is a candidate for every album
  // underneath it, so a per-match report would restate one inference once per
  // album. Keyed by root as well as path, since the same relative path under
  // two roots is two different files.
  const encodingReported = new Set<string>();

  try {
    // `IMMEDIATE`, so that what this transaction happens to do first cannot
    // decide whether it waits — the first statement below is a write, which
    // would consult the busy handler under a deferred `BEGIN`, but that is a
    // property of the order of the statements rather than of this line, and the
    // order is what the next edit changes. `db/index.ts` has the rule and
    // `search/index.ts` the case where it already matters (task:2871).
    db.exec('BEGIN IMMEDIATE');

    // Every root is walked again on every run, so last run's rows describe a
    // present that has been replaced. See `db/issue.ts`.
    clearIssues(db, STAGE);

    for (const root of roots) {
      const albums = (selectAlbums.all(root.id) as { rel_path: string }[]).map((r) => r.rel_path);
      const albumFiles = new Set(
        (selectAlbumFiles.all(root.id) as { rel_path: string }[]).map((r) => r.rel_path),
      );

      // Three questions about a cue that the per-album loop cannot answer, held
      // until the whole root has been walked. Two of them are the same question
      // asked late: a cue is a candidate for every album beneath it, so "did
      // this cue describe anything at all?" is not answerable while the albums
      // are still being read.
      const rootCues = (selectRootCues.all(root.id) as { rel_path: string }[]).map(
        (r) => r.rel_path,
      );
      const readCues = new Set<string>();
      const matchedCues = new Set<string>();
      const parentCues = new Set<string>();
      // Cues the stage tried to read and could not. They are not in `readCues`
      // either, and the difference matters: "nothing read it" is a second,
      // false reason to give about a file whose real one is already stated
      // (`cue-unreadable`) — task:2727.
      const unreadableCues = new Set<string>();

      // Cues whose lines the parser could not place, reported once per root for
      // the same reason the encoding guess is: a cue above the audio is a
      // candidate for every album beneath it, and the lines do not become
      // stranger with repetition.
      const strayReported = new Set<string>();

      /**
       * Say out loud what a cue wrote and the parser could not place.
       *
       * The parser answers with the lines; whether they matter is decided here,
       * because only this stage knows what is built out of them. A line opening
       * with a cue command and not parsing is a statement that was lost — the
       * `FILE My Album.flac FLAC` of finding 2 takes its file reference with it
       * and leaves the TRACKs after it counted against the file before it, so
       * every offset they carry points at the wrong file. A line that is not cue
       * syntax is reported too, and as information rather than warning: it is
       * usually something a ripper left behind (task:2756).
       */
      const reportStrayLines = (
        rootId: number,
        relPath: string,
        strays: readonly UnrecognizedLine[],
      ): void => {
        if (strays.length === 0) return;
        const key = `${rootId}:${relPath}`;
        if (strayReported.has(key)) return;
        strayReported.add(key);

        const shown = strays
          .slice(0, 3)
          .map((stray) => `line ${stray.line} "${stray.text}"`)
          .join('; ');
        const rest = strays.length > 3 ? `; and ${strays.length - 3} more` : '';
        const lost = strays.some((stray) => stray.malformed);

        recordIssue(
          rootId,
          relPath,
          'cue-unrecognized-line',
          `${strays.length} line(s) matched no cue command — ${shown}${rest}. ${
            lost
              ? 'A cue command that will not read takes what it declared with it'
              : 'Nothing here reads them'
          }`,
          lost ? 'warn' : 'info',
        );
      };

      // What each release's discs say it is called, gathered before any of them
      // is allowed to say it. A release is named once, for the whole box.
      const releaseCueTitles = new Map<number, { titles: Set<string>; relPath: string }>();

      // The same gathering for the other source that names a release: the ALBUM
      // tag each disc's files carry. Held apart from the cue's because the two
      // are read at different points of the walk, and because the tag has the
      // first say — an EAC disc label is no name for a box, while a tag is.
      const releaseTagTitles = new Map<number, { titles: Set<string>; relPath: string }>();

      for (const albumRelPath of albums) {
        const asFile = selectFileRow.get(root.id, albumRelPath) !== undefined;
        const sourceFolder = asFile ? folderOf(albumRelPath) : albumRelPath;
        const rows = selectFolderFiles.all(root.id, sourceFolder) as unknown as FileRow[];

        let audioFiles: WalkedFile[];
        /** Every audio file the folder holds, this album's or another's. */
        let folderAudio: WalkedFile[];
        let cueRows: FileRow[];

        if (asFile) {
          // A disc of a flat release: one image, and the cue named after it.
          const image = rows.find((r) => r.rel_path === albumRelPath && r.kind === 'audio');
          if (image === undefined) {
            recordIssue(root.id, albumRelPath, 'album-without-audio', 'album names a file that holds no audio');
            continue;
          }
          audioFiles = [toWalkedFile(image, sourceFolder)];
          folderAudio = audioFiles;

          // The same pairing the classifier made when it called this folder a
          // release — `pairKey` is shared with it precisely so the two cannot
          // disagree about which cue belongs to this image. Reading the name
          // here by `stemOf` alone knew `… - Pulse.cue` and not `… CD1.flac.cue`,
          // so the disc was recognised and then left without its cue, and its
          // declared tracks became the one track the image holds (task:2708).
          const imageKey = pairKey(image);
          cueRows = rows.filter((r) => r.kind === 'cue' && pairKey(r) === imageKey);
        } else {
          // A file that is an album of its own is not also a track of the album
          // whose folder holds it. The two meet in one place: a flat box, where
          // each disc is the image it lives in and the folder can hold loose
          // audio beside them (task:2719). Without this the box's own album read
          // every disc as one of its tracks too — three files, three tracks, two
          // of them already playing from an album of their own.
          const audioRows = rows.filter((r) => r.kind === 'audio');
          folderAudio = audioRows.map((r) => toWalkedFile(r, sourceFolder));
          audioFiles = audioRows
            .filter((r) => !albumFiles.has(r.rel_path))
            .map((r) => toWalkedFile(r, sourceFolder));
          cueRows = rows.filter((r) => r.kind === 'cue');
        }

        if (audioFiles.length === 0) continue;

        // A cue can sit one level above the audio it describes — a whole-album
        // cue in the root over `Album/01.flac`. Those count as candidates, but
        // they are not this album's cues: reporting an unmatched one would fire
        // once for every album underneath it.
        const parentFolder = folderOf(sourceFolder);
        const parentCueRows =
          parentFolder === sourceFolder
            ? []
            : (selectFolderFiles.all(root.id, parentFolder) as unknown as FileRow[]).filter(
                (row) => row.kind === 'cue',
              );

        const ownCuePaths = new Set(cueRows.map((row) => row.rel_path));
        const candidates: ReadCandidate[] = [];

        for (const row of [...cueRows, ...parentCueRows]) {
          try {
            const decoded = decodeText(readBytes(join(root.path, row.rel_path)));
            const doc = parseCue(decoded.text);
            candidates.push({ relPath: row.rel_path, doc, decoded });
            reportStrayLines(root.id, row.rel_path, doc.unrecognized);
          } catch (err) {
            unreadableCues.add(row.rel_path);
            recordIssue(root.id, row.rel_path, 'cue-unreadable', (err as Error).message);
          }
        }

        for (const candidate of candidates) {
          readCues.add(candidate.relPath);
          if (!ownCuePaths.has(candidate.relPath)) parentCues.add(candidate.relPath);
        }

        const match = chooseCue(candidates, audioFiles);
        if (match !== null) matchedCues.add(match.cue.relPath);

        // A cue of this folder's own that lost is not one report but three, and
        // only that cue's own references tell them apart — asking the album's
        // match answers about a different cue. The `WAV.cue` of an EAC image rip
        // names the same audio the winning `FLAC.cue` names (the stem rule reads
        // it so), so it lost on score and the reader has nothing to do. A cue
        // naming audio this folder does not hold is the lost rip the report
        // exists for; one naming a *second* file of the folder is a binding the
        // model dropped. Reporting all three as a warning is what teaches a
        // reader to skim warnings.
        for (const candidate of candidates) {
          if (candidate === match?.cue || !ownCuePaths.has(candidate.relPath)) continue;

          const named = audioNamedBy(candidate, folderAudio);

          // A cue naming a file that is an album of its own belongs to that
          // album, and is reported there if it is reported at all. Repeating it
          // here would restate one cue's situation once per folder that can see
          // the file — and would say it wrongly, since the folder does hold what
          // the cue names. The album's own file is exempt: a second cue
          // describing *this* album's image is exactly the lost rip this loop is
          // for.
          if (named !== null && named.audio.relPath !== albumRelPath && albumFiles.has(named.audio.relPath)) {
            continue;
          }

          let report: { detail: string; severity: 'info' | 'warn' };

          if (named !== null && match !== null && named.audio.relPath === match.audio.relPath) {
            report = {
              detail: 'another cue describes this audio; this one was not used',
              severity: 'info',
            };
          } else if (named === null) {
            report = { detail: 'cue describes no audio file in this folder', severity: 'warn' };
          } else {
            report = {
              detail: 'cue names an audio file this album was not matched to',
              severity: 'warn',
            };
          }

          recordIssue(root.id, candidate.relPath, 'cue-unmatched', report.detail, report.severity);
        }

        const probeFor = (file: WalkedFile): number | null => {
          // Only the last split track needs this, and it needs it exactly once
          // per album — but a collection of image+cue rips would spawn one
          // ffprobe per album on every run. A stored answer for a file the
          // filesystem reports unmoved is the same answer.
          const stored = selectUsableProbe.get(root.id, file.relPath, PROBE_METHOD) as
            | { duration_ms: number | null }
            | undefined;

          if (stored !== undefined) {
            counters.probesReused += 1;
            return stored.duration_ms;
          }

          const result = probe(join(root.path, file.relPath));
          counters.probed += 1;
          if (!result.ok) counters.probeFailures += 1;

          const fileRow = selectFileId.get(root.id, file.relPath) as { id: number } | undefined;
          if (fileRow !== undefined) {
            upsertProbe.run(
              fileRow.id,
              result.durationMs,
              result.codec,
              result.sampleRate,
              result.channels,
              result.bitrate,
              result.ok ? 1 : 0,
              result.err,
              'ffprobe',
              PROBE_METHOD,
            );
          }

          return result.ok ? result.durationMs : null;
        };

        // Memoised per album: a title is asked for once per track, and a
        // folder's files are asked about more than once across the plan.
        const tagMemo = new Map<string, string | null>();
        const tagValue = (relPath: string, name: string): string | null => {
          // A NUL between the two fields, because it is the one character
          // neither can contain — a space would collide the moment a path or a
          // tag name carried one. Written as an escape rather than as the byte
          // itself: a raw 0x00 in the source is enough for `rg`, `grep` and
          // every other tool to call this file binary and skip it (task:2722).
          const key = `${relPath}\u0000${name}`;
          if (!tagMemo.has(key)) {
            const fileRow = selectFileId.get(root.id, relPath) as { id: number } | undefined;
            const tag =
              fileRow === undefined
                ? undefined
                : (selectTagValue.get(fileRow.id, name) as { value: string } | undefined);
            tagMemo.set(key, tag?.value ?? null);
          }
          return tagMemo.get(key) ?? null;
        };

        const plan = planAlbum(audioFiles, match?.cue.doc ?? null, {
          // The matcher resolved the cue's `FILE` tags from the cue's own
          // folder; the plan has to read them from the same place, or it would
          // be asking whether the cue describes files it never named.
          cuePath: match?.cue.relPath ?? null,
          durationMs: probeFor,
          titleOf: (file) => tagValue(file.relPath, 'title'),
          // The album's own name, for the one thing that reads it: a file name
          // whose leading field the folder also states is the album's, not the
          // track's. An album with no folder of its own is the root, and its
          // name is then the name of the directory the root points at.
          albumName:
            sourceFolder === '' ? rootBasenameOf(root.path) : basenameOf(sourceFolder),
        });

        if (match !== null) {
          const cueRow = selectFileId.get(root.id, match.cue.relPath) as { id: number } | undefined;
          const audioRow = selectFileId.get(root.id, match.audio.relPath) as { id: number } | undefined;

          if (cueRow !== undefined) {
            const { decoded } = match.cue;

            upsertCue.run(
              cueRow.id,
              audioRow?.id ?? null,
              match.cue.doc.rem['CATALOG'] ?? null,
              JSON.stringify(match.cue.doc.rem),
              decoded.encoding,
              decoded.confidence,
              match.cue.doc.performer,
              match.cue.doc.title,
            );

            // The reader normalises to UTF-8, but when it had to *infer* the
            // source encoding, that inference is itself a finding. Once per
            // cue: a parent cue describes every album beneath it, and the
            // inference does not become truer — or noisier — with repetition.
            const cueKey = `${root.id}:${match.cue.relPath}`;
            if (decoded.confidence < CERTAIN && !encodingReported.has(cueKey)) {
              encodingReported.add(cueKey);
              recordIssue(
                root.id,
                match.cue.relPath,
                'cue-encoding-guessed',
                decoded.basis,
                decoded.confidence >= CONFIDENT ? 'info' : 'warn',
              );
            }
            const stored = selectCueId.get(cueRow.id) as { id: number } | undefined;

            if (stored !== undefined) {
              deleteCueTracks.run(stored.id);

              // Cue numbering is not guaranteed unique — a cue spanning several
              // files restarts at TRACK 01 for each. Recording the duplicate
              // beats throwing away the whole scan on a UNIQUE violation.
              const seen = new Set<string>();
              for (const entry of match.cue.doc.tracks) {
                const key = `${entry.fileIndex}:${entry.ordinal}`;
                if (seen.has(key)) {
                  recordIssue(
                    root.id,
                    match.cue.relPath,
                    'cue-duplicate-track',
                    `TRACK ${entry.ordinal} declared twice in file ${entry.fileIndex}`,
                  );
                  continue;
                }
                seen.add(key);
                insertCueTrack.run(
                  stored.id,
                  entry.fileIndex,
                  entry.ordinal,
                  entry.title,
                  entry.performer,
                  entry.index00Ms,
                  entry.index01Ms,
                  entry.index00FileIndex,
                  entry.index01FileIndex,
                );
              }
            }
            counters.cues += 1;
          }
        } else if (cueRows.length > 0) {
          // Nothing matched. Clear any stale binding so the cue does not keep
          // claiming an audio file that is no longer there.
          for (const row of cueRows) {
            const cueRow = selectFileId.get(root.id, row.rel_path) as { id: number } | undefined;
            if (cueRow !== undefined) {
              clearCue.run(cueRow.id);
              const stored = selectCueId.get(cueRow.id) as { id: number } | undefined;
              if (stored !== undefined) deleteCueTracks.run(stored.id);
            }
          }
        }

        const album = selectAlbumId.get(root.id, albumRelPath) as
          | { id: number; release_id: number | null; title_source: string | null }
          | undefined;

        const cueTitle = match?.cue.doc.title ?? null;
        if (album !== undefined) {
          const releaseId = album.release_id;

          if (cueTitle !== null && releaseId === null) {
            if (isSiteName(cueTitle)) {
              // The cue names where the rip came from, not the record — the
              // rule below on the tag path, applied to the source that speaks
              // first and loudest. Written, it would put a wrong word in the
              // meta layer under `'cue'`, the value that carries the most
              // authority, and say nothing about it (task:2725). Refused, the
              // record keeps the name its folder has, exactly as it does when a
              // tag is refused.
              recordIssue(
                root.id,
                albumRelPath,
                'title-cue-declined',
                `the cue states where the rip came from, not the record — "${cueTitle}" was not used as a name; the record keeps the name its folder has`,
                'info',
              );
            } else {
              updateAlbumTitle.run(cueTitle, 'cue', album.id);
            }
          } else {
            // Either no cue names this record, or it names a *disc* of one and a
            // disc's label is not the record's name. The files themselves get
            // their say instead — the ordinary case for a folder of tagged
            // files, and the reason a tag beats the folder at all. Every ALBUM
            // the files state, not the first one. A record whose files state two
            // titles has stated two answers to one question, and taking whichever
            // sorted first is the confident guess this project already refuses to
            // make elsewhere: `albumArtistOf` in `artist/apply.ts` declines the
            // credit when an album's files disagree, for exactly this reason. One
            // rule, not two.
            const stated = new Set<string>();
            for (const file of audioFiles) {
              const value = tagValue(file.relPath, 'album');
              if (value !== null) stated.add(value);
            }
            const tagTitles = [...stated].sort();

            if (releaseId !== null) {
              // Where a *release* is concerned the name belongs to the release,
              // exactly as the cue's does above: three discs of a box share one
              // album title, and a disc's tag may no more name the box than its
              // cue's label may. What the discs say is gathered here and decided
              // once for the whole box below, after every disc has been read.
              // Deciding it per disc is what named the box after whichever disc
              // came last, and left a box whose discs disagreed entirely silent
              // (task:2728).
              const seen = releaseTagTitles.get(releaseId) ?? {
                titles: new Set<string>(),
                relPath: albumRelPath,
              };
              for (const title of tagTitles) seen.titles.add(title);
              releaseTagTitles.set(releaseId, seen);
            } else {
              const fromTag = tagTitles.length === 1 ? (tagTitles[0] as string) : null;

              // Said out loud rather than dropped: the files disagree, so the
              // tag has no answer, and the record keeps the name its folder has
              // until somebody decides which of the two it is.
              if (tagTitles.length > 1) {
                recordIssue(
                  root.id,
                  albumRelPath,
                  'title-tag-ambiguous',
                  `its files state ${tagTitles.length} different ALBUM tags — ${tagTitles
                    .map((title) => `"${title}"`)
                    .join(', ')}; none was used, and the record keeps the name its folder has`,
                  'info',
                );
              }

              if (fromTag !== null && isSiteName(fromTag)) {
                // The tag names where the rip came from, not the record — see
                // `text/site-name.ts`. It is not written as knowledge, and the
                // refusal is said out loud.
                recordIssue(
                  root.id,
                  albumRelPath,
                  'title-tag-declined',
                  `the tag states where the rip came from, not the record — "${fromTag}" was not used as a name; the record keeps the name its folder has`,
                  'info',
                );
              } else if (fromTag !== null) {
                if (placeholder(album.title_source)) {
                  updateAlbumTitle.run(fromTag, 'tag', album.id);
                }
              }
            }
          }

          // A cue's claim on a *release* is not settled here. It is gathered and
          // decided once for the whole box after every disc has been read — see
          // below. Deciding it per cue was the first attempt and it was wrong:
          // one sibling cue carrying no marker would still name the record after
          // its own disc, and which cue came last decided the winner.
          if (cueTitle !== null && releaseId !== null) {
            const seen = releaseCueTitles.get(releaseId) ?? { titles: new Set<string>(), relPath: albumRelPath };
            seen.titles.add(cueTitle);
            releaseCueTitles.set(releaseId, seen);
          }
        }

        if (album !== undefined) {
          // Which places on this record the pass still names. Everything else
          // the record holds is left over from a cue that has changed, and is
          // swept once the writes are done — a track whose file could not be
          // named is *not* kept, so its old row does not outlive it.
          const kept: number[] = [];
          for (const track of plan.tracks) {
            const trackFile = selectFileId.get(root.id, track.file.relPath) as { id: number } | undefined;
            if (trackFile === undefined) continue;

            // A cue split states its own length; a whole-file track has only
            // what the file itself measured — which, for a FLAC, arrived in the
            // same pass without spawning anything.
            const duration =
              track.segmentStartMs !== null && track.segmentEndMs !== null
                ? track.segmentEndMs - track.segmentStartMs
                : ((selectFileDuration.get(trackFile.id, PROBE_METHOD, latestRun) as
                    | { duration_ms: number | null }
                    | undefined)?.duration_ms ?? null);

            upsertTrack.run(
              album.id,
              track.ordinal,
              track.title,
              track.titleSource,
              trackFile.id,
              track.segmentStartMs,
              track.segmentEndMs,
              duration,
            );
            kept.push(track.ordinal);
            counters.tracks += 1;
          }
          deleteStaleTracks(album.id, kept);
        }

        // A net no current path falls into. `planAlbum` answers with at least one
        // track for any album that reaches here, and an album with no audio at
        // all never does — `audioFiles.length === 0` above says so. It is kept
        // because the shape it catches is one this stage has already produced
        // once (an album emptied by a later pass), because the contract forbids
        // losing it without a word, and because the check is what makes that
        // impossible rather than merely unlikely. `test/multidisc.test.ts` pins
        // the invariant it enforces whether or not it fires.
        if (plan.tracks.length === 0) {
          recordIssue(
            root.id,
            albumRelPath,
            'album-without-tracks',
            `${audioFiles.length} audio file(s) yielded no tracks`,
          );
        }

        for (const issue of plan.issues) {
          recordIssue(root.id, albumRelPath, issue.kind, issue.detail, issue.severity ?? 'warn');
        }

        byShape[plan.shape] += 1;
        counters.albums += 1;
      }

      // A cue sitting above the albums that named audio in none of them.
      //
      // The per-album loop reports a cue of the folder's own and stops there:
      // a parent cue is a candidate for every album beneath it, so reporting it
      // there would restate one cue's situation once per album — which is the
      // repetition the filter exists to prevent, and it was taken as a reason to
      // say nothing at all. Waiting until the root is walked is what makes a
      // single report possible, and it is the only place that knows.
      for (const relPath of parentCues) {
        if (matchedCues.has(relPath)) continue;
        recordIssue(
          root.id,
          relPath,
          'cue-unmatched',
          'cue sits above these albums and names none of their audio',
          'warn',
        );
      }

      // A cue in a folder that holds no album. The stage walks albums, and a
      // folder with no audio is not one, so nothing read this cue, nothing
      // bonded it, and nothing said so — the one shape of cue that left no trace
      // anywhere in the meta layer.
      for (const relPath of rootCues) {
        // Read, or tried and failed. A cue that could not be opened has its
        // reason already, and "nothing read it" is not it — this loop is about
        // the folder, not about the attempt.
        if (readCues.has(relPath) || unreadableCues.has(relPath)) continue;
        recordIssue(
          root.id,
          relPath,
          'cue-unmatched',
          'cue is in a folder with no album; nothing read it',
          'warn',
        );
      }

      // The tag's half of the same rule, and the same reason for waiting: a box
      // is named once, by what its discs agree on. A disc's ALBUM tag named the
      // release the moment it was read, so the box took the title of whichever
      // disc came last, and a box whose discs stated different titles said
      // nothing at all about it — while the album level already refuses to pick
      // between files that disagree (task:2728).
      //
      // It runs before the cues below rather than after, because the tag has the
      // first say: a file's own ALBUM names the record, where a cue's TITLE on a
      // disc is the label EAC wrote for that disc. A release the tags have named
      // is one the cue pass finds no placeholder to fill.
      for (const [releaseId, seen] of releaseTagTitles) {
        const titles = [...seen.titles].sort();
        const [title] = titles;
        if (title === undefined) continue;

        // A cue already named this record, and a tag never overrides a cue
        // (`006_tags.sql`). The pass below is the other half of the same rule —
        // it skips a record a tag has named — and without this one the two only
        // agreed because of the order they happened to run in, which holds for a
        // record seen for the first time and not for one a previous run left
        // named by its cue.
        const named = selectReleaseSource.get(releaseId) as
          | { title_source: string | null }
          | undefined;
        if (!placeholder(named?.title_source)) continue;

        if (titles.length > 1) {
          recordIssue(
            root.id,
            seen.relPath,
            'title-tag-ambiguous',
            `its discs state ${titles.length} different ALBUM tags — ${titles
              .map((each) => `"${each}"`)
              .join(', ')}; none was used, and the box keeps the name its folder states`,
            'info',
          );
          continue;
        }

        if (isSiteName(title)) {
          // The tag names where the rip came from, not the record — see
          // `text/site-name.ts`. One report for the box rather than one per
          // disc, which is the scope the finding is about: every disc of a box
          // carries the same site.
          recordIssue(
            root.id,
            seen.relPath,
            'title-tag-declined',
            `the tag states where the rip came from, not the record — "${title}" was not used as a name; the box keeps the name its folder states`,
            'info',
          );
          continue;
        }

        // `recordTitle`, not the tag verbatim: a name a file states is shown to a
        // client exactly as a name a folder states, so it is read the same way.
        // The live collection had `1989 Звезда по имени Солнце (2019, Maschina
        // Records, MKM891CD, 3CD)` from a tag beside `Группа крови (Maschina
        // Records, MKK881CD, 3CD)` from a folder, under one artist, and only the
        // second looked like the rest of the records.
        updateReleaseTitle.run(recordTitle(title), 'tag', releaseId);
      }

      // A release is named by its cues only when the box speaks with one voice
      // and that voice is not a disc's.
      //
      // Both cues of the Wall say `The Wall [Disc 1]` and `The Wall [1994
      // Remaster](Disc 2)`, and writing each onto the one release row in turn
      // left the box named after whichever disc came last — EAC writes a disc's
      // label into `TITLE`, and here it stood in for the album's name with
      // nothing to show it happened.
      for (const [releaseId, seen] of releaseCueTitles) {
        const titles = [...seen.titles].sort();
        const [title] = titles;
        if (title === undefined) continue;

        const release = selectReleaseSource.get(releaseId) as
          | { title_source: string | null }
          | undefined;
        // A tag already named this record. That is the priority chain working,
        // not a cue being turned away, so it is not reported.
        if (!placeholder(release?.title_source)) continue;

        // Three ways a box's cues fail to name the record, and none is allowed
        // to happen quietly: its discs disagree about what they are, they agree
        // on a label that names one disc rather than the record, or they agree
        // on a host — the site the rip came from, which is the one shape no
        // agreement check can tell from a name (task:2725).
        const why =
          titles.length > 1
            ? 'its discs disagree'
            : discMarker(title) !== null
              ? `"${title}" names a disc`
              : isSiteName(title)
                ? `"${title}" names where the rip came from`
                : null;

        if (why === null) {
          // The same read the tag path uses, and for the same reason.
          updateReleaseTitle.run(recordTitle(title), 'cue', releaseId);
          continue;
        }

        // Nothing keeps a turned-away title — `cue` has no `title` column — so
        // the refusal is recorded rather than left to vanish (task:2697).
        recordIssue(
          root.id,
          seen.relPath,
          'release-title-declined',
          `cue titles not used — ${why}: ${titles.map((each) => `"${each}"`).join(', ')}; the release keeps its folder name`,
          'info',
        );
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already unwound; the original error is what matters.
    }
    throw err;
  }

  return { ...counters, byShape };
}
