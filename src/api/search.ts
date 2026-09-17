import type { DatabaseSync } from '../db/index.ts';
import { matchExpression } from '../search/query.ts';
import {
  albumsById,
  artistsById,
  root,
  searchAlbumIds,
  searchArtistIds,
  searchSongs,
  type SearchPage,
} from './meta.ts';
import { albumId3, artistId3, childOf, confinedTo, parseId } from './browse.ts';
import { ApiError, ERROR } from './envelope.ts';
import type { Visibility } from './visibility.ts';

/**
 * The library, searched.
 *
 * Three sections answer one query — artists, albums and songs — and they do not
 * answer it the same way. An artist and an album are *found through* the songs
 * that match, so a query for a title answers with the record it is on and who
 * made it, which is what a client showing a search result actually needs: the
 * user typed a song and is being offered a place to play it from.
 *
 * The counts are small on purpose and the protocol's own default is kept. A
 * client shows a handful of each and asks again with an offset when the user
 * scrolls, so a server that answered with everything would put the library on
 * the wire to have nineteen twentieths of it thrown away.
 */

/**
 * The protocol's default page, per section.
 *
 * Its own number and not the listing route's ten: a search is the one call a
 * client makes on every keystroke, and the two methods were given different
 * defaults by the protocol for that reason.
 */
const DEFAULT_COUNT = 20;

/** The ceiling a client cannot raise, so one call cannot ask for the collection. */
const MAX_COUNT = 500;

function count(query: URLSearchParams, name: string): number {
  const raw = query.get(name);
  if (raw === null || raw === '') return DEFAULT_COUNT;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ApiError(ERROR.generic, `${name} is not a whole number: ${raw}`);
  }
  // Zero is a page of no rows and not a missing page: `songCount=0` is a client
  // asking for artists only, and clamping it up to one — which is what the
  // listing route does with its own page size — answers with a song nobody
  // asked for.
  return Math.min(Math.max(value, 0), MAX_COUNT);
}

function offset(query: URLSearchParams, name: string): number {
  const raw = query.get(name);
  if (raw === null || raw === '') return 0;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ApiError(ERROR.generic, `${name} is not a whole number: ${raw}`);
  }
  return Math.max(value, 0);
}

export function search3(
  db: DatabaseSync,
  query: URLSearchParams,
  visibility: Visibility,
  origin: string,
): Record<string, unknown> {
  const rootId = confinedTo(db, query);

  // The protocol calls `query` required, and the empty one is the exception that
  // matters: a client's first sync asks `search3?query=` and expects the library
  // back. So a missing query and an empty one are the same request, and both
  // mean "everything" — see `SearchPage`.
  const words = matchExpression(query.get('query') ?? '');

  const page = (prefix: string): SearchPage => ({
    match: words,
    size: count(query, `${prefix}Count`),
    offset: offset(query, `${prefix}Offset`),
    ...(rootId === undefined ? {} : { rootId }),
    visibility,
  });

  return {
    searchResult3: {
      // The sections are always present, empty ones included: a client that
      // reads a missing section and an empty one differently would otherwise
      // have to guess which this server meant.
      // Each section resolves its whole page in one query. Asking per id was a
      // separate execution of the album select — which carries the genre window
      // table — for every row returned, so a page of 250 cost about two seconds.
      // The sections were never slow to *find* their rows; they were slow to
      // look them up one at a time.
      artist: artistsById(db, searchArtistIds(db, page('artist'))).map((row) =>
        artistId3(row, origin),
      ),
      album: albumsById(db, searchAlbumIds(db, page('album'))).map(albumId3),
      song: searchSongs(db, page('song')).map((row) =>
        childOf(row),
      ),
    },
  };
}
