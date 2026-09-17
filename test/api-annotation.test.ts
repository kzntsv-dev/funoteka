import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db/index.ts';
import { ask } from './helpers/api.ts';

/**
 * Stars and ratings: what the listener marked, and what a client is shown.
 *
 * The two halves are one feature — a mark nobody can read is not a mark — so
 * every test here sets something and then asks for it the way a client would:
 * through the listings that carry it (`getSong`, `getAlbum`, `getArtist`) and
 * through the starred listings themselves.
 *
 * Written straight into the tables rather than scanned, like the other API
 * suites: what is under test is what a client is told and what the server keeps.
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

  const file = (id: number, relPath: string): void =>
    run(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, 'Кино/45', ?, 'audio', 'flac', 4096, 1000)`,
      id,
      relPath,
      relPath.slice(relPath.lastIndexOf('/') + 1),
    );

  const track = (id: number, ordinal: number, title: string): void => {
    file(100 + id, `Кино/45/${String(ordinal).padStart(2, '0')}.flac`);
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

  return db;
}

interface Envelope {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
    song?: { id: string; starred?: string; userRating?: number };
    album?: {
      id: string;
      starred?: string;
      userRating?: number;
      song?: { id: string; starred?: string }[];
    };
    artist?: { id: string; starred?: string; userRating?: number };
    starred?: Starred;
    starred2?: Starred;
  };
}

interface Starred {
  artist?: { id: string; name: string; starred?: string }[];
  album?: { id: string; name?: string; title?: string; starred?: string }[];
  song?: { id: string; starred?: string; userRating?: number }[];
}

async function envelope(
  db: ReturnType<typeof openDb>,
  path: string,
): Promise<Envelope['subsonic-response']> {
  const response = await ask(db, path);
  return (JSON.parse(response.body.toString('utf8')) as Envelope)['subsonic-response'];
}

async function post(
  db: ReturnType<typeof openDb>,
  method: string,
  fields: [string, string][],
): Promise<Envelope['subsonic-response']> {
  const body = fields
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  const response = await ask(db, `${method}?f=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  return (JSON.parse(response.body.toString('utf8')) as Envelope)['subsonic-response'];
}

test('a starred song says so wherever a client meets it', async () => {
  // The mark is worth nothing if only one listing carries it: the same song
  // arrives through `getSong`, through its record and through a search, and a
  // client that drew a star from one of them and not the others would show the
  // listener a library that disagrees with itself.
  const db = collection();

  const starred = await post(db, 'star', [['id', 'tr-1']]);
  assert.equal(starred.status, 'ok');

  const song = await envelope(db, 'getSong?f=json&id=tr-1');
  assert.ok(song.song?.starred, 'the song carries the date');
  assert.equal(song.song?.userRating, undefined, 'and no rating — nobody gave one');

  const record = await envelope(db, 'getAlbum?f=json&id=al-10');
  const listed = record.album?.song?.find((one) => one.id === 'tr-1');
  assert.ok(listed?.starred, 'the same song in its record carries it too');

  const unstarred = await envelope(db, 'getSong?f=json&id=tr-2');
  assert.equal(unstarred.song?.starred, undefined, 'a song nobody starred says nothing');

  db.close();
});

test('unstarring takes the star and leaves the rating', async () => {
  // Two marks in one row, and the protocol lets a client take one off without
  // the other — a rating that vanished with a star would be a client's work
  // undone by a control it never touched.
  const db = collection();
  await post(db, 'star', [['id', 'tr-1']]);
  await post(db, 'setRating', [
    ['id', 'tr-1'],
    ['rating', '4'],
  ]);

  await post(db, 'unstar', [['id', 'tr-1']]);

  const song = await envelope(db, 'getSong?f=json&id=tr-1');
  assert.equal(song.song?.starred, undefined, 'the star is gone');
  assert.equal(song.song?.userRating, 4, 'the rating is not');

  db.close();
});

test('a rating of nought is a rating taken off, and the row goes with it', async () => {
  // The protocol's own spelling for "no rating", and the row that held only
  // that must not stay behind saying nothing.
  const db = collection();
  await post(db, 'setRating', [
    ['id', 'tr-1'],
    ['rating', '3'],
  ]);

  await post(db, 'setRating', [
    ['id', 'tr-1'],
    ['rating', '0'],
  ]);

  assert.equal((await envelope(db, 'getSong?f=json&id=tr-1')).song?.userRating, undefined);
  const left = db.prepare('SELECT COUNT(*) AS n FROM track_annotation').get() as { n: number };
  assert.equal(left.n, 0, 'a row that says nothing is not kept');

  db.close();
});

test('starring twice keeps the first date', async () => {
  // A client re-sending what it already said has not changed when it said it,
  // and a timestamp that moved on every sync would be a `starred` every client
  // keeps re-reading.
  const db = collection();
  await post(db, 'star', [['id', 'tr-1']]);
  const first = db.prepare('SELECT starred_at FROM track_annotation').get() as { starred_at: string };

  db.prepare("UPDATE track_annotation SET starred_at = '2020-01-01T00:00:00.000Z'").run();
  await post(db, 'star', [['id', 'tr-1']]);

  const after = db.prepare('SELECT starred_at FROM track_annotation').get() as { starred_at: string };
  assert.equal(after.starred_at, '2020-01-01T00:00:00.000Z', 'the first date stands');
  assert.notEqual(first.starred_at, undefined);

  db.close();
});

test('a record and an artist can be starred too, and both listings show it', async () => {
  const db = collection();
  await post(db, 'star', [
    ['albumId', 'al-10'],
    ['artistId', 'ar-1'],
  ]);

  const record = await envelope(db, 'getAlbum?f=json&id=al-10');
  assert.ok(record.album?.starred, 'the record carries its star');

  const artist = await envelope(db, 'getArtist?f=json&id=ar-1');
  assert.ok(artist.artist?.starred, 'and the artist carries theirs');

  const starred2 = await envelope(db, 'getStarred2?f=json');
  assert.equal(starred2.starred2?.artist?.[0]?.id, 'ar-1');
  assert.equal(starred2.starred2?.album?.[0]?.id, 'al-10');
  assert.deepEqual(starred2.starred2?.song, [], 'nothing was starred as a song');

  db.close();
});

test('one call stars a whole list of songs, in the protocol spelling', async () => {
  // `id` repeated once per song, which is how a client stars an album's worth.
  const db = collection();

  await post(db, 'star', [
    ['id', 'tr-1'],
    ['id', 'tr-2'],
  ]);

  const starred2 = await envelope(db, 'getStarred2?f=json');
  assert.equal(starred2.starred2?.song?.length, 2, 'both songs, not the last one');

  db.close();
});

test('the v1 starred listing is the same answer in the older shapes', async () => {
  // A client that predates ID3 browsing asks for `getStarred`, and the two
  // listings are one table read twice — a server that filled one and left the
  // other empty would show half its clients an empty screen.
  const db = collection();
  await post(db, 'star', [
    ['id', 'tr-1'],
    ['albumId', 'al-10'],
    ['artistId', 'ar-1'],
  ]);

  const starred = await envelope(db, 'getStarred?f=json');
  assert.equal(starred.starred?.song?.[0]?.id, 'tr-1');
  assert.equal(starred.starred?.album?.[0]?.id, 'al-10');
  assert.equal(starred.starred?.artist?.[0]?.name, 'Кино');

  db.close();
});

test('an id names whichever of the three it is, the way the protocol says', async () => {
  // `id` is documented as "the file (song) or folder (album/artist)": which of
  // the three it is comes from the id itself, and the two named parameters
  // beside it exist for clients that would rather say it outright. Reading only
  // `tr:` left the other two unreachable through the parameter every client
  // sends.
  const db = collection();

  await post(db, 'star', [['id', 'al-10']]);
  await post(db, 'star', [['id', 'ar-1']]);

  const starred2 = await envelope(db, 'getStarred2?f=json');
  assert.equal(starred2.starred2?.album?.[0]?.id, 'al-10');
  assert.equal(starred2.starred2?.artist?.[0]?.id, 'ar-1');

  db.close();
});

test('a client that names one subject in all three parameters stars it once', async () => {
  // **Measured live, on Castafiore.** It sends `id`, `albumId` and `artistId`
  // all set to the same value — and those two parameters used to be *enforced*
  // as to kind, so `albumId=tr-…` was refused with "No such album", the whole
  // call failed, and the track it had also named in `id` was never starred: the
  // heart never appeared and the client asked again, five times in a row.
  //
  // An id already says which kind it is, so the parameter it arrived in adds
  // nothing to the question. What is *not* relaxed is what the rest of this file
  // is careful about: every id is resolved before anything is written, so a call
  // naming one thing that is not here still changes nothing.
  const db = collection();

  await post(db, 'star', [
    ['id', 'tr-1'],
    ['albumId', 'tr-1'],
    ['artistId', 'tr-1'],
  ]);

  const starred2 = await envelope(db, 'getStarred2?f=json');
  assert.deepEqual(
    starred2.starred2?.song?.map((song) => song.id),
    ['tr-1'],
  );
  assert.deepEqual(starred2.starred2?.album, [], 'and nothing else was starred');

  const refused = await post(db, 'star', [
    ['id', 'tr-2'],
    ['albumId', 'al-999'],
  ]);
  assert.equal(refused.error?.code, 70, 'an id that is not here is still refused');

  const after = await envelope(db, 'getStarred2?f=json');
  assert.deepEqual(
    after.starred2?.song?.map((song) => song.id),
    ['tr-1'],
    'and the refusal changed nothing — tr-2 is not starred',
  );

  db.close();
});

test('a rating reaches a record and an artist, not only a song', async () => {
  // The schema keeps a rating for all three, and both listings already carried
  // it — a rating no client could set was a field nothing could ever fill.
  const db = collection();

  await post(db, 'setRating', [
    ['id', 'al-10'],
    ['rating', '5'],
  ]);
  await post(db, 'setRating', [
    ['id', 'ar-1'],
    ['rating', '3'],
  ]);

  const record = await envelope(db, 'getAlbum?f=json&id=al-10');
  assert.equal(record.album?.userRating, 5);
  const artist = await envelope(db, 'getArtist?f=json&id=ar-1');
  assert.equal(artist.artist?.userRating, 3);

  db.close();
});

test('a star given to a disc of a box lands on the record', async () => {
  // A box is one record with several `album` rows, and a client that stored
  // `al:` for its second disc — which is what every client did while the discs
  // were the albums — is answered about the record. The mark has to land on the
  // row the listings read, or it is written where nothing looks: measured on
  // the live database, starring a disc answered `ok` and appeared in no listing
  // at all.
  const db = collection();
  db.prepare('INSERT INTO release (id, root_id, rel_path, title) VALUES (1, 1, ?, ?)').run(
    'Кино/Бокс',
    'Бокс',
  );
  for (const [id, disc, path] of [
    [11, 1, 'Кино/Бокс/CD1'],
    [12, 2, 'Кино/Бокс/CD2'],
  ] as [number, number, string][]) {
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (?, 1, ?, ?, 'folder', 1, 1, ?)`,
    ).run(id, path, `CD${disc}`, disc);
  }

  // The second disc, and not the row that stands for the record: the first disc
  // is the representative (`ALBUM_GROUPS`), so an id that is not it is exactly
  // the case a client arrives with.
  await post(db, 'star', [['id', 'al-12']]);

  const record = await envelope(db, 'getAlbum?f=json&id=al-12');
  assert.ok(record.album?.starred, 'the record carries the mark, whichever disc was named');
  const starred2 = await envelope(db, 'getStarred2?f=json');
  assert.equal(starred2.starred2?.album?.[0]?.id, 'al-11', 'and it stands for the whole record');

  // And nothing was written against a row no listing reads.
  const rows = (
    db.prepare('SELECT album_id FROM album_annotation').all() as { album_id: number }[]
  ).map((one) => one.album_id);
  assert.deepEqual(rows, [11]);

  db.close();
});

test('marking nothing, or something the library does not have, is refused', async () => {
  const db = collection();

  const missing = await post(db, 'star', [['id', 'tr-99']]);
  assert.equal(missing.status, 'failed');
  assert.equal(missing.error?.code, 70);

  // A kind this server does not mark: `fd:` is a folder of the tree, and there
  // is no row for it to hold a mark.
  const folder = await post(db, 'star', [['id', 'fd-7']]);
  assert.equal(folder.status, 'failed');
  assert.equal(folder.error?.code, 70);

  // And a call that names nothing at all is not `ok`: a client that lost its id
  // on the way has not marked anything, and telling it that it did leaves it
  // showing a star nobody set.
  const silent = await post(db, 'star', []);
  assert.equal(silent.status, 'failed');
  assert.equal(silent.error?.code, 10);

  const left = db.prepare('SELECT COUNT(*) AS n FROM track_annotation').get() as { n: number };
  assert.equal(left.n, 0, 'and nothing was written');

  db.close();
});

test('a starred listing honours the music folder it was asked about', async () => {
  // The protocol's own filter, and every other listing in this API refuses a
  // folder it never handed out. One that accepted the parameter and answered
  // from everywhere would tell a client it was looking at one library while
  // showing it another.
  const db = collection();
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (2, ?, ?)').run(
    'D:/other',
    '2026-01-01T00:00:00Z',
  );
  db.prepare(
    `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id)
     VALUES (20, 2, 'Tool/Lateralus', 'Lateralus', 'folder', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (200, 2, 'Tool/Lateralus/01.flac', 'Tool/Lateralus', '01.flac', 'audio', 'flac', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
     VALUES (3, 20, 1, 'The Grudge', 200, 60000)`,
  ).run();

  await post(db, 'star', [
    ['id', 'tr-1'],
    ['id', 'tr-3'],
  ]);

  const everywhere = await envelope(db, 'getStarred2?f=json');
  assert.equal(everywhere.starred2?.song?.length, 2);

  const oneRoot = await envelope(db, 'getStarred2?f=json&musicFolderId=ro-1');
  assert.deepEqual(oneRoot.starred2?.song?.map((one) => one.id), ['tr-1'], 'only that folder');

  const otherRoot = await envelope(db, 'getStarred2?f=json&musicFolderId=ro-2');
  assert.deepEqual(otherRoot.starred2?.song?.map((one) => one.id), ['tr-3']);

  const unknown = await envelope(db, 'getStarred2?f=json&musicFolderId=ro-99');
  assert.equal(unknown.status, 'failed', 'and a folder this server never gave out is refused');
  assert.equal(unknown.error?.code, 70);

  db.close();
});

test('a rating is a number from nought to five, and is required', async () => {
  const db = collection();

  const seven = await post(db, 'setRating', [
    ['id', 'tr-1'],
    ['rating', '7'],
  ]);
  assert.equal(seven.status, 'failed', 'a client that asked for seven is not told it got five');

  const silent = await post(db, 'setRating', [['id', 'tr-1']]);
  assert.equal(silent.status, 'failed');
  assert.equal(silent.error?.code, 10, '"I forgot to say" is not "set it to nothing"');

  db.close();
});

test('a song that leaves the disk takes its stars and ratings with it', async () => {
  // The mark is about a row of the model, and the row is gone: a star on
  // nothing is not a star, and leaving it would put a song in the starred
  // listing that no longer exists.
  const db = collection();
  await post(db, 'star', [
    ['id', 'tr-1'],
    ['id', 'tr-2'],
  ]);
  await post(db, 'setRating', [
    ['id', 'tr-2'],
    ['rating', '5'],
  ]);

  db.prepare('DELETE FROM track WHERE id = 2').run();

  const starred2 = await envelope(db, 'getStarred2?f=json');
  assert.deepEqual(starred2.starred2?.song?.map((one) => one.id), ['tr-1']);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'and nothing dangles');

  db.close();
});
