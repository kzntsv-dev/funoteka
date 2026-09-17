import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db/index.ts';
import { openSubsonicExtensions } from '../src/api/extensions.ts';
import { route } from '../src/api/router.ts';
import { STUBBED, STUBBED_BYTES } from '../src/api/stubs.ts';
import { ask, type Db } from './helpers/api.ts';

/**
 * The rest of the surface: answered empty by form, never refused.
 *
 * A client that asks for something this server does not have must be able to
 * tell "nothing here" from "not a Subsonic server" (requirements:47,
 * «Заглушки»). The first two tests below are the contract's own list, written
 * out by hand so that a method dropped from `stubs.ts` fails a test rather than
 * quietly going back to `unknown method`; the rest are the properties the answers
 * have to keep — the shape is present, the format does not change it, and the
 * extensions list tells the truth about what is real.
 */

/**
 * The contract's list, verbatim from requirements:47, «Заглушки», minus the one
 * name that stopped being a stub.
 *
 * `getUsers` is not here because it answers for real now: the contract put user
 * *management* out of scope and the plural was stubbed with the rest, so a
 * client was told the server has no users by one method and about one user by
 * the other. The operator read the two side by side and said which was wrong;
 * `wiki:3640` records it. It is checked below beside `getUser`, and the point of
 * naming it here is that a name leaving this list is a decision and not a slip.
 */
const ANSWERED_FOR_REAL = ['getusers'];

/** The rest of the contract's list: answered empty by form. */
const ASKED_FOR = [
  'getlyrics',
  'getlyricsbysongid',
  'getalbuminfo',
  'getalbuminfo2',
  'getsimilarsongs',
  'getsimilarsongs2',
  'gettopsongs',
  'getsonicsimilartracks',
  'findsonicpath',
  'getpodcasts',
  'getnewestpodcasts',
  'getpodcastepisode',
  'refreshpodcasts',
  'createpodcastchannel',
  'deletepodcastchannel',
  'deletepodcastepisode',
  'downloadpodcastepisode',
  'getinternetradiostations',
  'createinternetradiostation',
  'updateinternetradiostation',
  'deleteinternetradiostation',
  'jukeboxcontrol',
  'getchatmessages',
  'addchatmessage',
  'getvideos',
  'getvideoinfo',
  'getshares',
  'createshare',
  'updateshare',
  'deleteshare',
  'createuser',
  'updateuser',
  'deleteuser',
  'changepassword',
  'getalbumlist',
  'search',
  'search2',
  'getartistinfo',
];

/** One envelope, parsed out of whichever format it came in. */
function envelope(body: Buffer): Record<string, any> {
  return JSON.parse(body.toString())['subsonic-response'];
}

function open(): Db {
  return openDb(':memory:');
}

test('the contract list is answered, and the byte methods have their own answers', () => {
  for (const method of ASKED_FOR) {
    if (STUBBED_BYTES.has(method)) continue;
    assert.ok(STUBBED.has(method), `${method} is answered`);
  }
  // And the one that left the list is answered by a route rather than by a stub,
  // which is the difference the test above would otherwise hide.
  for (const method of ANSWERED_FOR_REAL) {
    assert.ok(!STUBBED.has(method) && !STUBBED_BYTES.has(method), `${method} is not a stub`);
    assert.ok(route(method) !== undefined, `${method} is answered by a route`);
  }
  // The three that answer with bytes rather than an envelope, and cannot be
  // empty in the same way — an empty image is a broken picture.
  assert.deepEqual([...STUBBED_BYTES.keys()].sort(), ['getavatar', 'getcaptions', 'hls']);

  // A method this server *does* fill must not be in here: a stub that shadowed
  // a real route would answer the client with nothing and look like a server
  // whose collection is empty.
  for (const real of ['getalbum', 'getsong', 'stream', 'search3', 'getartistinfo2', 'getuser']) {
    assert.ok(!STUBBED.has(real) && !STUBBED_BYTES.has(real), `${real} is not stubbed`);
  }
});

test('each stub answers with the shape the specification gives it', async () => {
  const db = open();
  try {
    for (const [method, payload] of STUBBED) {
      const answer = await ask(db, `${method}?f=json`);
      assert.equal(answer.status, 200, `${method} is an answer, not a transport error`);
      const body = envelope(answer.body);
      assert.equal(body.status, 'ok', `${method} is not a refusal`);

      // The jukebox is the one entry whose payload is built from the question
      // and it has its own test below; here it is asked for the shape every
      // other stub has, which is that an answer arrives at all.
      if (typeof payload === 'function') continue;

      for (const [key, want] of Object.entries(payload)) {
        assert.ok(key in body, `${method} answers with "${key}"`);
        // An empty child array is *present and empty*: a client reading
        // `topSongs.song` has to find a list, not a missing field.
        for (const child of want !== null && typeof want === 'object' ? Object.keys(want) : []) {
          assert.ok(child in body[key], `${method}: ${key}.${child} is there`);
        }
      }
    }
  } finally {
    db.close();
  }
});

test('the same answer comes back in the protocol’s other format', async () => {
  const db = open();
  try {
    // The envelope is rendered, not written, so a stub that is right in JSON and
    // missing in XML is a stub that is wrong for every client using the default.
    const xml = (await ask(db, 'gettopsongs?artist=nobody')).body.toString();
    assert.match(xml, /<subsonic-response[^>]*status="ok"/);
    assert.match(xml, /<topSongs\/>|<topSongs><\/topSongs>/);

    const json = envelope((await ask(db, 'gettopsongs?artist=nobody&f=json')).body);
    assert.deepEqual(json.topSongs, { song: [] });
  } finally {
    db.close();
  }
});

test('the jukebox answers the question it was asked', async () => {
  const db = open();
  try {
    // The spec's own words: «jukeboxStatus for all actions but get,
    // jukeboxPlaylist for get». One empty shape for both would be wrong for one
    // of them, and the wrong one is a client reading an empty queue in a field
    // it never looks at.
    const asked = envelope((await ask(db, 'jukeboxcontrol?action=get&f=json')).body);
    assert.deepEqual(asked.jukeboxPlaylist, {
      currentIndex: 0,
      playing: false,
      gain: 1,
      position: 0,
      entry: [],
    });

    const played = envelope((await ask(db, 'jukeboxcontrol?action=start&f=json')).body);
    assert.deepEqual(played.jukeboxStatus, {
      currentIndex: 0,
      playing: false,
      gain: 1,
      position: 0,
    });
  } finally {
    db.close();
  }
});

test('a byte stub refuses in the protocol’s own language', async () => {
  const db = open();
  try {
    for (const method of STUBBED_BYTES.keys()) {
      const answer = await ask(db, `${method}?f=json`);
      // Not a 404 and not "unknown method": the method exists, and what it has
      // to say is that it holds nothing. A client reads a code out of the body,
      // and a transport error is the answer it cannot act on.
      assert.equal(answer.status, 200, method);
      const body = envelope(answer.body);
      assert.equal(body.status, 'failed', method);
      assert.equal(body.error.code, 70, `${method} says "not found", not "no such method"`);
      assert.ok(!body.error.message.includes('unknown method'), method);
    }
  } finally {
    db.close();
  }
});

test('the HLS method is recognised under the URL it is spelled with', async () => {
  const db = open();
  try {
    // `/rest/hls.m3u8` is the method's own spelling in the specification, and a
    // router that matched only the bare `hls` would answer a client asking for a
    // stream with "unknown method".
    const answer = await ask(db, 'hls.m3u8?id=tr-1&f=json');
    assert.equal(answer.status, 200);
    const body = envelope(answer.body);
    assert.equal(body.status, 'failed');
    assert.match(body.error.message, /does not produce HLS/);
  } finally {
    db.close();
  }
});

test('the user list holds the user, which is the answer the operator chose', async () => {
  const db = open();
  try {
    // The two methods used to disagree: this one said the server has no users
    // and `getUser` said it has one. A list of one is the same record, so what is
    // checked is that they agree — a client reading both is the reason the
    // question was asked at all.
    const list = envelope((await ask(db, 'getusers?f=json')).body);
    const one = envelope((await ask(db, 'getuser?f=json')).body);

    assert.equal(list.status, 'ok');
    assert.deepEqual(list.users.user, [one.user]);
    assert.equal(list.users.user[0].username, 'demo');
  } finally {
    db.close();
  }
});

test('a method nobody stubbed is still refused', async () => {
  const db = open();
  try {
    // The point of the list is that it is a list. A server that answered
    // everything would be a server that cannot say "no".
    const answer = envelope((await ask(db, 'getfrobnicator?f=json')).body);
    assert.equal(answer.status, 'failed');
    assert.match(answer.error.message, /unknown method/);
  } finally {
    db.close();
  }
});

test('the extensions list advertises only what is built', () => {
  // The other half of "empty by form": a stub must never appear here. An
  // extension is a promise that a client may send a parameter and be obeyed,
  // and `getTopSongs`'s `id` is exactly such a promise — the `topSongsByArtistId`
  // extension — which this server does not keep.
  const advertised = (openSubsonicExtensions() as { openSubsonicExtensions: { name: string }[] })
    .openSubsonicExtensions.map((one) => one.name);
  assert.deepEqual(advertised.sort(), [
    'apiKeyAuthentication',
    'indexBasedQueue',
    'playbackReport',
    'transcodeOffset',
    'transcoding',
  ]);
  for (const name of advertised) {
    assert.ok(!/lyric|podcast|share|radio|sonic|video|jukebox|top|similar|avatar|user/i.test(name));
  }
});
