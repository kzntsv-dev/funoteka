import { withTransaction, type DatabaseSync } from '../db/index.ts';

/**
 * What the listener marked: a star, a rating, or both.
 *
 * The second half of the listener's own layer — playlists are the first — and
 * it writes nothing the collection knows about. Nothing on disk says what
 * somebody thought of a record, so no scan touches this; what a scan *does* do
 * is delete rows of the model, and an annotation goes with the row it is about
 * through the cascade (`028_annotations.sql`).
 *
 * Three tables, one per kind of subject, because a foreign key cannot be
 * polymorphic. That is the whole of the duplication, and it is named once —
 * here, in the table below. The API knows the three protocol prefixes that
 * *address* those subjects (`tr:`, `al:`, `ar:`), which is a different thing
 * that happens to have the same length.
 *
 * **A row exists while it says something.** Unstarring what has no rating
 * deletes the row rather than leaving two NULLs behind, so a reader can take
 * the presence of a row as the presence of something — and the questions below
 * stay simple because of it.
 */

/** What a star or a rating can be about. The protocol has these three. */
export type Kind = 'track' | 'album' | 'artist';

const SUBJECTS: Record<Kind, { table: string; column: string }> = {
  track: { table: 'track_annotation', column: 'track_id' },
  album: { table: 'album_annotation', column: 'album_id' },
  artist: { table: 'artist_annotation', column: 'artist_id' },
};

/**
 * The mark on one subject, or nothing when there is none.
 *
 * Starring twice keeps the first date: a client that re-sends what it already
 * said has not changed when it said it, and a timestamp that moved on every
 * sync would be a `starred` a client keeps re-reading.
 */
export function star(db: DatabaseSync, kind: Kind, id: number): void {
  const { table, column } = SUBJECTS[kind];
  db.prepare(
    `INSERT INTO ${table} (${column}, starred_at, rating) VALUES (?, ?, NULL)
     ON CONFLICT (${column}) DO UPDATE SET starred_at = COALESCE(${table}.starred_at, excluded.starred_at)`,
  ).run(id, new Date().toISOString());
}

/**
 * Take the star off, and leave the rating alone.
 *
 * The two are independent in the protocol — a client may rate without starring
 * and unstar without unrating — so this clears one field and then drops the row
 * only if that left it saying nothing.
 */
export function unstar(db: DatabaseSync, kind: Kind, id: number): void {
  const { table, column } = SUBJECTS[kind];
  withTransaction(db, () => {
    db.prepare(`UPDATE ${table} SET starred_at = NULL WHERE ${column} = ?`).run(id);
    db.prepare(`DELETE FROM ${table} WHERE ${column} = ? AND rating IS NULL`).run(id);
  });
}

/**
 * Set the rating — zero means "no rating", which is the protocol's own spelling.
 *
 * Refused outside 1..5 by the caller (`api/annotation.ts`), not clamped here: a
 * rating of 7 is a client with a bug, and quietly storing 5 would tell it the
 * number it sent was accepted.
 */
export function setRating(db: DatabaseSync, kind: Kind, id: number, rating: number): void {
  const { table, column } = SUBJECTS[kind];
  withTransaction(db, () => {
    if (rating <= 0) {
      db.prepare(`UPDATE ${table} SET rating = NULL WHERE ${column} = ?`).run(id);
    } else {
      db.prepare(
        `INSERT INTO ${table} (${column}, starred_at, rating) VALUES (?, NULL, ?)
         ON CONFLICT (${column}) DO UPDATE SET rating = excluded.rating`,
      ).run(id, rating);
    }
    db.prepare(
      `DELETE FROM ${table} WHERE ${column} = ? AND rating IS NULL AND starred_at IS NULL`,
    ).run(id);
  });
}

/**
 * Everything starred of one kind, most recently starred first.
 *
 * The order is the protocol's suggestion and the only one that means anything
 * here: a starred list is a list of what somebody liked lately, and the
 * timestamps are the only thing the table says about when.
 */
export function starredIds(db: DatabaseSync, kind: Kind): number[] {
  const { table, column } = SUBJECTS[kind];
  return (
    db
      .prepare(
        `SELECT ${column} AS id FROM ${table}
          WHERE starred_at IS NOT NULL
          ORDER BY starred_at DESC, ${column}`,
      )
      .all() as unknown as { id: number }[]
  ).map((row) => row.id);
}
