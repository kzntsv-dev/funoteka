import type { DatabaseSync } from '../db/index.ts';
import * as store from '../playlist/store.ts';
import { ID, parseId, required, seconds, songChild } from './browse.ts';
import type { ServerConfig } from './config.ts';
import { ApiError, ERROR } from './envelope.ts';
import { knownTrackIds, songsOfPlaylist } from './meta.ts';
import type { Payload } from './router.ts';

/**
 * Playlists, in the protocol's shapes.
 *
 * The one part of this API that is not a reading of the collection. A playlist
 * is what the listener said about the music rather than what the music is, and
 * it is the only thing here a client can create — which makes three of these
 * five routes the only routes in the whole API that write (the writes
 * themselves are `playlist/store.ts`).
 *
 * The protocol's own split of that surface is kept as it is: `getPlaylists` is
 * the list a client draws a sidebar from and carries no songs, `getPlaylist` is
 * one playlist with its entries, and `createPlaylist` doubles as the update
 * when it is handed an id — which is the protocol's design and not a shortcut
 * taken here.
 */

/**
 * The id a playlist is named by.
 *
 * A `pl:` prefix like every other id this API hands out, and deliberately *not*
 * added to `KINDS` in `browse.ts`: that set is the tree — artists, albums,
 * tracks, folders, roots — and a playlist is not a branch of it. An id from
 * here is therefore refused by `getSong` and `getMusicDirectory` as naming
 * nothing, which is the true answer, while the routes below read it themselves.
 *
 * Digits only, rather than whatever `Number` accepts: `pl:1e3` and `pl:0x10`
 * would otherwise read as ids this server may never have handed out — and the
 * one thing an id from here is allowed to be is one that was handed out. The
 * refusals are the same either way; what the strict reading buys is that they
 * are always true.
 */
function playlistIdOf(raw: string): number {
  // **Both separators are read, and this is where that promise was broken
  // first.** `parseId` reads a colon and a hyphen; this compared against the
  // prefix *constant*, so when the constant changed the old spelling stopped
  // being recognised — and a client holding a playlist id from before was told
  // there is no such playlist, while the commit that changed the separator said
  // nothing would be orphaned (found by asking both spellings of a real
  // playlist, task:2896).
  const digits = /^pl[-:]/.test(raw) ? raw.slice(3) : '';
  if (!/^\d+$/.test(digits)) throw new ApiError(ERROR.notFound, `No such playlist: ${raw}`);
  return Number(digits);
}

/**
 * The playlist an id names, or a refusal.
 *
 * Every route but the listing has one of these, and all three spell the
 * protocol's not-found code rather than answering about a playlist that is not
 * there. An id that was never handed out by this server is the same answer as
 * one whose playlist was deleted: the client's question has no subject.
 */
function requiredPlaylist(db: DatabaseSync, raw: string): store.PlaylistRow {
  const row = store.playlist(db, playlistIdOf(raw));
  if (row === undefined) throw new ApiError(ERROR.notFound, `No such playlist: ${raw}`);
  return row;
}

/**
 * A playlist the listener may change — which a file's is not.
 *
 * Refused rather than allowed-and-later-undone, and the refusal is the only
 * honest answer available: the row is re-derived from its `.m3u` on every scan
 * that re-reads the file, so an edit would last until the next scan and a
 * deletion would be undone by the scan after it. A client that lost a rename
 * that way would have no way to tell it from its own bug — and the answer it
 * gets here says which file owns the list, which is also what it takes to
 * change it.
 *
 * The code is the protocol's "not authorized", which is what this is: the
 * caller is authenticated, and this particular list is not theirs to change.
 */
function requiredEditable(db: DatabaseSync, raw: string): store.PlaylistRow {
  const row = requiredPlaylist(db, raw);
  if (row.source_file_id !== null) {
    throw new ApiError(
      ERROR.notAuthorized,
      `This playlist is read from a file in the collection, and a scan rebuilds it: ${raw}`,
    );
  }
  return row;
}

/**
 * Every value of a repeated parameter, as song ids.
 *
 * `songId` and `songIdToAdd` arrive the protocol's way — the name repeated once
 * per song — so reading only the first would silently build a playlist one song
 * long. An empty value is dropped rather than refused: `songId=` is a client
 * with nothing to add, which is not an error.
 *
 * The refusal and the existence check below it say the same sentence, and that
 * is on purpose — from a client's side "that is not a song id" and "that song
 * is not here" are one answer about one parameter.
 */
function trackIdsIn(query: URLSearchParams, name: string): number[] {
  return query
    .getAll(name)
    .filter((raw) => raw !== '')
    .map((raw) => {
      const parsed = parseId(raw);
      if (parsed === undefined || parsed.kind !== 'tr') {
        throw new ApiError(ERROR.notFound, `No such song: ${raw}`);
      }
      return parsed.n;
    });
}

/**
 * Songs that exist, or a refusal naming the first that does not.
 *
 * Answered once for the whole call instead of per id, and the refusal is the
 * point: a playlist quietly shorter than the request is one the client cannot
 * tell from the playlist it asked for, and the song that went missing would
 * only surface when somebody played the list through.
 */
function requireKnown(db: DatabaseSync, ids: readonly number[]): void {
  const known = knownTrackIds(db, ids);
  for (const id of ids) {
    if (!known.has(id)) throw new ApiError(ERROR.notFound, `No such song: ${ID.track(id)}`);
  }
}

/**
 * Positions in a playlist, as the client sent them.
 *
 * A position is what the client is holding — it reads them out of the answer to
 * `getPlaylist` — so a negative one names nothing. It is refused rather than
 * ignored: a client that computed `-1` has a bug, and the alternative is a
 * playlist that silently kept a song it was told to drop.
 *
 * The code is the generic one, which is what `browse.ts` and `genre.ts` answer
 * with for a parameter that is not the number it should be — a client reading
 * the code learns the same thing from either.
 */
function positionsIn(query: URLSearchParams, name: string): number[] {
  return query
    .getAll(name)
    .filter((raw) => raw !== '')
    .map((raw) => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new ApiError(ERROR.generic, `${name} is not a position: ${raw}`);
      }
      return n;
    });
}

/** The protocol's booleans, which arrive as `true` or `false`. */
function booleanish(raw: string): boolean {
  const value = raw.toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * A playlist in the protocol's shape, without its songs.
 *
 * What `getPlaylists` answers with, and the half `getPlaylist` adds `entry` to.
 * The two therefore cannot disagree about a name, a length or a timestamp —
 * they are one object, read once.
 */
function asPlaylist(row: store.PlaylistRow, config: ServerConfig): Payload {
  return {
    id: ID.playlist(row.id),
    name: row.name,
    ...(row.comment === null ? {} : { comment: row.comment }),
    // The one account this server has. Kept in the answer because the protocol
    // makes it a field of a playlist and a client draws it beside the name.
    owner: config.user,
    public: row.public === 1,
    // OpenSubsonic's own field, and the protocol's rule for one of its own
    // additions: a server that supports it sends it even when it has nothing to
    // say, so a client can tell "editable" from "this server has never heard of
    // the question".
    //
    // False for the listener's own playlists — the one account here owns those —
    // and true for one read from a `.m3u` in the collection. That is not a
    // restriction invented here: the file is what that list *is*, the stage
    // rewrites the row from it on every scan that re-reads it, and an edit a
    // client was allowed to make would be undone by a scan nobody asked for.
    // A client that is told so can grey the controls out instead of losing work.
    readonly: row.source_file_id !== null,
    songCount: row.song_count,
    duration: seconds(row.duration_ms),
    created: row.created_at,
    changed: row.changed_at,
    // The picture is the first song's, in this answer and in the listing alike
    // — the protocol lets a server name the cover with any id `getCoverArt`
    // answers to, and an id of the playlist's own would need `getCoverArt`
    // taught a second kind of subject to say what this says already. An empty
    // playlist is handed no picture rather than an id for a cover that does not
    // exist.
    ...(row.cover_track_id === null
      ? {}
      : {
          coverArt:
            row.cover_album_id === null ? ID.track(row.cover_track_id) : ID.album(row.cover_album_id),
        }),
  };
}

/** A playlist and its songs, which is what opening one asks for. */
function withSongs(row: store.PlaylistRow, db: DatabaseSync, config: ServerConfig): Payload {
  const id = ID.playlist(row.id);
  return {
    ...asPlaylist(row, config),
    entry: songsOfPlaylist(db, row.id).map((song) => songChild(song, id)),
  };
}

/**
 * The playlists a client lists, without their songs.
 *
 * `username` is the protocol's filter, and this server has exactly one account:
 * the configured one owns every playlist. A name that is not that one is
 * answered with an empty list rather than an error — the question is "what does
 * this user have", and the true answer is nothing, since no other user exists
 * to have anything.
 */
export function getPlaylists(
  db: DatabaseSync,
  config: ServerConfig,
  query: URLSearchParams,
): Payload {
  const username = query.get('username');
  const mine = username === null || username === '' || username === config.user;

  return {
    playlists: {
      playlist: (mine ? store.playlists(db) : []).map((row) => asPlaylist(row, config)),
    },
  };
}

/** One playlist with its songs, by the id `getPlaylists` handed out. */
export function getPlaylist(db: DatabaseSync, config: ServerConfig, query: URLSearchParams): Payload {
  const raw = required(query, 'id');
  return { playlist: withSongs(requiredPlaylist(db, raw), db, config) };
}

/**
 * A new playlist — or, handed an id, the replacement of an existing one.
 *
 * The protocol folds the two into one method, and the difference is one
 * parameter — but **what an id does to the songs already there, the
 * documentation does not say.** "Creates (or updates) a playlist" is the whole
 * of it, and no client is told which of the two it will get.
 *
 * This server replaces them, because that is what the call means to the client
 * that makes it: a player saving a playlist sends the list it has on screen,
 * and a server that appended instead would make a song impossible to take out
 * of a playlist by the one route that saves one. A client adding a single song
 * has `updatePlaylist` for that, and says so by asking for it.
 *
 * **A call that names no songs at all is not a call that names none.** The
 * protocol's own criterion for this feature tells renaming apart from emptying,
 * and a client that renames sends an id and a name and nothing else; reading
 * its silence as "the list is now empty" would throw the listener's songs away
 * while answering `ok`, and the client would have no way to tell. So the songs
 * are replaced only when the parameter is there, and a client that means to
 * empty a playlist says so — `songId=` is that statement, and so is
 * `updatePlaylist` with every position removed.
 *
 * `name` is required only when there is no id — a playlist with no name cannot
 * be told from another in the sidebar a client draws, and a call that omits it
 * is refused by name rather than given one. With an id it is optional, and a
 * name the client did not send stays where it was.
 */
export function createPlaylist(
  db: DatabaseSync,
  config: ServerConfig,
  query: URLSearchParams,
): Payload {
  const songs = trackIdsIn(query, 'songId');
  requireKnown(db, songs);

  const rawId = query.get('playlistId');
  if (rawId !== null && rawId !== '') {
    const row = requiredPlaylist(db, rawId);
    const asked = query.get('name');
    const name = asked === null || asked === '' ? row.name : asked;
    // Only when the client said something about the songs — see above.
    const written = store.replace(db, row.id, name, query.has('songId') ? songs : undefined);
    return { playlist: withSongs(written, db, config) };
  }

  const name = required(query, 'name');
  return { playlist: withSongs(store.create(db, name, songs), db, config) };
}

/**
 * A partial edit: rename, re-comment, add songs, drop songs.
 *
 * The two song arguments are applied with the removals first, because a
 * position names a place in the list the client is holding — see `store.edit`
 * for what the protocol does and does not say about that.
 *
 * A field the client did not send is left alone, and an empty one is left alone
 * too **except for the comment**: a name of nothing is not a name a client can
 * have meant to give, and neither is a visibility of nothing, while an empty
 * comment is exactly how a client takes a comment off a playlist. That one is
 * stored as no comment rather than as a comment that reads empty — the two look
 * the same in a client's sidebar and only one of them is true.
 */
export function updatePlaylist(
  db: DatabaseSync,
  config: ServerConfig,
  query: URLSearchParams,
): Payload {
  const row = requiredEditable(db, required(query, 'playlistId'));

  const add = trackIdsIn(query, 'songIdToAdd');
  requireKnown(db, add);

  const name = query.get('name');
  const comment = query.get('comment');
  const isPublic = query.get('public');

  store.edit(db, row.id, {
    ...(name === null || name === '' ? {} : { name }),
    ...(comment === null ? {} : { comment: comment === '' ? null : comment }),
    ...(isPublic === null || isPublic === '' ? {} : { public: booleanish(isPublic) }),
    add,
    remove: positionsIn(query, 'songIndexToRemove'),
  });

  return {};
}

/**
 * A playlist, gone — the songs it named are untouched.
 *
 * A second call for the same id is refused as naming nothing, for the reason
 * every other route refuses one: the client is told its question had no
 * subject, which is truer than an `ok` about a deletion that did not happen.
 */
export function deletePlaylist(db: DatabaseSync, query: URLSearchParams): Payload {
  const row = requiredEditable(db, required(query, 'id'));
  store.remove(db, row.id);
  return {};
}
