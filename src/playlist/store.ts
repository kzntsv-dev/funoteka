import { withTransaction, type DatabaseSync } from '../db/index.ts';

/**
 * Playlists, and who owns which of them.
 *
 * Two kinds of row live in the same two tables and they have two different
 * authors, which is the whole of what a reader has to know before touching one:
 *
 *   - **The listener's**, written by the API: a statement about the music that
 *     lives nowhere on disk. Nothing else writes these.
 *   - **A file's**, imported by the playlist stage from a `.m3u` in the
 *     collection (`playlist/import.ts`): the row is a reading of that file, and
 *     the file is what the list *is*. A scan rewrites it from the file, and the
 *     API refuses to edit or delete it — see below.
 *
 * `source_file_id` is the field that tells them apart: `NULL` is the listener's
 * and a file id is that file's. It is not decoration, and the two rules that
 * hang off it are the reason this module has a doc comment at all:
 *
 *   1. An imported row is rewritten on every scan that re-reads its file, so an
 *      edit made through the API would survive exactly until the next scan. The
 *      API therefore does not accept one, and says so (`api/playlist.ts`).
 *   2. The row is the file's, so the file's removal takes it — through the
 *      cascade, and through the stage when a file stops being a list.
 *
 * What this module does *not* read is the collection. A playlist's songs are
 * read in `api/meta.ts` with every other song, by the same select, so a song in
 * a playlist is the same song as everywhere else — and the question this module
 * has about the collection, whether a track exists, is asked there too.
 *
 * Order is the whole of the domain here. `position` is a sequence laid out from
 * zero by every write, because the protocol addresses entries by index —
 * `songIndexToRemove` is a position — so every mutation below finishes by
 * writing the order it left behind rather than trusting the arithmetic of the
 * one before it. A song dropped by the cascade leaves its number unused until
 * the next write; nothing reads the number as a position, only as an order.
 */

/**
 * The number the next playlist gets.
 *
 * Read and moved on in the same transaction as the insert that uses it, so two
 * callers cannot be handed the same number. See migration 025 for why the
 * number comes from a table of its own rather than from the rows it numbers.
 */
function nextId(db: DatabaseSync): number {
  const row = db.prepare('SELECT next FROM playlist_sequence WHERE only_row = 1').get() as {
    next: number;
  };
  db.prepare('UPDATE playlist_sequence SET next = ? WHERE only_row = 1').run(row.next + 1);
  return row.next;
}

/** One playlist without its songs: what a client lists. */
export interface PlaylistRow {
  id: number;
  name: string;
  comment: string | null;
  /**
   * The `.m3u` this playlist was read from, or nothing when it is the
   * listener's — see the module comment. Read by the API to refuse an edit and
   * to tell a client which kind it is holding.
   */
  source_file_id: number | null;
  /** SQLite's own boolean: 0 or 1. See the migration for why it is kept at all. */
  public: number;
  created_at: string;
  changed_at: string;
  song_count: number;
  duration_ms: number | null;
  /**
   * The record the playlist is pictured by, or nothing when it holds no songs.
   *
   * The *first* song's record, which is the one a client would draw — see
   * `cover_album_id` beside it for the songs that are on no record at all.
   */
  cover_album_id: number | null;
  cover_track_id: number | null;
}

/**
 * When the playlist last moved, touched by every mutation that changes it.
 *
 * Reads and writes share the value: `changed_at` is written by the same
 * statement that writes the change, so a client syncing by it can never see a
 * change without the stamp that announces it.
 */
const TOUCH = 'changed_at = ?';

/**
 * Everything a playlist is, with the numbers and the picture a client draws
 * beside it.
 *
 * Counted over the entries rather than over distinct tracks: a song twice in one
 * playlist is two entries and two plays, and `songCount` is what the client
 * shows beside the length of the list.
 *
 * The picture is the first entry's song, and it is taken by a correlated
 * subquery — which this project has paid for once already (`ALBUM_GENRES` in
 * `api/meta.ts`) and which is allowed here for the reason it was wrong there.
 * The question is `MIN(position)` for one playlist, and the primary key of
 * `playlist_track` is `(playlist_id, position)`: the answer is the first row of
 * an index range, not a scan. Measured on 15 000 entries, a form that grouped
 * every playlist's entries before the `WHERE` could narrow anything cost
 * 5137 µs per call — against this one, which reads one index range. A playlist
 * with no entries matches nothing and is handed no picture.
 */
const PLAYLIST_SELECT = `
  SELECT p.id, p.name, p.comment, p.source_file_id, p.public, p.created_at, p.changed_at,
         COUNT(pt.track_id) AS song_count,
         SUM(t.duration_ms) AS duration_ms,
         ft.album_id AS cover_album_id,
         ft.id AS cover_track_id
    FROM playlist p
    LEFT JOIN playlist_track pt ON pt.playlist_id = p.id
    LEFT JOIN track t ON t.id = pt.track_id
    LEFT JOIN playlist_track fp ON fp.playlist_id = p.id
      AND fp.position = (SELECT MIN(first_pt.position) FROM playlist_track first_pt
                          WHERE first_pt.playlist_id = p.id)
    LEFT JOIN track ft ON ft.id = fp.track_id
`;

export function playlists(db: DatabaseSync): PlaylistRow[] {
  return db
    .prepare(
      `${PLAYLIST_SELECT}
        GROUP BY p.id
        ORDER BY p.name COLLATE NOCASE, p.id`,
    )
    .all() as unknown as PlaylistRow[];
}

export function playlist(db: DatabaseSync, id: number): PlaylistRow | undefined {
  return db
    .prepare(`${PLAYLIST_SELECT} WHERE p.id = ? GROUP BY p.id`)
    .get(id) as unknown as PlaylistRow | undefined;
}

/**
 * The entries of a playlist, in the order it holds them.
 *
 * The ids alone, because what a caller does with them is decide what to keep:
 * this is read by the mutations below, which reason about the list as a
 * sequence of tracks, and by nothing that renders.
 */
export function entriesOf(db: DatabaseSync, playlistId: number): number[] {
  return (
    db
      .prepare('SELECT track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position')
      .all(playlistId) as unknown as { track_id: number }[]
  ).map((row) => row.track_id);
}

/**
 * Write a playlist's entries as the order given.
 *
 * The one place positions are assigned, and it assigns all of them: every
 * mutation above ends here with the list it decided on, so no caller has to be
 * right about gaps, shifts or the arithmetic of a removal. Rewriting the whole
 * list is cheaper than proving an incremental update left no hole, and the
 * protocol sets no ceiling on how long a playlist may be — measured, a hundred
 * entries cost 74 ms inside the transaction that carries them.
 */
function writeEntries(db: DatabaseSync, playlistId: number, tracks: readonly number[]): void {
  db.prepare('DELETE FROM playlist_track WHERE playlist_id = ?').run(playlistId);

  const insert = db.prepare(
    'INSERT INTO playlist_track (playlist_id, position, track_id) VALUES (?, ?, ?)',
  );
  tracks.forEach((trackId, position) => insert.run(playlistId, position, trackId));
}

/**
 * A new playlist holding the songs named.
 *
 * An id that names no track never reaches here: `createPlaylist` refuses the
 * whole call when one of its `songId`s is not a song, and refusing is the point
 * — a playlist silently shorter than the request is a playlist the client
 * cannot tell from one it sent correctly, and the missing song would only show
 * up when somebody played the list through.
 *
 * The timestamps are the same instant: a playlist that was just made has not
 * been changed since it was made.
 */
export function create(
  db: DatabaseSync,
  name: string,
  tracks: readonly number[],
  sourceFileId: number | null = null,
): PlaylistRow {
  const at = new Date().toISOString();
  return withTransaction(db, () => {
    const id = nextId(db);
    db.prepare(
      `INSERT INTO playlist (id, name, comment, source_file_id, created_at, changed_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    ).run(id, name, sourceFileId, at, at);

    writeEntries(db, id, tracks);
    return written(db, id);
  });
}

/**
 * The row a write just left, read back.
 *
 * Every mutation that answers with the playlist answers with what is in the
 * table rather than with what it meant to put there — so the counts, the
 * timestamps and the entries in the answer are the ones a later `getPlaylist`
 * would give, and cannot be a calculation that disagreed with the write.
 */
function written(db: DatabaseSync, id: number): PlaylistRow {
  const row = playlist(db, id);
  if (row === undefined) throw new Error(`playlist ${id} is not there after it was written`);
  return row;
}

/**
 * Rename a playlist and, when songs are given, make them its contents.
 *
 * This is `createPlaylist` handed an id that already exists, which the protocol
 * makes the same call — see `api/playlist.ts` for why this server replaces the
 * songs and for the one case where it does not.
 *
 * `tracks` is `undefined` when the client named no songs at all, and that is not
 * the same as naming none: a call that renames a playlist carries no song list,
 * and treating its silence as "empty the playlist" would throw away everything
 * the listener put in it while answering `ok`. A client that means to empty a
 * playlist says so — it sends no song it wants kept.
 */
export function replace(
  db: DatabaseSync,
  id: number,
  name: string,
  tracks: readonly number[] | undefined,
): PlaylistRow {
  return withTransaction(db, () => {
    db.prepare(`UPDATE playlist SET name = ?, ${TOUCH} WHERE id = ?`).run(
      name,
      new Date().toISOString(),
      id,
    );
    if (tracks !== undefined) writeEntries(db, id, tracks);
    return written(db, id);
  });
}

/**
 * A partial edit: the fields the client sent, and the songs it asked to add or
 * remove.
 *
 * **The protocol does not say what the two song arguments do to each other**,
 * so what is written here is what is observable rather than what is documented:
 * a position names a place in the list the client is holding, and a song it
 * adds goes to the end — nothing in the protocol puts one anywhere else. So the
 * removals are read against the list as the client has it on screen, not as it
 * is being emptied, and the additions land after whatever survives. Read one
 * removal at a time instead, and the second of two would drop whichever song
 * had shifted into that place.
 *
 * Two removals naming the same place are one removal, which falls out of
 * removing by position rather than by step.
 *
 * Removals are applied first because the reasoning above is written in that
 * order, not because a client could tell the difference: with additions going
 * to the end, the two orders reach the same list either way.
 *
 * A call that changes nothing changes nothing — not even `changed_at`. A client
 * that syncs by that stamp would otherwise re-read a playlist because another
 * client asked a question about it.
 */
export interface Edit {
  name?: string;
  /** `null` takes the comment off, which is a thing a client asks for. */
  comment?: string | null;
  public?: boolean;
  add?: readonly number[];
  remove?: readonly number[];
}

export function edit(db: DatabaseSync, id: number, edit: Edit): void {
  const adds = edit.add !== undefined && edit.add.length > 0;
  const removes = edit.remove !== undefined && edit.remove.length > 0;
  const fields =
    edit.name !== undefined || edit.comment !== undefined || edit.public !== undefined;
  if (!adds && !removes && !fields) return;

  withTransaction(db, () => {
    let tracks = entriesOf(db, id);

    if (removes) {
      const doomed = new Set(edit.remove);
      tracks = tracks.filter((_, position) => !doomed.has(position));
    }
    if (adds) tracks = [...tracks, ...(edit.add ?? [])];

    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (edit.name !== undefined) {
      sets.push('name = ?');
      args.push(edit.name);
    }
    if (edit.comment !== undefined) {
      sets.push('comment = ?');
      args.push(edit.comment);
    }
    if (edit.public !== undefined) {
      sets.push('public = ?');
      args.push(edit.public ? 1 : 0);
    }
    sets.push(TOUCH);
    args.push(new Date().toISOString(), id);

    db.prepare(`UPDATE playlist SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    if (adds || removes) writeEntries(db, id, tracks);
  });
}

/** A playlist and its entries, gone. The songs themselves are untouched. */
export function remove(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM playlist WHERE id = ?').run(id);
}

/**
 * The playlist a file asked for, if this server has imported it.
 *
 * How an import stays one playlist: the file is what the list *is*, so the row
 * it produced is found by the file rather than by its name — a scan that reads
 * the same file again updates that row instead of making a second list with the
 * same name, and a third on the run after that.
 */
export function bySourceFile(db: DatabaseSync, fileId: number): PlaylistRow | undefined {
  return db
    .prepare(`${PLAYLIST_SELECT} WHERE p.source_file_id = ? GROUP BY p.id`)
    .get(fileId) as unknown as PlaylistRow | undefined;
}

/** The playlist a file asked for, gone — the file stopped asking for one. */
export function removeBySourceFile(db: DatabaseSync, fileId: number): void {
  db.prepare('DELETE FROM playlist WHERE source_file_id = ?').run(fileId);
}
