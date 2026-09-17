import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { withTransaction, type DatabaseSync } from '../db/index.ts';
import { clearIssues, type Stage } from '../db/issue.ts';
import { ledgerEntry, moved } from '../db/ledger.ts';
import { PROBE_METHOD, probeFile, type Probe } from '../probe/ffprobe.ts';
import { CERTAIN, CONFIDENT, decodeText } from '../text/encoding.ts';
import { firstTagStatements } from './first.ts';
import { readTags, TAGS_METHOD, type TagRead } from './read.ts';

/**
 * How many files one write transaction carries.
 *
 * **The number is the whole of what this stage promises a listener**, and it was
 * chosen the way the scan chose its own (`scan.ts`): the lock is held for a
 * batch and let go between them, so a save that loses the race for one batch
 * gets in on the next. The budget is the 250 ms a save waits
 * (`busy_timeout`, `db/index.ts`).
 *
 * Measured on a copy of the live collection before this existed, with the
 * transaction around the whole pass: 3432 files held the lock for **113.0 s**
 * and refused 284 of 311 saves ([[task:2929]], report `wiki:3647`). What that
 * pass spends its time on is *reading* files, so the reads come out of the
 * transaction altogether and this bounds only the writing that is left.
 *
 * Files and not rows, unlike the scan: what one file writes depends on what its
 * tags say — a cover, two advisories, eight first-values — so there is no row
 * count to name in advance.
 *
 * **The number is smaller than the budget wants, and the reason is measured.**
 * A batch's window is not what this stage writes — instrumenting `withTransaction`
 * through a full pass of 3432 files puts the work at **8–98 ms a batch** and the
 * commit that follows it at **189–285 ms**. The commit is the window, it does not
 * shrink with the batch, and on this deployment's volume it is already at the
 * 250 ms a save waits. So there is no batch size that reaches the budget; what a
 * batch size can do is decide whether the *work* is part of the problem.
 *
 * It was a hundred to begin with, which put the worst batch at **534 ms** across
 * a full pass; thirty-two measures the same worst window (530) and the same
 * refusals, because the commit is most of both. Thirty-two is chosen for the
 * other volume: where a commit costs a millisecond or two, this batch's window
 * is its work and nothing else, and the stage's promise does not depend on how
 * slow the disk under it happens to be.
 */
const FILES_PER_TRANSACTION = 32;

/** This stage's name in `issue.stage`. Bound to the insert and to the clear. */
const STAGE: Stage = 'tags';

export interface TagCounters {
  /** Audio files whose bytes were opened. */
  files: number;
  /** Tag rows written. */
  tags: number;
  /** Files whose text had to be inferred rather than declared. */
  encodings: number;
  /** Durations taken from a container header instead of a decoder. */
  durations: number;
  /** Files handed to ffprobe because the reader could not measure them. */
  probed: number;
  /** Of those, the ones ffprobe could not measure either. */
  probeFailures: number;
  /** Records whose year came from a file's own DATE rather than from a folder. */
  years: number;
  /**
   * Sidecar documents — an `.nfo`, an EAC `.log` — read and decoded, and the
   * ones that could not be opened at all.
   *
   * Counted apart from `files` because a sidecar is not an audio file and the
   * two are read for different reasons: this stage opens a song to learn what it
   * says about itself, and opens a sidecar to learn what the record's
   * documentation says. A number that added them together would say neither.
   */
  sidecars: number;
  sidecarFailures: number;
  issues: number;
}

export interface TagDeps {
  /** Swappable so tests need neither real bytes nor a readable file. */
  readBytes?: (absPath: string) => Uint8Array;
  /**
   * A window of a file, consulted by the default `readBytes` when it trims a FLAC
   * to its metadata chain.
   *
   * Swappable for the same reason `readBytes` is, and overridden by supplying
   * `readBytes` at all — which is what a test with no file on disk does, and what
   * keeps this from sending it looking for one.
   */
  readRange?: (absPath: string, at: number, length: number) => Uint8Array;
  /** Swappable so tests need neither ffprobe nor a process. */
  probe?: (absPath: string) => Probe;
}

/** `fLaC`, the four bytes a FLAC opens with. */
const FLAC_MARKER = [0x66, 0x4c, 0x61, 0x43] as const;

/** A window of a file from disk, short reads filled in until the length is met. */
function readRangeFromDisk(absPath: string, at: number, length: number): Uint8Array {
  const fd = openSync(absPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const got = readSync(fd, buffer, filled, length - filled, at + filled);
      if (got <= 0) break;
      filled += got;
    }
    return buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/**
 * The bytes `readTags` needs from a file, which for a FLAC is not all of them.
 *
 * Measured on this collection: its twenty largest FLACs come to 9.7 GB together,
 * and reading them whole took 16.7 seconds against 7 milliseconds for the
 * metadata chain alone — 1.4 MB read instead of 9706, a factor of about 6900.
 * The scan reads every file it has not read before, so this is the difference
 * between tens of gigabytes of I/O and about one.
 *
 * **Only FLAC is trimmed, and that is a decision rather than an oversight.** An
 * MP3 keeps a second tag block at the *other* end of the file and measures its
 * length against the buffer it was handed; an MP4's `moov` may sit after the
 * audio. Handing either of them a prefix would not save I/O, it would change the
 * answer. A FLAC's chain is a closed list that states where it ends, and its
 * reader stops at that flag — which is what makes this safe for that format, and
 * only for it.
 *
 * A chain that cannot be walked — a truncated file, a header promising more than
 * the file holds — falls back to the whole read rather than to a partial one. The
 * reader could make nothing of either, and the whole read is the answer this
 * stage gave before.
 */
function bytesForTags(
  absPath: string,
  readBytes: (absPath: string) => Uint8Array,
  readRange: (absPath: string, at: number, length: number) => Uint8Array,
): Uint8Array {
  const head = readRange(absPath, 0, FLAC_MARKER.length);
  if (head.length < FLAC_MARKER.length) return readBytes(absPath);
  if (FLAC_MARKER.some((byte, at) => head[at] !== byte)) return readBytes(absPath);

  let at = FLAC_MARKER.length;
  for (;;) {
    const header = readRange(absPath, at, 4);
    if (header.length < 4) return readBytes(absPath);

    const last = (header[0]! & 0x80) !== 0;
    const length = (header[1]! << 16) | (header[2]! << 8) | header[3]!;
    at += 4 + length;
    if (last) return readRange(absPath, 0, at);
  }
}

interface DueFile {
  id: number;
  rel_path: string;
  root_id: number;
  root_path: string;
  ext: string;
  /**
   * The ledger's verdict on this file, or null when it has none.
   *
   * Null is not "unmoved": a file the walk has not observed twice has no verdict
   * at all, and a stored measurement cannot be known to describe bytes that
   * nothing has compared.
   */
  changed: number | null;
}

/**
 * Read what each audio file says about itself, and write it down.
 *
 * Sits between `classify` and `applyCues`, for one reason: the classifier names
 * an album from the folder and a cue overrides that name, so the tag has to
 * arrive between the two to be third in line. Reading tags after the cue would
 * leave a stage that can only ever agree with what is already written.
 *
 * This stage reads and stores; it decides nothing about what a title should be.
 * The places that already own those decisions — `planAlbum` for track titles,
 * `applyCues` for album titles, `applyArtists` for who the artist is — consume
 * the rows this writes. Putting the priority here would mean a second copy of
 * each rule, free to drift from the first.
 *
 * What is read is decided by the ledger, and this is the one place where the
 * obvious rule is wrong. "Read a file whose bytes moved" is right and
 * insufficient: a file nothing has ever read has not moved either, so the
 * existing collection would never be read at all. "Or has no tag rows" looks
 * like it fixes that and cannot, because a file with no tags is an ordinary
 * untagged rip — it would be re-read on every scan forever with nothing to show
 * for it. So the read is stamped in `file.tags_read_run_id`, NULL meaning never
 * read, and both cases fall out of one condition.
 *
 * A file that cannot be opened is left unstamped on purpose: a permission error
 * or a locked file is a transient, and the next scan should try again.
 */
export function applyTags(db: DatabaseSync, deps: TagDeps = {}): TagCounters {
  // The trimming lives in the default, and that placement is the contract: a
  // caller that supplies its own `readBytes` keeps deciding what the reader is
  // handed. Every test that has no file on disk does exactly that, and reaching
  // for one anyway is what this arrangement prevents.
  const readBytes =
    deps.readBytes ??
    ((absPath: string): Uint8Array =>
      bytesForTags(absPath, () => readFileSync(absPath), deps.readRange ?? readRangeFromDisk));
  // A sidecar is read whole. The audio path is trimmed to what a reader needs —
  // a FLAC's metadata chain, a compressed frame's prefix — and a `.log` is not a
  // container with a beginning worth finding: the document *is* the file.
  const readWhole = deps.readBytes ?? ((absPath: string): Uint8Array => readFileSync(absPath));

  const probe = deps.probe ?? ((absPath: string): Probe => probeFile(absPath));

  const counters: TagCounters = {
    files: 0,
    tags: 0,
    encodings: 0,
    durations: 0,
    probed: 0,
    probeFailures: 0,
    years: 0,
    sidecars: 0,
    sidecarFailures: 0,
    issues: 0,
  };

  const latestRun = (db.prepare('SELECT MAX(id) AS id FROM scan_run').get() as {
    id: number | null;
  }).id;

  // The left join is deliberate: a file the walk has not seen twice yet has no
  // ledger row at all, and that is not a reason to skip it. Its `tags_read_run_id`
  // being NULL is what brings it in, so the join only has to supply the verdict
  // when there is one.
  //
  // `last_seen_run_id` is not a ledger matter but the run's own scope, and it is
  // the one that says which files this run may read at all. What it means is
  // that the run *stands behind* the file — the walk saw it, or the sweep's
  // amnesty kept it as a path under a directory the walk could not enter, which
  // `sweep.ts` stamps for exactly that reason. A file under a root this run did
  // not visit is neither, and it is the case that matters: the walk never
  // happened, so `changed` — a flag the walk sets — is whatever an older run
  // left, the file reads as moved, and the stage opens it and reports on it
  // (task:2751). What a run reports on is what it stands behind.
  //
  // The amnesty case is worth being plain about, since it is not "the walk saw
  // it": a file beneath a directory the walk could not enter is still read, and
  // still reported on, whenever it can be opened. That is deliberate — the
  // library holds the file, its row survived the sweep, and the run stands
  // behind the subtree it could not look into. Chosen rather than inherited, and
  // measured rather than argued: the amnesty puts such a file in scope and does
  // not decide the read — that is the ledger's `changed` — and where the read
  // happens it is true in both states of the file, present and gone. Reading
  // nothing there would suppress a true finding, not a false one
  // (`concepts/last-seen-run-id`, task:2759).
  // `tags_method` and `probe_method` are the next two reasons, and they are the
  // ones that repair rather than maintain: a verdict written by a reading that
  // is no longer taken is not an answer about the file, so the file is read
  // again and a verdict is taken again. `tags_method` is this stage's own reader
  // — the column says which reading stamped the file — and `probe_method` is
  // the probe row's, which this stage is also the one to re-take. Either fires
  // once per change of method: after a run everything is at the current number,
  // and a file with no row at all is not due *for that reason*, which is what
  // keeps this from re-reading the library on every scan forever.
  const selectDue = db.prepare(
    `SELECT f.id AS id, f.rel_path AS rel_path, f.root_id AS root_id, r.path AS root_path,
            f.ext AS ext, ss.changed AS changed
       FROM file f
       JOIN root r ON r.id = f.root_id
       LEFT JOIN scan_state ss ON ${ledgerEntry('f', 'ss')}
       LEFT JOIN audio_probe p ON p.file_id = f.id
      WHERE f.kind = 'audio'
        AND f.last_seen_run_id = ?
        AND (f.tags_read_run_id IS NULL OR ${moved('ss')}
             OR f.tags_method <> ?
             OR (p.probe_method IS NOT NULL AND p.probe_method <> ?))
      ORDER BY f.root_id, f.rel_path`,
  );

  // The same question asked of the record's documentation, and asked the same
  // way on purpose: a sidecar is due when this run stands behind it and the
  // ledger says it moved, which is exactly the rule the songs above follow. There
  // is no probe arm — nothing measures a `.log` — and the kinds are the scan's.
  const selectSidecarDue = db.prepare(
    `SELECT f.id AS id, f.rel_path AS rel_path, f.root_id AS root_id, r.path AS root_path
       FROM file f
       JOIN root r ON r.id = f.root_id
       LEFT JOIN scan_state ss ON ${ledgerEntry('f', 'ss')}
      WHERE f.kind IN ('log', 'nfo')
        AND f.last_seen_run_id = ?
        AND (f.tags_read_run_id IS NULL OR ${moved('ss')} OR f.tags_method <> ?)
      ORDER BY f.root_id, f.rel_path`,
  );
  const stampSidecar = db.prepare(
    `UPDATE file
        SET encoding = ?, encoding_confidence = ?, tags_read_run_id = ?, tags_method = ?
      WHERE id = ?`,
  );
  const upsertSidecar = db.prepare(
    `INSERT INTO sidecar_text (file_id, text) VALUES (?, ?)
     ON CONFLICT (file_id) DO UPDATE SET text = excluded.text`,
  );

  const deleteTags = db.prepare('DELETE FROM file_tag WHERE file_id = ?');
  // Re-derived with the tags and for the same reason: a picture taken out of the
  // file has to leave the meta layer, and only a delete can say that.
  const deleteCover = db.prepare('DELETE FROM cover_art WHERE file_id = ?');
  const insertCover = db.prepare(
    'INSERT INTO cover_art (file_id, mime, picture_type, offset, length, kind) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertTag = db.prepare(
    'INSERT INTO file_tag (file_id, name, value, position) VALUES (?, ?, ?, ?)',
  );
  // The same tags again, in the shape a listing reads them — one row a file,
  // written here so that it cannot drift from the rows it is derived from. See
  // `first.ts` for why the listing does not read `file_tag` itself.
  const firstTags = firstTagStatements(db);
  const stampRead = db.prepare(
    `UPDATE file
        SET encoding = ?, encoding_confidence = ?, tags_container = ?, tags_read_run_id = ?,
            tags_method = ?
      WHERE id = ?`,
  );
  /** What a failed read owes the next run: the file back in the due list. */
  const clearStamp = db.prepare('UPDATE file SET tags_read_run_id = NULL WHERE id = ?');

  // Seeded, not asserted — with one exception, and the exception is the whole
  // reason for the `WHERE`. A duration from a header is exactly as good as one
  // from a decoder for the same file, so a probe that already succeeded is not
  // this stage's to overwrite *while the bytes are the ones it measured* — nor
  // while it is a reading of the kind this code takes. `probe_method` is that
  // second half: a row written by an older method is not an answer about the
  // file, which is how the `codec` column came to hold container names for two
  // thousand files without anything saying so.
  const seedProbe = db.prepare(
    `INSERT INTO audio_probe (file_id, duration_ms, codec, sample_rate, channels, bitrate, probe_ok, probe_err, duration_source, probe_method)
     VALUES (?, ?, ?, ?, ?, NULL, 1, NULL, 'container', ?)
     ON CONFLICT (file_id) DO UPDATE SET
       duration_ms     = excluded.duration_ms,
       codec           = excluded.codec,
       sample_rate     = excluded.sample_rate,
       channels        = excluded.channels,
       probe_ok        = 1,
       probe_err       = NULL,
       duration_source = excluded.duration_source,
       probe_method    = excluded.probe_method
     WHERE audio_probe.probe_ok = 0 OR ? = 1 OR audio_probe.probe_method <> ?`,
  );

  // A row left over from bytes that have been replaced is not an answer about
  // this file, and there is nothing here to put in its place — see the loop.
  const deleteProbe = db.prepare('DELETE FROM audio_probe WHERE file_id = ?');

  // The probe's answer replaces whatever is there, failure included. It was
  // asked because nothing else here could answer, so it is the only word on the
  // file — unlike `seedProbe`, which defers to a probe that already succeeded.
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

  // Cleared per file rather than per stage, in the loop below. This stage reads
  // only the files the ledger reports as changed or never read, so a row it
  // files describes the last attempt on *that* file — and clearing the stage
  // wholesale would drop findings for every file this run did not open, which
  // is the reported silence `issue` exists to prevent. Per run it does grow:
  // a file that cannot be opened is left unstamped on purpose so the next scan
  // retries it, and it is reported again each time. `db/issue.ts` has the rule.
  const insertIssue = db.prepare(
    `INSERT INTO issue (scan_run_id, stage, root_id, rel_path, kind, severity, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const due = selectDue.all(latestRun, TAGS_METHOD, PROBE_METHOD) as unknown as DueFile[];

  // ── Reading, with nothing open ────────────────────────────────────────────
  //
  // **The reads are what this stage spends its time on, and they need no lock.**
  // Measured by the review umbrella ([[task:2928]], report `wiki:3647`): with the
  // transaction wrapped around the whole pass, all 3432 due files held the write
  // lock for **113.0 s**, and a listener's `savePlayQueue` arriving in that window
  // was refused **284 times out of 311** — a `ping` p90 of 349.81 ms against a
  // floor of 0.78. Reading a file off this disk is most of that time, and probing
  // a file that refused to be measured is a *process*: neither touches the
  // database, and both were inside the transaction anyway.
  //
  // So they come out, and the writing that follows happens a batch at a time.
  // What is held between the two is every due file's parse — a tag list and a
  // picture's offset, small — bounded by the collection rather than by the run.
  //
  // A file that could not be opened is carried as the error rather than thrown,
  // because the writing pass is where that has to be said: the stamp comes off
  // and the finding is filed, and both are writes.
  const parsed = new Map<number, TagRead | Error>();
  const answered = new Map<number, Probe>();
  for (const file of due) {
    let read: TagRead;
    try {
      read = readTags(readBytes(join(file.root_path, file.rel_path)));
    } catch (err) {
      parsed.set(file.id, err as Error);
      continue;
    }
    parsed.set(file.id, read);
    // The only thing in this stage worth a process, and it is one spawn per file
    // that refused and none for the rest — but a spawn inside the write
    // transaction charges a process's whole lifetime to the lock.
    //
    // **Outside the `catch` above, and that is not tidiness.** A reader that
    // cannot open a file is a fact about *the file*; a probe that throws is a
    // fault in this stage. Wrapped together, the second was filed as the first —
    // the run said `tag-unreadable` and carried on with every other file, where
    // the stage it replaced raised and took the run down with it. Found by
    // `test/run.test.ts` on the first run of this shape.
    if (read.durationRefused) answered.set(file.id, probe(join(file.root_path, file.rel_path)));
  }

  // ── Writing, one batch of files to a transaction ──────────────────────────
  //
  // A batch rather than the run, which is the whole of what this shape buys: the
  // lock is held for a batch, so a save waiting on it gets in between them. The
  // budget is the 250 ms `busy_timeout` a listener's save waits (`db/index.ts`),
  // and the sibling stage that solved this first is the scan — measured there, a
  // batch of five hundred rows holds the lock **12 ms at the median and 96 ms at
  // its worst** (`scan.ts`, `task:2871`).
  //
  // A batch that throws unwinds only itself: what came before it stays, the run
  // is marked `failed` with its reason filed, and every file it did not reach is
  // still `due` — the recovery this project's stages already promise (`run.ts`),
  // because a rerun reaches the state a clean run would.
  for (let at = 0; at < due.length; at += FILES_PER_TRANSACTION) {
    const batch = due.slice(at, at + FILES_PER_TRANSACTION);
    withTransaction(db, () => {
      for (const file of batch) {
        // This file is about to be read again, so its previous report describes an
        // attempt that has been superseded — including the aggregate row written
        // for it at the end of the loop, which carries the same path.
        clearIssues(db, STAGE, { rootId: file.root_id, relPath: file.rel_path });

        const read = parsed.get(file.id);
        if (read === undefined || read instanceof Error) {
          // A file that could not be opened is left unstamped, so the next scan
          // tries again — that is the promise `readBytes` makes above, and the
          // stamp is what has to come off for it to hold. An earlier successful
          // read left one, and the walk had already recorded the bytes it found
          // before this read was attempted, so `changed` settled to 0: a file read
          // once and then locked was never read again. Its old tags stayed in the
          // dump as current, and this row stayed forever — by then untrue
          // (task:2751, round 4).
          //
          // The reading pass carried the failure here rather than throwing it,
          // because both halves of what it owes are writes.
          clearStamp.run(file.id);
          insertIssue.run(
            latestRun,
            STAGE,
            file.root_id,
            file.rel_path,
            'tag-unreadable',
            'warn',
            read instanceof Error ? read.message : 'the file was not read',
          );
          counters.issues += 1;
          continue;
        }

        counters.files += 1;

        // The reader dispatches on the bytes, so `container === null` means it
        // recognised nothing at all — not "a format with no tags in it", which
        // is a FLAC with an empty Vorbis block and is perfectly understood. The
        // difference matters: the first is a gap in this project, the second is a
        // fact about the rip, and only the first is worth saying out loud.
        // The scan called this file audio from its extension, and the bytes say
        // otherwise: a picture track is a video whatever it is named. Said out
        // loud rather than passed over, because nothing else in the meta layer
        // records it — a track is made from the file either way, so it costs no
        // counter and leaves no gap in `unaccounted` (task:2727).
        if (read.video === true) {
          insertIssue.run(
            latestRun,
            STAGE,
            file.root_id,
            file.rel_path,
            'tag-video-as-audio',
            'warn',
            'the file holds a picture track — it is a video the scan called audio from its extension; no tags and no length were read from it',
          );
          counters.issues += 1;
        }

        // Re-derived every time rather than added to: a tag taken out of the file
        // has to leave the meta layer, and only a delete can say that.
        deleteTags.run(file.id);
        deleteCover.run(file.id);

        // The cover the file carries, as the place its bytes are — see
        // `db/migrations/013_cover_art.sql` on why it is a place and not a copy.
        if (read.picture !== undefined) {
          insertCover.run(
            file.id,
            read.picture.mime,
            read.picture.kind,
            read.picture.offset,
            read.picture.length,
            // Whether those two numbers are the picture itself or a region that
            // holds it — see migration 017 and `TagPicture.indirect`.
            read.picture.indirect === true ? 'indirect' : 'image',
          );
        }

        // Position restarts per name, because a name is what repeats: two ARTIST
        // values are the first and second artist, not an artist and a title.
        const seen = new Map<string, number>();
        for (const tag of read.tags) {
          const position = seen.get(tag.name) ?? 0;
          seen.set(tag.name, position + 1);
          insertTag.run(file.id, tag.name, tag.value, position);
          counters.tags += 1;
        }

        // The older tag block, for the names the newer one did not state at all.
        //
        // By *name*, and that is the whole of the priority rule: the v2 block is
        // what its writer maintained, so where both speak the v2 value is the
        // answer — and where only the v1 block speaks, its value is the only
        // statement of that fact in the file. What is deliberately not done is
        // storing both. Position would then read as "two artists", and this
        // project turns two artists into a collaboration — so an mp3 whose blocks
        // disagree would be filed under a credit nobody recorded, or, with no
        // `albumartist` to settle it, under none at all.
        const newerNames = new Set(read.tags.map((tag) => tag.name));
        for (const tag of read.fallbackTags ?? []) {
          if (newerNames.has(tag.name)) continue;
          const position = seen.get(tag.name) ?? 0;
          seen.set(tag.name, position + 1);
          insertTag.run(file.id, tag.name, tag.value, position);
          counters.tags += 1;
        }

        // And the eight a listing shows, as one row, now that the rows they come
        // from are in place. Here rather than in a stage of its own because it is
        // not a fact about the file that could be read without it: it *is* these
        // rows, and a second pass over them would be a second chance to disagree.
        firstTags.clear.run(file.id);
        firstTags.write.run(file.id);

        const encoding = read.encoding;
        stampRead.run(
          encoding?.encoding ?? null,
          encoding?.confidence ?? null,
          // Whether the reader recognised the container at all, kept because the
          // aggregate that reports it is counted over the collection and cannot
          // depend on this run having opened the file. See migration 012.
          read.container,
          latestRun,
          TAGS_METHOD,
          file.id,
        );

        // The reader normalises to text either way; when it had to *infer* the
        // source encoding, that inference is the finding. Stored on the file and
        // reported, like a cue's — a title that decodes to plausible mojibake is
        // exactly what the contract forbids losing silently.
        // A field the tag stated and the reader would not use — an ID3v1 year
        // that is not four digits, a genre byte the list does not name. Only the
        // reader knows this happened, and reading a value in order to throw it
        // away is precisely the silence the contract forbids. `info` rather than
        // `warn`: the file is not damaged and there is nothing to go and do, but
        // the dump should not read as if the field had been understood.
        if (read.refusals !== undefined) {
          insertIssue.run(
            latestRun,
            STAGE,
            file.root_id,
            file.rel_path,
            'tag-field-refused',
            'info',
            read.refusals.join('; '),
          );
          counters.issues += 1;
        }

        if (encoding !== null && encoding.confidence < CERTAIN) {
          counters.encodings += 1;
          insertIssue.run(
            latestRun,
            STAGE,
            file.root_id,
            file.rel_path,
            'tag-encoding-guessed',
            encoding.confidence >= CONFIDENT ? 'info' : 'warn',
            encoding.basis,
          );
          counters.issues += 1;
        }

        // Do the bytes just read belong to the row already in `audio_probe`? The
        // ledger is what knows: `changed` is the walk's own comparison of size and
        // mtime against the previous observation, so a file it reports as moved —
        // or one it has never observed twice, which has no verdict at all — is not
        // the file any stored measurement was taken from.
        const stale = file.changed !== 0;

        if (read.durationMs !== null) {
          seedProbe.run(
            file.id,
            read.durationMs,
            read.codec,
            read.sampleRate,
            read.channels,
            PROBE_METHOD,
            stale ? 1 : 0,
            PROBE_METHOD,
          );
          counters.durations += 1;
        } else if (stale && !read.durationRefused) {
          // The reader understood the bytes and produced no length, and nothing
          // below is going to either — a refused walk asks ffprobe, this does not.
          // So whatever row is stored describes bytes that are gone, and the cue
          // stage reads `probe_ok = 1` as "there is a length here". There is not
          // one any more, and the honest answer is that this stage has none.
          deleteProbe.run(file.id);
        }

        // The reader understood the bytes and still could not measure them: the
        // frame walk lost the stream with most of the file ahead of it. Nothing
        // here can recover that, and the number it did produce is short by
        // however much it skipped — so instead of storing that, this asks a
        // reader that can. It is the only thing in this stage worth a process,
        // and it is one spawn per file that refused and none for the rest.
        //
        // ffprobe is not required to be installed, and a probe that cannot run
        // is not an exception. It is the second failure of two, which is exactly
        // the loss the contract forbids leaving unsaid.
        if (read.durationRefused) {
          // Asked in the reading pass, where a process costs no lock.
          const answer = answered.get(file.id);
          if (answer === undefined) {
            // Unreachable — the pass above probes every file whose walk refused
            // and this is one — and said out loud rather than asserted away,
            // because a silent `undefined` here reads as "ffprobe could not
            // measure it", which is the opposite of what happened.
            throw new Error(`no probe answer was taken for ${file.rel_path}`);
          }
          counters.probed += 1;
          if (!answer.ok) counters.probeFailures += 1;

          upsertProbe.run(
            file.id,
            answer.durationMs,
            answer.codec,
            answer.sampleRate,
            answer.channels,
            answer.bitrate,
            answer.ok ? 1 : 0,
            answer.err,
            'ffprobe',
            PROBE_METHOD,
          );

          if (answer.ok) {
            counters.durations += 1;

            // Kept, and named. ffprobe answered where this stage could not, which
            // for an mp3 means one stating no frame count — so ffprobe had none
            // to read and derived the length from the size and the bitrate. The
            // number is worth having and is not a measurement, and this is the
            // only place that knows which. `info`, not `warn`: the collection is
            // not damaged by it and nothing needs doing.
            insertIssue.run(
              latestRun,
              STAGE,
              file.root_id,
              file.rel_path,
              'tag-duration-estimated',
              'info',
              'the frame walk lost the stream; the length kept is the one ffprobe worked out from the file size and bitrate, not one the file states',
            );
            counters.issues += 1;
          } else {
            insertIssue.run(
              latestRun,
              STAGE,
              file.root_id,
              file.rel_path,
              'tag-duration-refused',
              'warn',
              `the frame walk lost the stream, and ffprobe could not measure it either: ${answer.err ?? 'no reason given'}`,
            );
            counters.issues += 1;
          }
        }
      }
    });
  }
  // The record's documentation: an `.nfo`, an EAC `.log`.
  //
  // These are read for the same reason a song is — the meta layer should not
  // lose what a file says — and they are read *here* because this is the stage
  // that opens bytes and keeps an account of what it made of them: the
  // encoding, the confidence in it, and a row of its own for a document it
  // could not open. A sidecar whose bytes are never looked at is a hole in that
  // account, and there were 417 of them: `file.encoding` was NULL for every
  // one, while 41 FLAC rips in the same library carry their `.log` and `.cue`
  // as tags *inside* the file. The container was deciding whether the record's
  // documentation existed at all (task:2757).
  //
  // What is *not* done with the text is worth saying, because it was tried and
  // withdrawn: it is not a tracklist (`task:2711` — that was a way around a
  // broken ID3v2.2 reader, and the tags were there all along). Nothing here
  // derives a name, a year or a credit from a log. The text goes to the schema
  // and the refusals reach the dump; a consumer that wants more than that
  // should say so as a task of its own.
  //
  // Read outside the transaction like the songs, and it is the larger of the two
  // reads: a sidecar is a whole document, up to fifteen kilobytes of it, where a
  // song is a metadata chain.
  const sidecars = selectSidecarDue.all(latestRun, TAGS_METHOD) as unknown as DueFile[];
  const readSidecars = new Map<number, ReturnType<typeof decodeText> | Error>();
  for (const sidecar of sidecars) {
    try {
      readSidecars.set(sidecar.id, decodeText(readWhole(join(sidecar.root_path, sidecar.rel_path))));
    } catch (err) {
      readSidecars.set(sidecar.id, err as Error);
    }
  }

  // Written the same way, and for the same reason.
  for (let at = 0; at < sidecars.length; at += FILES_PER_TRANSACTION) {
    const batch = sidecars.slice(at, at + FILES_PER_TRANSACTION);
    withTransaction(db, () => {
      for (const sidecar of batch) {
        clearIssues(db, STAGE, { rootId: sidecar.root_id, relPath: sidecar.rel_path });

        const decoded = readSidecars.get(sidecar.id);
        if (decoded === undefined || decoded instanceof Error) {
          // Unstamped, like a song that could not be opened, and for the same
          // reason: the next run should try again rather than file the failure as
          // the answer.
          clearStamp.run(sidecar.id);
          insertIssue.run(
            latestRun,
            STAGE,
            sidecar.root_id,
            sidecar.rel_path,
            'sidecar-unreadable',
            'warn',
            decoded instanceof Error ? decoded.message : 'the sidecar was not read',
          );
          counters.sidecarFailures += 1;
          continue;
        }

        stampSidecar.run(
          decoded.encoding,
          decoded.confidence,
          latestRun,
          TAGS_METHOD,
          sidecar.id,
        );
        upsertSidecar.run(sidecar.id, decoded.text);
        counters.sidecars += 1;

        // A document that declared nothing and had to be guessed at is a finding
        // about the file, exactly as it is for a tag — and the value is kept
        // either way, so what is reported is the uncertainty and not a loss.
        if (decoded.confidence < 1) {
          insertIssue.run(
            latestRun,
            STAGE,
            sidecar.root_id,
            sidecar.rel_path,
            'sidecar-encoding-guessed',
            'info',
            decoded.basis ?? `${decoded.encoding} was inferred`,
          );
          counters.encodings += 1;
        }
      }
    });
  }

  // ── What the stage says about the collection as a whole ──────────────────
  //
  // In a transaction of its own, and after every file: the year below is read
  // off `file_tag`, so it can only be worked out once the tags are written.
  withTransaction(db, () => {

    // The year, for a record whose folder name did not state one.
    //
    // A folder is what a collector writes, so where it names a year that is the
    // year; where it does not, the files' own DATE is the only thing that says
    // anything, and until v1.5 brings an external source it is the best answer
    // there is. Counted over the whole collection rather than over the files
    // this run opened, like the format count below and for the same reason: the
    // rows are read off `file_tag`, which a previous run wrote, and a number
    // that depended on which files this run happened to open would change
    // without anything changing.
    //
    // The four digits are checked rather than taken: a DATE is `1988`, or
    // `1988-05-06`, or a timestamp, and a value that does not open with a year
    // is not one — `substr` of something else would file a record under a year
    // that appears nowhere in it.
    // The relation is the record's own, and it has two arms because a record is
    // keyed on two different things.
    //
    // An ordinary album *is* a folder, and the files whose tags say when it came
    // out are the ones in it. But a disc of a flat multi-disc release is keyed
    // on its **image** — `…/01. On The Beach.mp3` is that row's `rel_path`,
    // because the folder holds several discs and belongs to none of them — so
    // for that row the file *is* the record and its own path names it. With the
    // folder arm alone that row matched nothing: two ASOT records held no year
    // while every file in them stated `2025-03-28`.
    //
    // It cannot go through `track`, which is what the obvious version of this
    // query would do — tracks are made by the cue stage, which runs after this
    // one, so at this point in the chain there is nothing to join through.
    //
    // The second arm costs the first nothing: no file's path equals the path of
    // the folder holding it, so a folder-keyed record can never match it.
    const dated = db
      .prepare(
        `UPDATE album
            SET year = (SELECT CAST(substr(ft.value, 1, 4) AS INTEGER)
                          FROM file f JOIN file_tag ft ON ft.file_id = f.id
                         WHERE f.root_id = album.root_id
                           AND (f.folder_rel_path = album.rel_path OR f.rel_path = album.rel_path)
                           AND ft.name IN ('date', 'year')
                           AND substr(ft.value, 1, 4) GLOB '[12][0-9][0-9][0-9]'
                         ORDER BY f.rel_path, ft.name
                         LIMIT 1),
                year_source = 'tag'
          WHERE year IS NULL
            AND EXISTS (SELECT 1
                          FROM file f JOIN file_tag ft ON ft.file_id = f.id
                         WHERE f.root_id = album.root_id
                           AND (f.folder_rel_path = album.rel_path OR f.rel_path = album.rel_path)
                           AND ft.name IN ('date', 'year')
                           AND substr(ft.value, 1, 4) GLOB '[12][0-9][0-9][0-9]')`,
      )
      .run();
    counters.years = Number(dated.changes);

    // Formats nothing here can read, counted per root and extension. A `m4a` is
    // a third of some collections and yields no tags and no duration; that is
    // information about the collection rather than a defect in one file, and it
    // is stated once per extension so that 309 files are a finding and not 309
    // findings. Keyed by root too, because an issue with no root cannot be found
    // in the dump.
    //
    // Counted over the whole collection rather than over the files this run
    // opened, so that it is the same number on any run: what is on disk is what
    // makes it true, and reading a file is not. That is why the reader's verdict
    // is kept on the file (`tags_container`, migration 012) — a verdict that
    // lives only in the run dies with it, and the count then became "one file",
    // the one this run happened to open, beside an older row saying something
    // else (task:2706). Replaced rather than added to, like the row it is.
    clearIssues(db, STAGE, { kind: 'tag-format-unknown' });

    const unknownFormats = db
      .prepare(
        `SELECT root_id AS root_id, ext AS ext, COUNT(*) AS n, MIN(rel_path) AS rel_path
           FROM file
          WHERE kind = 'audio' AND tags_read_run_id IS NOT NULL AND tags_container IS NULL
          GROUP BY root_id, ext
          ORDER BY root_id, ext`,
      )
      .all() as { root_id: number; ext: string; n: number; rel_path: string }[];

    for (const format of unknownFormats) {
      insertIssue.run(
        latestRun,
        STAGE,
        format.root_id,
        format.rel_path,
        'tag-format-unknown',
        'info',
        `${format.n} .${format.ext} file(s) the reader does not recognise: no tags, no duration`,
      );
      counters.issues += 1;
    }

    // The rows this stage stands behind are not only the ones it wrote this run.
    // A file the ledger did not report changed is never re-read, and its report
    // describes the last read — which is still true, and which the dump has to
    // see. Stamping them as this run's is what says so: `inventory` reads the
    // run it describes, and a row left on an earlier run's id is a row the
    // reader is never shown. Re-reading the file to say nothing new is the other
    // way to close that gap, and it is the one incrementality exists to avoid
    // (task:2726).
    //
    // What may be claimed that way is not a matter of taste: the stamp says the
    // run stands behind the file — `file.last_seen_run_id`, the same stamp the
    // sweep judges rows by, and the meaning of it is spelled out at the query
    // above. So a row moves only for a file this run stands behind. A file that
    // is gone, and a file of a root this run did not visit, are neither, and a
    // diagnosis of one has no business in its report (task:2751). Unguarded, the
    // row rode into every later run: the dump named a path that was in neither
    // the walk nor `file`, while `unaccounted` read 0/0/0 beside it.
    //
    // A row about a file that is gone is left where it is rather than deleted.
    // Nothing reads an old run, the file may come back, and the sweep is not
    // this stage's to extend.
    //
    // Only rows that describe a file, which is the whole of what this stage
    // derives. A row about the stage itself — the `tags-failed` `run.ts` writes
    // — carries no path, is an event rather than a derivation, and is scoped to
    // the attempt that made it on purpose: a later run that succeeds is what
    // supersedes it, and restamping would keep it in the report forever.
    //
    // The count goes with the stamp: the report totals what the stages say they
    // filed, the dump totals the rows of the run, and a number that moves on one
    // side only is the same lie in a smaller place. Rows already carrying this
    // run's id are left out of the statement so they are not counted twice.
    const restamped = db
      .prepare(
        `UPDATE issue SET scan_run_id = ?
          WHERE stage = ? AND rel_path IS NOT NULL AND scan_run_id <> ?
            AND EXISTS (
              SELECT 1 FROM file f
               WHERE f.root_id = issue.root_id
                 AND f.rel_path = issue.rel_path
                 AND f.last_seen_run_id = ?
            )`,
      )
      .run(latestRun, STAGE, latestRun, latestRun);
    counters.issues += Number(restamped.changes);

  });

  return counters;
}
