import { test } from 'node:test';
import assert from 'node:assert/strict';

import { numberCollidingRecords } from '../src/classify/collision-name.ts';
import { openDb } from '../src/db/index.ts';

type Db = ReturnType<typeof openDb>;

function fixture(): Db {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('C:/music', '2026-01-01T00:00:00Z');
  db.prepare(
    `INSERT INTO artist (id, name, name_key, sort_key)
     VALUES (4, 'Sigur Rós', 'sigur ros', 'Sigur Rós'), (9, 'Someone Else', 'someone else', 'Someone Else'),
            (10, 'The Cure', 'the cure', 'The Cure')`,
  ).run();
  return db;
}

function album(db: Db, id: number, relPath: string, title: string, artistId: number | null, releaseId: number | null = null): void {
  db.prepare(
    `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id, release_id, disc_number)
     VALUES (?, 1, ?, ?, 'folder', ?, ?, NULL)`,
  ).run(id, relPath, title, artistId, releaseId);
}

function titleOf(db: Db, id: number): string {
  return (db.prepare('SELECT title FROM album WHERE id = ?').get(id) as { title: string }).title;
}

test('two records of one artist that read the same are numbered apart', () => {
  // The last resort, and the operator's rule for it: the server does not say
  // which is which, it makes the difference visible and leaves the sorting out to
  // the person whose collection it is. Two folders of one Sigur Rós record, one of
  // them missing the Japanese bonus track, carry the same album tag — so every
  // name the stages above could build for them is the same name.
  const db = fixture();
  try {
    album(db, 59, 'Sigur Rós/2008 - Med Sud', 'Med Sud (Japanese)', 4);
    album(db, 60, 'Sigur Rós/2008 - Med sud (Japanese)', 'Med Sud (Japanese)', 4);
    // The same title under another artist is a different page, not a collision.
    album(db, 61, 'Someone Else/2008 - Med Sud', 'Med Sud (Japanese)', 9);
    // And a record with no artist appears on no artist's page to collide on.
    album(db, 62, 'Loose/Med Sud', 'Med Sud (Japanese)', null);

    const counters = numberCollidingRecords(db);

    assert.equal(counters.groups, 1, 'one set read alike');
    assert.equal(counters.numbered, 2, 'and both of its records are told apart');
    assert.equal(titleOf(db, 59), 'Med Sud (Japanese) (1)', 'the first by path');
    assert.equal(titleOf(db, 60), 'Med Sud (Japanese) (2)');
    assert.equal(titleOf(db, 61), 'Med Sud (Japanese)', 'another artist, another page');
    assert.equal(titleOf(db, 62), 'Med Sud (Japanese)', 'no artist, no page');
  } finally {
    db.close();
  }
});

test('a pressing the folder states is a difference, so it needs no number', () => {
  // What a client is shown is the title *with the note the folder writes beside
  // it*, and this stage was reading the title alone. Three pressings of one Cure
  // record carry the tag `Entreat` and folders that say which pressing they are,
  // so it saw one name three times and numbered records a person could already
  // tell apart. On the live library sixteen of the eighteen numbers it wrote were
  // that (task:2783).
  const db = fixture();
  try {
    album(db, 80, 'The Cure/1990 - Entreat [1991 issue AU Warner 903174106-2]', 'Entreat', 10);
    album(db, 81, 'The Cure/1990 - Entreat [1991 issue JP Polydor POCP-9018]', 'Entreat', 10);
    album(db, 82, 'The Cure/1990 - Entreat [UK promo Fiction FIXCD 17]', 'Entreat', 10);

    const counters = numberCollidingRecords(db);

    assert.equal(counters.groups, 0, 'the folders tell them apart');
    assert.deepEqual(
      [titleOf(db, 80), titleOf(db, 81), titleOf(db, 82)],
      ['Entreat', 'Entreat', 'Entreat'],
      'and none of them gains a number',
    );
  } finally {
    db.close();
  }
});

test('two folders stating the same pressing still read alike', () => {
  // The other half of the same rule, and the reason the note is *read* rather
  // than the folders merely compared: two rips of one pressing say the same
  // thing about themselves, and a number is then the only honest difference
  // left. A stage that gave up whenever a note was present would show two
  // identical names instead.
  const db = fixture();
  try {
    album(db, 83, 'The Cure/1990 - Entreat [UK promo Fiction FIXCD 17]/rip a', 'Entreat', 10);
    album(db, 84, 'The Cure/1990 - Entreat [UK promo Fiction FIXCD 17]/rip b', 'Entreat', 10);

    const counters = numberCollidingRecords(db);

    assert.equal(counters.groups, 1, 'one set still reads alike');
    assert.equal(counters.numbered, 2);
    assert.deepEqual([titleOf(db, 83), titleOf(db, 84)], ['Entreat (1)', 'Entreat (2)']);
  } finally {
    db.close();
  }
});

test('two pressings of one catalogue number still read alike, and are numbered', () => {
  // The key carries the note as `unsaidNote` answers it, which is what the names
  // themselves carry — and a note's own year is not part of it: `(2019,
  // Maschina Records, MKK881CD, 3CD)` dates the pressing, and every name drops
  // that year. So these two read identically to a client, and a number is the
  // only thing that can tell them apart.
  //
  // Keyed on the folder's spelling instead, which keeps the year, the stage
  // would have found them different, written no number, and left the album list
  // showing the same name twice with nothing between them (task:2845).
  const db = fixture();
  try {
    album(db, 90, 'The Cure/1990 - Entreat (2019, Maschina Records, MKK881CD, 3CD)', 'Entreat', 10);
    album(db, 91, 'The Cure/1990 - Entreat (2020, Maschina Records, MKK881CD, 3CD)', 'Entreat', 10);

    const counters = numberCollidingRecords(db);

    assert.equal(counters.groups, 1, 'they read alike to a client');
    assert.equal(counters.numbered, 2, 'so both are told apart');
    assert.deepEqual([titleOf(db, 90), titleOf(db, 91)], ['Entreat (1)', 'Entreat (2)']);
  } finally {
    db.close();
  }
});

test('a box is one record, so its discs are not numbered', () => {
  // Numbering rows rather than records would put `(1)` through `(10)` on the discs
  // of one box: `ALBUM_GROUPS` folds them into a single record, and this stage
  // reads the same two sets that grouping does.
  const db = fixture();
  try {
    db.prepare(
      `INSERT INTO release (id, root_id, rel_path, title, title_source, artist_id)
       VALUES (1, 1, 'Sigur Rós/Box', 'Med Sud (Japanese)', 'folder', 4)`,
    ).run();
    album(db, 70, 'Sigur Rós/Box/CD1', 'Med Sud (Japanese)', 4, 1);
    album(db, 71, 'Sigur Rós/Box/CD2', 'Med Sud (Japanese)', 4, 1);

    const counters = numberCollidingRecords(db);

    assert.equal(counters.groups, 0, 'one release is one record');
    assert.equal(titleOf(db, 70), 'Med Sud (Japanese)');
    assert.equal(titleOf(db, 71), 'Med Sud (Japanese)');
    assert.equal(
      (db.prepare('SELECT title FROM release WHERE id = 1').get() as { title: string }).title,
      'Med Sud (Japanese)',
      'and the record keeps the name its folder states',
    );
  } finally {
    db.close();
  }
});

test('running the stage again does not number the number', () => {
  // Every stage here is re-derived each run, and a root the walk did not see keeps
  // the rows it had — this stage's among them. A name that collected a second
  // `(1)` on every run would be a name nobody could read.
  const db = fixture();
  try {
    album(db, 59, 'Sigur Rós/2008 - Med Sud', 'Med Sud (Japanese)', 4);
    album(db, 60, 'Sigur Rós/2008 - Med sud (Japanese)', 'Med Sud (Japanese)', 4);

    numberCollidingRecords(db);
    const once = [titleOf(db, 59), titleOf(db, 60)];
    numberCollidingRecords(db);

    assert.deepEqual([titleOf(db, 59), titleOf(db, 60)], once, 'the same names, twice');
  } finally {
    db.close();
  }
});
