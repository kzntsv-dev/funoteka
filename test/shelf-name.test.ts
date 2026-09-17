import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nameShelfRecords } from '../src/classify/shelf-name.ts';
import { openDb } from '../src/db/index.ts';

type Db = ReturnType<typeof openDb>;

/**
 * A library of one artist kept three ways: two shelves of the same records, and
 * the artist's own folder beside them — the shape the live collection has, and
 * the one that showed `We Are Not Your Kind` three times with nothing to choose
 * between them.
 *
 * Written straight into the tables: what is under test is what a name ends up
 * as, and a fixture that went through the scanner would be asserting the
 * scanner first.
 */
function collection(): Db {
  const db = openDb(':memory:');
  const run = (sql: string, ...args: (string | number | null)[]): void => {
    db.prepare(sql).run(...args);
  };

  run('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)', 'C:/music', 'x');
  run("INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Slipknot', 'slipknot', 'Slipknot')");

  const folders: [string, string, string][] = [
    ['Slipknot AAC 320', '', 'category'],
    ['Slipknot ALAC', '', 'category'],
    ['Slipknot', '', 'category'],
    ['S', '', 'category'],
    ['node-extract2', '', 'category'],
  ];
  for (const [relPath, parent, role] of folders) {
    run(
      'INSERT INTO folder (root_id, rel_path, parent_rel_path, role) VALUES (1, ?, ?, ?)',
      relPath,
      parent,
      role,
    );
  }

  run(
    `INSERT INTO release (id, root_id, rel_path, title, title_source, artist_id)
     VALUES (1, 1, 'Slipknot AAC 320', '.5: the Gray Chapter', 'tag', 1)`,
  );

  const albums: [number, string, string, number | null][] = [
    // id, rel_path, title, release
    [10, 'Slipknot AAC 320/2001 - Iowa', 'Iowa', null],
    [11, 'Slipknot ALAC/2001 - Iowa', 'Iowa', null],
    [12, 'Slipknot/2001 - Iowa (10th Anniversary Edition)', 'Iowa (10th Anniversary Edition)', null],
    [13, 'Slipknot AAC 320/2014 - .5 The Gray Chapter - CD 1', '.5: the Gray Chapter', 1],
    [14, 'Slipknot AAC 320/2014 - .5 The Gray Chapter - CD 2', '.5: the Gray Chapter', 1],
    // A shelf that names no artist: `S` is a letter bucket, and nothing else in
    // this collection starts with it.
    [15, 'S/2001 - Iowa', 'Iowa', null],
  ];
  for (const [id, relPath, title, release] of albums) {
    run(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (?, 1, ?, ?, 'tag', 1, ?, ?)`,
      id,
      relPath,
      title,
      release,
      release === null ? null : id === 13 ? 1 : 2,
    );
  }

  return db;
}

const titleOf = (db: Db, id: number): { title: string; title_source: string } =>
  db.prepare('SELECT title, title_source FROM album WHERE id = ?').get(id) as {
    title: string;
    title_source: string;
  };

test('a shelf says in the name what it says beyond its artist, and the artist does not', () => {
  const db = collection();
  const counters = nameShelfRecords(db);

  // Both rips of `Iowa` were one name between them; the shelf's own word is what
  // tells them apart, and it is the *artist's* name that is not repeated.
  assert.equal(titleOf(db, 10).title, 'Iowa (AAC 320)');
  assert.equal(titleOf(db, 11).title, 'Iowa (ALAC)');
  assert.equal(titleOf(db, 10).title_source, 'shelf');

  // The artist's own folder has nothing to say beyond `Slipknot`, so its record
  // is left exactly as the stages before this one named it.
  assert.equal(titleOf(db, 12).title, 'Iowa (10th Anniversary Edition)');
  assert.equal(titleOf(db, 12).title_source, 'tag');

  // A letter bucket is not an artist either: `S` does not claim `Slipknot`, and
  // its album is not `Iowa (S)`.
  assert.equal(titleOf(db, 15).title, 'Iowa');

  assert.equal(counters.shelves, 2, 'two shelves said something; the third said nothing');
  assert.equal(counters.named, 3, 'two albums and one record');
  db.close();
});

test('the record is told apart, the disc it is made of is not renamed', () => {
  // A disc of a shelf's set is not a record a client opens — the release is —
  // so the qualifier goes on the record's name and the disc keeps its own.
  const db = collection();
  nameShelfRecords(db);

  const release = db.prepare('SELECT title, title_source FROM release WHERE id = 1').get() as {
    title: string;
    title_source: string;
  };
  assert.equal(release.title, '.5: the Gray Chapter (AAC 320)');
  assert.equal(release.title_source, 'shelf');

  assert.equal(titleOf(db, 13).title, '.5: the Gray Chapter', 'the first disc');
  assert.equal(titleOf(db, 14).title, '.5: the Gray Chapter', 'and the second');
  db.close();
});

test('naming a shelf twice names it once', () => {
  // The stage runs on every scan, and a root the walk did not see keeps the
  // rows it had — so a name that collected a second `(AAC 320)` each run would
  // be a name nobody could read.
  const db = collection();
  nameShelfRecords(db);
  const once = [titleOf(db, 10).title, titleOf(db, 11).title];

  nameShelfRecords(db);
  assert.deepEqual([titleOf(db, 10).title, titleOf(db, 11).title], once);
  assert.equal(
    (db.prepare('SELECT title FROM release WHERE id = 1').get() as { title: string }).title,
    '.5: the Gray Chapter (AAC 320)',
  );
  db.close();
});

test('a shelf whose separator is a bullet gives up the bullet too', () => {
  // This collection writes a shelf as `Кино ● Каталог Maschina Records` — the
  // artist's name, then the bullet it uses as a separator, then the note. With
  // the bullet missing from the separator class the note came out as
  // `● Каталог Maschina Records`, and every record filed under that shelf was
  // named `… (● Каталог Maschina Records)` — the separator carried into the name
  // it was separating.
  const db = openDb(':memory:');
  try {
    db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('C:/music', 'x');
    db.prepare(
      "INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Кино', 'кино', 'Кино')",
    ).run();
    db.prepare(
      `INSERT INTO folder (root_id, rel_path, parent_rel_path, role)
       VALUES (1, 'Кино ● Каталог Maschina Records', '', 'category')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
       VALUES (10, 1, 'Кино ● Каталог Maschina Records/1988 ● Группа крови', 'Группа крови', 'tag', 1, null, null)`,
    ).run();

    nameShelfRecords(db);

    assert.equal(
      (db.prepare('SELECT title FROM album WHERE id = 10').get() as { title: string }).title,
      'Группа крови (Каталог Maschina Records)',
    );
  } finally {
    db.close();
  }
});
