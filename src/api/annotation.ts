import * as annotations from '../annotation/store.ts';
import { withTransaction, type DatabaseSync } from '../db/index.ts';
import { albumChild, albumId3, artistId3, childOf, confinedTo, ID, parseId } from './browse.ts';
import { ApiError, ERROR } from './envelope.ts';
import {
  album,
  albumsById,
  artist,
  artistIdsInRoot,
  artistsById,
  songsByIds,
  song,
} from './meta.ts';
import type { Payload } from './router.ts';

/**
 * What the listener marked, in the protocol's shapes.
 *
 * The second set of routes that write — playlists are the first — and the same
 * kind of thing: a statement about the music that no file states and no scan can
 * rebuild. What it is *about*, though, is the collection, so a mark goes with
 * the row it is on and nothing here has to clean up after a deleted record.
 *
 * The two halves of the protocol live here together: the methods that set the
 * marks, and the listings that show them. A client that stars a song and one
 * that draws a star are looking at the same row of the same table.
 */

/**
 * The protocol's three prefixes, and what each of them marks.
 *
 * `id` — the parameter `star`, `unstar` and `setRating` all take — names a
 * *subject*, and the protocol's own words for it are "the file (song) or folder
 * (album/artist)": which of the three it is comes from the id itself, not from
 * the parameter. The two named parameters beside it (`albumId`, `artistId`)
 * exist for clients that would rather say it outright.
 */
const MARKS: Record<string, annotations.Kind> = { tr: 'track', al: 'album', ar: 'artist' };

/**
 * The subject an id names, or nothing — and the *row's* id, not the one asked
 * with.
 *
 * That second half is the point of going through the model here rather than
 * taking the id apart and keeping it: `album` resolves a record through its
 * group, so a client that holds a box's second disc id — which is what every
 * client did while the discs were the albums — is answered about the record,
 * and the mark has to land on the row the listings read. `browse.ts` makes the
 * same distinction for the same reason ("the record's own id, not the one that
 * was asked with").
 */
function subjectOf(db: DatabaseSync, raw: string): { kind: annotations.Kind; id: number } | null {
  const parsed = parseId(raw);
  const kind = parsed === undefined ? undefined : MARKS[parsed.kind];
  if (parsed === undefined || kind === undefined) return null;

  const found =
    kind === 'track'
      ? song(db, parsed.n)
      : kind === 'album'
        ? album(db, parsed.n)
        : artist(db, parsed.n);
  return found === undefined ? null : { kind, id: found.id };
}

/**
 * Every subject the request names, checked before anything is written.
 *
 * The protocol spells a batch as the parameter repeated — `id` once per song —
 * and a client starring an album's worth of songs sends exactly that. Each is
 * resolved against the model first, and the whole batch is written in one
 * transaction after: a call naming one song that is not here changes nothing
 * rather than half of what it named, and a call naming forty does not pay forty
 * commits — measured on the live database, forty stars written one at a time
 * held this single-threaded server for **2967 ms**, against 21 ms for the same
 * forty inside one transaction.
 */
function mark(db: DatabaseSync, query: URLSearchParams, setting: boolean): void {
  const named = new Map<string, [annotations.Kind, number]>();

  // **The three parameters are read as one, and that is a decision.** The
  // protocol distinguishes them — `id` for "a song, album or artist", `albumId`
  // and `artistId` for clients that browse by tags — and this server's ids
  // already say which kind they are, so the parameter a client chose adds
  // nothing to the question. It used to be *enforced*, though: `albumId` had to
  // name an album, and a client that put a track id there was refused with "No
  // such album" — and refused as a whole call, so the track it named in `id` was
  // never starred and its heart never appeared.
  //
  // That is measured, not imagined: Castafiore sends `id`, `albumId` and
  // `artistId` all set to the same value, and starring from it did nothing at
  // all. One id, one entry, whichever parameter carried it.
  for (const name of ['id', 'albumId', 'artistId']) {
    for (const raw of query.getAll(name)) {
      if (raw === '') continue;
      const subject = subjectOf(db, raw);
      if (subject === null) throw new ApiError(ERROR.notFound, `No such id: ${raw}`);
      named.set(`${subject.kind}:${subject.id}`, [subject.kind, subject.id]);
    }
  }

  // A call that named nothing is refused rather than answered `ok`: a client
  // that lost its id on the way has not marked anything, and telling it that it
  // did leaves it showing a star nobody set.
  if (named.size === 0) {
    throw new ApiError(ERROR.missingParameter, 'Required parameter is missing: id');
  }

  withTransaction(db, () => {
    for (const [kind, id] of named.values()) {
      if (setting) annotations.star(db, kind, id);
      else annotations.unstar(db, kind, id);
    }
  });
}

export function star(db: DatabaseSync, query: URLSearchParams): Payload {
  mark(db, query, true);
  return {};
}

export function unstar(db: DatabaseSync, query: URLSearchParams): Payload {
  mark(db, query, false);
  return {};
}

/**
 * A rating from one to five — and nought, which is the protocol's way of saying
 * there is none.
 *
 * Refused outside that range rather than clamped: a client that asked for seven
 * has a bug, and storing five would tell it the number it sent was taken. The
 * parameter is required, so a call that names no rating is refused by name
 * rather than treated as zero — "set this to nothing" and "I forgot to say" are
 * different requests, and only one of them should clear a rating.
 *
 * The subject is whatever `id` names, the same three kinds `star` takes: the
 * documentation of this method says "file (song) or folder (album/artist)", and
 * a rating a client can set but never read back would be a control that does
 * nothing.
 */
export function setRating(db: DatabaseSync, query: URLSearchParams): Payload {
  const raw = query.get('rating');
  if (raw === null || raw === '') {
    throw new ApiError(ERROR.missingParameter, 'Required parameter is missing: rating');
  }

  const rating = Number(raw);
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
    throw new ApiError(ERROR.generic, `rating is not a number from 0 to 5: ${raw}`);
  }

  const subject = subjectOf(db, query.get('id') ?? '');
  if (subject === null) {
    throw new ApiError(ERROR.notFound, `No such id: ${query.get('id') ?? ''}`);
  }

  annotations.setRating(db, subject.kind, subject.id, rating);
  return {};
}

/**
 * The starred songs, records and artists, from one music folder if a client
 * asked for one.
 *
 * The folder is the protocol's own filter, and it is honoured the way every
 * other listing in this API honours it — through `confinedTo`, which refuses a
 * folder this server never handed out. A starred listing that accepted the
 * parameter and answered from every folder would tell a client it was looking
 * at one library while showing it another.
 *
 * Records are filtered by where they are, and songs by the root their file
 * lives in. An artist is nobody's to place — one artist's records can sit in
 * several folders — so they are kept when the folder asked about holds a record
 * of theirs, which is the only sense in which an artist is in a folder.
 */
function starred(
  db: DatabaseSync,
  query: URLSearchParams,
  withSongs: boolean,
  origin: string,
): Payload {
  const rootId = confinedTo(db, query);

  const songs = songsByIds(db, annotations.starredIds(db, 'track')).filter(
    (row) => rootId === undefined || row.root_id === rootId,
  );
  const records = albumsById(db, annotations.starredIds(db, 'album')).filter(
    (row) => rootId === undefined || row.root_id === rootId,
  );

  const performerIds = annotations.starredIds(db, 'artist');
  const inRoot = rootId === undefined ? null : artistIdsInRoot(db, performerIds, rootId);
  const performers = artistsById(db, inRoot === null ? performerIds : performerIds.filter((id) => inRoot.has(id)));

  const child = (row: (typeof songs)[number]): Payload =>
    childOf(row);

  return withSongs
    ? {
        starred2: {
          artist: performers.map((row) => artistId3(row, origin)),
          album: records.map(albumId3),
          song: songs.map(child),
        },
      }
    : {
        starred: {
          // The v1 shapes: an `Artist` is a name and an id, and a record is a
          // `Child`. The same three readings, told the older way.
          artist: performers.map((row) => ({
            id: ID.artist(row.id),
            name: row.name,
            ...(row.starred_at === null ? {} : { starred: row.starred_at }),
            ...(row.rating === null ? {} : { userRating: row.rating }),
          })),
          album: records.map((row) => albumChild(row, ID.top)),
          song: songs.map(child),
        },
      };
}

export function getStarred(db: DatabaseSync, query: URLSearchParams, origin: string): Payload {
  return starred(db, query, false, origin);
}

export function getStarred2(db: DatabaseSync, query: URLSearchParams, origin: string): Payload {
  return starred(db, query, true, origin);
}
