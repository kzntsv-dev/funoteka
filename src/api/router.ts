import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from '../db/index.ts';
import { getStarred, getStarred2, setRating, star, unstar } from './annotation.ts';
import { getArtistInfo2 } from './artistinfo.ts';
import { createBookmark, deleteBookmark, getBookmarks } from './bookmark.ts';
import {
  getAlbum,
  getAlbumList2,
  getArtist,
  getArtists,
  getIndexes,
  getMusicDirectory,
  getMusicFolders,
  getRandomSongs,
  getSong,
} from './browse.ts';
import { download } from './download.ts';
import type { ServerConfig } from './config.ts';
import { coverArt } from './cover.ts';
import { openSubsonicExtensions } from './extensions.ts';
import { getGenres, getSongsByGenre } from './genre.ts';
import {
  getNowPlaying,
  getPlayQueue,
  getPlayQueueByIndex,
  reportPlayback,
  savePlayQueue,
  savePlayQueueByIndex,
  scrobble,
} from './history.ts';
import { scanStatus } from './meta.ts';
import {
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylists,
  updatePlaylist,
} from './playlist.ts';
import { search3 } from './search.ts';
import { stream } from './stream.ts';
import { STUBBED, STUBBED_BYTES, stubPayload, stubRefusal } from './stubs.ts';
import { getTranscodeDecision, getTranscodeStream } from './transcode.ts';
import { getUser, getUsers } from './user.ts';
import type { Visibility } from './visibility.ts';

/**
 * Which method is which route.
 *
 * A route answers with the fields that go inside the envelope and nothing else:
 * it neither renders, nor decides a format, nor knows what HTTP status carries
 * its answer. What it gets in return is everything a route is allowed to depend
 * on — the meta layer, the config, and what the client asked for.
 */
export interface RouteContext {
  db: DatabaseSync;
  config: ServerConfig;
  query: URLSearchParams;
  /**
   * The request body, as the client wrote it — or nothing, for the methods that
   * have none.
   *
   * Every POST body is already read before a route runs, and for one reason: a
   * body nobody reads stays in the socket and the connection cannot be reused
   * until it is gone. What is new here is that it is *kept*: the protocol has
   * methods whose interesting half is a body rather than a query — the
   * `transcoding` extension's `ClientInfo` is the first, and it is JSON, which
   * the form-encoded merge below cannot carry.
   *
   * Raw and unparsed on purpose. A route that expects JSON parses it and owns
   * the refusal when it is not; a route that expects nothing ignores it.
   */
  body: string | null;
  /**
   * The scheme and authority the client reached this server by.
   *
   * Only `getArtistInfo2` needs it today: the protocol names an artist's
   * picture as a URL, and a client that is handed a path has to guess at the
   * host it is already talking to. It is carried here rather than derived from
   * the config because `config.host` is the address the server *bound* —
   * `0.0.0.0` on a deployed box — and that is not an address anyone can call
   * back.
   */
  origin: string;
  /**
   * What this request may be shown.
   *
   * Settled once, before any route runs, so that no listing has to decide it and
   * two listings answering the same request cannot decide it differently. See
   * `visibility.ts` for what the two answers are and how the switch is read.
   */
  visibility: Visibility;
}

export type Payload = Record<string, unknown>;

/**
 * A route may answer now or later.
 *
 * Everything here used to answer now, and the reason is worth keeping: a route
 * reads the meta layer and shapes a payload, and neither of those waits for
 * anything. `getTranscodeDecision` is the first that does — it asks the *file*
 * what codec is inside it, for the `.m4a` files whose container does not say, and
 * the answer comes from a process. Asked synchronously that reading held this
 * server for 90 ms apiece (measured, task:2898), so it is awaited and the route
 * is asynchronous; the type says so rather than leaving it to be discovered.
 */
export type Route = (context: RouteContext) => Payload | Promise<Payload>;

const ROUTES: ReadonlyMap<string, Route> = new Map<string, Route>([
  ['ping', () => ({})],

  // What this server supports, which is the one answer a client may ask for
  // without credentials — see `PUBLIC` in `server.ts`. It sits here rather than
  // near the rest because it is not about the collection at all: it is about
  // the build.
  ['getopensubsonicextensions', () => openSubsonicExtensions()],

  // A server that runs on your own hardware has no trial to expire and nothing
  // to sell, so the license is always valid. The method exists because clients
  // call it before anything else and take a refusal as "do not talk to me".
  ['getlicense', () => ({ license: { valid: true } })],

  ['getscanstatus', ({ db }) => ({ scanStatus: scanStatus(db) })],

  ['getindexes', ({ db, query, visibility }) => getIndexes(db, query, visibility)],
  ['getartists', ({ db, query, visibility, origin }) => getArtists(db, query, visibility, origin)],
  ['getmusicfolders', ({ db }) => getMusicFolders(db)],
  ['getartist', ({ db, query, visibility, origin }) => getArtist(db, query, visibility, origin)],
  ['getartistinfo2', ({ db, query, origin }) => getArtistInfo2(db, query, origin)],
  ['getalbum', ({ db, query }) => getAlbum(db, query)],
  ['getalbumlist2', ({ db, query, visibility }) => getAlbumList2(db, query, visibility)],
  ['getmusicdirectory', ({ db, query, visibility }) => getMusicDirectory(db, query, visibility)],
  ['getsong', ({ db, query }) => getSong(db, query)],
  ['getgenres', ({ db, visibility }) => getGenres(db, visibility)],
  ['getsongsbygenre', ({ db, query, visibility }) => getSongsByGenre(db, query, visibility)],
  ['search3', ({ db, query, visibility, origin }) => search3(db, query, visibility, origin)],
  ['getuser', ({ db, config, query }) => getUser(db, config, query.get('username'))],
  // The same record inside a list, which is what the protocol's plural asks for
  // and what the operator asked for when the two answers disagreed (wiki:3640).
  ['getusers', ({ db, config }) => getUsers(db, config)],

  // Something to open the app on, and a place to come back to. The first is
  // the one listing here whose answer is not the same twice.
  ['getrandomsongs', ({ db, query, visibility }) => getRandomSongs(db, query, visibility)],
  ['getbookmarks', ({ db, config }) => getBookmarks(db, config)],
  ['createbookmark', ({ db, query }) => createBookmark(db, query)],
  ['deletebookmark', ({ db, query }) => deleteBookmark(db, query)],

  // The listener's marks: the rest of the writing surface, and the same kind of
  // thing as a playlist — said about the music rather than read from it. The
  // two listings read what the three above write, and they take the protocol's
  // music-folder filter like every other listing here.
  ['star', ({ db, query }) => star(db, query)],
  ['unstar', ({ db, query }) => unstar(db, query)],
  ['setrating', ({ db, query }) => setRating(db, query)],
  ['getstarred', ({ db, query, origin }) => getStarred(db, query, origin)],
  ['getstarred2', ({ db, query, origin }) => getStarred2(db, query, origin)],

  // What the listener played, what is on, and the queue they left. The third
  // part of their own layer, and the only one that is about *time*: the rows
  // here say the collection was used, not what somebody thought of it.
  ['scrobble', ({ db, query }) => scrobble(db, query)],
  ['getnowplaying', ({ db, config }) => getNowPlaying(db, config)],
  ['reportplayback', ({ db, query }) => reportPlayback(db, query)],
  ['getplayqueue', ({ db, config }) => getPlayQueue(db, config)],
  ['saveplayqueue', ({ db, query }) => savePlayQueue(db, query)],
  // The `indexBasedQueue` extension, and the same queue: an id cannot say which
  // of two identical entries is playing, and a position can.
  ['getplayqueuebyindex', ({ db, config }) => getPlayQueueByIndex(db, config)],
  ['saveplayqueuebyindex', ({ db, query }) => savePlayQueueByIndex(db, query)],

  // The listener's playlists. Everything else here answers about a collection
  // the scanner built; these answer about what the listener said of it, and
  // three of the five write.
  ['getplaylists', ({ db, config, query }) => getPlaylists(db, config, query)],
  ['getplaylist', ({ db, config, query }) => getPlaylist(db, config, query)],
  ['createplaylist', ({ db, config, query }) => createPlaylist(db, config, query)],
  ['updateplaylist', ({ db, config, query }) => updatePlaylist(db, config, query)],
  ['deleteplaylist', ({ db, query }) => deletePlaylist(db, query)],

  // The `transcoding` extension, first half: what this server would do with a
  // song for a client that has stated what it can play. Its other half answers
  // with the stream itself and is a binary route below, because the bytes are
  // `stream`'s own — see `transcode.ts`.
  ['gettranscodedecision', (context) => getTranscodeDecision(context)],
]);

/**
 * The route for a method name, if there is one.
 *
 * The lookup lowers the name: the protocol spells its methods in camelCase, and
 * a server that answered only the exact spelling would fail a client over a
 * difference no answer depends on.
 */
export function route(method: string): Route | undefined {
  const name = method.toLowerCase();

  const answered = ROUTES.get(name);
  if (answered !== undefined) return answered;

  // What this server answers empty by form rather than refusing. Asked here
  // instead of being listed beside the real routes so that `ROUTES` above stays
  // what it reads as — the surface this server *fills* — and the two cannot be
  // confused for each other by a reader counting entries. See `stubs.ts`.
  if (STUBBED.has(name)) {
    return ({ query }) => stubPayload(name, query) ?? {};
  }
  return undefined;
}

/**
 * A route that answers with bytes.
 *
 * `stream` is the protocol's one method whose answer is not an envelope: the
 * audio itself goes back, and the status, the headers and the byte range are
 * HTTP's to settle. So it is handed the response and finishes it, rather than
 * returning a payload for the server to render.
 *
 * Everything it refuses, it refuses before writing a header — a refusal that
 * arrived after the first byte would be an error the client could not read.
 */
export type BinaryRoute = (
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

const BINARY: ReadonlyMap<string, BinaryRoute> = new Map<string, BinaryRoute>([
  ['stream', stream],
  // The same bytes as `stream` and a different promise: `stream` answers with
  // something a client can play, `download` with the file itself.
  ['download', download],
  ['getcoverart', coverArt],
  // The other half of `transcoding`: the same bytes `stream` would send, chosen
  // by the decision a client was handed rather than by parameters of its own.
  ['gettranscodestream', getTranscodeStream],
]);

export function binaryRoute(method: string): BinaryRoute | undefined {
  const name = method.toLowerCase();

  const answered = BINARY.get(name);
  if (answered !== undefined) return answered;

  // The byte-answering stubs: three methods the protocol answers with an image,
  // a caption file or a playlist, none of which this server can produce. The
  // refusal is thrown rather than written, so it goes out through the one place
  // that renders refusals — and before any header, which is the rule every
  // binary route keeps.
  const reason = STUBBED_BYTES.get(name);
  if (reason === undefined) return undefined;
  return () => {
    throw stubRefusal(reason);
  };
}

/**
 * Every method this build answers for real, envelope and bytes together.
 *
 * The two maps above are the list, and a reader counting them by hand is what
 * this exists to spare: what this server answers is the one thing it says about
 * itself that a client developer plans against, and a list kept by hand is a
 * list that goes stale. `docs/OPENSUBSONIC.md` is where it is written out for
 * them, and `test/docs-opensubsonic.test.ts` holds that page against this
 * function — so a method added to `ROUTES` fails a test until the page names it.
 *
 * The *empty* half is deliberately not here: `STUBBED` and `STUBBED_BYTES` in
 * `stubs.ts` are their own list, and the difference between the two is exactly
 * what the page has to keep apart.
 */
export function answeredMethods(): readonly string[] {
  return [...ROUTES.keys(), ...BINARY.keys()];
}
