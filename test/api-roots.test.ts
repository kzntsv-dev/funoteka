import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { addRoot, listRoots, removeRoot } from '../src/api/roots.ts';
import { openDb } from '../src/db/index.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The roots an operator manages, against a real filesystem.
 *
 * A root is a directory, and the two things that go wrong with one are both
 * about the filesystem: a path that is not a directory, and two spellings of one
 * directory. Neither can be asked of a fake, and the second is the one that
 * quietly reads a library twice.
 */

/** A directory with a couple of files in it, and its own db. */
function workspace(): { db: ReturnType<typeof openDb>; root: string } {
  const dir = tempRoot('funoteka-roots-');
  const root = join(dir, 'music');
  mkdirSync(join(root, 'album'), { recursive: true });
  writeFileSync(join(root, 'album', 'track.flac'), 'audio');
  return { db: openDb(':memory:'), root };
}

/** A root row as the scanner would have left it, with files under it. */
function scanned(db: ReturnType<typeof openDb>, path: string, songs: number, albums: number): number {
  const id = Number(
    db.prepare('INSERT INTO root (path, created_at) VALUES (?, ?)').run(path, '2026-09-01T00:00:00.000Z')
      .lastInsertRowid,
  );
  db.prepare(
    'INSERT INTO scan_run (started_at, finished_at, status, roots_json) VALUES (?, ?, ?, ?)',
  ).run('2026-09-01T00:00:00.000Z', '2026-09-01T00:01:00.000Z', 'ok', JSON.stringify([path]));
  db.prepare("INSERT INTO folder (root_id, rel_path, parent_rel_path) VALUES (?, '', NULL)").run(id);

  for (let n = 0; n < albums; n += 1) {
    db.prepare("INSERT INTO album (root_id, rel_path, title) VALUES (?, ?, ?)").run(id, `a${n}`, `A${n}`);
  }
  for (let n = 0; n < songs; n += 1) {
    db.prepare(
      "INSERT INTO file (root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms) " +
        "VALUES (?, ?, '', ?, 'audio', 'flac', 1, 1)",
    ).run(id, `t${n}.flac`, `t${n}.flac`);
  }
  return id;
}

test('a library nobody has configured has no roots', () => {
  const { db } = workspace();

  assert.deepEqual(listRoots(db), []);
  assert.equal(removeRoot(db, '/nowhere'), null, 'and removing one that is not there answers nothing');
  db.close();
});

test('a directory is configured as a root, absolute and as it is', () => {
  const { db, root } = workspace();

  const added = addRoot(db, root);

  assert.equal(added.already, false);
  assert.equal(added.root.path, resolve(root));
  assert.equal(added.root.files, 0, 'configured but not yet read');
  assert.equal(added.root.lastScannedAt, null);
  assert.equal(listRoots(db).length, 1);

  db.close();
});

test('a path that is not a directory on this machine is refused, and named', () => {
  // The failure this prevents is the quiet one: a mistyped root scans nothing,
  // reports success, and leaves an operator wondering where their library went.
  const { db, root } = workspace();

  assert.throws(() => addRoot(db, join(root, 'no-such-shelf')), /not a directory on this machine/);
  assert.throws(() => addRoot(db, join(root, 'album', 'track.flac')), /not a directory/, 'a file is not a directory');
  assert.deepEqual(listRoots(db), [], 'and nothing was configured');

  db.close();
});

test('one directory is one root, however it is spelled', () => {
  // `rootKey` is the scanner's own notion of identity — the trailing separator,
  // the `.` segment, the case a Windows volume folds — and it is asked here for
  // the same reason: two rows for one directory is every file under it read
  // twice, which nothing downstream can see.
  const { db, root } = workspace();

  addRoot(db, root);
  const again = addRoot(db, `${root}${process.platform === 'win32' ? '\\' : '/'}`);
  const relative = addRoot(db, resolve(root));

  assert.equal(again.already, true);
  assert.equal(relative.already, true);
  assert.equal(listRoots(db).length, 1, 'and there is still one root');
  assert.equal(again.root.id, relative.root.id);

  db.close();
});

test('a root is listed with what came from it, and when it was last read', () => {
  const { db, root } = workspace();
  scanned(db, resolve(root), 7, 2);

  const [view] = listRoots(db);

  assert.equal(view?.files, 7, 'audio files, which is what a person counts as songs');
  assert.equal(view?.albums, 2);
  assert.equal(view?.folders, 1);
  assert.equal(view?.lastScanStatus, 'ok');
  assert.equal(view?.lastScannedAt, '2026-09-01T00:01:00.000Z');

  db.close();
});

test('a root that was never scanned says so rather than looking empty', () => {
  // "Nothing under it" and "nobody has looked" are different facts about a
  // shelf, and the second is what an operator who just added one needs to see.
  const { db, root } = workspace();
  addRoot(db, root);

  const [view] = listRoots(db);

  assert.equal(view?.files, 0);
  assert.equal(view?.lastScannedAt, null);
  assert.equal(view?.lastScanStatus, null);

  db.close();
});

test('removing a root takes what came from it, and says how much that was', () => {
  // The destructive verb, and the cascade is the point: every folder, file and
  // album under a root is derived from it, so a root that went while its rows
  // stayed would be a library still serving a shelf the deployment no longer
  // reads. The count is in the answer because "removed" and "removed a third of
  // your library" are the same word and not the same event.
  const { db, root } = workspace();
  scanned(db, resolve(root), 12, 3);

  const removed = removeRoot(db, root);

  assert.equal(removed?.songs, 12);
  assert.equal(removed?.albums, 3);
  assert.deepEqual(listRoots(db), []);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number }).n,
    0,
    'and nothing of it is left in the library',
  );

  db.close();
});

test('removing one root leaves the other one alone', () => {
  const { db, root } = workspace();
  const other = join(tempRoot('funoteka-roots-'), 'other');
  mkdirSync(other, { recursive: true });

  scanned(db, resolve(root), 3, 1);
  scanned(db, resolve(other), 5, 2);

  removeRoot(db, root);

  const left = listRoots(db);
  assert.equal(left.length, 1);
  assert.equal(left[0]?.path, resolve(other));
  assert.equal(left[0]?.files, 5);

  db.close();
});
