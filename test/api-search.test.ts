import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/api/server.ts';
import { openDb } from '../src/db/index.ts';
import { rebuildSearchIndex } from '../src/search/index.ts';
import { ask, CONFIG, type Db } from './helpers/api.ts';

/**
 * A collection small enough to hold in the head and varied enough that every
 * rule has something to fail against: two artists, one record each, two songs
 * on each record, and one name in Cyrillic — which is the case a search built
 * on SQLite's own `LIKE` would get wrong, because its case folding is ASCII.
 */
function collection(): Db {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('/music', 'x');

  db.prepare(
    `INSERT INTO artist (id, name, name_key, sort_key) VALUES
       (1, 'Кино', 'кино', 'Кино'),
       (2, 'The Cure', 'the cure', 'Cure, The')`,
  ).run();

  db.prepare(
    `INSERT INTO album (id, root_id, rel_path, title, artist_id) VALUES
       (1, 1, 'Кино/1988. Группа крови', 'Группа крови', 1),
       (2, 1, 'The Cure/1989. Disintegration', 'Disintegration', 2)`,
  ).run();

  const tracks: [number, number, number, string, string][] = [
    [1, 1, 1, 'Группа крови', 'Кино/1988. Группа крови/01.flac'],
    [2, 1, 2, 'Закрой за мной дверь', 'Кино/1988. Группа крови/02.flac'],
    [3, 2, 1, 'Plainsong', 'The Cure/1989. Disintegration/01.flac'],
    [4, 2, 2, 'Pictures of You', 'The Cure/1989. Disintegration/02.flac'],
  ];
  for (const [id, albumId, ordinal, title, relPath] of tracks) {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, ?, ?, 'audio', 'flac', 1000, 1000)`,
    ).run(id, relPath, relPath.slice(0, relPath.lastIndexOf('/')), name);
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
       VALUES (?, ?, ?, ?, ?, 240000)`,
    ).run(id, albumId, ordinal, title, id);
  }

  rebuildSearchIndex(db);
  return db;
}

/** The parts of the answer these tests read. */
interface Found {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
    searchResult3?: {
      artist?: { id: string; name: string; albumCount: number }[];
      album?: { id: string; name: string; artist: string; songCount: number }[];
      song?: { id: string; title: string; artist: string; album: string; duration: number }[];
    };
  };
}

async function search(db: Db, params: string): Promise<Found['subsonic-response']> {
  const response = await ask(db, `search3?${params}`);
  return (JSON.parse(response.body.toString('utf8')) as Found)['subsonic-response'];
}

async function withCollection(work: (db: Db) => Promise<void>): Promise<void> {
  const db = collection();
  try {
    await work(db);
  } finally {
    db.close();
  }
}

const ids = (list: { id: string }[] | undefined): string[] => (list ?? []).map((row) => row.id);

test('a word from a title finds the song, and nothing else', async () => {
  await withCollection(async (db) => {
    const answer = await search(db, 'query=Pictures&f=json');
    assert.equal(answer.status, 'ok');
    assert.deepEqual(ids(answer.searchResult3?.song), ['tr-4']);
    assert.deepEqual(ids(answer.searchResult3?.album), ['al-2'], 'and the record it is on');
    assert.deepEqual(ids(answer.searchResult3?.artist), ['ar-2'], 'and who made it');
  });
});

test('a search counts an artist the way the artist page lists it', async () => {
  // `search3` resolves its artist section through `artistsById`, and the artist
  // page through `artist` and `albumsOfArtist`. A box is one record in the
  // listing, so the count beside it has to be the same number: a number and a
  // list that agree by accident are the defect this project keeps finding, and
  // `artistsById` was the one reader of `album` that never learned about the
  // group — every disc of every box counted again.
  const db = openDb(':memory:');
  try {
    db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('/music', 'x');
    db.prepare(
      "INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Кино', 'кино', 'Кино')",
    ).run();
    db.prepare(
      `INSERT INTO release (id, root_id, rel_path, title, artist_id, title_source)
       VALUES (1, 1, 'Кино/1988 ● Группа крови', 'Группа крови', 1, 'folder')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, artist_id, release_id, disc_number) VALUES
         (10, 1, 'Кино/1988 ● Группа крови/CD1', 'Альбом', 1, 1, 1),
         (11, 1, 'Кино/1988 ● Группа крови/CD2', 'Ранний вариант', 1, 1, 2)`,
    ).run();

    const discs: [number, number, string][] = [
      [1, 10, 'Кино/1988 ● Группа крови/CD1/01.flac'],
      [2, 11, 'Кино/1988 ● Группа крови/CD2/01.flac'],
    ];
    for (const [id, albumId, relPath] of discs) {
      const name = relPath.slice(relPath.lastIndexOf('/') + 1);
      db.prepare(
        `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
         VALUES (?, 1, ?, ?, ?, 'audio', 'flac', 1000, 1000)`,
      ).run(id, relPath, relPath.slice(0, relPath.lastIndexOf('/')), name);
      db.prepare(
        `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
         VALUES (?, ?, 1, 'Группа крови', ?, 240000)`,
      ).run(id, albumId, id);
    }
    rebuildSearchIndex(db);

    const found = await search(db, 'query=Группа&f=json');
    assert.equal(found.searchResult3?.artist?.[0]?.id, 'ar-1');
    assert.equal(found.searchResult3?.artist?.[0]?.albumCount, 1, 'the box is one record here');

    const page = JSON.parse(
      (await ask(db, 'getArtist?id=ar-1&f=json')).body.toString('utf8'),
    ) as { 'subsonic-response': { artist: { album: { id: string }[] } } };
    assert.equal(page['subsonic-response'].artist.album.length, 1, 'and one record there');
  } finally {
    db.close();
  }
});

test('the case of the query is not the case of the collection', async () => {
  // Cyrillic is why this is not free: SQLite's own `LIKE` folds A–Z and nothing
  // else, so a search built on it answers nothing for `кино` against `Кино` —
  // in a collection whose records are mostly named in that alphabet.
  await withCollection(async (db) => {
    for (const query of ['кино', 'КИНО', 'КиНо']) {
      const answer = await search(db, `query=${encodeURIComponent(query)}&f=json`);
      assert.deepEqual(ids(answer.searchResult3?.artist), ['ar-1'], query);
      assert.equal(answer.searchResult3?.song?.length, 2, query);
    }
  });
});

test('a word that begins a name is enough to find it', async () => {
  await withCollection(async (db) => {
    const answer = await search(db, 'query=Disint&f=json');
    assert.deepEqual(ids(answer.searchResult3?.album), ['al-2']);
    assert.deepEqual(ids(answer.searchResult3?.song), ['tr-3', 'tr-4'], 'the songs follow the record');
  });
});

test('two words both have to be there', async () => {
  // Not a detail: a search that ORs its words answers with everything by an
  // artist for any query that names one, and a client showing twenty results
  // shows nineteen wrong ones. The words are looked for across all three columns
  // of a song at once, which is why a record's name finds its songs.
  await withCollection(async (db) => {
    const narrowed = await search(db, 'query=Cure+Plainsong&f=json');
    assert.deepEqual(ids(narrowed.searchResult3?.song), ['tr-3'], 'not both Cure songs');
    assert.deepEqual(ids(narrowed.searchResult3?.artist), ['ar-2']);

    const albumName = await search(db, 'query=Группа+крови&f=json');
    assert.deepEqual(ids(albumName.searchResult3?.song), ['tr-1', 'tr-2'], 'the record answers for its songs');

    const impossible = await search(db, 'query=Группа+Plainsong&f=json');
    assert.deepEqual(ids(impossible.searchResult3?.song), []);
    assert.equal(impossible.status, 'ok', 'finding nothing is an answer, not a refusal');
  });
});

test('an empty query answers with the library, which is how a client syncs', async () => {
  // Symfonium's first sync is `search3?query=` and it expects the library; a
  // server that takes the query literally answers nothing and the client shows
  // an empty collection. Counts and offsets still apply, so it pages through.
  await withCollection(async (db) => {
    const page = await search(db, 'query=&songCount=2&albumCount=1&artistCount=1&f=json');
    assert.equal(page.status, 'ok');
    assert.equal(page.searchResult3?.song?.length, 2);
    assert.equal(page.searchResult3?.album?.length, 1);
    assert.equal(page.searchResult3?.artist?.length, 1);
  });
});

test('each of the three sections is paged on its own', async () => {
  await withCollection(async (db) => {
    const first = await search(db, 'query=&songCount=2&songOffset=0&f=json');
    const second = await search(db, 'query=&songCount=2&songOffset=2&f=json');
    assert.deepEqual(ids(first.searchResult3?.song), ['tr-1', 'tr-2']);
    assert.deepEqual(ids(second.searchResult3?.song), ['tr-3', 'tr-4']);

    // The offsets are the section's own: paging the songs must not have moved
    // the artists, which a client paging three lists separately depends on.
    assert.equal(second.searchResult3?.artist?.length, 2, 'the artists were not paged with them');
  });
});

test('a section asked for none of returns none, and the count is not a page size', async () => {
  // `songCount=0` is how a client asks for artists only. Clamping it up to one —
  // which is what the listing route does with its own page size — would answer
  // with a song nobody asked for.
  await withCollection(async (db) => {
    const answer = await search(db, 'query=&songCount=0&artistCount=1&f=json');
    assert.deepEqual(ids(answer.searchResult3?.song), []);
    assert.equal(answer.searchResult3?.artist?.length, 1);
  });
});

test('the query is words, not a search language', async () => {
  // Whatever the user typed is words. A query that reached FTS5 unquoted could
  // say OR, or open a parenthesis, or a quote it never closes — and the answer
  // would be about the search engine rather than about the collection.
  await withCollection(async (db) => {
    for (const query of ['Pictures OR You', '"Pictures', 'You*', 'Pictures (You)', 'a AND b']) {
      const answer = await search(db, `query=${encodeURIComponent(query)}&f=json`);
      assert.equal(answer.status, 'ok', query);
    }

    const or = await search(db, `query=${encodeURIComponent('Pictures OR You')}&f=json`);
    assert.deepEqual(ids(or.searchResult3?.song), [], 'OR is a word here, and no title holds it');
  });
});

test('every song answers with the fields a client syncs on', async () => {
  // Symfonium fails a whole sync over a song with no title or a null duration,
  // and the meta layer holds both — a track the cue stage named and a length no
  // probe could measure are ordinary rows, not broken ones.
  await withCollection(async (db) => {
    db.prepare('UPDATE track SET title = NULL, duration_ms = NULL WHERE id = 3').run();

    const answer = await search(db, 'query=Plainsong&f=json');
    const song = answer.searchResult3?.song?.[0];
    assert.equal(typeof song?.title, 'string');
    assert.equal(typeof song?.duration, 'number');
    assert.equal(song?.artist, 'The Cure');
    assert.equal(song?.album, 'Disintegration');
  });
});

test('a search confined to one music folder answers about that folder', async () => {
  // Two roots, because one root cannot tell a filter from a no-op. The id is the
  // one getMusicFolders hands out, and a client uses it as it was given — so an
  // id that names no root is refused rather than quietly widened to everything.
  const db = openDb(':memory:');
  try {
    db.exec(`
      INSERT INTO root (id, path, created_at) VALUES (1, '/home', 'x'), (2, '/shed', 'x');
      INSERT INTO artist (id, name, name_key, sort_key) VALUES
        (1, 'Кино', 'кино', 'Кино'), (2, 'Tool', 'tool', 'Tool');
      INSERT INTO album (id, root_id, rel_path, title, artist_id) VALUES
        (1, 1, 'Кино/45', '45', 1), (2, 2, 'Tool/Lateralus', 'Lateralus', 2);
      INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms) VALUES
        (1, 1, 'Кино/45/01.flac', 'Кино/45', '01.flac', 'audio', 'flac', 1, 1),
        (2, 2, 'Tool/Lateralus/01.flac', 'Tool/Lateralus', '01.flac', 'audio', 'flac', 1, 1);
      INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms) VALUES
        (1, 1, 1, 'Дальше действовать будем мы', 1, 1000),
        (2, 2, 1, 'The Grudge', 2, 1000);
    `);
    rebuildSearchIndex(db);

    const everything = await search(db, 'query=&songCount=50&f=json');
    assert.equal(everything.searchResult3?.song?.length, 2);

    const home = await search(db, 'query=&songCount=50&musicFolderId=ro-1&f=json');
    assert.deepEqual(ids(home.searchResult3?.song), ['tr-1']);
    assert.deepEqual(ids(home.searchResult3?.artist), ['ar-1'], 'the artists are confined too');

    const shed = await search(db, 'query=&songCount=50&musicFolderId=ro-2&f=json');
    assert.deepEqual(ids(shed.searchResult3?.song), ['tr-2']);

    const unknown = await search(db, 'query=&musicFolderId=ro-99&f=json');
    assert.equal(unknown.status, 'failed');
    assert.equal(unknown.error?.code, 70);
    assert.match(unknown.error?.message ?? '', /music folder/);

    const invented = await search(db, 'query=&musicFolderId=0&f=json');
    assert.equal(invented.status, 'failed', 'an id no folder list could have given out');
  } finally {
    db.close();
  }
});

test('the answer is named the way the protocol names it', async () => {
  await withCollection(async (db) => {
    const answer = await search(db, 'query=Cure&f=json');
    assert.ok(answer.searchResult3 !== undefined, 'searchResult3, not searchResult2');
  });
});

test('a search before any scan answers with nothing rather than failing', async () => {
  // The index is empty, not absent: the route reads a table, and a table with no
  // rows is a collection with nothing to find — which is true.
  const db = openDb(':memory:');
  try {
    db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('/music', 'x');
    const answer = await search(db, 'query=anything&f=json');
    assert.equal(answer.status, 'ok');
    assert.deepEqual(ids(answer.searchResult3?.song), []);
  } finally {
    db.close();
  }
});

test('the answer survives the format the client asked for', async () => {
  // XML is not decoration here: the protocol's default, and what most clients
  // ask for. The three sections have to be elements a parser can find.
  await withCollection(async (db) => {
    const response = await ask(db, 'search3?query=Cure');
    const body = response.body.toString('utf8');
    assert.match(body, /<searchResult3>/);
    assert.match(
      body,
      /<artist id="ar-2" name="The Cure" albumCount="1" coverArt="ar-2" artistImageUrl="http:\/\/[^"]+\/rest\/getCoverArt\?id=ar-2(?:&amp;|&)sig=[^"]+"><roles>albumartist<\/roles><roles>artist<\/roles><\/artist>/,
      'the artist: the id to ask with, the signed url to load, and the roles a client files it under',
    );
    assert.match(body, /<song id="tr-3"/);
  });
});
