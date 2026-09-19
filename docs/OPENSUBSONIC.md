# OpenSubsonic in funoteka

**What this server answers, what it promises, and what it does not** — the page to
read before you write anything against it.

The method names in the tables below are the method names in the router, and a test in
this repository compares the two, name for name. So *not on this page* means *not in
this build*, rather than *not written down yet*, and a method that was a stub when this
page was written is not a stub on it now.

**Ask the server, not this page.** `getOpenSubsonicExtensions` is the one method the
protocol requires to be reachable without credentials, and its answer is what a client
should really plan against:

```sh
curl -s http://your-host:4533/rest/getOpenSubsonicExtensions.view    # no u=, no p=
```

```json
{"subsonic-response":{"status":"ok","version":"1.16.1","type":"funoteka","serverVersion":"0.1.5","openSubsonic":true,"openSubsonicExtensions":[{"name":"indexBasedQueue","versions":[1]},{"name":"playbackReport","versions":[1]},{"name":"transcodeOffset","versions":[1]},{"name":"transcoding","versions":[1]},{"name":"apiKeyAuthentication","versions":[1]}]}}
```

(That is the whole answer, unwrapped from one line.) It came from this build, and two
of its fields move: `version` is the protocol version this server speaks — `1.16.1` —
while `serverVersion` is its own build number and changes with every release. Every
response carries the same envelope fields, plus `openSubsonic: true`, which is how a
client learns that the extensions below mean anything.

Everything below is read from your own files and the meta layer the scanner built
beside them. This server calls no external service — no Last.fm, no MusicBrainz, no
cover-art provider — and that is why some of the methods further down answer nothing.

---

## Endpoints this build answers

Forty-four methods, in the groups the protocol puts them in — forty answered inside the
envelope, and four that answer with bytes.

Ids are the tree's: `al-` an album, `ar-` an artist, `tr-` a song, `fd-` a folder,
`ro-` a root, `vn:` a virtual node (an artist whose records are spread over more than
one folder, named by the artist rather than by any of them), `pl-` a playlist. They are
stable across rescans, so a client may keep one.

### System

| Method | What it answers |
|---|---|
| `ping` | Always `ok`, and nothing else. How a client checks its credentials before it draws anything. |
| `getLicense` | Always `valid: true`. A server on its own hardware has no trial to expire, and clients call this before anything else and read a refusal as "do not talk to me". |
| `getMusicFolders` | The roots the server was pointed at, for a client that lets the listener pick one. |
| `getScanStatus` | What the last scan did and what a running one has counted so far. |
| `getOpenSubsonicExtensions` | The list in the section below — and the one method the protocol requires to answer without credentials. |

### Browsing

| Method | What it answers |
|---|---|
| `getIndexes` | The top of the library grouped by the letter it files under — artists, and the folder series that are not artists but are still what a listener browses. A row answers to a `vn:` or `fd:` id that `getMusicDirectory` opens. |
| `getArtists` | The same library in the ID3 shape: an `index` of artists with `albumCount`, `coverArt`, `artistImageUrl` and `roles`. |
| `getArtist` | One artist, with its albums. |
| `getArtistInfo2` | The biography kept in an `artist.nfo` inside the collection, the artist's picture, and the other artists that folder gathers. `lastFmUrl` and `musicBrainzId` are not sent: this server talks to no external service. |
| `getAlbum` | One record and its songs. A box set is a record *and* its disc-albums, and both are reachable. |
| `getMusicDirectory` | The folder tree, by folder id. |
| `getSong` | One song, by `tr-…` id. |
| `getGenres` | Genres, as the files' own tags spell them. |
| `getAlbumList2` | The listings `alphabeticalByName`, `alphabeticalByArtist`, `newest`, `random`, `starred`, `highest`, `recent`, `frequent`, `byGenre` and `byYear`. Any other `type` is refused rather than answered with an empty list. |

### Album and song lists

| Method | What it answers |
|---|---|
| `getRandomSongs` | A shuffle over the collection, with the protocol's `fromYear`/`toYear`/`genre` filters. |
| `getSongsByGenre` | Songs whose file states that genre. |
| `getNowPlaying` | What this server has been told is playing, by the clients that told it. |
| `getStarred` | The listener's stars, in the protocol's v1 shape. |
| `getStarred2` | The same stars in the v2 shape, with the ID3 fields. |

### Search

| Method | What it answers |
|---|---|
| `search3` | Artists, albums and songs in one answer, twenty of each by default. An artist or an album is found *through* the songs that match, so a query for a title answers with the record it is on. |

### Media retrieval

| Method | What it answers |
|---|---|
| `stream` | The bytes to play. `format` and `maxBitRate` re-encode, `timeOffset` starts later inside the song, and a song cut from a cue image is cut as it is asked for. Byte ranges are honoured. |
| `download` | The original media data, for a client that means to keep it: no transcode, no downsample. A song cut from a cue image is sent as its own frames rather than as the whole disc. |
| `getCoverArt` | A picture, by song, album or artist id. `size` is accepted and ignored — nothing is scaled, the collection's own file is served. A link the server itself handed out for a picture carries a `sig` and works without credentials; a bare `id` does not. |

### Media annotation

| Method | What it answers |
|---|---|
| `star` | A mark on a song, an album or an artist. Kept in the meta layer, so it survives a rescan. |
| `unstar` | The mark taken back. |
| `setRating` | A rating from 1 to 5; `0` means *no rating*, which is the protocol's own spelling of it. |
| `scrobble` | One play, or several — the `id` parameter may repeat. `submission=false` is "this is playing now". |
| `reportPlayback` | The `playbackReport` extension: what a player says about a song it has just played. |

### Playlists

| Method | What it answers |
|---|---|
| `getPlaylists` | The playlists this server holds, with `songCount`, `duration`, `created`, `changed` and a `coverArt` when there is something to draw. |
| `getPlaylist` | One playlist and its songs. |
| `createPlaylist` | A new one, from ids or from a whole album. |
| `updatePlaylist` | Renamed, with songs added or removed. |
| `deletePlaylist` | Removed. The `.m3u` it may have been imported from is left alone. |

### Play queue

| Method | What it answers |
|---|---|
| `getPlayQueue` | The queue a client left, `current` always present and a valid index. |
| `savePlayQueue` | That queue, saved. `id` may repeat; ids live in the meta layer, so the queue survives a rescan. |
| `getPlayQueueByIndex` | The same queue addressed by position — the `indexBasedQueue` extension. |
| `savePlayQueueByIndex` | The same, saved by position. |

### Bookmarks

| Method | What it answers |
|---|---|
| `getBookmarks` | Where the listener stopped in a song, with the position carried both as `position` and as `bookmarkPosition` on the song itself. |
| `createBookmark` | A new mark. One per song, which is the protocol's rule. |
| `deleteBookmark` | The mark taken back. |

### User management

| Method | What it answers |
|---|---|
| `getUser` | The one account this server has. |
| `getUsers` | The same record inside a list, which is what the plural asks for. |

### Transcoding

| Method | What it answers |
|---|---|
| `getTranscodeDecision` | A `POST`, with the client's own `ClientInfo` as the JSON body: what this server would do with a song for a client that has stated what it can play. `http` profiles only — an HLS-only client is told `canTranscode: false`, because this server produces no HLS. |
| `getTranscodeStream` | The bytes the decision promised, chosen by the token it handed out. The one route that answers an HTTP error status instead of `200`-with-an-error inside the envelope, because that is what its own page declares. |

---

## OpenSubsonic extensions

Exactly these five, each at version 1, and no others. An extension is a promise that a
client may send a parameter and be obeyed; a name here that no method backs would be a
lie the protocol gives a client no way to detect, so names arrive only with the code
that keeps them.

| Extension | Versions | Carried by | What a client gets |
|---|---|---|---|
| `indexBasedQueue` | 1 | `getPlayQueueByIndex`, `savePlayQueueByIndex` | The queue addressed by position rather than by id — which is what tells two identical entries apart. |
| `playbackReport` | 1 | `reportPlayback` | A way to say what was played, for history the server did not witness itself. |
| `transcodeOffset` | 1 | `timeOffset` on `stream` | To start the answer later than the song does, without a transcode. |
| `transcoding` | 1 | `getTranscodeDecision`, `getTranscodeStream` | To state what the client can play and be told what the server would do, instead of naming a format and a ceiling and hoping. |
| `apiKeyAuthentication` | 1 | `apiKey` on every method | A key alone is a credential. The server keeps a registry of them and can take one back; the registry is managed with the `funoteka keys` command, not over the API. |

### Fields beyond 1.16.1

A client that reads OpenSubsonic fields finds these as well, in the answers that carry
them:

- `song.explicitStatus` — `explicit`, `clean`, or an empty string for "nobody rated
  this", which is the third value the protocol gives the field. Read from the file's
  own advisory tags.
- `song.replayGain` — what the file says its loudness is, so a client that normalises
  has something to normalise by. Present always, sometimes empty.
- `artist.roles` — what the artist is in this library: `albumartist`, `artist`. Two
  roles are claimed, and only the two the collection can show.
- `artist.artistImageUrl` — the artist's picture as an address rather than as an id,
  pointing back at this server's own `getCoverArt`.
- `album.artists` — the record's artist credit, as distinct from a song's.
- `playlist.readonly` — `true` for a list imported from an `.m3u` in the collection: the
  file is what that list is, and a scan re-reads it, so an edit made over the API would
  be undone by a scan nobody asked for. A client told so can grey the controls out.

### One parameter that is not an extension

`showJunk` — `?showJunk=true` on any listing shows the folders the junk filter hides by
default. The protocol has no way to ask this and no field to answer it in, so it is a
parameter: the server's own setting is `FUNOTEKA_SHOW_JUNK`, and a client that says
nothing gets the default view. The junk filter only ever hides; it never deletes, and
what it hid is listed by the admin surface.

---

## The rest of the surface

Everything here is a method a client may ask for and this server does not fill. It is
answered **empty by form** rather than refused — a present, empty list rather than a
missing field, so a client draws nothing and carries on instead of showing an error.
The difference is what a client's startup calls turn on: it is the difference between a
library that opens and one that does not.

Reads here answer "nothing" and mean it. The *writes* — `createShare`, `deleteUser`,
`changePassword` and their neighbours — answer `ok` and change nothing, and nothing in
this collection is reachable through them. That is the one place this server lies about
its shape rather than its content, and it is deliberate: the alternative is a refusal,
which lands on exactly the same client as a missing method does.

### Lyrics and reviews

| Method | Answered with |
|---|---|
| `getLyrics` | `lyrics: {}` — the flat 1.2.0 shape. |
| `getLyricsBySongId` | `lyricsList.structuredLyrics: []` — the OpenSubsonic shape. A client asks by version, so both are answered. |
| `getAlbumInfo` | `albumInfo: {}`. |
| `getAlbumInfo2` | `albumInfo: {}`. |
| `getArtistInfo` | `artistInfo: {}`. `getArtistInfo2` above is about the collection and answers for real; this one is about an external service, which this server does not read. |

### Recommendations

| Method | Answered with |
|---|---|
| `getSimilarSongs` | `similarSongs.song: []`. |
| `getSimilarSongs2` | `similarSongs2.song: []`. |
| `getTopSongs` | `topSongs.song: []`. |
| `getSonicSimilarTracks` | `sonicMatch: []`. Similarity needs a corpus this server does not compute. |
| `findSonicPath` | `sonicMatch: []`. The sonic path needs fingerprints. |

### Podcasts

| Method | Answered with |
|---|---|
| `getPodcasts` | `podcasts.channel: []`. |
| `getNewestPodcasts` | `newestPodcasts.episode: []`. |
| `getPodcastEpisode` | `podcastEpisode: {}`. |
| `refreshPodcasts` | An empty envelope. |
| `createPodcastChannel` | An empty envelope. |
| `deletePodcastChannel` | An empty envelope. |
| `deletePodcastEpisode` | An empty envelope. |
| `downloadPodcastEpisode` | An empty envelope. This one is a *request to start* downloading, and an empty answer is what the specification asks for on success — it answers with no bytes, unlike the three at the end of this section. |

### Internet radio

| Method | Answered with |
|---|---|
| `getInternetRadioStations` | `internetRadioStations.internetRadioStation: []`. |
| `createInternetRadioStation` | An empty envelope. |
| `updateInternetRadioStation` | An empty envelope. |
| `deleteInternetRadioStation` | An empty envelope. |

### Chat

| Method | Answered with |
|---|---|
| `getChatMessages` | `chatMessages.chatMessage: []`. There is one listener. |
| `addChatMessage` | An empty envelope. |

### Video

| Method | Answered with |
|---|---|
| `getVideos` | `videos.video: []`. The collection is music. |
| `getVideoInfo` | `videoInfo: {}`. |

### Sharing

| Method | Answered with |
|---|---|
| `getShares` | `shares.share: []`. |
| `createShare` | `shares.share: []` — a well-formed empty list, not a share. |
| `updateShare` | An empty envelope. |
| `deleteShare` | An empty envelope. |

### User management

| Method | Answered with |
|---|---|
| `createUser` | An empty envelope. |
| `updateUser` | An empty envelope. |
| `deleteUser` | An empty envelope. |
| `changePassword` | An empty envelope. |

`getUser` and `getUsers` above both answer for real — the one account this server has.
What is empty here is the *management* of accounts.

### Jukebox

| Method | Answered with |
|---|---|
| `jukeboxControl` | `jukeboxPlaylist` (with `entry: []`) for `action=get`, `jukeboxStatus` for every other action, which is the split the specification describes. |

### The protocol's first generation

Kept for clients that never moved on. Each is a question this server answers properly
in a later shape — `getAlbumList2`, `search3` — asked in a form that cannot carry what
the collection holds.

| Method | Answered with |
|---|---|
| `getAlbumList` | `albumList.album: []`. |
| `search` | `searchResult` with `offset: 0`, `total: 0` and `match: []`. |
| `search2` | `searchResult2` with empty `artist`, `album` and `song` lists. |

### Answered with a refusal, because there is no empty form

An empty form has to have a *form*. The protocol's answer to these three is an image, a
caption file or a playlist, and a zero-byte one of those is a broken picture, not an
empty answer. The specification says so itself — `getAvatar` "returns the avatar image
in binary form on success, **or an XML document on error**" — so the refusal is the
protocol's, in error code `70`, and it is not the `unknown method` a client can do
nothing with.

| Method | Refused with |
|---|---|
| `getAvatar` | `this server keeps no avatars`. |
| `getCaptions` | `this server holds no video, so there are no captions`. |
| `hls` | `this server does not produce HLS`. `getTranscodeDecision` says the same thing in the extension's own language, with `canTranscode: false`. |

---

## Answered `unknown method`

A method that is on neither list is refused with error code `0` and the message
`unknown method: <name>`. Three worth naming, because a client developer will look for
them:

| Method | Why it is not even a stub |
|---|---|
| `startScan` | It asks the server to rescan, and the protocol defines it. A stub would answer `ok`, a client would draw "scanning started", and nothing would happen — a lie with the listener's name on it. The scan is started from the admin surface instead. |
| `getMoods`, `getMood` | Not endpoints of this API at all. Neither the Subsonic 1.16.1 endpoint list nor OpenSubsonic's has them — `moods` is an OpenSubsonic *field* a response may carry, not a method to call — so there is no shape to answer with and no name a client could have got from the specification. A caller asking for one is refused like any other name that is not a method. |
| `tokeninfo` | An endpoint of the OpenSubsonic key-access extension, and this server does not implement it. It announces `apiKeyAuthentication` instead, and a client that reads the extension list before asking will never ask for this. |

---

## A short list for a test session

- **Credentials.** `u` and `p`, or `t`/`s`, or `apiKey` alone. Everything refuses an
  unauthenticated call, with two exceptions: `getOpenSubsonicExtensions` above, and
  `getCoverArt` when it carries the `sig` the server put on a link it handed out. That
  second one is what lets a client's *image loader* — which does not authenticate —
  fetch an artist picture at all. Changing the server's password or key revokes every
  link ever handed out, because nothing about them is stored.
- **Formats.** `f=json` or `f=xml`; the default is XML. `/rest/ping.view` and
  `/rest/ping` are the same method.
- **Errors are inside the envelope** with HTTP `200`, with one exception
  (`getTranscodeStream`, above). A client that branches on the status line will read a
  Subsonic refusal as success.
- **What a listing holds.** The junk filter's default view is `records`; `showJunk=true`
  shows the rest. Both are the same library — nothing hidden is deleted.
- **What has no equivalent here.** No user accounts to create, no shares, no podcasts,
  no radio, no video, no chat, no lyrics, no recommendations, no moods, no HLS, and
  nothing fetched from the internet. A client that depends on one of those gets a
  well-formed nothing rather than a broken connection.
