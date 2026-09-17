import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db/index.ts';
import { refreshFirstTags } from '../src/tags/first.ts';
import { ask } from './helpers/api.ts';

/**
 * The genres, which the scanner has always read and the API never offered.
 *
 * Written straight into the tables rather than scanned, like `api-browse.test.ts`
 * and for the same reason: what is under test is what a client is told, and a
 * fixture that went through the scanner would be asserting the scanner first.
 *
 * The collection it builds is small and deliberately awkward in three ways. One
 * genre value carries a trailing space, which is the only normalisation this
 * project does to a genre and the thing that would otherwise list twice. One
 * album's two files state *different* genres, which is what a compilation is and
 * what makes "the record's genre" a question with more than one answer. And one
 * file states no genre at all, so that "no genre" can be told from "a genre
 * called nothing".
 */
function collection(): ReturnType<typeof openDb> {
  const db = openDb(':memory:');
  const run = (sql: string, ...args: (string | number | null)[]): void => {
    db.prepare(sql).run(...args);
  };

  run('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)', 'C:/music', '2026-01-01T00:00:00Z');
  run("INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Кино', 'кино', 'Кино')");

  for (const [id, relPath, title] of [
    [10, 'Кино/Группа крови', 'Группа крови'],
    [11, 'Кино/Звезда по имени Солнце', 'Звезда по имени Солнце'],
    [12, 'Сборник', 'Сборник'],
  ] as [number, string, string][]) {
    run(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id)
       VALUES (?, 1, ?, ?, 'folder', 1)`,
      id,
      relPath,
      title,
    );
  }

  const file = (id: number, relPath: string): void => {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    run(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, ?, ?, 'audio', 'flac', 4096, 1000)`,
      id,
      relPath,
      relPath.slice(0, relPath.lastIndexOf('/')),
      name,
    );
  };
  file(100, 'Кино/Группа крови/01.flac');
  file(101, 'Кино/Группа крови/02.flac');
  file(102, 'Кино/Звезда по имени Солнце/01.flac');
  file(103, 'Сборник/01.flac');
  file(104, 'Сборник/02.flac');

  const track = (id: number, albumId: number, ordinal: number, title: string, fileId: number): void => {
    run(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 60_000)`,
      id,
      albumId,
      ordinal,
      title,
      fileId,
    );
  };
  track(1, 10, 1, 'Группа крови', 100);
  track(2, 10, 2, 'Закрой за мной дверь', 101);
  track(3, 11, 1, 'Звезда по имени Солнце', 102);
  track(4, 12, 1, 'Something Old', 103);
  track(5, 12, 2, 'Something New', 104);

  const tag = (fileId: number, name: string, value: string, position = 0): void => {
    run('INSERT INTO file_tag (file_id, name, value, position) VALUES (?, ?, ?, ?)', fileId, name, value, position);
  };
  // Two files, one genre each — and the value the second states carries a
  // trailing space, which no one wrote on purpose.
  tag(100, 'genre', 'Rock');
  tag(101, 'genre', 'Rock ');
  tag(102, 'genre', 'Rock');
  // One collection, two genres: this is what the album's genre has to answer for.
  tag(103, 'genre', 'Electronic');
  tag(104, 'genre', 'Ambient');
  // 104 also carries a title, so the file is not wholly untagged.
  tag(104, 'title', 'Something New');

  refresh(db);

  return db;
}

/** The files this fixture has, and the row a listing reads their eight tags off. */
const FILES = [100, 101, 102, 103, 104] as const;

/**
 * Rewrite the row a listing reads, after a test has written `file_tag` by hand.
 *
 * The scanner writes both in one transaction and is the only other writer, so a
 * fixture that moves a tag and forgets this one is describing a collection the
 * scanner cannot produce (task:2925).
 */
function refresh(db: ReturnType<typeof openDb>): void {
  for (const id of FILES) refreshFirstTags(db, id);
}

interface Envelope {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
    genres?: { genre: { value: string; songCount: number; albumCount: number }[] };
    songsByGenre?: { song: { id: string; title: string; genre?: string }[] };
    albumList2?: { album: { id: string; name: string; genre?: string }[] };
    song?: { title: string; genre?: string };
  };
}

async function envelope(db: ReturnType<typeof openDb>, path: string): Promise<Envelope['subsonic-response']> {
  const response = await ask(db, path);
  return (JSON.parse(response.body.toString('utf8')) as Envelope)['subsonic-response'];
}

test('the genres the collection states are listed, with their counts', async () => {
  const db = collection();

  const answer = await envelope(db, 'getGenres?f=json');
  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.genres?.genre, [
    { value: 'Ambient', songCount: 1, albumCount: 1 },
    { value: 'Electronic', songCount: 1, albumCount: 1 },
    { value: 'Rock', songCount: 3, albumCount: 2 },
  ]);

  db.close();
});

test('a genre with whitespace on it is one genre, not two', async () => {
  // The one normalisation this project does to a genre, and the reason it does
  // it: a value is the only thing here that is *shown* rather than matched, and
  // "Rock " beside "Rock" is a list with a duplicate in it that no one can see.
  const db = collection();

  const answer = await envelope(db, 'getGenres?f=json');
  const rock = answer.genres?.genre.filter((one) => one.value === 'Rock');

  assert.equal(rock?.length, 1, 'trimmed, so the two files are one genre');
  assert.equal(rock?.[0]?.songCount, 3);

  db.close();
});

test('the songs of a genre are the songs whose files state it', async () => {
  const db = collection();

  const answer = await envelope(db, 'getSongsByGenre?f=json&genre=Rock');
  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.songsByGenre?.song.map((one) => one.title), [
    'Группа крови',
    'Закрой за мной дверь',
    'Звезда по имени Солнце',
  ]);
  // The song carries its own genre, which is its file's — not the record's.
  assert.equal(answer.songsByGenre?.song[0]?.genre, 'Rock');

  db.close();
});

test('a genre nothing states is an empty list, not a refusal', async () => {
  // A client asks for a genre it was just handed; if the collection changed
  // under it, the answer is that there is nothing there — which is a fact about
  // the collection rather than a fault in the request.
  const db = collection();

  const answer = await envelope(db, 'getSongsByGenre?f=json&genre=Polka');
  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.songsByGenre?.song, []);

  db.close();
});

test('the records of a genre are the records whose files state it', async () => {
  const db = collection();

  const answer = await envelope(db, 'getAlbumList2?f=json&type=byGenre&genre=Rock');
  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.albumList2?.album.map((one) => one.name), [
    'Группа крови',
    'Звезда по имени Солнце',
  ]);

  db.close();
});

test('a record whose files disagree has one genre, and it is the first file that states it', async () => {
  // A compilation is exactly this, and some answer has to be first. The rule is
  // the album's *year* rule — the file order decides — so that the answer is a
  // function of what is in the folder rather than of the order a query visited
  // it in. The song keeps its own genre either way, which is what makes the
  // track list of such a record readable.
  const db = collection();

  const answer = await envelope(db, 'getAlbumList2?f=json&type=byGenre&genre=Electronic');
  assert.deepEqual(answer.albumList2?.album.map((one) => one.name), ['Сборник']);
  assert.equal(answer.albumList2?.album[0]?.genre, 'Electronic');

  // And the other half: the same record is not listed under the genre only its
  // second file states.
  const ambient = await envelope(db, 'getAlbumList2?f=json&type=byGenre&genre=Ambient');
  assert.deepEqual(
    ambient.albumList2?.album.map((one) => one.name),
    ['Сборник'],
    'the record is found by either of its files',
  );

  db.close();
});

test('a record whose files state no genre says nothing rather than nothing-named', async () => {
  const db = collection();
  db.prepare("DELETE FROM file_tag WHERE name = 'genre'").run();
  refresh(db);

  const answer = await envelope(db, 'getAlbumList2?f=json&type=alphabeticalByName');

  assert.equal(answer.albumList2?.album[0]?.genre, undefined, 'absent, not an empty genre');
  assert.equal((await envelope(db, 'getGenres?f=json')).genres?.genre.length, 0);

  db.close();
});

test('a song on a file with no genre carries none', async () => {
  const db = collection();
  db.prepare("DELETE FROM file_tag WHERE file_id = 101 AND name = 'genre'").run();
  refresh(db);

  const answer = await envelope(db, 'getSong?f=json&id=tr-2');

  assert.equal(answer.song?.genre, undefined);

  db.close();
});

test('asking for albums by genre without naming one is refused, and says why', async () => {
  // `byGenre` is the one listing whose argument is not optional — every other
  // one is a way of ordering the whole collection, and this one is a filter.
  const db = collection();

  const answer = await envelope(db, 'getAlbumList2?f=json&type=byGenre');
  assert.equal(answer.status, 'failed');
  assert.match(answer.error?.message ?? '', /genre/);

  db.close();
});

test('the count a client asks for is the count it gets', async () => {
  // The protocol's name for this method's page size is `count`, not `size` —
  // its sibling listing route uses `size` and this one does not. The first
  // version of this read `size` and defaulted to a hundred, so a client asking
  // for `count=2` was handed whatever the server felt like: a caller who names
  // an argument and is not obeyed has been lied to, and neither side can see it.
  const db = collection();

  const answer = await envelope(db, 'getSongsByGenre?f=json&genre=Rock&count=2');

  assert.equal(answer.songsByGenre?.song.length, 2, 'asked for two, given two');

  db.close();
});

test('a genre value that is nothing but whitespace is not a genre', async () => {
  // A name that is a tab is a name nobody can see, and it would sit in the list
  // as an entry that looks empty. SQLite's one-argument `TRIM` removes space and
  // nothing else, which is why the character set is spelled out — with the plain
  // form this value survives the emptiness guard and is listed.
  const db = collection();
  db.prepare("UPDATE file_tag SET value = ? WHERE file_id = 102 AND name = 'genre'").run('\t \n');
  refresh(db);

  const answer = await envelope(db, 'getGenres?f=json');

  assert.deepEqual(answer.genres?.genre.map((one) => one.value), ['Ambient', 'Electronic', 'Rock']);

  db.close();
});

test('a genre padded with something other than a space is trimmed too', async () => {
  const db = collection();
  db.prepare("UPDATE file_tag SET value = ? WHERE file_id = 102 AND name = 'genre'").run('\tRock\n');

  refresh(db);
  const answer = await envelope(db, 'getGenres?f=json');
  const rock = answer.genres?.genre.find((one) => one.value === 'Rock');

  assert.ok(rock, 'the tab and the newline came off');
  assert.equal(rock.songCount, 3, 'and it is the same genre as the two plain files');

  db.close();
});
