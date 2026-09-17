import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { refreshFirstTags } from '../src/tags/first.ts';
import { ask } from './helpers/api.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * Finding something to play: a random draw, a place kept, and the file itself.
 *
 * Three methods that have nothing to do with each other except that they are
 * what a listener does *around* playing — they open the app on something, they
 * stop an audio book and come back to it, and they take a record with them on a
 * train. The shapes are the protocol's, taken from the specification
 * (`opensubsonic/open-subsonic-api`, `content/en/docs/Endpoints/…`) rather than
 * from a client.
 *
 * Written against a real directory, because `download` is bytes off a disk and a
 * fixture that only described the file could not say whether they arrived.
 */

/** Sixteen bytes, so what comes back can be checked by eye. */
const BYTES = Buffer.from('ABCDEFGHIJKLMNOP');

function collection(): { db: ReturnType<typeof openDb>; root: string } {
  const root = tempRoot('funoteka-discovery-');
  mkdirSync(join(root, 'Album'), { recursive: true });
  writeFileSync(join(root, 'Album', 'whole.flac'), BYTES);

  const db = openDb(':memory:');
  const run = (sql: string, ...args: (string | number | null)[]): void => {
    db.prepare(sql).run(...args);
  };

  run('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)', root, '2026-01-01T00:00:00Z');
  run("INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Кино', 'кино', 'Кино')");
  run(
    `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, year)
     VALUES (10, 1, 'Кино/45', '45', 'folder', 1, 1985)`,
  );
  run(
    `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, year)
     VALUES (11, 1, 'Кино/Группа крови', 'Группа крови', 'folder', 1, 1988)`,
  );

  const track = (id: number, albumId: number, ordinal: number, title: string, genre: string): void => {
    // Named by the track's own id and not by its ordinal: two records number
    // their songs from one, and a path built from the number alone collides.
    run(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, 'Кино/45', ?, 'audio', 'flac', 4096, 1000)`,
      100 + id,
      `Кино/45/${id}.flac`,
      `${id}.flac`,
    );
    run(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms) VALUES (?, ?, ?, ?, ?, 60000)`,
      id,
      albumId,
      ordinal,
      title,
      100 + id,
    );
    run("INSERT INTO file_tag (file_id, name, value, position) VALUES (?, 'genre', ?, 0)", 100 + id, genre);
    // And the row a listing reads the eight tags off, which the scanner writes
    // beside them: a fixture that writes the genre and not this is describing a
    // collection the scan cannot produce (task:2925).
    refreshFirstTags(db, 100 + id);
  };

  track(1, 10, 1, 'Восьмиклассница', 'Rock');
  track(2, 10, 2, 'Транквилизатор', 'Rock');
  track(3, 11, 1, 'Группа крови', 'Rock');
  track(4, 11, 2, 'Закрой за мной дверь', 'Post-punk');
  track(5, 11, 3, 'Легенда', 'Post-punk');

  // The one song that is a whole file, so `download` has something to send.
  run(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (900, 1, 'Album/whole.flac', 'Album', 'whole.flac', 'audio', 'flac', ?, 1000)`,
    BYTES.length,
  );
  run(
    `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms) VALUES (900, 10, 9, 'Целая', 900, 60000)`,
  );

  // And one whose *file name* is not ASCII, which is the case the header has to
  // survive: a header value is latin-1, and this collection is full of `Кино`.
  writeFileSync(join(root, 'Album', 'Песня.flac'), BYTES);
  run(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (901, 1, 'Album/Песня.flac', 'Album', 'Песня.flac', 'audio', 'flac', ?, 1000)`,
    BYTES.length,
  );
  run(
    `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms) VALUES (901, 10, 10, 'Песня', 901, 60000)`,
  );

  // And one that is a stretch of an image rather than a file, whose frames
  // cannot be restated — so `download` refuses it rather than re-encoding, which
  // is the branch that used to arrive wearing the song's name.
  writeFileSync(join(root, 'Album', 'image.m4a'), BYTES);
  run(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (950, 1, 'Album/image.m4a', 'Album', 'image.m4a', 'audio', 'm4a', ?, 1000)`,
    BYTES.length,
  );
  run(
    `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms, segment_start_ms, segment_end_ms)
     VALUES (950, 10, 11, 'Кусок', 950, 60000, 1000, 2000)`,
  );

  return { db, root };
}

interface Child {
  id: string;
  title?: string;
  bookmarkPosition?: number;
}

interface Bookmark {
  entry: Child;
  position: number;
  username?: string;
  comment?: string;
  created?: string;
  changed?: string;
}

interface Envelope {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
    randomSongs?: { song?: Child[] };
    bookmarks?: { bookmark?: Bookmark[] };
  };
}

async function call(db: ReturnType<typeof openDb>, path: string): Promise<Envelope> {
  const served = await ask(db, `${path}${path.includes('?') ? '&' : '?'}f=json`);
  return JSON.parse(served.body.toString('utf8')) as Envelope;
}

// --- getRandomSongs: something to open the app on -------------------------

test('getRandomSongs answers with songs from the collection', async () => {
  const { db, root } = collection();

  const answer = await call(db, 'getRandomSongs');
  const songs = answer['subsonic-response'].randomSongs?.song ?? [];

  assert.equal(answer['subsonic-response'].status, 'ok');
  // Counted from the fixture rather than written down: the claim is "every song
  // there is", and a literal here has to be edited every time a test above adds
  // one, which is a number that drifts from the sentence it is meant to check.
  const all = (db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number }).n;
  assert.equal(songs.length, all, 'every song there is, when the default size covers them');
  for (const song of songs) {
    assert.match(song.id, /^tr-\d+$/u, 'each one is a song a client can ask for by id');
    assert.ok(song.title);
  }

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('getRandomSongs takes no more than its size, and no more than five hundred', async () => {
  const { db, root } = collection();

  const two = await call(db, 'getRandomSongs?size=2');
  assert.equal(two['subsonic-response'].randomSongs?.song?.length, 2);

  // The ceiling is the protocol's, and a client that asks for more is answered
  // with five hundred rather than with a refusal — the number is a limit rather
  // than a promise, and refusing would break a client over its own arithmetic.
  const many = await call(db, 'getRandomSongs?size=5000');
  const all = (db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number }).n;
  assert.equal(many['subsonic-response'].randomSongs?.song?.length, all);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('getRandomSongs draws differently from one call to the next', async () => {
  // The whole point of the method, and the one thing about it that a shape
  // cannot show. Thirty draws of one song from five: a server that always
  // answered the same song would repeat itself every time, and the odds of five
  // songs doing that by chance are none worth printing.
  const { db, root } = collection();

  const drawn = new Set<string>();
  for (let at = 0; at < 30; at += 1) {
    const answer = await call(db, 'getRandomSongs?size=1');
    drawn.add(answer['subsonic-response'].randomSongs?.song?.[0]?.id ?? '');
  }

  assert.ok(drawn.size > 1, `thirty draws produced ${drawn.size} distinct song(s)`);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('getRandomSongs answers only what the filters name', async () => {
  const { db, root } = collection();

  const postPunk = await call(db, 'getRandomSongs?genre=Post-punk&size=10');
  assert.deepEqual(
    (postPunk['subsonic-response'].randomSongs?.song ?? []).map((s) => s.id).sort(),
    ['tr-4', 'tr-5'],
  );

  // A genre nothing states is an empty draw rather than every song.
  const none = await call(db, 'getRandomSongs?genre=Jazz&size=10');
  assert.deepEqual(none['subsonic-response'].randomSongs?.song ?? [], []);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('getRandomSongs honours a range of years and a music folder', async () => {
  const { db, root } = collection();

  const older = await call(db, 'getRandomSongs?toYear=1985&size=10');
  assert.deepEqual(
    (older['subsonic-response'].randomSongs?.song ?? []).map((s) => s.id).sort(),
    ['tr-1', 'tr-2', 'tr-900', 'tr-901', 'tr-950'],
  );

  const folder = await call(db, 'getRandomSongs?musicFolderId=ro-1&size=10');
  const all = (db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number }).n;
  assert.equal(folder['subsonic-response'].randomSongs?.song?.length, all);

  // A folder this server never handed out is refused, the rule every listing
  // here follows: answering from every folder would tell a client it was looking
  // at one library while showing it another.
  const nowhere = await call(db, 'getRandomSongs?musicFolderId=ro-99');
  assert.equal(nowhere['subsonic-response'].status, 'failed');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- bookmarks: where a listener stopped ------------------------------

test('a bookmark is kept with its position, its comment and its dates', async () => {
  const { db, root } = collection();

  const made = await call(db, 'createBookmark?id=tr-1&position=129000&comment=side%20two');
  assert.equal(made['subsonic-response'].status, 'ok');

  const answer = await call(db, 'getBookmarks');
  const marks = answer['subsonic-response'].bookmarks?.bookmark ?? [];

  assert.equal(marks.length, 1);
  const mark = marks[0] as Bookmark;
  assert.equal(mark.position, 129000);
  assert.equal(mark.username, 'demo', 'the protocol requires it');
  assert.equal(mark.comment, 'side two');
  assert.ok(mark.created, 'and when it was made');
  assert.equal(mark.changed, mark.created, 'a bookmark just made has not been changed since');
  assert.equal(mark.entry.id, 'tr-1');
  assert.equal(mark.entry.title, 'Восьмиклассница');
  assert.equal(
    mark.entry.bookmarkPosition,
    129000,
    'and the entry carries it too — that is what a client draws the resume mark from',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('bookmarking the same song again moves the mark rather than adding one', async () => {
  // The protocol's own words: "If a bookmark already exists for this file it
  // will be overwritten." Two marks on one song would leave a client with two
  // resume points and no way to choose.
  const { db, root } = collection();

  const first = await call(db, 'createBookmark?id=tr-1&position=1000&comment=first');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await call(db, 'createBookmark?id=tr-1&position=2000');

  const answer = await call(db, 'getBookmarks');
  const marks = answer['subsonic-response'].bookmarks?.bookmark ?? [];

  assert.equal(marks.length, 1);
  const mark = marks[0] as Bookmark;
  assert.equal(mark.position, 2000);
  assert.equal(mark.comment, undefined, 'the comment went with the position that carried it');
  assert.notEqual(mark.changed, mark.created, 'and the change is dated');
  assert.ok(mark.created);
  assert.ok(first['subsonic-response'].status === 'ok');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a bookmark is deleted by the song it marks', async () => {
  const { db, root } = collection();
  await call(db, 'createBookmark?id=tr-1&position=1000');

  const gone = await call(db, 'deleteBookmark?id=tr-1');
  assert.equal(gone['subsonic-response'].status, 'ok');

  const answer = await call(db, 'getBookmarks');
  assert.deepEqual(answer['subsonic-response'].bookmarks?.bookmark ?? [], []);

  // Deleting one that is not there is the state the client asked for, so it is
  // answered `ok` rather than refused: a client tidying up after itself must not
  // be told it did something wrong.
  const again = await call(db, 'deleteBookmark?id=tr-1');
  assert.equal(again['subsonic-response'].status, 'ok');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a bookmark names a song that is there, and a position that is a position', async () => {
  const { db, root } = collection();

  const nowhere = await call(db, 'createBookmark?id=tr-99&position=1000');
  assert.equal(nowhere['subsonic-response'].status, 'failed');
  assert.equal(nowhere['subsonic-response'].error?.code, 70);

  const nowhereEither = await call(db, 'deleteBookmark?id=tr-99');
  assert.equal(nowhereEither['subsonic-response'].status, 'failed');

  const missing = await call(db, 'createBookmark?id=tr-1');
  assert.equal(missing['subsonic-response'].status, 'failed');
  assert.equal(missing['subsonic-response'].error?.code, 10, 'position is required');

  const negative = await call(db, 'createBookmark?id=tr-1&position=-1');
  assert.equal(negative['subsonic-response'].status, 'failed');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a bookmark goes with the song whose file is gone', async () => {
  const { db, root } = collection();
  await call(db, 'createBookmark?id=tr-1&position=1000');

  db.prepare('DELETE FROM track WHERE id = 1').run();

  const answer = await call(db, 'getBookmarks');
  assert.deepEqual(
    answer['subsonic-response'].bookmarks?.bookmark ?? [],
    [],
    'a mark on a song that is gone marks nothing',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- download: the file itself --------------------------------------------

test('download sends the file, byte for byte', async () => {
  const { db, root } = collection();

  const served = await ask(db, 'download?id=tr-900');
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(served.body), BYTES, 'the original bytes, not a re-encode');
  assert.equal(served.headers.get('content-length'), String(BYTES.length));

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('download names the file it sends, so a client can save it', async () => {
  const { db, root } = collection();

  const served = await ask(db, 'download?id=tr-900');

  assert.match(
    served.headers.get('content-disposition') ?? '',
    /attachment/,
    'this is the method a client saves with',
  );
  assert.match(served.headers.get('content-disposition') ?? '', /whole\.flac/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('download names a file this collection could have', async () => {
  // Both halves of the header, and the second is the one that matters here: a
  // header value is latin-1, so a file called `Песня.flac` cannot be named in
  // `filename` at all — `setHeader` throws on it — and the real name has to ride
  // in `filename*`, percent-encoded. A test with only ASCII names exercises
  // neither branch.
  const { db, root } = collection();

  const served = await ask(db, 'download?id=tr-901');
  const disposition = served.headers.get('content-disposition') ?? '';

  assert.equal(served.status, 200);
  assert.match(disposition, /filename="_____\.flac"/u, 'the plain name is the ASCII stand-in');
  assert.match(
    disposition,
    /filename\*=UTF-8''%D0%9F%D0%B5%D1%81%D0%BD%D1%8F\.flac/u,
    'and the real one is percent-encoded, so a client that reads it saves the right name',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a refused download carries no name to save it under', async () => {
  // The refusal is an envelope, and an envelope is not a file. `download` sets
  // the name before it knows whether it can send anything — the header has to be
  // in place before the bytes start — so a refusal arriving afterwards used to
  // arrive with `attachment; filename="…m4a"` beside it, and a client that
  // trusts the 200 saves the error under the song's name (task:2864).
  const { db, root } = collection();

  const served = await ask(db, 'download?id=tr-950');

  assert.equal(served.status, 200);
  assert.match(served.body.toString('utf8'), /failed/, 'it is a refusal');
  assert.equal(
    served.headers.get('content-disposition'),
    null,
    'and nothing tells a client to save it',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('download of a song that is not there is refused in the protocol, not as a status', async () => {
  // The specification's own words: "Returns binary data on success, or an XML
  // document on error". A client that asked for bytes and got a 404 reads a
  // broken server rather than a refusal it can show.
  const { db, root } = collection();

  const served = await ask(db, 'download?id=tr-99');

  assert.equal(served.status, 200, 'the status is not where a Subsonic client reads a refusal');
  assert.match(served.body.toString('utf8'), /failed/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});
