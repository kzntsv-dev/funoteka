import { ApiError, ERROR } from './envelope.ts';
import type { Payload } from './router.ts';

/**
 * The surface this server answers and does not fill.
 *
 * Everything here is a method a client may ask for, answered **empty by form**
 * rather than refused (requirements:47, «Заглушки»). The difference is not
 * cosmetic: a client that gets `unknown method` shows an error, retries, or
 * decides this server is not Subsonic at all — while a client that gets a
 * well-formed empty answer draws an empty list and carries on. Which of the two
 * a client does with the six methods it calls on startup is the difference
 * between a library that opens and a library that does not.
 *
 * **Every shape below is the specification's, not a guess.** Each was read from
 * the endpoint's own page in `opensubsonic/open-subsonic-api`
 * (`content/en/docs/Endpoints/<Name>.md`) — which names the element a method
 * answers with, and, where an example exists, its fields. The rule the project
 * keeps for the protocol applies here as everywhere: the spec is the source and
 * a shape recalled is a shape invented. The two places the spec is silent are
 * called out at the entry itself rather than filled in quietly.
 *
 * **What a stub is not.** It is not a claim that the server does something. The
 * reads here answer "nothing" and mean it; the *writes* — `createShare`,
 * `deleteUser`, `changePassword` — answer `ok` and change nothing, which is a
 * lie of shape rather than of content, and it is the one the contract asked for
 * by name. `wiki:3639` records what that costs: nothing in this collection is
 * reachable through those methods, and a client that believes it created a share
 * finds no share. The alternative — refusing — is what the contract rejects, and
 * it lands on the same client that a missing method lands on.
 */

/** An answer whose whole content is that there is none. */
const nothing: Payload = {};

/**
 * A listing that holds nothing.
 *
 * The child array is *present and empty* rather than absent, and that is the
 * point of the whole module: a client reading `topSongs.song` and finding no
 * field at all is a client reading a shape it does not recognise, while one
 * reading `[]` is a client reading a list of none.
 */
const none = (container: string, child: string): Payload => ({ [container]: { [child]: [] } });

/**
 * A stub's answer: fixed, or built from the question where the shape depends on
 * it — which is the jukebox and nothing else.
 */
export type Stub = Payload | ((query: URLSearchParams) => Payload);

/**
 * What each method answers, keyed by the name the client asks with.
 *
 * The comments name what the method would hold if this server had it, because a
 * reader of this file is deciding what to build next, and the list is the map of
 * that.
 */
export const STUBBED: ReadonlyMap<string, Stub> = new Map<string, Stub>([
  // Words about the music, which this server does not hold. The protocol has two
  // shapes for them — the flat `lyrics` of 1.2.0 and the structured list of the
  // OpenSubsonic extension — and both are answered, because a client asks by
  // version, not by what this server would prefer.
  ['getlyrics', { lyrics: {} }],
  ['getlyricsbysongid', none('lyricsList', 'structuredLyrics')],

  // Reviews and biographies from an external service. This server reads no
  // external service (`requirements:47`, «Норма»), so there is nothing to say —
  // and `getArtistInfo2`, which is about the *collection*, is answered for real
  // beside these.
  ['getalbuminfo', { albumInfo: {} }],
  ['getalbuminfo2', { albumInfo: {} }],
  ['getartistinfo', { artistInfo: {} }],

  // Recomendations. Similarity needs a corpus this server does not compute, and
  // the sonic path needs fingerprints.
  ['getsimilarsongs', none('similarSongs', 'song')],
  ['getsimilarsongs2', none('similarSongs2', 'song')],
  ['gettopsongs', none('topSongs', 'song')],
  ['getsonicsimilartracks', { sonicMatch: [] }],
  ['findsonicpath', { sonicMatch: [] }],

  // Podcasts: a channel, its episodes, and the fetches that keep them current.
  //
  // `downloadPodcastEpisode` is here and **not** among the byte-answering stubs,
  // which its name invites a reader to get wrong — a review axis did. What it
  // does is ask the server to *start* downloading, and the specification says
  // so in its own words: «Request the server to start downloading a given
  // Podcast episode», and «An empty `subsonic-response` element on success».
  // The episode is not the answer; the answer is that the request was taken.
  ['getpodcasts', none('podcasts', 'channel')],
  ['getnewestpodcasts', none('newestPodcasts', 'episode')],
  ['getpodcastepisode', { podcastEpisode: {} }],
  ['refreshpodcasts', nothing],
  ['createpodcastchannel', nothing],
  ['deletepodcastchannel', nothing],
  ['deletepodcastepisode', nothing],
  ['downloadpodcastepisode', nothing],

  // Internet radio: a station is a URL and a name, and this server holds none.
  ['getinternetradiostations', none('internetRadioStations', 'internetRadioStation')],
  ['createinternetradiostation', nothing],
  ['updateinternetradiostation', nothing],
  ['deleteinternetradiostation', nothing],

  // Chat between listeners of one server. There is one listener.
  ['getchatmessages', none('chatMessages', 'chatMessage')],
  ['addchatmessage', nothing],

  // Video: the collection is music, and `getCaptions` below is where the
  // captions of a video that does not exist would go.
  ['getvideos', none('videos', 'video')],
  ['getvideoinfo', { videoInfo: {} }],

  // Shares: a public link to a record. Nothing here is shared.
  ['getshares', none('shares', 'share')],
  ['createshare', none('shares', 'share')],
  ['updateshare', nothing],
  ['deleteshare', nothing],

  // Accounts. `getUser` and `getUsers` beside these both answer for real — the
  // one account this server has, and a list holding it — and the *management* is
  // what is stubbed, which is the contract's line (requirements:47, «Заглушки»).
  // `getUsers` was a stub here too until the operator read the two answers side
  // by side and said which one was wrong; `wiki:3640` records it.
  ['createuser', nothing],
  ['updateuser', nothing],
  ['deleteuser', nothing],
  ['changepassword', nothing],

  // The protocol's first generation, kept for clients that never moved on. Each
  // is the same question as a method this server answers properly — `getAlbumList`
  // against `getAlbumList2`, `search`/`search2` against `search3` — asked in a
  // shape that cannot carry what the collection holds (no `byYear`, no artist
  // credit, no OpenSubsonic fields). Answering emptily is honest here in a way it
  // is not for the modern ones, and it is still better than a client reading
  // "unknown method".
  //
  // `searchResult` is the one shape the specification does **not** define:
  // `Responses/searchResult.md` is a stub of its own, and the endpoint page's
  // example is `// TODO`. The three fields are the legacy v1 ones, and an empty
  // `match` is what a client reads either way.
  ['getalbumlist', none('albumList', 'album')],
  ['search', { searchResult: { offset: 0, total: 0, match: [] } }],
  ['search2', { searchResult2: { artist: [], album: [], song: [] } }],

  // The one entry whose answer depends on what was asked — see `jukebox`.
  ['jukeboxcontrol', jukebox],
]);

/**
 * The jukebox, which is the one stub whose shape depends on what was asked.
 *
 * Declared before the map that holds it so the entry reads as one list; a
 * function declaration hoists, and the reference is resolved when the map is
 * built.
 *
 * `action=get` returns the playlist and every other action returns the status
 * (the specification's own words: «jukeboxStatus for all actions but get,
 * jukeboxPlaylist for get»). A single empty payload would be wrong for one of
 * the two, and a client that called `get` and was handed a status has been told
 * the queue is empty in a field it will not look at. The status is the honest
 * one for a machine that is not playing anything.
 */
function jukebox(query: URLSearchParams): Payload {
  const status = { currentIndex: 0, playing: false, gain: 1, position: 0 };
  return query.get('action') === 'get'
    ? { jukeboxPlaylist: { ...status, entry: [] } }
    : { jukeboxStatus: status };
}

/**
 * The payload for a stubbed method, or undefined when the name is not one.
 *
 * Folded rather than kept beside the table because it is the same answer with
 * one exception, and a second lookup in `router.ts` would be a second place to
 * forget that the jukebox reads its question.
 */
export function stubPayload(method: string, query: URLSearchParams): Payload | undefined {
  const entry = STUBBED.get(method);
  if (entry === undefined) return undefined;
  return typeof entry === 'function' ? entry(query) : entry;
}

/**
 * The methods that answer with *bytes* rather than with an envelope, and why
 * there are no bytes.
 *
 * `пусто по форме` has no form here: the protocol's answer to these is an image,
 * a caption file or a playlist, and an empty one of those is not an answer — a
 * zero-byte image is a broken picture, where a client expects a picture or a
 * refusal and handles both. The specification says so itself: `getAvatar`
 * «returns the avatar image in binary form on success, or an XML document on
 * error», and `hls` likewise. So the refusal is the protocol's, in the
 * protocol's language, and it is not the "unknown method" a client cannot act
 * on.
 */
export const STUBBED_BYTES: ReadonlyMap<string, string> = new Map<string, string>([
  ['getavatar', 'this server keeps no avatars'],
  ['getcaptions', 'this server holds no video, so there are no captions'],
  ['hls', 'this server does not produce HLS'],
]);

/** The refusal a byte-answering stub throws, before any header is written. */
export function stubRefusal(reason: string): ApiError {
  return new ApiError(ERROR.notFound, reason);
}
