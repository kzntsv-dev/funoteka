import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db/index.ts';
import { matchExpression } from '../src/search/query.ts';
import { rebuildSearchIndex } from '../src/search/index.ts';

/**
 * The index stage, tested against the table it writes rather than through the
 * route that reads it: what the route does with a match is its own suite's
 * business, and what is written here is the stage's.
 */

type Db = ReturnType<typeof openDb>;

/** What the index holds for a query, as the ids of the songs it answers with. */
function matching(db: Db, words: string): number[] {
  const match = matchExpression(words);
  assert.notEqual(match, null, `"${words}" is not a query`);

  return (
    db.prepare('SELECT rowid AS id FROM track_fts WHERE track_fts MATCH ? ORDER BY rowid').all(match) as {
      id: number;
    }[]
  ).map((row) => row.id);
}

function collection(): Db {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('/music', 'x');
  db.prepare(
    `INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Кино', 'кино', 'Кино')`,
  ).run();
  db.prepare(
    `INSERT INTO album (id, root_id, rel_path, title, artist_id) VALUES (1, 1, 'Кино/45', '45', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (1, 1, 'Кино/45/01.flac', 'Кино/45', '01.flac', 'audio', 'flac', 100, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
     VALUES (1, 1, 1, 'Дальше действовать будем мы', 1, 200000)`,
  ).run();
  return db;
}

test('a song is found by its title, its record and its artist', async () => {
  const db = collection();
  try {
    const counted = rebuildSearchIndex(db);
    assert.equal(counted.rows, 1);

    assert.deepEqual(matching(db, 'Дальше'), [1], 'by a word of the title');
    assert.deepEqual(matching(db, '45'), [1], 'by the record it is on');
    assert.deepEqual(matching(db, 'кино'), [1], 'by who made it, in another case');
  } finally {
    db.close();
  }
});

test('a track the collection lost is not still findable', async () => {
  // The rebuild is total, and this is why: an index that only ever added would
  // answer about a record the scan has since removed, and nothing in the meta
  // layer would disagree — there would be no row left to disagree with it.
  const db = collection();
  try {
    rebuildSearchIndex(db);
    assert.deepEqual(matching(db, 'Дальше'), [1]);

    db.prepare('DELETE FROM track WHERE id = 1').run();
    const counted = rebuildSearchIndex(db);

    assert.equal(counted.rows, 0);
    assert.deepEqual(matching(db, 'Дальше'), []);
  } finally {
    db.close();
  }
});

test('a title a later stage renames is re-indexed, and the old one is gone', async () => {
  // The stage runs last for this reason: a cue has the final word on what a
  // track is called, and an index built before that word would publish the name
  // the cue overruled.
  const db = collection();
  try {
    rebuildSearchIndex(db);

    db.prepare(`UPDATE track SET title = 'Бошетунмай' WHERE id = 1`).run();
    rebuildSearchIndex(db);

    assert.deepEqual(matching(db, 'Бошетунмай'), [1]);
    assert.deepEqual(matching(db, 'Дальше'), [], 'the name it no longer has');
  } finally {
    db.close();
  }
});

test('a track on no record is indexed rather than dropped', async () => {
  // A song the classifier could not attach to an album is an ordinary row — a
  // loose file in a download folder — and a search that lost it would be losing
  // exactly the files a collector is most likely to be looking for.
  const db = collection();
  try {
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (2, 1, 'loose.flac', '', 'loose.flac', 'audio', 'flac', 100, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
       VALUES (2, NULL, 1, 'Ничья', 2, 200000)`,
    ).run();

    const counted = rebuildSearchIndex(db);
    assert.equal(counted.rows, 2);
    assert.deepEqual(matching(db, 'Ничья'), [2]);
  } finally {
    db.close();
  }
});

test('no words is not a query, and an empty one is not asked of the index', async () => {
  // FTS5 has no expression for "everything", so the empty search — which is how
  // a client syncs — is answered from the tables instead. The index is not
  // asked, and this is where that is decided.
  assert.equal(matchExpression(''), null);
  assert.equal(matchExpression('   '), null);
  assert.equal(matchExpression('"'), null);
  assert.equal(matchExpression('__'), null);

  assert.equal(matchExpression('Кино'), '"Кино"*');
  assert.equal(matchExpression('Группа крови'), '"Группа" "крови"*');
});

test('nothing a user can type means anything to the index but a word', async () => {
  // The query is reduced to words before it reaches FTS5, so the operators of
  // its own language are words like any other and a stray quote is not a syntax
  // error the client sees as an empty library.
  assert.equal(matchExpression('a OR b'), '"a" "OR" "b"*');
  assert.equal(matchExpression('"unclosed'), '"unclosed"*');
  assert.equal(matchExpression('NEAR(x y)'), '"NEAR" "x" "y"*');

  const db = collection();
  try {
    rebuildSearchIndex(db);
    for (const query of ['OR', 'NEAR(x y)', '"Дальше', '-Дальше', 'Дальше OR 45']) {
      assert.doesNotThrow(() => matching(db, query), query);
    }
    // And a query that is nothing but punctuation has no words in it at all,
    // which is the empty search rather than an index question.
    assert.equal(matchExpression('*'), null);
  } finally {
    db.close();
  }
});
