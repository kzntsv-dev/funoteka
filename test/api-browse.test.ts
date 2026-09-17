import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { albumChild, albumId3, parseId } from '../src/api/browse.ts';
import type { ServerConfig } from '../src/api/config.ts';
import { createServer } from '../src/api/server.ts';
import { openDb } from '../src/db/index.ts';
import { refreshFirstTags } from '../src/tags/first.ts';

type Db = ReturnType<typeof openDb>;

const CONFIG: ServerConfig = {
  dbPath: ':memory:',
  host: '127.0.0.1',
  port: 0,
  user: 'demo',
  password: 'sesame',
  apiKey: '',
  ffmpeg: 'ffmpeg',
    cacheDir: '/tmp/funoteka-cache-test',
  logFile: '',
  logRequests: false,
  cors: false,
  showJunk: false,
};

const ROOT = 'C:/music';

// The collection these tests browse. Written straight into the tables rather
// than scanned: what is under test is what a client is told, and a fixture that
// went through the scanner would be asserting the scanner first.
//
// It carries the three shapes the contract names. A box: one release, two disc
// albums. Two pressings: one album title in two folders. A cue album: one image
// file and three songs cut from it.
function collection(): Db {
  const db = openDb(':memory:');
  const run = (sql: string, ...args: (string | number | null)[]): void => {
    db.prepare(sql).run(...args);
  };

  run('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)', ROOT, '2026-01-01T00:00:00Z');

  for (const [id, name, key, sort] of [
    [1, 'The Cure', 'cure', 'Cure, The'],
    [2, 'Nirvana', 'nirvana', 'Nirvana'],
    [3, 'Tool', 'tool', 'Tool'],
  ] as [number, string, string, string][]) {
    run('INSERT INTO artist (id, name, name_key, sort_key) VALUES (?, ?, ?, ?)', id, name, key, sort);
  }

  run(
    `INSERT INTO release (id, root_id, rel_path, title, artist_id, title_source)
     VALUES (1, 1, 'The Cure/Show', 'Show', 1, 'folder')`,
  );

  const albums: [number, string, string, number, number | null, number | null][] = [
    // id, rel_path, title, artist, release, disc
    [10, 'The Cure/Show/CD1', 'Show', 1, 1, 1],
    [11, 'The Cure/Show/CD2', 'Show', 1, 1, 2],
    [12, 'The Cure/Disintegration', 'Disintegration', 1, null, null],
    [13, 'The Cure/Disintegration (Remaster)', 'Disintegration', 1, null, null],
    [20, 'Nirvana/Nevermind', 'Nevermind', 2, null, null],
    [30, 'Tool/Lateralus', 'Lateralus', 3, null, null],
  ];
  for (const [id, relPath, title, artist, release, disc] of albums) {
    run(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (?, 1, ?, ?, 'folder', ?, ?, ?)`,
      id,
      relPath,
      title,
      artist,
      release,
      disc,
    );
  }

  const folders: [number, string, string, string | null][] = [
    [1, '', '', null],
    [2, 'The Cure', '', 'category'],
    [3, 'The Cure/Show', 'The Cure', 'box'],
    [4, 'The Cure/Show/CD1', 'The Cure/Show', 'disc'],
    [5, 'The Cure/Show/CD2', 'The Cure/Show', 'disc'],
    [6, 'The Cure/Disintegration', 'The Cure', 'album'],
    [7, 'The Cure/Disintegration (Remaster)', 'The Cure', 'album'],
    [8, 'Nirvana', '', 'category'],
    [9, 'Nirvana/Nevermind', 'Nirvana', 'album'],
    [10, 'Tool', '', 'category'],
    [11, 'Tool/Lateralus', 'Tool', 'album'],
  ];
  for (const [id, relPath, parent, role] of folders) {
    run(
      'INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role) VALUES (?, 1, ?, ?, ?)',
      id,
      relPath,
      parent,
      role,
    );
  }

  const file = (id: number, relPath: string): void => {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    const folder = relPath.slice(0, relPath.lastIndexOf('/'));
    run(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, ?, ?, 'audio', 'flac', 4096, 1000)`,
      id,
      relPath,
      folder,
      name,
    );
  };
  file(100, 'The Cure/Show/CD1/01.flac');
  file(101, 'The Cure/Show/CD1/02.flac');
  file(102, 'The Cure/Show/CD2/01.flac');
  file(103, 'The Cure/Disintegration/01.flac');
  file(104, 'The Cure/Disintegration/02.flac');
  file(105, 'The Cure/Disintegration (Remaster)/01.flac');
  file(110, 'Nirvana/Nevermind/01.flac');
  file(130, 'Tool/Lateralus/image.flac');

  const track = (
    id: number,
    albumId: number,
    ordinal: number,
    title: string,
    fileId: number,
    start: number | null,
    end: number | null,
    duration: number,
  ): void => {
    run(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      albumId,
      ordinal,
      title,
      fileId,
      start,
      end,
      duration,
    );
  };

  track(1000, 10, 1, 'Plainsong', 100, null, null, 300_000);
  track(1001, 10, 2, 'Pictures of You', 101, null, null, 400_000);
  track(1002, 11, 1, 'Prayers for Rain', 102, null, null, 350_000);
  track(1003, 12, 1, 'Plainsong', 103, null, null, 305_000);
  track(1004, 12, 2, 'Pictures of You', 104, null, null, 405_000);
  track(1005, 13, 1, 'Plainsong', 105, null, null, 310_000);
  track(1010, 20, 1, 'Smells Like Teen Spirit', 110, null, null, 301_000);
  track(1020, 30, 1, 'The Grudge', 130, 0, 5_000, 5_000);
  track(1021, 30, 2, 'Eon Blue Apocalypse', 130, 5_000, 6_000, 1_000);
  track(1022, 30, 3, 'The Patient', 130, 6_000, 12_000, 6_000);

  return db;
}

interface Answer {
  'subsonic-response': Record<string, any> & {
    status: string;
    error?: { code: number; message: string };
  };
}

/** One authenticated call, against a server that is up only for this call. */
async function call(db: Db, path: string): Promise<Record<string, any>> {
  const server = createServer(db, CONFIG);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(
      `http://127.0.0.1:${port}/rest/${path}${separator}u=demo&p=sesame&f=json`,
    );
    const body = (await response.json()) as Answer;
    const envelope = body['subsonic-response'];
    if (envelope.status === 'failed') return envelope;
    return envelope;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test('getIndexes files an artist under the letter its sort name starts with', () => {
  // `The Cure` is browsed under C, which is the whole reason the meta layer
  // keeps a sort key apart from the name — and the list of articles the server
  // moved has to travel with the answer, because the client is the one that
  // decides where to put everything else it is shown.
  const db = collection();

  return call(db, 'getIndexes').then((envelope) => {
    const indexes = envelope.indexes;
    assert.equal(indexes.ignoredArticles, 'The');

    const letters = Object.fromEntries(
      indexes.index.map((entry: { name: string }) => [entry.name, entry]),
    );
    assert.deepEqual(Object.keys(letters).sort(), ['C', 'N', 'T']);
    // Three records: the box and the two pressings. The count is of what
    // `getArtist` will list, and the box's two discs are one record there.
    // The id is the node's, not the artist's: a client that follows it is sent
    // to the folders under the artist, which is what the count beside it is a
    // count of. The picture is still the artist's own.
    assert.deepEqual(letters.C.artist, [
      { id: 'vn:cure', name: 'The Cure', albumCount: 3, coverArt: 'ar-1' },
    ]);
    assert.equal(letters.N.artist[0].name, 'Nirvana');

    // The library first, then the roots: clients that browse by directory
    // rather than by tag build their tree from here, and this one does — it saw
    // the roots alone and the virtual top was reachable only through
    // `getMusicDirectory(-1)`, which it never asked.
    assert.deepEqual(
      indexes.child.map((child: { id: string }) => child.id),
      ['vn:', 'ro-1'],
    );
    assert.equal(indexes.child[0].isDir, true);
    db.close();
  });
});

test('getArtist lists its records, and a box is one of them', () => {
  // A box is a release with one album row per disc, and a client is offered the
  // *record*. Showing the discs instead is what this test was written against
  // after the live collection showed `CD1 ● Альбом`, `CD2 ● …`, `CD3 ● …` as
  // three albums and the record's own name nowhere.
  const db = collection();

  return call(db, 'getArtist?id=ar-1').then((envelope) => {
    const artist = envelope.artist;
    assert.equal(artist.name, 'The Cure');
    assert.equal(artist.albumCount, 3);

    const ids = artist.album.map((album: { id: string }) => album.id).sort();
    assert.deepEqual(ids, ['al-10', 'al-12', 'al-13']);

    // The box carries the release's name once, the songs of both its discs, and
    // no disc number — a record is not a disc, and `discNumber` is what the
    // *songs* use to say which disc they are on.
    const box = artist.album.find((album: { id: string }) => album.id === 'al-10');
    assert.equal(box.name, 'Show');
    assert.equal(box.songCount, 3);
    assert.equal(box.duration, 1050);
    assert.equal(box.discNumber, undefined);
    db.close();
  });
});

test('a box opens as one record, from either of its discs', async () => {
  // Every client that stored an id while the discs were the albums holds a
  // disc id. Resolving it to the record is what keeps those clients working —
  // and it is the same record either way, not two answers that nearly agree.
  const db = collection();
  try {
    const first = (await call(db, 'getAlbum?id=al-10')).album;
    const second = (await call(db, 'getAlbum?id=al-11')).album;

    for (const album of [first, second]) {
      assert.equal(album.name, 'Show');
      assert.equal(album.songCount, 3);
      // Disc by disc, then by the ordinal within a disc: the second disc's only
      // song comes last even though its ordinal is 1.
      assert.deepEqual(album.song.map((song: { title: string }) => song.title), [
        'Plainsong',
        'Pictures of You',
        'Prayers for Rain',
      ]);
      assert.deepEqual(album.song.map((song: { discNumber: number }) => song.discNumber), [1, 1, 2]);
      // And every song names the record, so a client following a song's album
      // lands on the box rather than on one of its discs.
      assert.deepEqual(
        album.song.map((song: { albumId: string }) => song.albumId),
        ['al-10', 'al-10', 'al-10'],
      );
    }

    assert.deepEqual(first.song, second.song, 'the same record, asked for two ways');
  } finally {
    db.close();
  }
});

test('a standalone album is not swept into a box that shares its id', () => {
  // `album.id` and `release.id` are two independent sequences, so a group key of
  // `COALESCE(release_id, id)` files album 1 with release 1: different tables,
  // same integer, and nothing in the value saying which. It is not hypothetical
  // — on the live collection a Cock E.S.P record (album 9) was listed as the
  // record of a Kino box (release 9), and the box then vanished from its artist
  // entirely, because the row chosen to stand for the group belonged to someone
  // else.
  const db = collection();
  db.prepare(
    `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
     VALUES (1, 1, 'Tool/Undertow', 'Undertow', 'folder', 3, NULL, NULL)`,
  ).run();

  return call(db, 'getArtist?id=ar-1').then((envelope) => {
    assert.equal(envelope.artist.albumCount, 3, 'the box is still one record of its own');
    const box = envelope.artist.album.find((album: { id: string }) => album.id === 'al-10');
    assert.equal(box.name, 'Show');
    assert.equal(box.songCount, 3);
    db.close();
  });
});

test('a record is offered the edition its folder names, and no version when it names none', () => {
  // `AlbumID3.version` is where the protocol keeps "which edition is this" — the
  // label, the catalogue number, `Special Edition` — and it is read off the
  // record's folder, which is the same string the name comes from. `Группа
  // крови` and `Группа Крови (Gold Castle Rec.)` are one album by one band, and
  // a client shown the bare title five times cannot choose between them.
  const row = {
    id: 7,
    root_id: 1,
    rel_path: 'The Cure/Show (Deluxe Edition)',
    title: 'Show',
    artist_id: 1,
    artist_name: 'The Cure',
    artist_sort: 'Cure, The',
    release_title: 'Show',
    disc_number: null,
    year: 1993,
    genre: null,
    song_count: 2,
    duration_ms: 1000,
    release_id: 1,
    starred_at: null,
    rating: null,
  };

  assert.equal(albumId3(row).version, 'Deluxe Edition');
  assert.equal(albumId3({ ...row, rel_path: 'The Cure/Show' }).version, undefined);

  // And a record whose name was written verbatim — a tag named it, note and
  // all — is not told twice. What is compared is the note's own *words*, and
  // not the brackets either side wrote them in: `Кинохроники 2021/1982 (2019,
  // Maschina Records, MASHCD-099)` carries `Maschina Records, MASHCD-099`, the
  // pressing's year being no part of the note.
  const verbatim = {
    ...row,
    rel_path: 'Кино/Кинохроники 2021/1982 (2019, Maschina Records, MASHCD-099)',
    title: 'Кинохроники 2021/1982 (2019, Maschina Records, MASHCD-099)',
  };
  assert.equal(albumId3(verbatim).version, undefined);
});

test('the tree says a note the title already carries, once, whatever brackets it is in', () => {
  // `recordTitle` is what writes a folder's note into a title, and it writes
  // *round* brackets with the pressing's own year off. So a folder stating the
  // note in square ones leaves a title the folder's spelling does not match —
  // and asking the folder's spelling said the catalogue number twice:
  // `2004 - Join The Dots (EU Polydor 981 463-0) [EU Polydor 981 463-0]`.
  // Measured over the live library: 34 records read that way in the tree, and
  // 18 in the album list, before both asked `unsaidNote` (task:2845).
  const row = {
    id: 13,
    root_id: 1,
    rel_path: 'The Cure/Compilations/2004 - Join The Dots [EU Polydor 981 463-0]',
    title: 'Join The Dots (EU Polydor 981 463-0)',
    artist_id: 1,
    artist_name: 'The Cure',
    artist_sort: 'Cure, The',
    release_title: null,
    disc_number: null,
    year: 2004,
    genre: null,
    song_count: 2,
    duration_ms: 1000,
    release_id: null,
    // The listener's marks. Nothing here starred this record — see
    // `api-meta`'s select, which joins them for every listing alike.
    starred_at: null,
    rating: null,
  };

  assert.equal(albumChild(row, 'vn:cure').title, '2004 - Join The Dots (EU Polydor 981 463-0)');
  assert.equal(albumId3(row).name, 'Join The Dots (EU Polydor 981 463-0)');

  // A title that says nothing about the pressing is owed it — in the brackets
  // the folder wrote it in for the tree, and in round ones for the album.
  const silent = { ...row, title: 'Join The Dots' };
  assert.equal(albumChild(silent, 'vn:cure').title, '2004 - Join The Dots [EU Polydor 981 463-0]');
  assert.equal(albumId3(silent).name, 'Join The Dots (EU Polydor 981 463-0)');
});

test('a row without a disc number does not stand for the record', async () => {
  // A group is represented by its **lowest disc**: `ALBUM_GROUPS` orders by disc
  // number, and everything a client is shown for a record comes off that one row
  // — its `al:` id, its name, its year. A row with no disc number sorted as
  // zero, which put it *first*, so a folder sitting inside a disc — a bonus
  // folder, an extra directory — could stand for the whole record and answer
  // with its own name and its own absent year.
  //
  // No such row exists in the live collection: 0 albums carry a release without
  // a disc number, and no album's path lies inside a disc folder (task:2843).
  // This is the shape it would be, so that the ordering is not the thing that
  // decides it.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (90, 1, 'The Cure/Show/CD1/Bonus', 'Bonus', 'folder', 1, 1, NULL)`,
    ).run();

    const album = (await call(db, 'getAlbum?id=al-10')).album;
    assert.equal(album.name, 'Show', 'the record is still named after its disc');
    assert.deepEqual(
      album.song.map((song: { albumId: string }) => song.albumId),
      ['al-10', 'al-10', 'al-10'],
      'and its songs still name the lowest disc',
    );
  } finally {
    db.close();
  }
});

test('a disc that names itself beyond its number is reported, and one that does not is silent', () => {
  // The discs of a box are not albums a client browses, so the name a disc
  // carries — `CD2 ● Ранний вариант` — has nowhere to go in the listing. The
  // protocol's `discTitles` is where it goes.
  const db = collection();
  db.prepare("UPDATE album SET title = 'CD2 ● Ранний вариант' WHERE id = 11").run();

  return call(db, 'getAlbum?id=al-10').then((envelope) => {
    assert.deepEqual(envelope.album.discTitles, [{ disc: 2, title: 'Ранний вариант' }]);

    // The first disc is called `Show`, which is the record's own name: a
    // subtitle repeating it labels nothing.
    db.prepare("UPDATE album SET title = 'Show' WHERE id = 11").run();
    return call(db, 'getAlbum?id=al-10').then((second) => {
      assert.equal(second.album.discTitles, undefined);
      db.close();
    });
  });
});

test('two pressings of one album are two albums, and are never merged', () => {
  // The contract's first rule, seen from a client: same title, same artist, two
  // folders — two albums with two ids. A server that merged them would be
  // exactly the failure this project exists to avoid.
  const db = collection();

  return call(db, 'getAlbumList2?type=alphabeticalByName&size=100').then((envelope) => {
    const named = envelope.albumList2.album.filter((album: { name: string }) =>
      album.name.startsWith('Disintegration'),
    );
    assert.equal(named.length, 2, 'both pressings are listed');
    assert.notEqual(named[0].id, named[1].id, 'and they are two ids, not one');
    // And now they read apart: the pressing one of their folders states reaches
    // its name, where before both were `Disintegration` to a client that does not
    // render `version`.
    assert.deepEqual(
      named.map((album: { name: string }) => album.name).sort(),
      ['Disintegration', 'Disintegration (Remaster)'],
      'two records, told apart by name',
    );
    db.close();
  });
});

test('getAlbum returns the songs a client plays, in order', () => {
  const db = collection();

  return call(db, 'getAlbum?id=al-12').then((envelope) => {
    const album = envelope.album;
    assert.equal(album.name, 'Disintegration');
    assert.equal(album.artist, 'The Cure');
    assert.equal(album.artistId, 'ar-1');
    assert.equal(album.songCount, 2);
    assert.equal(album.duration, 710);

    const [first, second] = album.song;
    assert.equal(first.title, 'Plainsong');
    assert.equal(first.track, 1);
    assert.equal(first.isDir, false);
    assert.equal(first.albumId, 'al-12');
    assert.equal(first.artistId, 'ar-1');
    assert.equal(first.album, 'Disintegration');
    assert.equal(first.suffix, 'flac');
    assert.equal(first.size, 4096);
    assert.equal(first.duration, 305);
    assert.equal(first.path, `${ROOT}/The Cure/Disintegration/01.flac`);
    assert.equal(first.parent, 'al-12');
    assert.equal(second.track, 2);
    db.close();
  });
});

test('a cue album is as many songs as the cue has tracks, each from the one image', () => {
  // One file on disk, three songs to a client — the split the whole scanner
  // exists for, seen from the outside. Every song names the image it is cut
  // from, and carries the length of its own segment rather than the file's.
  const db = collection();

  return call(db, 'getAlbum?id=al-30').then((envelope) => {
    const album = envelope.album;
    assert.equal(album.songCount, 3);
    assert.deepEqual(
      album.song.map((song: { title: string }) => song.title),
      ['The Grudge', 'Eon Blue Apocalypse', 'The Patient'],
    );
    assert.deepEqual(
      album.song.map((song: { duration: number }) => song.duration),
      [5, 1, 6],
    );
    assert.deepEqual(
      album.song.map((song: { path: string }) => song.path),
      Array(3).fill(`${ROOT}/Tool/Lateralus/image.flac`),
      'one image, three songs on it',
    );
    assert.equal(album.duration, 12, "the album's length is its songs', not the file's");
    db.close();
  });
});

test('an id from before the separator changed is still the same row', () => {
  // **Both separators are read, and only one is written.** `tr:112384` is what
  // this API handed out until the hyphen replaced the colon — the reason is in
  // `parseId`, and it is a client that reads the id's alphabet rather than
  // treating it as opaque. A client holding an id from before (a queued song,
  // an offline list) has to reach the same row rather than a not-found, so both
  // spellings are one id and this test is what keeps that true.
  for (const kind of ['ar', 'al', 'tr', 'fd', 'ro'] as const) {
    assert.deepEqual(parseId(`${kind}:7`), { kind, n: 7 }, `${kind}:7 still parses`);
    assert.deepEqual(parseId(`${kind}-7`), { kind, n: 7 }, `${kind}-7 is what is written now`);
  }

  // And an id of a kind this API does not hold is still nothing, in either
  // spelling: `pl` is refused here so that `getSong` can truthfully answer "no
  // such id" about a playlist.
  assert.equal(parseId('pl:4725'), undefined);
  assert.equal(parseId('pl-4725'), undefined);
  assert.equal(parseId('nonsense'), undefined);
});

test('an artist says what it is in the library, and only what can be shown', async () => {
  // `ArtistID3.roles` — "the list of all roles this artist has in the library" —
  // which a client buckets its views by. The operator's Symfonium has an "album
  // artists" view and a "composers" one, and the second was empty because no
  // artist was anything at all (task:2896).
  //
  // Two roles are claimed and neither is guessed: `albumartist` for an artist a
  // record is credited to, `artist` for one credited on a track. `composer` is
  // deliberately absent — see `rolesOf`: sixteen names in this collection state
  // one, and one of them is an artist.
  const db = collection();

  const envelope = await call(db, 'getArtists');
  const artists = (envelope.artists.index as { artist: { name: string; roles?: string[] }[] }[])
    .flatMap((index) => index.artist);
  assert.ok(artists.length > 0, 'the fixture offers artists, so this is about something');

  for (const artist of artists) {
    assert.ok(artist.roles !== undefined, `${artist.name} says what it is`);
    assert.deepEqual(
      [...new Set(artist.roles)].sort(),
      artist.roles,
      `${artist.name}: every role once, in one order`,
    );
    for (const role of artist.roles) {
      assert.ok(
        ['albumartist', 'artist'].includes(role),
        `${artist.name}: ${role} is one of the two this server will claim`,
      );
    }
  }

  // The Cure owns a record, so it is both — and it is the *record's* artist that
  // carries the second role, which is this model's own fact: a record's artist
  // is its tracks' artist.
  const cure = artists.find((artist) => artist.name === 'The Cure');
  assert.deepEqual(cure?.roles, ['albumartist', 'artist']);

  db.close();
});

test('a song cut out of an image says its own length, not the image\'s', async () => {
  // **The operator found this bringing clients up against the server.** A
  // six-minute song inside a 465 MB image answered `size: 465472848`, and 1789
  // of this collection's tracks are cut from images. A client that sizes a
  // download by this field, or decides by size whether it will stream something
  // at all, was being told a number two orders of magnitude wrong.
  //
  // What it answers instead is derived, and the derivation is measured against a
  // real cut — Whole Lotta Love out of a 510 MB image: 68 334 081 against
  // 68 863 475 bytes, 0.8% low. Here: 1651579 bps for the image times the
  // track's own 5000 ms, over 8000.
  const db = collection();
  db.prepare(
    `INSERT INTO audio_probe (file_id, codec, sample_rate, channels, bitrate, probe_ok, probe_method)
     VALUES (130, 'flac', 44100, 2, 1651579, 1, 1)`,
  ).run();

  const envelope = await call(db, 'getAlbum?id=al-30');
  const songs = envelope.album.song as { id: string; size?: number }[];

  assert.equal(songs.find((song) => song.id === 'tr-1020')?.size, 1_032_237);
  assert.ok(
    songs.every((song) => song.size !== 4096),
    'the image\'s length is what none of them answer',
  );
  db.close();
});

test('a song whose image nobody measured a bitrate for says no size at all', async () => {
  // `size` is `Req. No`, and this server's rule for a number nobody measured is
  // to leave the field out rather than fill it with something else — the rule
  // `maxBitRate` already follows for a file whose bitrate is unknown. The one
  // answer that must not come back is the image's length again, which is what
  // the fixture's tracks would say if the estimate were the only change.
  const db = collection();

  const envelope = await call(db, 'getAlbum?id=al-30');
  const songs = envelope.album.song as { id: string; size?: number }[];

  assert.equal(songs.length, 3);
  assert.ok(
    songs.every((song) => song.size === undefined),
    'no measurement, no number',
  );
  db.close();
});

test('getSong answers for one song, and an id it does not hold is a not-found', () => {
  const db = collection();

  return call(db, 'getSong?id=tr-1003')
    .then((envelope) => {
      assert.equal(envelope.song.title, 'Plainsong');
      assert.equal(envelope.song.album, 'Disintegration');
      assert.equal(envelope.song.artist, 'The Cure');
      return call(db, 'getSong?id=tr-9999');
    })
    .then((envelope) => {
      assert.equal(envelope.status, 'failed');
      assert.equal(envelope.error?.code, 70);
      db.close();
    });
});

test('a file whose artist tag is only whitespace names no artist', () => {
  // The record has no artist of its own — a compilation is the shape — so the
  // file's tag is the only thing that could answer for the song, and the answer
  // it gives has to be nothing.
  //
  // `TRIM(X)` removes spaces and *nothing else*, which is the trap this pins:
  // SQLite's one-argument form leaves a tab where it found it, so `"\t"` passes
  // an `<> ''` guard and reaches a client as an artist whose name is invisible.
  // The claim is not academic — `annotation` at `meta.ts` spells the character
  // set out for exactly this reason, and the artist lookup was the one place
  // still reading the short form.
  const db = collection();
  db.prepare('UPDATE album SET artist_id = NULL WHERE id = 30').run();
  db.prepare("INSERT INTO file_tag (file_id, name, value, position) VALUES (130, 'artist', ?, 0)").run(
    'King Crimson',
  );
  refreshFirstTags(db, 130);

  return call(db, 'getSong?id=tr-1020')
    .then((envelope) => {
      // The control: the path is live, and answers when the tag says something.
      assert.equal(envelope.song.artist, 'King Crimson');
      db.prepare("UPDATE file_tag SET value = ? WHERE file_id = 130 AND name = 'artist'").run('\t');
      refreshFirstTags(db, 130);
      return call(db, 'getSong?id=tr-1020');
    })
    .then((envelope) => {
      assert.equal(envelope.song.artist, '');
      db.close();
    });
});

test('getMusicDirectory walks the folders a scan found, and the songs in them', () => {
  const db = collection();

  return call(db, 'getMusicDirectory?id=-1')
    .then((envelope) => {
      // `-1` is the protocol's own way of asking for the top of the tree, which
      // for this server is the library and, beside it, the roots it was told to
      // scan. The root below is untouched by the virtual top: what the walk
      // found is still what it lists.
      assert.deepEqual(
        envelope.directory.child.map((child: { id: string; title: string }) => [child.id, child.title]),
        [
          ['vn:', 'Музыка'],
          ['ro-1', 'music'],
        ],
      );
      return call(db, 'getMusicDirectory?id=ro-1');
    })
    .then((envelope) => {
      assert.deepEqual(
        envelope.directory.child.map((child: { title: string }) => child.title),
        ['Nirvana', 'The Cure', 'Tool'],
        'the folders directly under the root, in one settled order',
      );
      return call(db, 'getMusicDirectory?id=fd-3');
    })
    .then((envelope) => {
      assert.deepEqual(
        envelope.directory.child.map((child: { title: string }) => child.title),
        ['CD1', 'CD2'],
        'the box itself holds discs, not songs',
      );
      return call(db, 'getMusicDirectory?id=fd-6');
    })
    .then((envelope) => {
      const songs = envelope.directory.child;
      assert.equal(songs.length, 2);
      assert.equal(songs[0].isDir, false);
      assert.equal(songs[0].title, 'Plainsong');
      assert.equal(songs[0].parent, 'fd-6');
      db.close();
    });
});

test('a root is named by its last folder, however its path is written', () => {
  // Found on the first collection this ran against rather than in a fixture: a
  // root configured on Windows is written with backslashes, and the listing
  // named it by its entire path — `C:\Users\...\Кино ● Каталог` — which is not a
  // thing to show anyone. A relative path always uses forward slashes, so one
  // separator was never enough.
  const db = collection();
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (2, ?, ?)').run(
    'D:\\music\\Кино',
    '2026-01-01T00:00:00Z',
  );

  return call(db, 'getMusicDirectory?id=ro-2').then((envelope) => {
    assert.equal(envelope.directory.name, 'Кино');
    db.close();
  });
});

test('getAlbumList2 pages, and refuses a listing it cannot honestly answer', () => {
  const db = collection();

  return call(db, 'getAlbumList2?type=alphabeticalByName&size=2&offset=0')
    .then((envelope) => {
      assert.deepEqual(
        envelope.albumList2.album.map((album: { name: string }) => album.name),
        ['Disintegration', 'Disintegration (Remaster)'],
        'the two pressings sort together, and now read apart',
      );
      return call(db, 'getAlbumList2?type=alphabeticalByName&size=2&offset=2');
    })
    .then((envelope) => {
      assert.deepEqual(
        envelope.albumList2.album.map((album: { name: string }) => album.name),
        ['Lateralus', 'Nevermind'],
      );
      return call(db, 'getAlbumList2?type=random&size=2');
    })
    .then((envelope) => {
      assert.equal(envelope.albumList2.album.length, 2);
      return call(db, 'getAlbumList2?type=starred');
    })
    .then((envelope) => {
      // **The listener's own lists answer now.** This used to assert a refusal,
      // on the reasoning that nothing in the meta layer records a star — true
      // when it was written, false since v1.2 added the marks and the history.
      // With no star set, the honest answer is the empty list: "nothing is
      // starred" is a claim this server can make, and the classic client's
      // screens were empty for want of it (task:2896).
      assert.equal(envelope.status, 'ok');
      assert.deepEqual(envelope.albumList2.album, [], 'nothing is starred, and that is what it says');
      return call(db, 'getAlbumList2?type=mood');
    })
    .then((envelope) => {
      // And a listing with no such meaning is still refused rather than answered
      // with an arbitrary page.
      assert.equal(envelope.status, 'failed');
      assert.match(envelope.error?.message ?? '', /mood/);
      db.close();
    });
});

test('the listener’s own lists are ordered by what they marked and played', async () => {
  // The four the classic client asks for and got three empty screens from:
  // `starred`, `highest`, `recent`, `frequent`. Each is an *order* over albums
  // and each is empty when there is nothing to order by — a "most played" list
  // of albums nobody played is not a list.
  const db = collection();

  // Two records marked and rated differently, and plays on two of them.
  db.prepare(
    `INSERT INTO album_annotation (album_id, starred_at, rating) VALUES (12, '2026-01-01T00:00:00Z', 3)`,
  ).run();
  db.prepare(
    `INSERT INTO album_annotation (album_id, starred_at, rating) VALUES (20, '2026-02-01T00:00:00Z', 5)`,
  ).run();
  db.prepare(
    `INSERT INTO track_play (track_id, play_count, played_at) VALUES (1003, 4, '2026-03-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO track_play (track_id, play_count, played_at) VALUES (1010, 9, '2026-02-01T00:00:00Z')`,
  ).run();

  const names = async (type: string): Promise<string[]> => {
    const envelope = await call(db, `getAlbumList2?type=${type}&size=10`);
    assert.equal(envelope.status, 'ok', `${type} answers`);
    return (envelope.albumList2.album as { name: string }[]).map((album) => album.name);
  };

  assert.deepEqual(await names('starred'), ['Nevermind', 'Disintegration'], 'most recently starred first');
  assert.deepEqual(await names('highest'), ['Nevermind', 'Disintegration'], 'the higher rating first');
  assert.deepEqual(await names('recent'), ['Disintegration', 'Nevermind'], 'last played first');
  assert.deepEqual(await names('frequent'), ['Nevermind', 'Disintegration'], 'most plays first');

  // And an album nobody marked is not in the marked lists.
  const starred = await names('starred');
  assert.ok(!starred.includes('Lateralus'), 'nothing was marked on it');

  db.close();
});

test('the year a record lists under is the year a range finds it by', async () => {
  // `byYear` was the one axis the server refused while holding the value: every
  // record carries a year — the release's where it has one, its folder's
  // otherwise — and a client's "by year" tab was empty for want of a filter, not
  // for want of a number. Both bounds are required rather than defaulted: a range
  // whose end was invented is not the range the client asked for.
  const db = collection();
  try {
    db.prepare(`UPDATE album SET year = 1989, year_source = 'folder' WHERE id = 12`).run();
    db.prepare(`UPDATE album SET year = 2009, year_source = 'folder' WHERE id = 13`).run();
    db.prepare(`UPDATE album SET year = 1991, year_source = 'folder' WHERE id = 20`).run();
    db.prepare(`UPDATE album SET year = 2001, year_source = 'folder' WHERE id = 30`).run();

    const years = async (query: string): Promise<number[]> => {
      const list = await call(db, `getAlbumList2?${query}`);
      return list.albumList2.album.map((one: { year: number }) => one.year);
    };

    assert.deepEqual(
      await years('type=byYear&fromYear=1989&toYear=1991&size=50'),
      [1989, 1991],
      'both ends are included, and it reads oldest first',
    );
    assert.deepEqual(
      await years('type=byYear&fromYear=2000&toYear=2010&size=50'),
      [2001, 2009],
      'and a decade none of them are in is an empty list, not an error',
    );
    assert.deepEqual(await years('type=byYear&fromYear=1970&toYear=1980&size=50'), []);

    const missing = await call(db, 'getAlbumList2?type=byYear&fromYear=1989');
    assert.equal(missing.status, 'failed', 'a bound that was not sent is refused');
    assert.match(String(missing.error?.message ?? ''), /toYear/);
  } finally {
    db.close();
  }
});

test('a record is named by its title everywhere, and the year only in the tree', async () => {
  // The operator settled this in two steps. First the albums view was reported
  // showing the year twice; then the other three lists were asked about, and
  // all three draw it themselves. So the rule is not "the tree and the artist
  // page" — it is the folder tree and nothing else: every list outside it
  // renders the protocol's own `year`, and a name carrying one repeats it.
  //
  // The tree is the one place with no such field on screen, which is why the
  // year leads there and only there.
  const db = collection();
  try {
    db.prepare(`UPDATE album SET year = 1993, year_source = 'folder' WHERE id = 12`).run();

    const list = await call(db, 'getAlbumList2?type=alphabeticalByName&size=50');
    const listed = list.albumList2.album.find((one: { id: string }) => one.id === 'al-12');
    assert.equal(listed.name, 'Disintegration', 'the albums view shows the title alone');
    assert.equal(listed.year, 1993, 'and the year in the field that view draws from');

    const artist = await call(db, 'getArtist?id=ar-1');
    const page = artist.artist.album.find((one: { id: string }) => one.id === 'al-12');
    assert.equal(page.name, 'Disintegration', 'the artist page draws the year too');

    const album = await call(db, 'getAlbum?id=al-12');
    assert.equal(album.album.name, 'Disintegration', 'and so does the album page');

    const tree = await call(db, 'getMusicDirectory?id=vn:cure');
    const entry = tree.directory.child.find((one: { id: string }) => one.id === 'al-12');
    assert.equal(
      entry.title,
      '1993 - Disintegration',
      'the tree draws no year, so the name is where it is said',
    );
  } finally {
    db.close();
  }
});

test('the index counts what the node it opens actually holds', async () => {
  // A row that says one number and opens a different one is the defect this
  // project keeps finding. The count is asked for separately now, without
  // reading the records it counts, and that is exactly the shape that lets the
  // two drift apart — so the invariant is pinned here rather than assumed.
  const db = collection();
  try {
    const indexes = await call(db, 'getIndexes');
    const rows = (indexes.indexes.index as { artist: { id: string; albumCount: number }[] }[])
      .flatMap((group) => group.artist);
    assert.ok(rows.length > 0, 'the fixture offers rows');

    for (const row of rows) {
      const opened = await call(db, `getArtist?id=${encodeURIComponent(row.id)}`);
      assert.equal(
        row.albumCount,
        opened.artist.albumCount,
        `${row.id}: the index says ${row.albumCount}, the node opens ${opened.artist.albumCount}`,
      );
    }
  } finally {
    db.close();
  }
});

test('getMusicFolders offers the roots, under the ids getIndexes gives the same folders', async () => {
  // A client that connects to more than one library asks this first, and it is
  // emphatic that it uses the ids it is given rather than inventing them — so an
  // id this server does not offer is one it can never be asked to search in.
  const db = collection();
  try {
    // Folders on disk, and only those: the library is a view of the collection
    // rather than a folder in it, and offering it here claims something about
    // the disk that is not true.
    const folders = await call(db, 'getMusicFolders');
    assert.deepEqual(folders.musicFolders.musicFolder, [{ id: 'ro-1', name: 'music' }]);

    // What the two must agree on is not the list but the *ids*: whatever a
    // client is offered to choose between, it must be able to browse. The
    // library is offered by `getIndexes` and accepted as a choice, so an id
    // this server hands out is never one it then refuses.
    const indexes = await call(db, 'getIndexes');
    for (const child of indexes.indexes.child) {
      const opened = await call(db, `getMusicDirectory?id=${encodeURIComponent(child.id)}`);
      assert.equal(opened.status, 'ok', `${child.id} is offered and must open`);
      const confined = await call(db, `getIndexes?musicFolderId=${encodeURIComponent(child.id)}`);
      assert.equal(confined.status, 'ok', `${child.id} is offered and must be a usable choice`);
    }
  } finally {
    db.close();
  }
});

test('getArtists answers about artists, and getIndexes about the whole top', async () => {
  // The protocol grew `getArtists` when it moved from browsing folders to
  // browsing tags, and the two are different questions now: this list is who is
  // in the collection by tag, and that one is what the top of the library holds
  // — which includes the shelves that are nobody's artist, and which the client
  // this library is read in draws its folder view from, and only from.
  const db = collection();
  try {
    // The shelf, and a record filed on it. The record is the point: a node with
    // nothing under it is not offered at all (`VirtualNode.records`), so a
    // fixture that gave the shelf no album would be asking about a folder the
    // library has no reason to show — measured on the live collection, all 31
    // top-level folders that are not `empty` hold at least one record.
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (58, 1, 'Серия «Подлинная история»', '', 'category')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source)
       VALUES (58, 1, 'Серия «Подлинная история»/(1) 2005', '(1) 2005', 'folder')`,
    ).run();

    const artists = await call(db, 'getArtists');
    const indexes = await call(db, 'getIndexes');

    assert.equal(artists.artists.ignoredArticles, indexes.indexes.ignoredArticles);
    assert.ok(artists.artists.child === undefined, 'no folders here: an artist is an artist');

    const named = (envelope: Record<string, any>): string[] =>
      envelope.artists.index.flatMap((group: { artist: { name: string }[] }) =>
        group.artist.map((one) => one.name),
      );

    assert.deepEqual(named(artists), ['The Cure', 'Nirvana', 'Tool'], 'artists only, filed by sort key');
    assert.ok(
      indexes.indexes.index
        .flatMap((group: { artist: { name: string }[] }) => group.artist.map((one) => one.name))
        .includes('Серия «Подлинная история»'),
      'and the top of the library holds what belongs to no artist',
    );
  } finally {
    db.close();
  }
});

test('a song the collection never named is given the word the dump gives it', async () => {
  // The meta layer keeps null, and it is right to: a cue that says `(empty)` has
  // stated that this division of the disc has no name, and dressing that hole up
  // in the scan would be inventing a title. The protocol has no way to say it,
  // though — an empty title is not read as an absence, and a client fails a
  // whole sync over one song without a title — so the API says `(untitled)`,
  // which is what the inventory dump already prints for the same row.
  const db = collection();
  try {
    db.prepare('UPDATE track SET title = NULL WHERE id = 1000').run();

    const album = await call(db, 'getAlbum?id=al-10');
    const song = album.album.song.find((entry: { id: string }) => entry.id === 'tr-1000');
    assert.equal(song.title, '(untitled)');
    assert.equal(typeof song.title, 'string');

    const search = await call(db, 'getSong?id=tr-1000');
    assert.equal(search.song.title, '(untitled)', 'and by the route that asks for one song');
  } finally {
    db.close();
  }
});

test('getUser describes the one account there is, roles and folders included', async () => {
  // A client asks this on the way in, and Feishin will not add a server without
  // it — it reads a record of roles out of the answer and falls over on a
  // missing one. Every role is granted because the account is not restricted;
  // several of them name features this server does not have, and a client that
  // asks for one is refused by name like anything else it cannot do.
  const db = collection();
  try {
    const answer = await call(db, 'getUser');
    const user = answer.user;

    assert.equal(user.username, 'demo');
    assert.equal(user.adminRole, true);
    assert.equal(user.streamRole, true);
    assert.equal(user.playlistRole, true);
    assert.equal(user.scrobblingEnabled, false, 'nothing here scrobbles');
    assert.deepEqual(user.folder, ['ro-1'], 'the same ids getMusicFolders hands out');

    const byName = await call(db, 'getUser?username=demo');
    assert.equal(byName.user.username, 'demo');

    const stranger = await call(db, 'getUser?username=someone');
    assert.equal(stranger.status, 'failed');
    assert.equal(stranger.error?.code, 70);
  } finally {
    db.close();
  }
});

test('every shape that can be shown with a picture says which id to ask for one', async () => {
  // A client that is not told the id draws a placeholder, which is exactly how
  // the whole library looked in the first browser client pointed at this server
  // — the art was there behind `getCoverArt` all along, and nothing said so.
  const db = collection();
  try {
    const album = await call(db, 'getAlbum?id=al-10');
    assert.equal(album.album.coverArt, 'al-10');
    assert.equal(album.album.song[0].coverArt, 'al-10', 'a song’s art is its record’s');

    const artist = await call(db, 'getArtist?id=ar-1');
    assert.equal(artist.artist.coverArt, 'ar-1');
    // Disintegration, not the box: an artist's records are ordered by disc
    // number, and a record with none sorts before one that has it.
    assert.equal(artist.artist.album[0].coverArt, 'al-12');

    const directory = await call(db, 'getArtist?id=ar-1');
    assert.equal(directory.artist.album[0].coverArt, 'al-12', 'and in a directory listing');
  } finally {
    db.close();
  }
});

test('a record states the year its folder names, and a song borrows it', async () => {
  // The classifier has always parsed this out of the folder name and thrown it
  // away — `1988. Группа крови` was filed under `Группа крови` and the 1988 was
  // lost on the same line — which is why no client could show a release date.
  const db = collection();
  try {
    db.prepare(`UPDATE album SET year = 1993, year_source = 'folder' WHERE id = 12`).run();

    const artist = await call(db, 'getArtist?id=ar-1');
    const record = artist.artist.album.find((one: { id: string }) => one.id === 'al-12');
    assert.equal(record.year, 1993);

    const album = await call(db, 'getAlbum?id=al-12');
    assert.equal(album.album.year, 1993);
    assert.equal(album.album.song[0].year, 1993, 'a song is as old as its record');

    const bare = await call(db, 'getAlbum?id=al-20');
    assert.equal('year' in bare.album, false, 'and a record with no year says nothing');
    assert.equal('year' in bare.album.song[0], false, 'rather than saying zero');
  } finally {
    db.close();
  }
});

test('a compilation with no artist of its own names each track from its own file', () => {
  // The case the operator found on material they brought in: a tribute album of
  // thirteen acts, one per track, no `albumartist` anywhere. `albumArtistOf`
  // refuses to choose between thirteen names, which is right — but the refusal
  // left every track nameless in a client, while each file's own tag said who
  // performed it. The record's artist still wins wherever there is one; this is
  // the fallback for the case where there is not.
  const db = collection();
  db.prepare(
    "INSERT INTO album (id, root_id, rel_path, title, title_source) VALUES (50, 1, 'Satori', 'Satori', 'folder')",
  ).run();
  for (const [id, ordinal, title, artist] of [
    [710, 1, 'Spirit', 'Hamlet Machine & Sponge'],
    [711, 2, 'Mask', 'Dummy'],
  ] as [number, number, string, string][]) {
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, 'Satori', ?, 'audio', 'mp3', 4096, 1000)`,
    ).run(id, `Satori/0${ordinal}.mp3`, `0${ordinal}.mp3`);
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
       VALUES (?, 50, ?, ?, ?, NULL, NULL, 60_000)`,
    ).run(id, ordinal, title, id);
    db.prepare("INSERT INTO file_tag (file_id, name, value, position) VALUES (?, 'artist', ?, 0)").run(id, artist);
    refreshFirstTags(db, id);
  }

  return call(db, 'getAlbum?id=al-50').then((envelope) => {
    assert.equal(envelope.album.artist, '', 'the record has no artist, and says so');
    assert.deepEqual(
      envelope.album.song.map((song: { title: string; artist: string }) => [song.title, song.artist]),
      [
        ['Spirit', 'Hamlet Machine & Sponge'],
        ['Mask', 'Dummy'],
      ],
    );
  });
});

test('a track no file names falls back to the artist of its record', () => {
  // This test used to be called "the record artist still wins over the file the
  // moment there is one", and it was the other half of a rule that had the order
  // the wrong way round: a band's album shows the band, yes, but the field for
  // that is `albumArtist` and not `artist`. The order made `artist` answer for
  // the record, which was wrong for 1492 songs of the live collection — every
  // compilation and every split (task:2850).
  //
  // What survives of it is the fallback, and it is the half worth keeping: a
  // track whose file states no artist is still named, and named after its
  // record.
  const db = collection();

  return call(db, 'getAlbum?id=al-12').then((envelope) => {
    assert.equal(envelope.album.artist, 'The Cure');
    for (const song of envelope.album.song) {
      assert.equal(song.artist, 'The Cure');
      assert.equal(song.albumArtist, 'The Cure');
    }
  });
});

test('a box is as old as the box, not as old as its first disc', async () => {
  // The two years answer different questions, and `COALESCE(rep.year,
  // rel.year)` asked the disc's first. `Show` is a 1993 live album whose first
  // disc holds 1987 recordings, so the record was stated as 1987 — the year of
  // one of its discs rather than of itself. Measured on the live collection:
  // `The Cure - Assemblage - 1991 (12CD FLAC)` was shown as 1979, which is what
  // its first disc holds.
  //
  // The release is asked first because a record *is* its release where it has
  // one. The other order was written for a box that states its year on the box
  // folder and whose discs state none — `1988 ● Группа крови (…)` over `CD1` —
  // and that case is unharmed: `COALESCE` falls through to the disc exactly
  // when the release says nothing, which is also what keeps a flat disc-pair
  // release dated by the disc that names it.
  const db = collection();
  try {
    db.prepare(`UPDATE release SET year = 1993 WHERE id = 1`).run();
    db.prepare(`UPDATE album SET year = 1987, year_source = 'folder' WHERE id = 10`).run();

    const artist = await call(db, 'getArtist?id=ar-1');
    const record = artist.artist.album.find((one: { id: string }) => one.id === 'al-10');
    assert.equal(record.year, 1993, 'the record is as old as the box it is');

    const album = await call(db, 'getAlbum?id=al-10');
    assert.equal(album.album.year, 1993);
    assert.equal(album.album.song[0].year, 1993, 'and so is everything on it');
  } finally {
    db.close();
  }
});

test('the top of the tree is the library, and the roots stay beside it', async () => {
  // The virtual top is what the collection *is*; the root is what is on the
  // disk. Both, because wiki:3498 §5 asks that the physical tree stay reachable
  // as one of the views, and a client that wants it should not have to be
  // configured for it.
  const db = collection();
  try {
    const top = await call(db, 'getMusicDirectory?id=-1');
    assert.deepEqual(
      top.directory.child.map((c: { title: string }) => c.title),
      ['Музыка', 'music'],
    );
    assert.equal(top.directory.child[0].id, 'vn:');
  } finally {
    db.close();
  }
});

test('a shelf is gathered into the artist it is named after', async () => {
  // `The Cure AAC 320` is a second rip of the same records, filed beside the
  // artist's own folder. Two folders, one artist — and the node holds what is
  // under *both*, which is the whole reason the id is not the artist's.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (50, 1, 'The Cure AAC 320', '', 'category')`,
    ).run();
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (51, 1, 'The Cure AAC 320/1993 - Show', 'The Cure AAC 320', 'album')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (60, 1, 'The Cure AAC 320/1993 - Show', 'Show', 'folder', 1, null, null)`,
    ).run();

    const top = await call(db, 'getMusicDirectory?id=vn:');
    const names = top.directory.child.map((c: { title: string }) => c.title);
    assert.equal(names.filter((n: string) => n === 'The Cure').length, 1, 'one node, not two');
    assert.equal(names.includes('The Cure AAC 320'), false, 'the shelf is not a node of its own');

    const node = top.directory.child.find((c: { title: string }) => c.title === 'The Cure');
    assert.equal(node.id, 'vn:cure', 'an artist node is keyed by the fold, not by a folder');

    const inside = await call(db, `getMusicDirectory?id=${node.id}`);
    const records = inside.directory.child.map((c: { title: string }) => c.title);
    // One of them is filed in the shelf beside the artist's own folder, so it
    // is labelled with its year and the other is not — the entries are records,
    // not folders, and a record says when it came out.
    assert.equal(
      records.filter((t: string) => /Show$/.test(t)).length,
      2,
      'both rips of `Show` are there',
    );
    assert.ok(records.includes('Disintegration'), 'and the artists own records with them');
  } finally {
    db.close();
  }
});

test('a folder that is nobody and nothing keeps its own name', async () => {
  // A series, a shelf of compilations, a folder that is not music at all. It is
  // shown under the name the collector gave it and opens as a folder always
  // did — the tree decides what the top *is*, not what every folder means.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (51, 1, 'Серия «Подлинная история»', '', 'category')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (61, 1, 'Серия «Подлинная история»/1968 - Пластинка', 'Пластинка', 'folder', 2, null, null)`,
    ).run();

    const top = await call(db, 'getMusicDirectory?id=vn:');
    const node = top.directory.child.find(
      (c: { title: string }) => c.title === 'Серия «Подлинная история»',
    );
    assert.ok(node, 'the folder is a node of its own');
    assert.equal(node.id, 'fd-51', 'and it keeps its own id, because one folder is the whole of it');
  } finally {
    db.close();
  }
});

test('a folder holding nothing playable is left out of the library', async () => {
  // The root of this collection is also the operator's Downloads: 1029 of its
  // 1558 folders are installers and drivers, and none of them is part of a
  // music library.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (52, 1, 'Photoshop.2022', '', 'empty')`,
    ).run();

    const top = await call(db, 'getMusicDirectory?id=vn:');
    const names = top.directory.child.map((c: { title: string }) => c.title);
    assert.equal(names.includes('Photoshop.2022'), false);
  } finally {
    db.close();
  }
});

test('an artist is offered only if they own a folder of their own', async () => {
  // Twenty-two of the thirty-seven artists this collection credits are names a
  // *tag* wrote while the folders filed the record somewhere else: eleven acts
  // across the splits in `Cock E.S.P/`, one Slipknot single credited to `All Out
  // Life`, four Кино records to `Виктор Цой`. The folder decides — the
  // operator's rule and the one the virtual tree already keeps — so the list a
  // client browses by is the folder owners, and a credit is reached by search.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO artist (id, name, name_key, sort_key) VALUES (4, 'All Out Life', 'all out life', 'All Out Life')`,
    ).run();
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (53, 1, 'The Cure/2018 - All Out Life', 'The Cure', 'album')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (70, 1, 'The Cure/2018 - All Out Life', 'All Out Life', 'folder', 4, null, null)`,
    ).run();

    const listed = await call(db, 'getArtists');
    const names = listed.artists.index.flatMap((group: { artist: { name: string }[] }) =>
      group.artist.map((one) => one.name),
    );
    assert.equal(names.includes('All Out Life'), false, 'a credit with no folder is not offered');
    assert.ok(names.includes('The Cure'), 'and the folder owner still is');

    // The record itself is untouched: it belongs to `The Cure/` and the tree
    // files it there, and its own credit is what a search finds it by.
    const inside = await call(db, 'getMusicDirectory?id=vn:cure');
    const titles = inside.directory.child.map((c: { title: string }) => c.title);
    assert.ok(
      titles.some((t: string) => /All Out Life$/.test(t)),
      'the record is under the artist whose folder holds it',
    );
  } finally {
    db.close();
  }
});

test('the records under a node are read by year, and their names say it', async () => {
  // Path order is the collector's shelves — `Compilations/`, `Deluxe Editions/`,
  // `Live Albums/` — so this artist listed every compilation from 1983 to 2004,
  // then every deluxe edition from 2004 on, and the year jumped at every shelf
  // boundary. The operator's report on it was that it read as alphabetical.
  //
  // A folder is a folder and keeps its order; what is *shown* for it is a
  // record, and records are read by when they came out. The year leads the name
  // for the same reason: a client showing a list of entries is not obliged to
  // render the year field, and one that does not would show titles alone.
  const db = collection();
  try {
    db.prepare(`UPDATE release SET year = 1993 WHERE id = 1`).run();
    db.prepare(`UPDATE album SET year = 1987, year_source = 'folder' WHERE id = 12`).run();
    db.prepare(`UPDATE album SET year = 2009, year_source = 'folder' WHERE id = 13`).run();

    const inside = await call(db, 'getMusicDirectory?id=vn:cure');
    const titles = inside.directory.child.map((c: { title: string }) => c.title);
    // Two of them are both called `Disintegration` — one the 1987 album, one a
    // 2009 remaster — and the year in front is what tells them apart in a list
    // a client draws. The remaster says so as well, because its *folder* does:
    // `The Cure/Disintegration (Remaster)`, in the round brackets that folder
    // wrote. The tree is the folder view, so a note the folder states reaches
    // the name here as it reaches it everywhere else (task:2783).
    assert.deepEqual(titles, [
      '1987 - Disintegration',
      '1993 - Show',
      '2009 - Disintegration (Remaster)',
    ]);

    // The year leads the name in the tree and stops there. Every list outside
    // it — the album page, the artist page — draws the protocol's own `year`
    // field, so a name carrying one says the same thing twice; the operator
    // found that in the albums view and confirmed it of the rest. The field
    // keeps the year everywhere, and the tree keeps it in the name as well.
    const album = await call(db, 'getAlbum?id=al-12');
    assert.equal(album.album.name, 'Disintegration');
    assert.equal(album.album.year, 1987);

    const artist = await call(db, 'getArtist?id=ar-1');
    const shown = artist.artist.album.find((one: { id: string }) => one.id === 'al-12');
    assert.equal(shown.name, 'Disintegration');
  } finally {
    db.close();
  }
});

test('a node keeps its shelves, and a loose record lands beside them', async () => {
  // `The Cure/` is not a flat bag of records. The collector filed them into
  // `Compilations/`, `Deluxe Editions/`, `Live Albums/`, `Side Projects/`,
  // `Singles and EPs/` and `Studio Albums/`, and the operator asked for that to
  // stay: the structure inside an artist is theirs, and the fold above it is the
  // only thing the tree decides.
  //
  // What the fold adds is the record left at the top of the *root* beside the
  // artist's folder — `The Cure - Assemblage - 1991 (12CD FLAC)` — which has no
  // shelf to be under and belongs to the artist. It lands directly there.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (54, 1, 'The Cure/Deluxe Editions', 'The Cure', 'category')`,
    ).run();
    db.prepare(`UPDATE folder SET parent_rel_path = 'The Cure/Deluxe Editions' WHERE id = 7`).run();
    db.prepare(
      `UPDATE album SET rel_path = 'The Cure/Deluxe Editions/Disintegration (Remaster)' WHERE id = 13`,
    ).run();

    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (55, 1, 'The Cure - Assemblage - 1991 (12CD FLAC)', '', 'box')`,
    ).run();
    db.prepare(
      `INSERT INTO release (id, root_id, rel_path, title, artist_id, title_source, year)
       VALUES (3, 1, 'The Cure - Assemblage - 1991 (12CD FLAC)', 'Assemblage (12CD FLAC)', 1, 'folder', 1991)`,
    ).run();
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (56, 1, 'The Cure - Assemblage - 1991 (12CD FLAC)/01 - Three Imaginary Boys', 'The Cure - Assemblage - 1991 (12CD FLAC)', 'disc')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (81, 1, 'The Cure - Assemblage - 1991 (12CD FLAC)/01 - Three Imaginary Boys', 'Three Imaginary Boys', 'folder', 1, 3, 1)`,
    ).run();

    const inside = await call(db, 'getMusicDirectory?id=vn:cure');
    const children = inside.directory.child.map((c: { id: string; title: string }) => [c.id, c.title]);

    assert.deepEqual(children, [
      // The shelf, as the folder it is. Opening it shows what it always showed.
      ['fd-54', 'Deluxe Editions'],
      // The record that had no shelf to be under, and the artist's own records.
      // Records without a year come after the ones with it.
      ['al-81', '1991 - Assemblage (12CD FLAC)'],
      ['al-12', 'Disintegration'],
      ['al-10', 'Show'],
    ]);

    // The box's disc is not listed: it is a disc of the record above it, and
    // showing it here would offer that record twice.
    assert.equal(
      children.some((row: string[]) => String(row[1]).includes('Three Imaginary Boys')),
      false,
    );

    // And the shelf still holds what it held.
    const shelf = await call(db, 'getMusicDirectory?id=fd-54');
    assert.deepEqual(
      shelf.directory.child.map((c: { title: string }) => c.title),
      ['Disintegration (Remaster)'],
    );
  } finally {
    db.close();
  }
});

test('a node crediting several artists shows a drawer for each', async () => {
  // `Кино/` holds thirty records of Кино and five of Виктор Цой — the soloist
  // the collector filed with the band — and a client drawing titles shows them
  // as one flat run in which nothing says whose is whose. The operator asked for
  // the grouping, and it is the only thing that makes the credit visible in a
  // client that draws a name and not the `artist` field beside it.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO artist (id, name, name_key, sort_key) VALUES (5, 'Виктор Цой', 'виктор цои', 'Виктор Цой')`,
    ).run();
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (57, 1, 'The Cure/1989 - Атаман', 'The Cure', 'album')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (82, 1, 'The Cure/1989 - Атаман', 'Атаман', 'folder', 5, null, null)`,
    ).run();

    const inside = await call(db, 'getMusicDirectory?id=vn:cure');
    const drawers = inside.directory.child.map((c: { id: string; title: string }) => [c.id, c.title]);
    assert.deepEqual(drawers, [
      ['vn:cure|cure', 'The Cure'],
      ['vn:cure|виктор цои', 'Виктор Цой'],
    ]);

    // And each drawer says whose picture it is — the *credit's* artist id, the
    // same one `getArtistInfo2` hands a client as a related artist, so a person
    // is shown the same picture wherever the server names them. The drawer was
    // the one place that offered none, and a client cannot tell an artist the
    // server has nothing for from one it forgot (task:2847).
    const covers = inside.directory.child.map((c: { id: string; coverArt?: string }) => [c.id, c.coverArt]);
    assert.deepEqual(covers, [
      ['vn:cure|cure', 'ar-1'],
      ['vn:cure|виктор цои', 'ar-5'],
    ]);

    // Each drawer holds its own, and only its own.
    const mine = await call(db, 'getMusicDirectory?id=' + encodeURIComponent('vn:cure|виктор цои'));
    assert.deepEqual(
      mine.directory.child.map((c: { title: string }) => c.title),
      ['Атаман'],
    );

    const theirs = await call(db, 'getMusicDirectory?id=' + encodeURIComponent('vn:cure|cure'));
    assert.equal(
      theirs.directory.child.some((c: { title: string }) => /Атаман/.test(c.title)),
      false,
      'a drawer does not hold another artists records',
    );
  } finally {
    db.close();
  }
});

test('a node crediting one artist stays flat', async () => {
  // Ninety per cent of nodes, and they must not grow a drawer named after
  // themselves: `The Cure` inside `The Cure` is a level that says nothing.
  const db = collection();
  try {
    const inside = await call(db, 'getMusicDirectory?id=vn:cure');
    const titles = inside.directory.child.map((c: { title: string }) => c.title);
    assert.equal(titles.includes('The Cure'), false, 'no drawer for the only artist');
    assert.ok(titles.includes('Disintegration'), 'the records are listed directly');
  } finally {
    db.close();
  }
});

test('a request confined to one music folder answers about that folder', async () => {
  // Feishin offers the choice and passes `musicFolderId` on every browsing call
  // — `getIndexes`, `getArtists`, `getAlbumList2`, `getMusicDirectory`,
  // `search3`. A server that ignored it answered "everything" to a question
  // about one folder, whatever the client had selected.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO root (id, path, created_at) VALUES (2, 'D:/other', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO artist (id, name, name_key, sort_key) VALUES (6, 'Aphex Twin', 'aphex twin', 'Aphex Twin')`,
    ).run();
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (70, 2, 'Aphex Twin', '', 'category')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (90, 2, 'Aphex Twin/Selected Ambient Works', 'Selected Ambient Works', 'folder', 6, null, null)`,
    ).run();

    const names = (envelope: Record<string, any>): string[] =>
      envelope.indexes.index.flatMap((group: { artist: { name: string }[] }) =>
        group.artist.map((one) => one.name),
      );

    const all = await call(db, 'getIndexes');
    const confined = await call(db, 'getIndexes?musicFolderId=' + encodeURIComponent('ro-2'));

    assert.deepEqual(names(all).sort(), ['Aphex Twin', 'Nirvana', 'The Cure', 'Tool']);
    assert.deepEqual(names(confined), ['Aphex Twin'], 'one root, one artist');
    assert.deepEqual(
      confined.indexes.child.map((child: { id: string }) => child.id),
      ['vn:', 'ro-2'],
      'and the folders offered are the ones that were asked about',
    );

    // And the library itself is one of the choices — it is the first entry of
    // `getMusicFolders`, and a client that picks it must not be refused for
    // using an id the server handed out.
    const library = await call(db, 'getIndexes?musicFolderId=' + encodeURIComponent('vn:'));
    assert.equal(library.status, 'ok');
    assert.deepEqual(names(library).sort(), ['Aphex Twin', 'Nirvana', 'The Cure', 'Tool']);

    // An id naming no root is refused rather than ignored: answering with the
    // whole library would answer a question about some other music.
    const refused = await call(db, 'getIndexes?musicFolderId=' + encodeURIComponent('ro-99'));
    assert.equal(refused.status, 'failed');
    assert.match(String(refused.error.message), /No such music folder/);
  } finally {
    db.close();
  }
});

test('a folder asked for confines the page as well as the list', async () => {
  // `musicFolderId` narrowed the list and stopped there. An artist the tree has no
  // node for is answered from the credit, and that read was never confined — so a
  // client confined to one root could open an artist and be given records from a
  // root it had just said it was not looking at. Measured on the live collection
  // before this: `getArtist?id=ar-15&musicFolderId=ro-2` answered with 31 records,
  // every one of them in `ro-1`. The list confines, so the page has to.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO root (id, path, created_at) VALUES (2, 'D:/other', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO artist (id, name, name_key, sort_key)
       VALUES (7, 'Boards of Canada', 'boards of canada', 'Boards of Canada')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (90, 1, 'Live Archives/1998 - Peel Session', 'Peel Session', 'folder', 7, null, null),
              (91, 2, 'Second Root/2002 - Geogaddi', 'Geogaddi', 'folder', 7, null, null)`,
    ).run();

    const names = async (confined?: string): Promise<string[]> => {
      const where = confined === undefined ? '' : `&musicFolderId=${encodeURIComponent(confined)}`;
      const answer = await call(db, `getArtist?id=ar-7${where}`);
      return answer.artist.album.map((row: { name: string }) => row.name).sort();
    };

    assert.deepEqual(await names(), ['Geogaddi', 'Peel Session'], 'both roots when none is asked for');
    assert.deepEqual(await names('ro-1'), ['Peel Session'], 'only the root that was asked about');
    assert.deepEqual(await names('ro-2'), ['Geogaddi'], 'and only what lies in the other one');
  } finally {
    db.close();
  }
});

test('every id this server hands out can be asked about', async () => {
  // The rule the `vn:` refusal broke, said once and checked everywhere: the ids
  // a client is given are the ids it uses. `getIndexes` offers `vn:` and `fd:`
  // and `getArtists` offers `ar:`, and a client may follow any of them with
  // either browsing call — Feishin uses `getMusicDirectory`, another client
  // asks `getArtist` first. Both have to answer.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (58, 1, 'Серия «Подлинная история»', '', 'category')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (91, 1, 'Серия «Подлинная история»/1968 - Пластинка', 'Пластинка', 'folder', 2, null, null)`,
    ).run();

    // The ids a client browses *artists* by are the ones that must answer both
    // ways, because a client may follow either call. `getIndexes.child` offers
    // the folders on disk, which are browsed and not asked about as artists.
    const browsable = new Set<string>();
    const indexes = await call(db, 'getIndexes');
    for (const group of indexes.indexes.index) {
      for (const one of group.artist) browsable.add(one.id);
    }
    const artists = await call(db, 'getArtists');
    for (const group of artists.artists.index) {
      for (const one of group.artist) browsable.add(one.id);
    }
    assert.ok(browsable.size >= 6, 'the fixture offers several kinds of id');

    for (const id of browsable) {
      const where = encodeURIComponent(id);
      assert.equal(
        (await call(db, `getMusicDirectory?id=${where}`)).status,
        'ok',
        `${id} is offered and must open as a directory`,
      );
      assert.equal(
        (await call(db, `getArtist?id=${where}`)).status,
        'ok',
        `${id} is offered and must answer as an artist`,
      );
    }

    for (const child of indexes.indexes.child) {
      assert.equal(
        (await call(db, `getMusicDirectory?id=${encodeURIComponent(child.id)}`)).status,
        'ok',
        `${child.id} is offered as a folder and must open as one`,
      );
    }
  } finally {
    db.close();
  }
});

test('an artist and their node answer with the same records', async () => {
  // `ar:` was the tag's answer and `vn:` the folder's, so one artist read as two
  // different artists to two clients that came by different doors — `Cock
  // E.S.P.` holds twenty-four records in its folder and thirteen carry its
  // credit. The folder decides, so both answer with the folder.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (59, 1, 'The Cure AAC 320', '', 'category')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (92, 1, 'The Cure AAC 320/1993 - Show', 'Show', 'folder', 2, null, null)`,
    ).run();

    const names = async (id: string): Promise<string[]> => {
      const answer = await call(db, `getArtist?id=${encodeURIComponent(id)}`);
      return answer.artist.album.map((row: { name: string }) => row.name).sort();
    };

    const byTag = await names('ar-1');
    const byNode = await names('vn:cure');
    assert.deepEqual(byTag, byNode, 'one artist, one answer');
    assert.equal(byTag.length, 4, 'and the shelf beside the artist is included');
  } finally {
    db.close();
  }
});

test('the number beside an artist is the number opening them gives', async () => {
  // The other half of the decision above. `getArtist` was made to answer with the
  // folder, and `getArtists` went on counting the credit — so the row a client
  // draws said one number and the page behind it held another. On the live
  // collection 7 of 21 artists disagreed, because that is how many own a folder
  // holding somebody else's records: `Кино` read as 31 and opened to 36, its
  // folder holding five records of Виктор Цой. The operator's rule is that the
  // folder decides — those five belong to Кино too, having been filed there —
  // and the only thing left is for the list to say so.
  //
  // A number in a list is a promise about the list behind it, which is the same
  // promise `Cock E.S.P.` broke twice before (see `folderIndex`).
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (59, 1, 'The Cure AAC 320', '', 'category')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (92, 1, 'The Cure AAC 320/1993 - Show', 'Show', 'folder', 2, null, null)`,
    ).run();

    const listed = await call(db, 'getArtists');
    const rows = listed.artists.index.flatMap(
      (group: { artist: { id: string; name: string; albumCount: number }[] }) => group.artist,
    );
    assert.ok(rows.length > 0, 'the fixture offers artists');

    const disagreements: string[] = [];
    for (const row of rows) {
      const page = await call(db, `getArtist?id=${encodeURIComponent(row.id)}`);
      if (row.albumCount !== page.artist.album.length) {
        disagreements.push(
          `${row.name}: the row says ${row.albumCount}, opening it gives ${page.artist.album.length}`,
        );
      }
    }
    assert.deepEqual(disagreements, [], 'every row counts what it opens');
  } finally {
    db.close();
  }
});

test('a song is by the artist its own file names, and the record beside it', async () => {
  // `artist` is the track's field in this protocol and `albumArtist` is the
  // record's. The order here was the other way round, and it was wrong for 1492
  // songs of the live collection: `Round Midnight` is by Duran Y Garcia and the
  // answer was `Various Artists`, and on a split both halves were named after
  // whichever act the record was filed under (task:2850).
  //
  // The argument for the old order was that preferring the file's would replace
  // a band with whoever guested on one track. The field below is the answer:
  // the band is named in `albumArtist`, which is where the record's name goes.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO file_tag (file_id, name, value, position) VALUES (100, 'artist', 'A Guest', 0)`,
    ).run();
    refreshFirstTags(db, 100);

    const album = (await call(db, 'getAlbum?id=al-10')).album;
    const [guest, ...rest] = album.song;

    assert.equal(guest.artist, 'A Guest', 'the track names its own artist');
    assert.equal(guest.albumArtist, 'The Cure', 'and the record is named beside it');
    assert.equal(rest[0].artist, 'The Cure', 'a track with no artist of its own falls back');
    assert.equal(rest[0].albumArtist, 'The Cure');
  } finally {
    db.close();
  }
});

test('a song says what its own file says about its loudness', async () => {
  // The four ReplayGain tags, on the field OpenSubsonic gives them. They were
  // read by the scanner, stored, and never handed to anybody — so a client that
  // wanted to normalise had nothing to normalise by, and Symfonium's ReplayGain
  // streaming presets were a label over an empty answer (task:2921).
  //
  // The two spellings are the point of the parsing: a gain is written `-7.66
  // dB` with its unit, and a peak is written `0.99960327` without one.
  const db = collection();
  const tag = db.prepare(
    `INSERT INTO file_tag (file_id, name, value, position) VALUES (130, ?, ?, 0)`,
  );
  tag.run('replaygain_track_gain', '-7.66 dB');
  tag.run('replaygain_album_gain', '+0.01 dB');
  tag.run('replaygain_track_peak', '0.99960327');
  tag.run('replaygain_album_peak', '1.00000000');
  refreshFirstTags(db, 130);

  const named = await call(db, 'getSong?id=tr-1020');
  assert.deepEqual(named.song.replayGain, {
    trackGain: -7.66,
    albumGain: 0.01,
    trackPeak: 0.99960327,
    albumPeak: 1,
  });

  // A song whose file says nothing still carries the field, and it is empty:
  // the specification is explicit that what is omitted is the *property*, and
  // that "the replayGain field on Child must always be present".
  const silent = await call(db, 'getSong?id=tr-1003');
  assert.deepEqual(silent.song.replayGain, {});

  db.close();
});

test('a gain spelled so it cannot be read is left out, not sent as nought', async () => {
  // Nought decibels means "leave the loudness alone", which is a real thing to
  // say about a file — so an unreadable value has to be nothing rather than a
  // number a client would act on. The same for a negative peak: it is not a
  // quiet song, it is a value that cannot be one, and a client that scaled by
  // it would invert the audio.
  const db = collection();
  const tag = db.prepare(
    `INSERT INTO file_tag (file_id, name, value, position) VALUES (130, ?, ?, 0)`,
  );
  tag.run('replaygain_track_gain', 'loud, honestly');
  tag.run('replaygain_album_gain', '+2.5 dB');
  tag.run('replaygain_track_peak', '-0.5');
  tag.run('replaygain_album_peak', '1.2');
  refreshFirstTags(db, 130);

  const envelope = await call(db, 'getSong?id=tr-1020');
  assert.deepEqual(envelope.song.replayGain, { albumGain: 2.5, albumPeak: 1.2 });

  // And the trap inside the same rule: `Number('')` is `0` and `0` is finite,
  // so a value that is nothing but its unit would have arrived as nought
  // decibels — "leave the loudness alone" — rather than as an absence. Found by
  // the review umbrella, and no such value exists in the collection, which is
  // exactly why it needed a test rather than a look at the data (task:2926).
  db.prepare("UPDATE file_tag SET value = ' dB' WHERE file_id = 130 AND name = 'replaygain_album_gain'").run();
  refreshFirstTags(db, 130);
  const unit = await call(db, 'getSong?id=tr-1020');
  assert.deepEqual(unit.song.replayGain, { albumPeak: 1.2 }, 'a unit with no number is nothing');

  db.close();
});
