import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import { withTransaction, type DatabaseSync } from '../db/index.ts';
import { clearIssues, type Stage } from '../db/issue.ts';
import { ledgerEntry, moved } from '../db/ledger.ts';
import { decodeText } from '../text/encoding.ts';
import { basenameOf, stemOf } from '../util/names.ts';
import { parseEntries, readingOf } from './files.ts';
import * as store from './store.ts';

/**
 * The playlist files the collection carries, read and weighed.
 *
 * A `.m3u` is either the album it sits beside or a list somebody made, and
 * `files.ts` decides which — this stage is where that decision meets the meta
 * layer. The two outcomes are handled very differently on purpose:
 *
 *   - **redundant** (every entry in one folder) is *ignored*, and an issue says
 *     so. The folder tree already offers that music; importing it would list
 *     every album in the library a second time, under a name a client shows
 *     beside real playlists.
 *   - **curated** becomes a playlist, found by the file it came from rather
 *     than by its name, so reading the same file again updates that playlist
 *     instead of making another one. The row keeps the file it came from, which
 *     is also what tells the API that this playlist is the file's and not the
 *     listener's (`playlist/store.ts`).
 *
 * A file that stops being curated takes its playlist with it, and so does one
 * that stops naming anything this library holds: the list is the file's, and a
 * row left behind by a file that no longer asks for it is a list the collection
 * does not have. So does a file that is deleted, through the cascade on
 * `playlist.source_file_id`.
 *
 * **What is measured on this collection:** of 27 playlist files, all 27 name
 * songs from one folder each and not one reaches outside the folder it sits in.
 * The curated branch is therefore the one this library never exercises — which
 * is why it is the branch the tests do.
 */

/** This stage's name in `issue.stage`. Bound to the insert and to the clear. */
const STAGE: Stage = 'playlists';

export interface PlaylistFileCounters {
  /** Files this stage took up: format checked, then read or read from cache. */
  files: number;
  /**
   * How many of those had to be read off disk.
   *
   * Counted apart from `files` because they answer different questions: a
   * second scan over an unchanged collection takes up every file and reads none
   * of them, and "27 file(s) read" would hide the cache doing its job — it is
   * the number a reader checks exactly that claim with.
   */
  filesRead: number;
  redundant: number;
  curated: number;
  /** Playlists written: made, or rewritten because what the file says changed. */
  imported: number;
  /** Curated files whose playlist already said exactly what the file says. */
  unchanged: number;
  /** Entries of a curated list that named no song this library holds. */
  entriesMissing: number;
  unreadable: number;
  issues: number;
}

export interface ImportDeps {
  /** Swappable so a test needs no files on disk. */
  readBytes?: (absPath: string) => Uint8Array;
}

interface PlaylistFileRow {
  id: number;
  rel_path: string;
  root_id: number;
  root_path: string;
  ext: string;
  cached_text: string | null;
  /** 1 when the ledger says the file moved, 0 or NULL when it did not. */
  moved: number | null;
}

/**
 * Read the collection's playlist files, and import the ones that are lists.
 *
 * Runs after `cues`, and that is not a preference: an imported playlist names
 * songs, and songs exist only once the cue stage has written them.
 *
 * The whole pass is one transaction, like every other stage that writes: it
 * reads a file, asks several questions of the meta layer and writes what it
 * concluded, and a scan that fell over halfway through should leave none of it
 * behind. Measured on the live meta layer, a hundred writes outside a
 * transaction cost 4452 ms against 74 ms inside one — the stage that reads
 * every playlist in a collection is not the place to pay that again.
 */
export function applyPlaylists(db: DatabaseSync, deps: ImportDeps = {}): PlaylistFileCounters {
  const counters: PlaylistFileCounters = {
    files: 0,
    filesRead: 0,
    redundant: 0,
    curated: 0,
    imported: 0,
    unchanged: 0,
    entriesMissing: 0,
    unreadable: 0,
    issues: 0,
  };

  const latest = db.prepare('SELECT MAX(id) AS id FROM scan_run').get() as { id: number | null };
  if (latest.id === null) return counters;

  const readBytes = deps.readBytes ?? ((absPath: string) => readFileSync(absPath));

  // Every playlist file of this run is taken up on every run, and its *bytes*
  // are read only when there are none kept or the ledger says they moved — the
  // same rule the tag stage follows for the record's documentation, and the same
  // table: `sidecar_text` holds what the bytes said, so a playlist in CP1251 is
  // decoded once.
  //
  // Taken up every time on purpose, and that is not the same question. A `.m3u`
  // that did not change still describes a *library* that may have: a song it
  // names can be deleted, and the playlist imported from it should lose that
  // song. Skipping the files the ledger calls unmoved would leave the playlist
  // holding what the collection no longer has, which is the one thing an
  // imported list must never do. Re-reading the text is what the cache saves;
  // the verdict is reached again from it, and nothing is written unless it
  // changed (see `sameSongs`).
  const due = db
    .prepare(
      `SELECT f.id, f.rel_path, f.root_id, r.path AS root_path, f.ext,
              st.text AS cached_text, ${moved('ss')} AS moved
         FROM file f
         JOIN root r ON r.id = f.root_id
         LEFT JOIN scan_state ss ON ${ledgerEntry('f', 'ss')}
         LEFT JOIN sidecar_text st ON st.file_id = f.id
        WHERE f.kind = 'playlist' AND f.last_seen_run_id = ?
        ORDER BY f.root_id, f.rel_path`,
    )
    .all(latest.id) as unknown as PlaylistFileRow[];

  const upsertText = db.prepare(
    `INSERT INTO sidecar_text (file_id, text) VALUES (?, ?)
     ON CONFLICT (file_id) DO UPDATE SET text = excluded.text`,
  );
  const stampEncoding = db.prepare(
    'UPDATE file SET encoding = ?, encoding_confidence = ? WHERE id = ?',
  );

  // A path may be spelled with either separator, and the meta layer holds the
  // forward one (`scan/walk.ts` normalises it there). Case is folded on Windows
  // and not elsewhere, because that is what the two filesystems do — a list that
  // says `01.FLAC` names the file on one and not on the other.
  const samePath = process.platform === 'win32' ? 'COLLATE NOCASE' : '';
  const fileIdOf = db.prepare(
    `SELECT f.id AS id FROM file f WHERE f.root_id = ? AND f.rel_path = ? ${samePath}`,
  );
  const songsOfFile = db.prepare(
    `SELECT t.id AS id FROM track t JOIN file f ON f.id = t.file_id
      WHERE f.root_id = ? AND f.rel_path = ? ${samePath}
      ORDER BY t.ordinal, t.id`,
  );
  const nameTaken = db.prepare(
    `SELECT 1 AS taken FROM playlist
      WHERE name = ? AND (source_file_id IS NULL OR source_file_id <> ?)`,
  );
  const isTaken = (name: string, fileId: number): boolean =>
    nameTaken.get(name, fileId) !== undefined;

  const insertIssue = db.prepare(
    `INSERT INTO issue (scan_run_id, stage, root_id, rel_path, kind, severity, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const complain = (row: PlaylistFileRow, kind: string, severity: string, detail: string): void => {
    insertIssue.run(latest.id, STAGE, row.root_id, row.rel_path, kind, severity, detail);
    counters.issues += 1;
  };

  withTransaction(db, () => {
    for (const row of due) {
      clearIssues(db, STAGE, { rootId: row.root_id, relPath: row.rel_path });

      // The one format this does not read. `.pls` is a different document — an
      // INI with numbered `FileN=` keys — and pretending otherwise would be
      // worse than saying so: a `.pls` read as an `.m3u` yields no entries at
      // all, and "redundant" would be the answer to a question nobody asked.
      if (row.ext !== 'm3u' && row.ext !== 'm3u8') {
        complain(row, 'playlist-format-not-read', 'info', `.${row.ext} is not read`);
        continue;
      }

      let text = row.cached_text;
      if (text === null || row.moved === 1) {
        try {
          const decoded = decodeText(readBytes(join(row.root_path, row.rel_path)));
          text = decoded.text;
          counters.filesRead += 1;
          upsertText.run(row.id, text);
          stampEncoding.run(decoded.encoding, decoded.confidence, row.id);
          if (decoded.confidence < 1) {
            complain(
              row,
              'playlist-encoding-guessed',
              'info',
              decoded.basis ?? `${decoded.encoding} was inferred`,
            );
          }
        } catch (err) {
          counters.unreadable += 1;
          complain(row, 'playlist-unreadable', 'warn', (err as Error).message);
          continue;
        }
      }

      // Counted here rather than at the top of the loop: a `.pls` was taken up
      // and refused, and a file that would not open was not read at all — the
      // report says "read", and this is the number that keeps that word true.
      counters.files += 1;

      const folder = dirname(join(row.root_path, row.rel_path));
      const entries = parseEntries(text);
      const reading = readingOf(entries, folder);

      // Both verdicts need this: a redundant list is only *the folder* if its
      // entries are the folder's files, and one carried from another machine
      // names nothing here — calling that "already offered by the folder" would
      // be a false account of a list that was quietly dropped.
      const songs: number[] = [];
      let missing = 0;
      for (const path of reading.paths) {
        const rel = within(row.root_path, path);
        if (rel === null) {
          missing += 1;
          continue;
        }
        const found = fileIdOf.get(row.root_id, rel) as { id: number } | undefined;
        if (found === undefined) {
          missing += 1;
          continue;
        }
        if (reading.verdict === 'curated') {
          for (const song of songsOfFile.all(row.root_id, rel) as { id: number }[]) songs.push(song.id);
        }
      }

      if (reading.verdict === 'redundant') {
        store.removeBySourceFile(db, row.id);
        counters.redundant += 1;
        complain(
          row,
          'playlist-redundant',
          'info',
          missing > 0
            ? `${reading.entries} entries in ${reading.folders} folder${reading.folders === 1 ? '' : 's'}, ${missing} of them naming nothing here — the folder already offers this`
            : `${reading.entries} entries in ${reading.folders} folder${reading.folders === 1 ? '' : 's'} — the folder already offers this`,
        );
        continue;
      }

      counters.curated += 1;
      counters.entriesMissing += missing;
      if (missing > 0) {
        complain(
          row,
          'playlist-entries-missing',
          'warn',
          `${missing} of ${entries.length} entries name no song in this library`,
        );
      }

      if (songs.length === 0) {
        // Curated by where it points, but nothing in it lands here — a list made
        // on another machine, or one whose music was never scanned. An empty
        // playlist would be a promise this library cannot keep, and one left over
        // from a previous reading of this file would be a list it no longer says.
        store.removeBySourceFile(db, row.id);
        complain(
          row,
          'playlist-nothing-imported',
          'warn',
          `no entry of ${entries.length} names a song here`,
        );
        continue;
      }

      const name = nameFor(row, isTaken);
      const existing = store.bySourceFile(db, row.id);

      if (existing === undefined) {
        store.create(db, name, songs, row.id);
        counters.imported += 1;
      } else if (existing.name !== name || !sameSongs(db, existing.id, songs)) {
        store.replace(db, existing.id, name, songs);
        counters.imported += 1;
      } else {
        // The file says what the playlist already says. Writing it again would
        // move `changed_at`, and a client that syncs by that stamp would re-read
        // a playlist because a scan ran — the same reasoning as `store.edit`'s
        // silence when nothing changes.
        counters.unchanged += 1;
      }

      complain(
        row,
        'playlist-imported',
        'info',
        `${songs.length} songs from ${reading.folders} folders`,
      );
    }

  });

  return counters;
}

/** Whether a playlist already holds exactly these songs, in this order. */
function sameSongs(db: DatabaseSync, playlistId: number, songs: readonly number[]): boolean {
  const held = store.entriesOf(db, playlistId);
  return held.length === songs.length && held.every((id, at) => id === songs.at(at));
}

/**
 * What to call an imported playlist.
 *
 * The file's own name, and the folder it sits in when that name is already
 * taken by another playlist. Two `a.m3u` in two folders are two lists, and a
 * sidebar showing `a` twice is a sidebar where one of them cannot be chosen —
 * the same argument the project settled for records whose names collide
 * ([[wiki:3602]]). The name is not the identity here either: the row is found
 * by its file, and this is only what a person reads.
 */
function nameFor(row: PlaylistFileRow, isTaken: (name: string, fileId: number) => boolean): string {
  const stem = stemOf(basename(row.rel_path));
  if (!isTaken(stem, row.id)) return stem;

  const parent = basenameOf(dirname(row.rel_path));
  return parent === '' ? stem : `${stem} (${parent})`;
}

/**
 * Where a path lies inside the root, in the spelling the meta layer uses — or
 * nothing, when it lies outside it.
 *
 * Outside is not a failure of the list: a curated playlist made elsewhere may
 * name music this library does not have, and those entries are counted and
 * reported rather than resolved into a path that cannot exist. `..odd.flac`
 * inside the root is a file, though, and is not confused with `../odd.flac` —
 * hence the separator rather than a bare prefix test.
 *
 * The collection has more than one root, and this stage asks about one at a
 * time: a list may name music that lives under *another* root of the same
 * collection, and that entry is reported as unmatched. Doing better means
 * resolving against every root, which is a change to make when a collection
 * actually has a `.m3u` that reaches across its own roots — measured on this
 * one, none does.
 */
function within(rootPath: string, absPath: string): string | null {
  const rel = relative(rootPath, absPath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || /^[a-z]:/i.test(rel)) return null;
  return rel.split('\\').join('/');
}
