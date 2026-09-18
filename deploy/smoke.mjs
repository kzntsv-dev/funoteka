#!/usr/bin/env node
/**
 * The acceptance checklist of requirements:44 and :47, walked over HTTP.
 *
 * A deployment is not "the process started" — it is a client being able to do
 * every one of the things below against the collection that is actually on the
 * disk. So this asks the running server the questions a client asks, in roughly
 * the order a client asks them, and prints what came back. It is what to run
 * after a deploy, and what to run first when a phone cannot play something.
 *
 *   node deploy/smoke.mjs http://127.0.0.1:4533 demo sesame
 *
 * The three arguments fall back to FUNOTEKA_URL, FUNOTEKA_USER and
 * FUNOTEKA_PASSWORD, so a service's own settings can be reused.
 *
 * Exit code 0 when nothing failed, 1 when something did, 2 when it was not told
 * how to ask. A check that could not fail would be a report, not a check.
 *
 * Three outcomes and not two: a step that found nothing to test — no whole file
 * in the collection to range, no album with art — is reported as skipped and
 * does not fail the run. It is a fact about the collection, and calling it a
 * pass would be the lie.
 */

const [, , urlArg, userArg, passwordArg] = process.argv;

const base = (urlArg ?? process.env.FUNOTEKA_URL ?? 'http://127.0.0.1:4533').replace(/\/+$/, '');
const user = userArg ?? process.env.FUNOTEKA_USER ?? '';
const password = passwordArg ?? process.env.FUNOTEKA_PASSWORD ?? '';

if (user === '' || password === '') {
  process.stderr.write('usage: node deploy/smoke.mjs [url] <user> <password>\n');
  process.exit(2);
}

const auth = new URLSearchParams({ u: user, p: password, f: 'json' });

/**
 * The parameters as the protocol spells them.
 *
 * A name given a list is repeated once per value rather than sent as one joined
 * string: that is how the protocol carries a list — `createPlaylist` takes one
 * `songId` per song — and the server's own reading of a POST body has to keep
 * them all, which is a thing a client cannot check for itself.
 */
function form(params) {
  const query = new URLSearchParams(auth);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((one) => query.append(key, String(one)));
    else query.set(key, String(value));
  }
  return query;
}

function url(method, params = {}) {
  return `${base}/rest/${method}?${form(params)}`;
}

async function api(method, params = {}) {
  // POST, and the body rather than the URL: this deployment is checked through
  // the road a client that would rather not spell a password in a URL takes,
  // which is also the road a server that reads only the query string fails on.
  const response = await fetch(`${base}/rest/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(params),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = JSON.parse(await response.text())['subsonic-response'];
  if (body.status !== 'ok') throw new Error(`code ${body.error?.code} — ${body.error?.message}`);
  return body;
}

/**
 * The head of an answer that is bytes: what it says it is, and the first of them.
 *
 * The connection is closed after the first chunk on purpose. A cue track is a
 * stretch of an image and cannot be ranged, so asking one for `bytes=0-99` is
 * answered with the whole track — thirty megabytes of a check that wanted to
 * know whether the bytes flow at all.
 */
async function peek(method, params = {}, headers = {}) {
  const response = await fetch(url(method, params), { headers });
  const reader = response.body.getReader();
  const first = await reader.read();
  await reader.cancel();

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    acceptRanges: response.headers.get('accept-ranges'),
    contentRange: response.headers.get('content-range'),
    length: Number(response.headers.get('content-length') ?? '0'),
    firstBytes: first.value?.length ?? 0,
  };
}

/**
 * A phone's capabilities, as the client this extension was built for states them.
 *
 * Three direct-play profiles rather than one, because that is what a real player
 * sends — and it is what made the decision and the stream disagree on the live
 * server the first time this was run: **all but one profile refuses any given
 * file**, and a client told `canDirectPlay: true` beside a list of reasons has
 * been told two things at once, of which the list is the half it acts on.
 */
const PHONE = {
  name: 'smoke',
  platform: 'Android',
  maxAudioBitrate: 0,
  maxTranscodingAudioBitrate: 0,
  directPlayProfiles: [
    { containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'], maxAudioChannels: 2 },
    { containers: ['m4a', 'mp4'], audioCodecs: ['aac', 'alac'], protocols: ['http'], maxAudioChannels: 2 },
    { containers: ['mp3'], audioCodecs: ['mp3'], protocols: ['http'] },
  ],
  transcodingProfiles: [
    { container: 'mp3', audioCodec: 'mp3', protocol: 'http', maxAudioChannels: 2 },
    { container: 'flac', audioCodec: 'flac', protocol: 'hls', maxAudioChannels: 2 },
  ],
};

/**
 * One `getTranscodeDecision`, asked for the way the specification says to ask.
 *
 * A POST with the capabilities as a JSON body — they are a nested list of
 * profiles and do not fit in a query string, which is the whole reason the
 * method is a POST in the first place.
 */
async function decide(mediaId, capabilities) {
  const response = await fetch(`${base}/rest/getTranscodeDecision?${form({ mediaId, mediaType: 'song' })}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(capabilities),
  });
  const body = JSON.parse(await response.text())['subsonic-response'];
  if (body.status !== 'ok') throw new Error(`code ${body.error?.code} — ${body.error?.message}`);
  return body.transcodeDecision;
}

const results = [];

async function step(name, work) {
  try {
    const detail = await work();
    if (detail && typeof detail === 'object' && 'skipped' in detail) {
      results.push(['skip', name, detail.skipped]);
      return;
    }
    results.push(['ok', name, detail ?? '']);
  } catch (err) {
    results.push(['fail', name, err.message]);
  }
}

await step('ping answers at all', async () => {
  await api('ping');
  return base;
});

await step('the license is valid, which clients check before anything else', async () => {
  const body = await api('getLicense');
  if (body.license?.valid !== true) throw new Error('the license is not valid');
  return 'valid';
});

await step('the scan status says how big the library is', async () => {
  const body = await api('getScanStatus');
  if (!(body.scanStatus.count > 0)) throw new Error('no songs — has this database been scanned?');
  return `${body.scanStatus.count} songs`;
});

const artists = [];
await step('artists are browsable, in every letter they fall under', async () => {
  const body = await api('getIndexes');
  for (const group of body.indexes.index ?? []) artists.push(...(group.artist ?? []));
  if (artists.length === 0) throw new Error('no artists in the index');
  return `${artists.length} artists under ${(body.indexes.index ?? []).length} letters`;
});

// Sampled across the collection rather than from its head. A record cut from a
// cue image and a record of whole files look nothing alike to a client, and a
// check that only ever met the first five artists would report the cue path as
// absent in a library that is mostly cue images — the one thing this server
// does that others do not.
const MEDLEY = 12;

const albums = [];
await step('an artist lists its records', async () => {
  const spread = artists.filter((_, at) => at % Math.max(1, Math.floor(artists.length / MEDLEY)) === 0);
  for (const artist of spread.slice(0, MEDLEY)) {
    const body = await api('getArtist', { id: artist.id });
    albums.push(...(body.artist.album ?? []));
  }
  if (albums.length === 0) throw new Error('no records under the artists sampled');
  return `${albums.length} records under ${Math.min(spread.length, MEDLEY)} artists`;
});

const songs = [];
await step('a record lists its songs', async () => {
  for (const album of albums.slice(0, MEDLEY)) {
    const body = await api('getAlbum', { id: album.id });
    songs.push(...(body.album.song ?? []));
  }
  if (songs.length === 0) throw new Error('no songs on the records sampled');
  return `${songs.length} songs`;
});

await step('a playlist is made, edited, listed and taken away', async () => {
  // The one part of this API that writes, and so the one part a deployment can
  // get wrong without any answer looking different: a list saved short, a
  // rename that emptied it, a deletion that left it behind. It is checked on
  // the live library because that is where the client that makes playlists
  // actually is — and it puts the library back the way it found it.
  const first = songs[0].id;
  const second = songs[1]?.id ?? first;

  const made = await api('createPlaylist', { name: 'smoke — плейлист', songId: [first, second] });
  const id = made.playlist?.id;
  if (!id) throw new Error('createPlaylist answered without an id');
  if (made.playlist.songCount !== 2) {
    throw new Error(`made a playlist of ${made.playlist.songCount} songs out of two`);
  }

  const opened = await api('getPlaylist', { id });
  if ((opened.playlist.entry ?? []).length !== 2) throw new Error('the playlist lost its songs');

  await api('updatePlaylist', {
    playlistId: id,
    name: 'smoke — правленый',
    songIndexToRemove: '0',
    songIdToAdd: first,
  });
  const edited = await api('getPlaylist', { id });
  if (edited.playlist.name !== 'smoke — правленый') throw new Error('the rename did not stick');
  if (edited.playlist.entry?.[0]?.id !== second) throw new Error('the removal did not stick');

  const listed = await api('getPlaylists');
  if (!(listed.playlists.playlist ?? []).some((one) => one.id === id)) {
    throw new Error('the playlist is not in the list');
  }

  await api('deletePlaylist', { id });
  const after = await api('getPlaylists');
  if ((after.playlists.playlist ?? []).some((one) => one.id === id)) {
    throw new Error('the playlist is still there after being deleted');
  }

  return `made, renamed, edited and deleted ${id}`;
});

await step('a song can be starred and rated, and says so where a client looks', async () => {
  // The rest of the writing surface, and the same acceptance question as the
  // playlist above: a mark is worth nothing if only the method that set it knows
  // about it. So it is set, read back through `getSong` (which is what a client
  // draws a star from), found in the starred listing, and taken off again.
  //
  // **What was there before is read first and put back afterwards.** This is a
  // library somebody listens to: a check that cleared a star the operator had
  // set would be a check that costs them something, and "the library is left as
  // it was found" would be false in the one case where it matters.
  const song = songs[0].id;
  const before = (await api('getSong', { id: song })).song;

  await api('star', { id: song });
  await api('setRating', { id: song, rating: '4' });

  const one = await api('getSong', { id: song });
  if (!one.song?.starred) throw new Error('the song does not say it is starred');
  if (one.song.userRating !== 4) throw new Error(`rated ${one.song.userRating}, asked for 4`);

  const starred = await api('getStarred2');
  if (!(starred.starred2.song ?? []).some((entry) => entry.id === song)) {
    throw new Error('the song is not among the starred');
  }

  await api('unstar', { id: song });
  await api('setRating', { id: song, rating: '0' });
  const cleared = await api('getSong', { id: song });
  if (cleared.song.starred !== undefined || cleared.song.userRating !== undefined) {
    throw new Error('the marks did not come off');
  }

  // Back the way it was: a star the operator had set is set again, and a rating
  // is put back to what it was — including none at all.
  if (before.starred !== undefined) await api('star', { id: song });
  if (before.userRating !== undefined) {
    await api('setRating', { id: song, rating: String(before.userRating) });
  }

  const marks = before.starred === undefined && before.userRating === undefined ? 'was unmarked' : 'was marked';
  return `${song}: starred, rated 4, listed, cleared (${marks})`;
});

await step('a song is served as audio, and the bytes arrive', async () => {
  const served = await peek('stream', { id: songs[0].id });
  if (served.status !== 200) throw new Error(`HTTP ${served.status}`);
  if (!served.contentType.startsWith('audio/')) throw new Error(`served as ${served.contentType}`);
  if (served.firstBytes === 0) throw new Error('the answer had no bytes in it');
  return `${served.firstBytes} bytes of ${served.contentType} (${served.length} in all)`;
});

await step('a whole file is rangeable, which is how seeking works', async () => {
  for (const song of songs.slice(0, 60)) {
    const ranged = await peek('stream', { id: song.id }, { range: 'bytes=0-99' });
    if (ranged.status === 206) {
      if (ranged.firstBytes !== 100) throw new Error(`206 answered with ${ranged.firstBytes} bytes`);
      if (!/^bytes 0-99\//.test(ranged.contentRange ?? '')) {
        throw new Error(`206 without a content-range saying which bytes: ${ranged.contentRange}`);
      }
      return `${song.title} — 206, ${ranged.contentRange}`;
    }
    if (ranged.status === 200 && ranged.acceptRanges !== 'bytes') continue; // a cue track
    throw new Error(`${song.title}: HTTP ${ranged.status}, accept-ranges ${ranged.acceptRanges}`);
  }
  return { skipped: `no whole-file song among the ${Math.min(songs.length, 60)} sampled — every one is cut from an image` };
});

await step('a track cut out of an image is served as a track, and says so', async () => {
  // **How a song cut out of an image says so** (issue:100): the image's own
  // path with the cut number before the extension — `image (track 3).flac`.
  // One spelling living in two places (`browse.ts`'s `songPathOf` and here), so
  // a change in either has to be made in both: this step reads the path to find
  // a cut record at all.
  const CUT = / \(track (\d+)\)(\.[^./\\]+)?$/;

  // Found rather than guessed at: several songs of one record naming **the same
  // image**. A cue-split record is the only shape that looks like that — every
  // other song is its own file.
  //
  // The detector used to look for songs of one record reporting *the image's
  // size*, which was the same fact seen through a defect: `size` is the song's
  // length, and answering with the file's is what this step exists to catch one
  // field over (`9b91ccf`). Then it looked for songs of one record reporting
  // the same **path** — which is now the defect itself, so the record is found
  // by the image a song is cut from: its path with the cut number taken back
  // out. That answers for a fixed library and for a regressed one (where the
  // number is gone and every song of the image is back to one path), which is
  // what keeps this step from going quietly `skipped` the way it did over
  // `size` (`9b91ccf`).
  const page = await api('search3', { query: '', songCount: 500 });
  const images = new Map();
  for (const song of page.searchResult3.song ?? []) {
    if (song.albumId === undefined) continue;
    const mark = typeof song.path === 'string' ? CUT.exec(song.path) : null;
    const image = mark === null ? song.path : song.path.replace(CUT, mark[2] ?? '');
    const key = `${song.albumId}\u0000${image}`;
    if (!images.has(key)) images.set(key, []);
    images.get(key).push(song);
  }

  const cut = [...images.values()].find((group) => group.length >= 2);
  if (cut === undefined) {
    return { skipped: 'no cue-split record among the first 500 songs — this library is all whole files' };
  }

  // **The defect itself, and the reason this step exists** (issue:100): a
  // client keys a song by its path — Symfonium's own rule is *"songs with the
  // same file are supposed to be the same song"* — so songs of one image that
  // share a path are one song to it, and it plays the first track of the record
  // twelve times. Every song here carries a cut number of its own, and the
  // number is the one the record gives it: a path reading `track 9` beside
  // `track: 3` is the same defect one field over.
  for (const song of cut) {
    const mark = typeof song.path === 'string' ? CUT.exec(song.path) : null;
    if (mark === null) {
      throw new Error(
        `${cut.length} songs of one image all answer with the path ${song.path} — a client keys them as one song (issue:100)`,
      );
    }
    if (Number(mark[1]) !== song.track) {
      throw new Error(
        `${song.title}: the path says track ${mark[1]} where the record says track ${song.track}`,
      );
    }
  }

  // What a segment promises changed when seeking was made to work (`6fea2b6`):
  // the answer is rebuilt from the frames the track covers, so a range is
  // honoured and its total is the *segment's* length. The regression this step
  // catches is the answer being the image instead — a total an order of
  // magnitude over the track, which every other step here would pass.
  const served = await peek('stream', { id: cut[0].id }, { range: 'bytes=0-99' });
  const total = Number((served.contentRange ?? '').split('/')[1] ?? '0');

  if (served.status !== 206) {
    throw new Error(`${cut[0].title}: HTTP ${served.status}, expected 206 for a range`);
  }
  if (served.acceptRanges !== 'bytes') {
    throw new Error(`${cut[0].title}: accept-ranges ${served.acceptRanges}, expected bytes`);
  }
  if (served.length !== 100) {
    throw new Error(`${cut[0].title}: content-length ${served.length}, expected 100`);
  }
  // `size` is the song's own share of the image, and a song whose image nobody
  // measured a bitrate for is handed none at all rather than the image's
  // (`sizeOf`) — in which case there is no promise here to hold the answer to,
  // and saying so beats comparing against `undefined` and passing silently.
  if (cut[0].size === undefined) {
    return {
      skipped: `${cut.length} songs of one image found and each has its own path, but no size was measured for the image to hold a range against`,
    };
  }
  if (total === 0 || total > cut[0].size * 1.5) {
    throw new Error(
      `${cut[0].title}: the range totals ${total} bytes against a song reported at ${cut[0].size} — the answer is the image, not the track`,
    );
  }

  // And the field the operator found: songs of one image no longer answer with
  // the image's length. Each is its own share of it, so whenever the lengths
  // differ the sizes have to differ too — the one assertion that tells a fixed
  // `size` from a merely smaller wrong one.
  const durations = new Set(cut.map((song) => song.duration));
  const sizes = new Set(cut.map((song) => song.size));
  if (durations.size > 1 && sizes.size === 1) {
    throw new Error(
      `${cut.length} songs of one image of different lengths all report ${cut[0].size} bytes`,
    );
  }

  return `${cut[0].title} (${cut.length} tracks of one image) — 206, a ${total}-byte track, reported at ${cut[0].size}`;
});

await step('a record has cover art', async () => {
  let withArt = 0;
  for (const album of albums.slice(0, 10)) {
    const cover = await peek('getCoverArt', { id: album.id });
    if (cover.status === 200 && cover.contentType.startsWith('image/')) withArt += 1;
  }
  if (withArt === 0) throw new Error('not one of the ten sampled records answered with an image');
  return `${withArt}/${Math.min(albums.length, 10)} records of the sample`;
});

await step('a search finds what is in the collection', async () => {
  const body = await api('search3', { query: '', songCount: 1 });
  const found = body.searchResult3.song ?? [];
  if (found.length === 0) throw new Error('an empty query must answer with the library — that is how a client syncs');
  return `${found[0].title} — ${found[0].artist}`;
});

await step('a search by a word answers', async () => {
  const body = await api('search3', { query: 'а', songCount: 1 });
  return `${(body.searchResult3.song ?? []).length} song(s) for "а"`;
});

await step('the collection browses as folders too', async () => {
  const body = await api('getMusicDirectory', { id: '-1' });
  const roots = body.directory.child ?? [];
  if (roots.length === 0) throw new Error('no roots');
  return `${roots.length} root(s)`;
});

// The v1.2 surface: the listener's own layer, the delivery layer's parameters,
// and the two answers about the build itself. Each was added when its stage
// landed, and the deployment gate had gone without them — which is how a reader
// change that never reached a file (`tags/read.ts`, `TAGS_METHOD`) got past a
// green smoke run and had to be found by a review instead (task:2869).

await step('the queue is saved, read back, and put back as it was', async () => {
  // **The queue is the listener's own state, and a check that clobbered it
  // would be a check nobody dares run on a deployment.** So what was there is
  // read first and restored at the end — including the empty case, which the
  // protocol can express: no `id` at all clears the queue (`history.ts`, "send
  // no id to clear"). The operator's queue was destroyed once by a test that
  // cleaned up "after itself" and took his with it (task:2863).
  const before = await api('getPlayQueue');
  const was = (before.playQueue.entry ?? []).map((entry) => entry.id);

  const { searchResult3 } = await api('search3', { query: '', songCount: 3 });
  const songs = (searchResult3.song ?? []).map((song) => song.id);
  if (songs.length < 2) {
    return { skipped: 'the collection answers with fewer than two songs' };
  }

  await api('savePlayQueue', { id: songs, current: songs[0], position: 1234 });
  const saved = await api('getPlayQueue');
  const back = (saved.playQueue.entry ?? []).map((entry) => entry.id);
  if (back.join(',') !== songs.join(',')) {
    throw new Error(`saved ${songs.join(',')} and read back ${back.join(',')}`);
  }
  if (saved.playQueue.position !== 1234) {
    throw new Error(`position came back as ${saved.playQueue.position}, not 1234`);
  }

  // Put it back, whatever it was.
  if (was.length === 0) {
    await api('savePlayQueue', {});
  } else {
    await api('savePlayQueue', { id: was, current: before.playQueue.current ?? was[0] });
  }
  return `${back.length} entries round-tripped; the queue it found is back`;
});

await step('a play is recorded, and what is on now says so', async () => {
  const { searchResult3 } = await api('search3', { query: '', songCount: 1 });
  const song = (searchResult3.song ?? [])[0];
  if (song === undefined) return { skipped: 'no songs' };

  const played = await api('getSong', { id: song.id });
  const before = played.song.playCount ?? 0;

  await api('scrobble', { id: song.id, submission: true });
  const after = await api('getSong', { id: song.id });
  if ((after.song.playCount ?? 0) !== before + 1) {
    throw new Error(`playCount ${before} → ${after.song.playCount}, and a scrobble was sent`);
  }
  if (after.song.played === undefined || after.song.played === '') {
    throw new Error('a scrobble left nothing saying when');
  }

  // `getNowPlaying` is a different question — what is on *now* — and it is
  // answered even with nobody listening, which is what an idle server is.
  const now = await api('getNowPlaying');
  const on = (now.nowPlaying.entry ?? []).length;

  // The scrobble is a row about this listener and is left behind on purpose:
  // it is what the field is for, and undoing it would mean a second endpoint.
  return `${song.title}: playCount ${before} → ${after.song.playCount}, ${on} playing now`;
});

await step('something to open on is drawn from the collection', async () => {
  const body = await api('getRandomSongs', { size: 5 });
  const drawn = body.randomSongs.song ?? [];
  if (drawn.length === 0) throw new Error('a draw answered with nothing to play');
  if (drawn.some((song) => song.id === undefined || song.id === '')) {
    throw new Error('a drawn song has no id, so nothing can be done with it');
  }
  return `${drawn.length} drawn, first is ${drawn[0].title}`;
});

await step('a song can be taken away whole, named as a file', async () => {
  const { searchResult3 } = await api('search3', { query: '', songCount: 1 });
  const song = (searchResult3.song ?? [])[0];
  if (song === undefined) return { skipped: 'no songs' };

  const response = await fetch(url('download', { id: song.id }));
  // One chunk and the connection is dropped, like `peek`: a check that wanted
  // the header has no business pulling a whole record through the wire.
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();

  const disposition = response.headers.get('content-disposition') ?? '';
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  if (!disposition.includes('attachment')) {
    throw new Error(`no attachment name for a download: ${disposition}`);
  }
  if (disposition.includes('${')) {
    throw new Error(`the file name is not a header value: ${disposition}`);
  }
  return `${song.title} — ${disposition.split('filename')[1]?.slice(0, 40) ?? ''}`;
});

await step('a format asked for by name is the format that comes back', async () => {
  // The parameter pair a client actually sends. `format=raw` beside it means
  // "do not transcode", which is the same promise `download` makes, so these
  // two are the whole of what the delivery layer adds over the file.
  const body = await api('getAlbumList2', { type: 'alphabeticalByName', size: 500 });
  const albums = body.albumList2.album ?? [];

  let tried = 0;
  for (const album of albums) {
    const detail = await api('getAlbum', { id: album.id });
    const song = (detail.album.song ?? []).find((one) => one.suffix === 'flac');
    if (song === undefined) continue;

    tried += 1;
    const got = await peek('stream', { id: song.id, format: 'mp3', maxBitRate: 128 });
    if (got.status !== 200) throw new Error(`HTTP ${got.status} for ${song.title}`);
    if (!got.contentType.startsWith('audio/mpeg')) {
      throw new Error(`${song.title}: asked for mp3, got ${got.contentType}`);
    }
    return `${song.title} — flac in, ${got.contentType} out`;
  }
  return { skipped: `no flac song found among ${albums.length} records` };
});

await step('the server says what it is, to a client with no credentials', async () => {
  // Public by the specification's own demand ("must be publicly accessible"),
  // because a client asks this before it hands over a password.
  const response = await fetch(`${base}/rest/getOpenSubsonicExtensions?f=json`);
  const body = JSON.parse(await response.text())['subsonic-response'];
  if (body.status !== 'ok') throw new Error(`code ${body.error?.code} without credentials`);
  if (body.openSubsonic !== true) throw new Error('the envelope does not claim OpenSubsonic');
  if (body.serverVersion === undefined || body.serverVersion === '') {
    throw new Error('no serverVersion, which is how a client knows to ask this again');
  }

  const named = (body.openSubsonicExtensions ?? []).map((one) => one.name);
  if (named.length === 0) throw new Error('a build that supports nothing says nothing');
  return named.join(', ');
});

/** A flac song from the records sampled, which is what the three checks below want. */
const flacSong = songs.find((one) => one.suffix === 'flac');

await step('a client is told what would happen to a song, and what it would be given instead', async () => {
  if (flacSong === undefined) return { skipped: 'no flac song among the records sampled' };

  const decision = await decide(flacSong.id, PHONE);
  if (decision.canDirectPlay !== true) {
    throw new Error(`${flacSong.title}: a FLAC profile against a FLAC file answered canDirectPlay ${decision.canDirectPlay}`);
  }
  if (decision.transcodeReason !== undefined) {
    throw new Error(`${flacSong.title}: nothing needs transcoding, yet reasons were given: ${decision.transcodeReason.join(', ')}`);
  }
  if (!decision.transcodeParams) throw new Error('a decision that can transcode carries a token');
  if (decision.sourceStream?.codec !== 'flac') {
    throw new Error(`${flacSong.title}: the source is described as ${decision.sourceStream?.codec}`);
  }
  if (decision.sourceStream?.container !== 'flac') {
    throw new Error(`${flacSong.title}: the source container is ${decision.sourceStream?.container}`);
  }
  if (decision.transcodeStream?.codec !== 'mp3') {
    throw new Error(`the answer would be ${decision.transcodeStream?.codec}, not the mp3 the profile names`);
  }
  return `${flacSong.title} — direct play, or ${decision.transcodeStream.container} as ${decision.transcodeStream.codec}`;
});

await step('the stream a decision promised is the stream that comes back', async () => {
  // A FLAC profile against a FLAC song, so what `stream` answers is the file
  // itself rather than a re-encode — what is being checked is the token's road
  // from one call to the other, and not ffmpeg.
  if (flacSong === undefined) return { skipped: 'no flac song among the records sampled' };

  const decision = await decide(flacSong.id, {
    name: 'smoke',
    platform: 'Android',
    directPlayProfiles: [{ containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'] }],
    transcodingProfiles: [{ container: 'flac', audioCodec: 'flac', protocol: 'http' }],
  });
  if (!decision.transcodeParams) throw new Error('no token to ask the stream with');

  const got = await peek('getTranscodeStream', {
    mediaId: flacSong.id,
    mediaType: 'song',
    transcodeParams: decision.transcodeParams,
  });
  if (got.status !== 200) throw new Error(`HTTP ${got.status}`);
  if (!got.contentType.startsWith('audio/flac')) {
    throw new Error(`${flacSong.title}: asked for flac, got ${got.contentType}`);
  }
  return `${flacSong.title} — ${got.firstBytes} bytes of ${got.contentType}`;
});

await step('a client whose profiles are all hls is refused, not promised a stream', async () => {
  // The volume decision of the extension: this server produces no HLS, so a
  // profile over that transport is skipped rather than answered with a token
  // that leads to an error the client cannot read.
  if (flacSong === undefined) return { skipped: 'no flac song among the records sampled' };

  const decision = await decide(flacSong.id, {
    name: 'smoke — hls only',
    platform: 'Android',
    directPlayProfiles: [],
    transcodingProfiles: [{ container: 'flac', audioCodec: 'flac', protocol: 'hls' }],
  });
  if (decision.canTranscode !== false) throw new Error('hls was offered, and this server makes none');
  if (decision.transcodeParams !== undefined) {
    throw new Error('a token was issued for a stream that cannot be produced');
  }
  if (!/http/.test(String(decision.errorReason ?? ''))) {
    throw new Error(`the refusal does not say what would work: ${decision.errorReason}`);
  }
  return 'canTranscode false, and the refusal names the transport that works';
});

await step('a song says how it is rated, even when the collection says nothing', async () => {
  const { searchResult3 } = await api('search3', { query: '', songCount: 5 });
  const songs = searchResult3.song ?? [];
  if (songs.length === 0) return { skipped: 'no songs' };

  // The field always answers — the protocol gives it a third value and it is
  // the empty string — so `undefined` here is a client reading a field that is
  // not there, which is a different thing from a song nobody rated.
  const silent = songs.filter((song) => song.explicitStatus === undefined);
  if (silent.length > 0) throw new Error(`${silent.length} of ${songs.length} songs have no explicitStatus at all`);

  const rated = songs.filter((song) => song.explicitStatus !== '').length;
  return `${songs.length} songs, ${rated} carry a rating, the rest answer ""`;
});

await step('what is not a record is hidden, and the switch shows it', async () => {
  const asked = async (extra) => {
    const body = await api('getAlbumList2', { type: 'alphabeticalByName', size: 500, ...extra });
    return (body.albumList2.album ?? []).map((album) => album.name);
  };

  const hidden = await asked({});
  const shown = await asked({ showJunk: 1 });
  if (shown.length < hidden.length) {
    throw new Error(`the switch showed fewer records (${shown.length}) than the default (${hidden.length})`);
  }
  const kept = shown.filter((name) => !hidden.includes(name));

  // The collection may honestly hold nothing to hide — the filter would then be
  // untested rather than passing, which is what `skip` is for.
  if (kept.length === 0) return { skipped: 'nothing in this collection is marked as junk' };
  return `${kept.length} hidden of ${shown.length}: ${kept.join(', ')}`;
});

await step('wrong credentials are refused', async () => {
  const query = new URLSearchParams({ u: user, p: `${password}-wrong`, f: 'json' });
  const response = await fetch(`${base}/rest/ping?${query}`);
  const body = JSON.parse(await response.text())['subsonic-response'];
  if (body.status !== 'failed') throw new Error('a wrong password was accepted');
  return `code ${body.error?.code}`;
});

const marks = { ok: '  ok  ', fail: ' FAIL ', skip: ' skip ' };
for (const [outcome, name, detail] of results) {
  process.stdout.write(`${marks[outcome]} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}

const failed = results.filter(([outcome]) => outcome === 'fail').length;
const passed = results.filter(([outcome]) => outcome === 'ok').length;
const skipped = results.filter(([outcome]) => outcome === 'skip').length;

process.stdout.write(
  `\n${passed}/${results.length} passed${skipped === 0 ? '' : `, ${skipped} skipped`} against ${base}\n`,
);
process.exit(failed === 0 ? 0 : 1);
