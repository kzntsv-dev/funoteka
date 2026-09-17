import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, migrate, SCHEMA_VERSION } from '../src/db/index.ts';

/** Tables the meta layer is contracted to carry (requirements:39 §1–9). */
const EXPECTED_TABLES = [
  'album',
  'artist',
  'artist_credit',
  'audio_probe',
  'cue',
  'cue_track',
  'file',
  'file_tag',
  'folder',
  'issue',
  'release',
  'root',
  'scan_run',
  'scan_state',
  'track',
];

function tableNames(db: ReturnType<typeof openDb>): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** Columns a table carries, in the order SQLite reports them. */
function columnNames(db: ReturnType<typeof openDb>, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

test('openDb builds the whole meta layer', () => {
  const db = openDb(':memory:');
  const names = tableNames(db);
  for (const t of EXPECTED_TABLES) {
    assert.ok(names.includes(t), `meta layer is missing table "${t}"`);
  }
  db.close();
});

test('schema version is pinned once migrations run', () => {
  const db = openDb(':memory:');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(row.user_version, SCHEMA_VERSION);
  db.close();
});

test('migrate is idempotent', () => {
  const db = openDb(':memory:');
  // Re-running on an already-migrated database must be a no-op, not an error:
  // every scan opens the db, so a non-idempotent migrate breaks the second run.
  migrate(db);
  migrate(db);
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(row.user_version, SCHEMA_VERSION);
  db.close();
});

test('FTS5 is available for the search layer', () => {
  // Spec §2 wants FTS5 in the meta layer; node:sqlite must be built with it.
  const db = openDb(':memory:');
  const names = tableNames(db);
  assert.ok(
    names.some((n) => n.startsWith('track_fts')),
    'expected an FTS5 virtual table for search',
  );
  db.close();
});

test('a cue is looked up by the file it plays', () => {
  // `cue.audio_file_id` is what three readers ask by: the inventory's performer
  // column, its "audio files with no track or cue" counter, and the artist
  // stage's own binding. It carried no index, so each question read every cue.
  //
  // Measured on a 472-album collection — 5054 tracks against 302 cues — the
  // inventory's performer subquery cost **120.7 ms** of the dump's 171.0 ms,
  // and the dump is **72.7 ms** with the index.
  //
  // **Asserted as the index and not as a query plan**, which is the weaker
  // reading and the deliberate one: a plan is chosen from statistics, and on an
  // empty schema SQLite picks a different one than it does on a populated
  // database — so a plan-based test passes without the index and would be a
  // check that cannot fail. What is asserted is the thing that made the numbers
  // move; the index's *name* is not, so any index doing the job passes.
  const db = openDb(':memory:');
  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cue'")
    .all() as { sql: string | null }[];
  const leads = indexes.some((row) => /\(\s*audio_file_id\s*[,)]/.test(row.sql ?? ''));

  assert.ok(
    leads,
    `no index on cue leads with audio_file_id, so every lookup reads every cue:\n${indexes
      .map((row) => row.sql ?? '(automatic)')
      .join('\n')}`,
  );
  db.close();
});

test('album identity is path, so the same album name in two roots is two rows', () => {
  // requirements:39 §2 — duplicates across roots are DIFFERENT albums, never merged.
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('/music', 'now');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (2, ?, ?)').run('/backup', 'now');
  const ins = db.prepare('INSERT INTO album (root_id, rel_path, title) VALUES (?, ?, ?)');
  ins.run(1, 'Tool/10000 Days', '10000 Days');
  ins.run(2, 'Tool/10000 Days', '10000 Days');

  const count = db.prepare('SELECT COUNT(*) AS n FROM album').get() as { n: number };
  assert.equal(count.n, 2);
  db.close();
});

test('the same album path cannot be inserted twice into one root', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('/music', 'now');
  const ins = db.prepare('INSERT INTO album (root_id, rel_path, title) VALUES (?, ?, ?)');
  ins.run(1, 'Tool/10000 Days', '10000 Days');
  assert.throws(() => ins.run(1, 'Tool/10000 Days', '10000 Days'), /UNIQUE|constraint/i);
  db.close();
});

test('tag storage arrives with the schema that reads it', () => {
  const db = openDb(':memory:');

  // The encoding a tag's text was read as, and how sure the reader was — the
  // same pair a cue carries, for the same reason: an inferred encoding is
  // information, and the contract forbids losing it silently.
  assert.deepEqual(
    columnNames(db, 'file').filter((c) => c.startsWith('encoding')),
    ['encoding', 'encoding_confidence'],
  );

  // Which run last read this file's tags. Without it, "re-read when the ledger
  // says the file moved" has no way to tell a file that was read and had no
  // tags from one that was never read at all — and every untagged file would be
  // re-read on every single scan.
  assert.ok(columnNames(db, 'file').includes('tags_read_run_id'));

  // Where a title came from. Album titles are never NULL (classify fills them
  // from the folder), so "write it if empty" cannot tell a folder name from a
  // cue's — the source has to be written down instead of inferred.
  assert.ok(columnNames(db, 'album').includes('title_source'));
  assert.ok(columnNames(db, 'release').includes('title_source'));

  db.close();
});

test('an artist credit is a list, and goes when what it belongs to goes', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('/music', 'now');
  db.prepare('INSERT INTO album (id, root_id, rel_path) VALUES (1, 1, ?)').run('Split');
  db.prepare("INSERT INTO artist (id, name, name_key) VALUES (1, 'Cock E.S.P.', 'cock esp')").run();
  db.prepare("INSERT INTO artist (id, name, name_key) VALUES (2, 'Thirdorgan', 'thirdorgan')").run();

  const ins = db.prepare(
    'INSERT INTO artist_credit (album_id, position, artist_id, join_phrase) VALUES (?, ?, ?, ?)',
  );

  // The first entry carries no phrase; each later one carries what joined it to
  // the artist before, verbatim, so the original string can be rebuilt exactly.
  ins.run(1, 0, 1, '');
  ins.run(1, 1, 2, ' + ');

  // One album cannot hold two credits in the same slot.
  assert.throws(() => ins.run(1, 0, 2, ''), /UNIQUE|constraint/i);

  // `album.credit_raw` keeps what the source actually said: the split is a
  // reading of it, not a replacement for it.
  assert.ok(columnNames(db, 'album').includes('credit_raw'));
  assert.ok(columnNames(db, 'album').includes('credit_source'));

  db.prepare('DELETE FROM album WHERE id = 1').run();
  const left = db.prepare('SELECT COUNT(*) AS n FROM artist_credit').get() as { n: number };
  assert.equal(left.n, 0, 'a deleted album must not leave its credit behind');

  // The other direction matters just as much: `applyArtists` prunes artists
  // holding nothing, and a cascade here would take the credit rows with it.
  db.prepare('INSERT INTO album (id, root_id, rel_path) VALUES (2, 1, ?)').run('Another');
  ins.run(2, 0, 2, '');
  db.prepare('DELETE FROM artist WHERE id = 2').run();
  const leftAfterArtist = db.prepare('SELECT COUNT(*) AS n FROM artist_credit').get() as { n: number };
  assert.equal(leftAfterArtist.n, 0);

  db.close();
});

test('file_tag holds one name several times, and leaves when its file does', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('/music', 'now');
  db.prepare("INSERT INTO scan_run (id, started_at, status, roots_json) VALUES (1, ?, 'ok', '[]')").run(
    'now',
  );
  db.prepare(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms, last_seen_run_id)
     VALUES (1, 1, 'Tool/a.flac', 'Tool', 'a.flac', 'audio', '.flac', 1, 1, 1)`,
  ).run();

  const ins = db.prepare('INSERT INTO file_tag (file_id, name, value, position) VALUES (?, ?, ?, ?)');

  // Vorbis comments repeat a name freely: two ARTIST lines are a real album.
  ins.run(1, 'artist', 'Maynard', 0);
  ins.run(1, 'artist', 'Danny', 1);

  // But one name at one position is one fact, and cannot be said twice.
  assert.throws(() => ins.run(1, 'artist', 'Maynard', 0), /UNIQUE|constraint/i);

  db.prepare('DELETE FROM file WHERE id = ?').run(1);
  const left = db.prepare('SELECT COUNT(*) AS n FROM file_tag').get() as { n: number };
  assert.equal(left.n, 0, 'a deleted file must not leave its tags behind');

  db.close();
});
