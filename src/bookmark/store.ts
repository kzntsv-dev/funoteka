import type { DatabaseSync } from '../db/index.ts';

/**
 * Where the listener stopped, per song.
 *
 * The fourth part of the listener's own layer and the smallest: one row per
 * song somebody paused in, with the position they paused at. Playlists are what
 * they arranged, stars what they thought, plays what they did — and this is how
 * far they got, which is the one of the four that is answered by a single
 * number and a single song.
 *
 * **One place per song**, keyed by the track and with no id of its own, because
 * that is what the protocol says a bookmark is ("if a bookmark already exists
 * for this file it will be overwritten") and because two resume points for one
 * audio book is a client with no way to choose. So the write below is an upsert
 * and not an insert, and there is no way to make a second one.
 */

/** One bookmark, as the table holds it. */
export interface BookmarkRow {
  trackId: number;
  positionMs: number;
  comment: string | null;
  createdAt: string;
  changedAt: string;
}

/**
 * Every bookmark, most recently moved first.
 *
 * Ordered by when it was last touched rather than by the song: a list of where
 * somebody stopped is a list of the things they are in the middle of, and the
 * one they are furthest into is the one they last listened to.
 */
export function bookmarks(db: DatabaseSync): BookmarkRow[] {
  return db
    .prepare(
      `SELECT track_id    AS trackId,
              position_ms AS positionMs,
              comment     AS comment,
              created_at  AS createdAt,
              changed_at  AS changedAt
         FROM bookmark
        ORDER BY changed_at DESC, track_id`,
    )
    .all() as unknown as BookmarkRow[];
}

/**
 * Put the mark on a song, or move the one that is there.
 *
 * `created_at` survives a second write and `changed_at` does not: moving a
 * bookmark is not making one, and a client that shows "added" beside a list of
 * bookmarks would be told something untrue about every mark its user has
 * adjusted.
 *
 * **The comment is written as given, and a write that names none clears the
 * one that was there** — which is the protocol's rule for this method and not
 * the one playlists follow. `updatePlaylist` treats a missing song list as
 * silence because a client renaming a playlist means to keep its songs; here
 * the protocol says the bookmark "will be overwritten", and a client that
 * updates the position and drops the comment has said what the mark now is.
 * The difference is worth the sentence because the other rule is the one this
 * project would reach for by habit.
 */
export function bookmark(
  db: DatabaseSync,
  trackId: number,
  positionMs: number,
  comment: string | null,
  at: string,
): void {
  db.prepare(
    `INSERT INTO bookmark (track_id, position_ms, comment, created_at, changed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (track_id) DO UPDATE SET
       position_ms = excluded.position_ms,
       comment     = excluded.comment,
       changed_at  = excluded.changed_at`,
  ).run(trackId, positionMs, comment, at, at);
}

/**
 * Take the mark off a song. Nothing to take off is not an error.
 *
 * One statement and no transaction around it, which is `playlist/store.ts`'s
 * `remove` as well: a lone `DELETE` is its own transaction, and a `withTransaction`
 * here would be a wrapper that says something is being kept together when
 * nothing is.
 */
export function unbookmark(db: DatabaseSync, trackId: number): void {
  db.prepare('DELETE FROM bookmark WHERE track_id = ?').run(trackId);
}
