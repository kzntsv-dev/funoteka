import { bookmark, bookmarks, unbookmark, type BookmarkRow } from '../bookmark/store.ts';
import type { DatabaseSync } from '../db/index.ts';
import { childOf, required, trackId } from './browse.ts';
import type { ServerConfig } from './config.ts';
import { ApiError, ERROR } from './envelope.ts';
import { song, songsByIds } from './meta.ts';
import type { Payload } from './router.ts';

/**
 * Where the listener stopped, in the protocol's shape.
 *
 * The smallest of the listener's own routes and the only one with a single
 * number in it: a bookmark is a song and a position inside it, and everything
 * else in the answer is either the song itself or when the mark was made.
 *
 * One place per song, which is the protocol's rule and the schema's — see
 * `bookmark/store.ts` for what that costs and why it is worth it.
 */

/**
 * The mark, as the protocol spells it.
 *
 * The entry carries the position a second time, as `bookmarkPosition`. That is
 * not redundancy to trim: the inner field is on the `Child`, and the `Child` is
 * what a client draws a resume mark from in a list of songs — a client reading
 * only `position` would have to know that the song beside it is the one it
 * belongs to.
 */
function markOf(row: BookmarkRow, entry: Payload, config: ServerConfig): Payload {
  return {
    entry: { ...entry, bookmarkPosition: row.positionMs },
    position: row.positionMs,
    username: config.user,
    // Absent rather than empty when the listener wrote none: a comment of `""`
    // is a comment whose text is nothing, and a client that draws one draws an
    // empty line under every bookmark nobody annotated.
    ...(row.comment === null ? {} : { comment: row.comment }),
    created: row.createdAt,
    changed: row.changedAt,
  };
}

export function getBookmarks(db: DatabaseSync, config: ServerConfig): Payload {
  const rows = bookmarks(db);
  const songs = songsByIds(
    db,
    rows.map((row) => row.trackId),
  );
  const byId = new Map(songs.map((row) => [row.id, row]));

  const list = rows.flatMap((row) => {
    const found = byId.get(row.trackId);
    return found === undefined ? [] : [markOf(row, childOf(found), config)];
  });

  return { bookmarks: { bookmark: list } };
}

/**
 * The position, in milliseconds, which the protocol requires.
 *
 * Refused when absent rather than read as zero: nought is the beginning of the
 * song, which is a bookmark nobody means, and a client that forgot the
 * parameter should be told it forgot rather than handed a mark at the start.
 */
function positionIn(query: URLSearchParams): number {
  const raw = required(query, 'position');
  const position = Number(raw);
  if (!Number.isInteger(position) || position < 0) {
    throw new ApiError(ERROR.generic, `position is not a position: ${raw}`);
  }
  return position;
}

/**
 * Put a mark on a song, or move the one that is there.
 *
 * A song this server does not hold is refused by name — `song` answers nothing
 * for an id that names no row — because a bookmark on a song that is not here is
 * a mark a client would never be shown again.
 */
export function createBookmark(db: DatabaseSync, query: URLSearchParams): Payload {
  // The budget this is held to is the hundred milliseconds a person notices, and
  // measured on the live database it is **64–70 ms** — which is the *commit*,
  // not the row: `star` and `unstar` pay 23–101 ms for one annotation written
  // the same way, so this is what the live file costs, not what this route adds.
  // On one thread that is every other client waiting out the write.
  //
  const id = trackId(query);
  const row = song(db, id);
  if (row === undefined) throw new ApiError(ERROR.notFound, `No such song: ${id}`);

  const comment = query.get('comment');
  bookmark(
    db,
    row.id,
    positionIn(query),
    comment === null || comment === '' ? null : comment,
    new Date().toISOString(),
  );

  return {};
}

/**
 * Take the mark off a song.
 *
 * An id that names no row is refused, and one that names a song nobody
 * bookmarked is not: the first is a client asking about a song this server does
 * not have, and the second is a client tidying up — the state it asked for is
 * the state it gets, and refusing would tell it off for succeeding. The
 * asymmetry is deliberate and it is between a *song* and a *mark*: a song this
 * server does not have is a question it cannot answer, and a mark that is not
 * there is the answer already.
 *
 * **Which of the two paths a measurement lands on is worth saying**, because
 * they are twenty times apart: the delete that removes nothing is **3–6 ms**
 * (no write happens) and the one that removes a mark is **84–87 ms** (a commit
 * does). A stand that probed the no-op would report this route as far cheaper
 * than a client experiences it.
 */
export function deleteBookmark(db: DatabaseSync, query: URLSearchParams): Payload {
  const id = trackId(query);
  const row = song(db, id);
  if (row === undefined) throw new ApiError(ERROR.notFound, `No such song: ${id}`);

  unbookmark(db, row.id);
  return {};
}
