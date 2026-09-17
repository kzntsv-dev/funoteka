import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getNowPlaying } from '../src/api/history.ts';
import { openDb } from '../src/db/index.ts';
import { ask, CONFIG } from './helpers/api.ts';

/**
 * What was played, what is playing, and the queue a listener left behind.
 *
 * Three things a client says about playback, and all three are the listener's
 * own — nothing on disk states them and no scan can rebuild them, which is the
 * same footing playlists and stars are on. Two of them are *history* (a play
 * that happened, a queue saved to be resumed elsewhere) and one is *now*.
 *
 * Written straight into the tables rather than scanned, like the other API
 * suites: what is under test is what a client is told and what the server keeps.
 *
 * The shapes are the protocol's and they were taken from the specification
 * rather than from a client (`content/en/docs/Endpoints/…` in
 * `opensubsonic/open-subsonic-api`), because several of these fields have no
 * input parameter at all — `playerId` and `playerName` are the server's to
 * derive, and `minutesAgo` is the server's to count.
 */
function collection(): ReturnType<typeof openDb> {
  const db = openDb(':memory:');
  const run = (sql: string, ...args: (string | number | null)[]): void => {
    db.prepare(sql).run(...args);
  };

  run('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)', 'C:/music', '2026-01-01T00:00:00Z');
  run("INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Кино', 'кино', 'Кино')");
  run(
    `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id)
     VALUES (10, 1, 'Кино/45', '45', 'folder', 1)`,
  );

  const track = (id: number, ordinal: number, title: string): void => {
    run(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, 'Кино/45', ?, 'audio', 'flac', 4096, 1000)`,
      100 + id,
      `Кино/45/${String(ordinal).padStart(2, '0')}.flac`,
      `${String(ordinal).padStart(2, '0')}.flac`,
    );
    run(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
       VALUES (?, 10, ?, ?, ?, 60000)`,
      id,
      ordinal,
      title,
      100 + id,
    );
  };

  track(1, 1, 'Группа крови');
  track(2, 2, 'Закрой за мной дверь');
  // Two more, because the queue's worst case needs a track *ahead* of the
  // current one to disappear — the case an index into the surviving list gets
  // wrong and a seat number does not.
  track(3, 3, 'В наших глазах');
  track(4, 4, 'Легенда');

  return db;
}

interface NowPlaying {
  id: string;
  title?: string;
  username?: string;
  minutesAgo?: number;
  playerId?: number;
  playerName?: string;
  state?: string;
  positionMs?: number;
  playbackRate?: number;
}

interface Queue {
  current?: string;
  currentIndex?: number;
  position?: number;
  username?: string;
  changed?: string;
  changedBy?: string;
  entry?: { id: string; title?: string }[];
}

interface Envelope {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
    nowPlaying?: { entry?: NowPlaying[] };
    playQueue?: Queue;
    playQueueByIndex?: Queue;
    song?: { id: string; playCount?: number; played?: string };
  };
}

async function call(db: ReturnType<typeof openDb>, path: string): Promise<Envelope> {
  const served = await ask(db, `${path}${path.includes('?') ? '&' : '?'}f=json`);
  return JSON.parse(served.body.toString('utf8')) as Envelope;
}

/**
 * A database that counts the song selects run through it.
 *
 * A batch's cost *is* its query count: `trackOf` answered with a whole
 * `SongRow`, which is a `SONG_SELECT` — the one that opens `FROM track t` and
 * materializes the album groups — at about 2 ms each on the live collection.
 * Counting them is the deterministic way to hold the fix, because a timing
 * assertion is a test that fails on a busy machine while this one fails only if
 * the batching is undone.
 */
function countingSongs(db: ReturnType<typeof openDb>): {
  db: ReturnType<typeof openDb>;
  selects: () => number;
} {
  let selects = 0;

  const proxy = new Proxy(db as object, {
    get(target, property) {
      const value = (target as Record<string | symbol, unknown>)[property];
      if (property === 'prepare') {
        return (sql: string) => {
          if (/\bFROM track t\b/.test(sql)) selects += 1;
          return (value as (sql: string) => unknown).call(target, sql);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { db: proxy as ReturnType<typeof openDb>, selects: () => selects };
}

test('a batch of ids is resolved in one query, not one per id', async () => {
  // Measured on the live daemon before this was batched: a six-hundred-id
  // `scrobble` took 1122–1243 ms, and a `ping` sent during it waited 1133 ms
  // against 1.8 ms idle. On one thread that is every other client stopped for a
  // second — and the two calls that take a list are the two a client makes with
  // one.
  const db = collection();
  const counted = countingSongs(db);

  await call(counted.db, 'scrobble?id=tr-1&id=tr-2&id=tr-3&id=tr-4&c=Feishin');

  assert.equal(
    counted.selects(),
    0,
    'nothing on the write path needs a whole song row — resolving four ids one at ' +
      'a time would run the album-groups select four times, and six hundred would ' +
      'run it six hundred times',
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM play').get() as { n: number }).n,
    4,
    'and the batch still lands',
  );

  db.close();
});

// --- scrobble: the play, and the notification that one is happening -------

test('a scrobble records that the track was played', async () => {
  const db = collection();

  const answer = await call(db, 'scrobble?id=tr-1&submission=true&c=Feishin');
  assert.equal(answer['subsonic-response'].status, 'ok');

  const plays = db.prepare('SELECT track_id FROM play ORDER BY id').all() as { track_id: number }[];
  assert.deepEqual(
    plays.map((row) => row.track_id),
    [1],
    'the play is the record; nothing else states that it happened',
  );

  db.close();
});

test('a now-playing notification is not a play', async () => {
  // `submission=false` is the client saying "this started", and the protocol
  // separates it from the scrobble a finished track earns. A history that
  // counted both would say a listener had heard everything they had opened.
  const db = collection();

  await call(db, 'scrobble?id=tr-1&submission=false&c=Feishin');

  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM play').get() as { n: number }).n,
    0,
    'a notification is not a play',
  );

  db.close();
});

test('a scrobble of many ids records every one of them', async () => {
  // The protocol spells a list as the parameter repeated, and a client
  // finishing an album sends exactly that.
  const db = collection();

  await call(db, 'scrobble?id=tr-1&id=tr-2&c=Feishin');

  const plays = db.prepare('SELECT track_id FROM play ORDER BY track_id').all() as {
    track_id: number;
  }[];
  assert.deepEqual(plays.map((row) => row.track_id), [1, 2]);

  db.close();
});

test('an id that names nothing is refused, and nothing is recorded', async () => {
  const db = collection();

  const answer = await call(db, 'scrobble?id=tr-99&c=Feishin');

  assert.equal(answer['subsonic-response'].status, 'failed');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM play').get() as { n: number }).n,
    0,
    'a call that named one track that is not here changes nothing rather than half of it',
  );

  db.close();
});

test('a scrobble that names nothing at all is refused', async () => {
  const db = collection();

  const answer = await call(db, 'scrobble?c=Feishin');

  assert.equal(answer['subsonic-response'].status, 'failed');
  assert.match(answer['subsonic-response'].error?.message ?? '', /id/i);

  db.close();
});

// --- getNowPlaying: what is on, and who is playing it ---------------------

test('a now-playing notification makes the track appear in getNowPlaying', async () => {
  const db = collection();

  await call(db, 'scrobble?id=tr-1&submission=false&c=Feishin');
  const answer = await call(db, 'getNowPlaying');
  const entry = answer['subsonic-response'].nowPlaying?.entry?.[0];

  assert.equal(entry?.id, 'tr-1');
  assert.equal(entry?.title, 'Группа крови');
  assert.equal(entry?.username, 'demo', 'the protocol requires a username');
  assert.equal(entry?.playerName, 'Feishin', 'the client is the only player this server can name');
  assert.equal(typeof entry?.playerId, 'number', 'the protocol requires a playerId');
  assert.equal(entry?.minutesAgo, 0, 'it started less than a minute ago');

  db.close();
});

test('getNowPlaying is empty when nothing is playing', async () => {
  const db = collection();

  const answer = await call(db, 'getNowPlaying');

  assert.equal(answer['subsonic-response'].status, 'ok');
  assert.deepEqual(answer['subsonic-response'].nowPlaying?.entry ?? [], []);

  db.close();
});

test('reportPlayback carries the position, and getNowPlaying reports it back', async () => {
  // The `playbackReport` extension: a client says where it is, and the server
  // is what remembers — `getNowPlaying` is read by a *different* client, which
  // is the whole point of the queue and the now-playing list existing at all.
  const db = collection();

  await call(db, 'reportPlayback?mediaId=tr-1&mediaType=song&positionMs=120000&state=playing&c=Feishin');
  const answer = await call(db, 'getNowPlaying');
  const entry = answer['subsonic-response'].nowPlaying?.entry?.[0];

  assert.equal(entry?.id, 'tr-1');
  assert.equal(entry?.state, 'playing');
  assert.equal(entry?.positionMs, 120000);
  assert.equal(entry?.playbackRate, 1, 'the protocol defaults the rate to 1.0');

  db.close();
});

test('a track that leaves the collection leaves the now-playing list', async () => {
  const db = collection();
  await call(db, 'scrobble?id=tr-1&submission=false&c=Feishin');

  db.prepare('DELETE FROM track WHERE id = 1').run();

  const answer = await call(db, 'getNowPlaying');
  assert.deepEqual(
    answer['subsonic-response'].nowPlaying?.entry ?? [],
    [],
    'a row pointing at a track that is gone would name nothing back',
  );

  db.close();
});

// --- the queue: what a listener resumes on another device -----------------

test('a saved queue comes back with its entries, its current track and its position', async () => {
  const db = collection();

  const saved = await call(
    db,
    'savePlayQueue?id=tr-1&id=tr-2&current=tr-1&position=1000&c=Feishin',
  );
  assert.equal(saved['subsonic-response'].status, 'ok');

  const answer = await call(db, 'getPlayQueue');
  const queue = answer['subsonic-response'].playQueue;

  assert.equal(queue?.current, 'tr-1');
  assert.equal(queue?.position, 1000);
  assert.equal(queue?.username, 'demo');
  assert.equal(queue?.changedBy, 'Feishin', 'the protocol requires the client that changed it');
  assert.ok(queue?.changed, 'and when');
  assert.deepEqual(queue?.entry?.map((entry) => entry.id), ['tr-1', 'tr-2']);

  db.close();
});

test('a call with no ids at all clears the queue', async () => {
  // OpenSubsonic's rule, and the opposite of the original: `id` is optional
  // there, and a call without one is how a client says "forget this queue".
  const db = collection();
  await call(db, 'savePlayQueue?id=tr-1&id=tr-2&current=tr-1&c=Feishin');

  await call(db, 'savePlayQueue?c=Feishin');

  const answer = await call(db, 'getPlayQueue');
  assert.deepEqual(answer['subsonic-response'].playQueue?.entry ?? [], []);
  assert.equal(answer['subsonic-response'].playQueue?.current, undefined);

  db.close();
});

test('a queue is saved again whole, not appended to', async () => {
  const db = collection();
  await call(db, 'savePlayQueue?id=tr-1&id=tr-2&current=tr-1&c=Feishin');

  await call(db, 'savePlayQueue?id=tr-2&current=tr-2&c=Feishin');

  const answer = await call(db, 'getPlayQueue');
  assert.deepEqual(answer['subsonic-response'].playQueue?.entry?.map((e) => e.id), ['tr-2']);

  db.close();
});

test('getPlayQueueByIndex answers the same queue by position', async () => {
  // The `indexBasedQueue` extension, and the reason it exists: a queue may hold
  // the same song twice, and `current` — an id — cannot say which of them is
  // playing.
  const db = collection();
  await call(db, 'savePlayQueueByIndex?id=tr-1&id=tr-2&id=tr-1&currentIndex=2&position=500&c=Feishin');

  const answer = await call(db, 'getPlayQueueByIndex');
  const queue = answer['subsonic-response'].playQueueByIndex;

  assert.equal(queue?.currentIndex, 2);
  assert.equal(queue?.position, 500);
  assert.deepEqual(queue?.entry?.map((e) => e.id), ['tr-1', 'tr-2', 'tr-1']);

  db.close();
});

test('an index outside the queue is refused by name', async () => {
  // The specification is explicit: "the server must respond with error code 10".
  const db = collection();

  const answer = await call(db, 'savePlayQueueByIndex?id=tr-1&currentIndex=7&c=Feishin');

  assert.equal(answer['subsonic-response'].status, 'failed');
  assert.equal(answer['subsonic-response'].error?.code, 10);

  db.close();
});

test('a queue entry whose track is gone is dropped with it', async () => {
  const db = collection();
  await call(db, 'savePlayQueue?id=tr-1&id=tr-2&current=tr-1&c=Feishin');

  db.prepare('DELETE FROM track WHERE id = 1').run();

  const answer = await call(db, 'getPlayQueue');
  assert.deepEqual(
    answer['subsonic-response'].playQueue?.entry?.map((e) => e.id),
    ['tr-2'],
    'the queue is a reading of the collection, like a playlist',
  );
  assert.equal(
    answer['subsonic-response'].playQueue?.current,
    'tr-2',
    'the queue is not empty, so the protocol requires a current track — and the ' +
      'one that was playing is gone, so the queue hands over to the next',
  );

  db.close();
});

test('the current track is the one that was saved, not the one that took its place', async () => {
  // **The case a stored index gets wrong.** A track *ahead* of the current one
  // leaves the collection, every entry after it shifts down one, and an index
  // into the surviving list now names its neighbour: `getPlayQueue` announced a
  // song no client had ever had current, and this is exactly the ambiguity the
  // `indexBasedQueue` extension exists to remove. Seats do not shift; the entry
  // that went leaves its number unused.
  const db = collection();
  await call(db, 'savePlayQueue?id=tr-1&id=tr-2&id=tr-3&current=tr-3&c=Feishin');

  db.prepare('DELETE FROM track WHERE id = 1').run();

  const answer = await call(db, 'getPlayQueue');
  assert.equal(answer['subsonic-response'].playQueue?.current, 'tr-3');
  assert.deepEqual(
    answer['subsonic-response'].playQueue?.entry?.map((e) => e.id),
    ['tr-2', 'tr-3'],
  );

  const byIndex = await call(db, 'getPlayQueueByIndex');
  assert.equal(
    byIndex['subsonic-response'].playQueueByIndex?.currentIndex,
    1,
    'the seat moved to the front of what is left, and the index says so',
  );

  db.close();
});

test('a track leaving ahead of the current one does not promote its neighbour', async () => {
  // The symptom the review actually saw, in one line: `current` naming a song no
  // client had ever had current. The queue is [1, 2, 3] and `tr-2` is playing;
  // `tr-1` goes, and every ordinal after it shifts down — so an index now points
  // at `tr-3`.
  const db = collection();
  await call(db, 'savePlayQueue?id=tr-1&id=tr-2&id=tr-3&current=tr-2&c=Feishin');

  db.prepare('DELETE FROM track WHERE id = 1').run();

  const answer = await call(db, 'getPlayQueue');
  assert.equal(answer['subsonic-response'].playQueue?.current, 'tr-2');
  assert.deepEqual(
    answer['subsonic-response'].playQueue?.entry?.map((e) => e.id),
    ['tr-2', 'tr-3'],
  );

  const byIndex = await call(db, 'getPlayQueueByIndex');
  assert.equal(byIndex['subsonic-response'].playQueueByIndex?.currentIndex, 0);

  db.close();
});

test('an index sent with no ids is refused, not taken as a clear', async () => {
  // The specification is explicit that a call with no `id` clears the queue and
  // that `currentIndex` "must not be set" then. A client that sets it has taken
  // this endpoint for the other one, and clearing its queue in silence is the
  // one answer that hides the mistake.
  const db = collection();
  await call(db, 'savePlayQueue?id=tr-1&id=tr-2&current=tr-1&c=Feishin');

  const answer = await call(db, 'savePlayQueueByIndex?currentIndex=0&c=Feishin');

  assert.equal(answer['subsonic-response'].status, 'failed');
  const left = await call(db, 'getPlayQueue');
  assert.deepEqual(
    left['subsonic-response'].playQueue?.entry?.map((e) => e.id),
    ['tr-1', 'tr-2'],
    'the queue nobody asked to clear is still there',
  );

  db.close();
});

// --- the play itself, as a client sees it --------------------------------

test('the time a client states is the time the play is recorded at', async () => {
  // The only thing that dates a play made while the client was offline, which is
  // the case the playback-report extension names by hand.
  const db = collection();
  const when = Date.UTC(2026, 0, 2, 3, 4, 5);

  await call(db, `scrobble?id=tr-1&time=${when}&c=Feishin`);

  const row = db.prepare('SELECT played_at FROM play').get() as { played_at: string };
  assert.equal(row.played_at, new Date(when).toISOString());

  db.close();
});

test('a play reaches a client as a count and a date', async () => {
  // Without this the history is written and never read: the protocol puts both
  // fields on every `Child`, and a scrobble's own description says it "updates
  // the play count and last played timestamp for the media files".
  const db = collection();

  const before = await call(db, 'getSong?id=tr-1');
  assert.equal(before['subsonic-response'].song?.playCount, 0, 'nothing has been played yet');
  assert.equal(before['subsonic-response'].song?.played, undefined);

  await call(db, 'scrobble?id=tr-1&c=Feishin');
  await call(db, 'scrobble?id=tr-1&c=Feishin');

  const after = await call(db, 'getSong?id=tr-1');
  assert.equal(after['subsonic-response'].song?.playCount, 2);
  assert.ok(after['subsonic-response'].song?.played, 'and when the last one was');

  db.close();
});

test('minutesAgo counts whole minutes elapsed, so a track under a minute is nought', () => {
  // The seam `getNowPlaying` takes `now` through, used for the only thing it is
  // for: an entry that is not brand new. A field the protocol calls "last
  // update" answers time elapsed, and rounding it made a track thirty-one
  // seconds in look a minute old.
  const db = collection();
  const start = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  db.prepare("INSERT INTO player (id, name) VALUES (1, 'Feishin')").run();
  db.prepare('INSERT INTO now_playing (player_id, track_id, updated_at) VALUES (1, 1, ?)').run(
    start.toISOString(),
  );

  const entry = (seconds: number) => {
    const answer = getNowPlaying(db, CONFIG, () => new Date(start.getTime() + seconds * 1000)) as {
      nowPlaying: { entry: NowPlaying[] };
    };
    return answer.nowPlaying.entry[0] as NowPlaying;
  };

  assert.equal(entry(31).minutesAgo, 0, 'thirty-one seconds is not a minute');
  assert.equal(entry(90).minutesAgo, 1, 'a minute and a half is one minute, not two');

  db.close();
});
