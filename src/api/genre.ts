import type { DatabaseSync } from '../db/index.ts';
import { childOf, required } from './browse.ts';
import { ApiError, ERROR } from './envelope.ts';
import { genres, songsByGenre } from './meta.ts';
import type { Payload } from './router.ts';
import type { Visibility } from './visibility.ts';

/**
 * The genres, which are the one thing a Subsonic client asks for that this
 * server had nothing to answer with.
 *
 * The meta layer has held them since the first scan — every file's `genre` tag
 * is a row in `file_tag`, and there are 2338 of them over 159 values — but no
 * route ever read one. A client asking `getGenres` was told the method did not
 * exist and drew an empty list, which is what "the collection has no genres"
 * looks like from the outside. It had them all along.
 *
 * There is no genre *table* here and this does not add one. A genre is what a
 * file states, the same way a title is, and a table would be a second place for
 * it to be true — with the first one still being the file. What is derived is
 * the two counts a client wants beside each name, and they are derived on the
 * request rather than stored.
 */

/** The protocol's own ceiling on a page, matching the album and song listings. */
const MAX_PAGE = 500;

/**
 * How many songs `getSongsByGenre` returns when the client does not say.
 *
 * **The protocol's own number and its own parameter name**, which is `count` and
 * not `size` — the sibling listing route uses `size`, and this method does not.
 * The first version of this read `size` and defaulted to a hundred, which meant
 * a client asking for `count=50` was quietly given whatever this server felt
 * like: a caller who names an argument and is not obeyed has been lied to, and
 * the lie is invisible from either side.
 */
const DEFAULT_COUNT = 10;

function numeric(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ApiError(ERROR.generic, `${name} is not a whole number: ${raw}`);
  }
  return value;
}

/**
 * Every genre the collection states, with how many songs and records state it.
 *
 * No paging, and no `size`/`offset` honoured: the protocol defines neither for
 * this method, and a client shows the whole list in a sidebar. 159 entries is
 * what this collection has; a list an order of magnitude larger would be a
 * collection with a problem rather than this route's.
 */
export function getGenres(db: DatabaseSync, visibility: Visibility = 'records'): Payload {
  return {
    genres: {
      genre: genres(db, visibility).map((row) => ({
        value: row.value,
        songCount: row.song_count,
        albumCount: row.album_count,
      })),
    },
  };
}

/**
 * The songs one genre names.
 *
 * The genre is taken as the file states it, trimmed the way the list trims it —
 * so a client can hand back a value it was given and get the songs that value
 * came from, which is the whole contract between these two methods.
 */
export function getSongsByGenre(
  db: DatabaseSync,
  query: URLSearchParams,
  visibility: Visibility = 'records',
): Payload {
  const genre = required(query, 'genre');
  // `count`, which is this method's own name for the argument — the sibling
  // listing route calls it `size`, and a server that answered the wrong one
  // would look to a client exactly like a server that ignored it.
  const count = Math.min(Math.max(numeric(query, 'count', DEFAULT_COUNT), 1), MAX_PAGE);
  const offset = Math.max(numeric(query, 'offset', 0), 0);

  return {
    songsByGenre: {
      song: songsByGenre(db, genre, count, offset, visibility).map((row) =>
        childOf(row),
      ),
    },
  };
}

