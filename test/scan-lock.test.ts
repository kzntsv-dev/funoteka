import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import * as playlists from '../src/playlist/store.ts';
import { scan } from '../src/scan/scan.ts';
import type { WalkResult } from '../src/scan/walk.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The scan and the server write one file, and they are two connections to it.
 *
 * The server keeps its connection open for the life of the process and answers
 * every client on it; a scan is its own process with a connection of its own
 * (`cli.ts`). SQLite gives one writer at a time, so the two are only ever
 * sharing the file politely if the scan's transactions are short — and a scan
 * that holds the write lock across its whole run makes a listener's save fail.
 *
 * What that costs is bounded by `busy_timeout` (250 ms, `db/index.ts`), which is
 * short on purpose: the wait is served by blocking the one thread this server
 * answers on. So the scan has to let go often enough that a save waiting on it
 * gets in, which is the contract the three tests below pin — the walk, the
 * boundary between roots, and the boundary between batches.
 *
 * The listener here is a second connection in this process rather than a real
 * server. That is the same arrangement as two processes on one file, minus the
 * parts that are not about locking, and it lets a test say *when* the save
 * arrives — which is the whole question.
 */

function tempDb(): { dir: string; path: string } {
  const dir = tempRoot('funoteka-lock-');
  return { dir, path: join(dir, 'funoteka.db') };
}

/** A root of `count` files, without touching a disk — the walk is injected. */
function walkOf(prefix: string, count: number): WalkResult {
  const name = (i: number): string => `track-${String(i).padStart(4, '0')}.flac`;
  return {
    files: Array.from({ length: count }, (_, i) => ({
      relPath: `${prefix}/${name(i)}`,
      folderRelPath: prefix,
      name: name(i),
      kind: 'audio' as const,
      ext: 'flac',
      size: 1,
      mtimeMs: 1,
    })),
    folders: [prefix],
    skipped: [],
    ignored: [],
  };
}

test('a listener saves a playlist while the scan is walking the disk', () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  const listener = openDb(path);

  let attempted = false;
  const counters = scan(db, ['/collection'], {
    walk: () => {
      // Where a listener's save lands in real life. Walking the disk is most of
      // what a scan does and none of what needs the write lock, so this is the
      // moment the scan has least business refusing anybody.
      playlists.create(listener, 'Driving', []);
      attempted = true;
      return walkOf('album', 2);
    },
  });

  assert.ok(attempted, 'the save has to reach the database, not be skipped');
  assert.equal(counters.files, 2);
  assert.deepEqual(
    (listener.prepare('SELECT name FROM playlist').all() as { name: string }[]).map((r) => r.name),
    ['Driving'],
    'the playlist is there — the scan neither refused the save nor undid it',
  );

  listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a root is committed before the next root is walked', () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  const listener = openDb(path);

  const seen: number[] = [];
  let walked = 0;
  scan(db, ['/first', '/second'], {
    walk: () => {
      walked += 1;
      if (walked === 2) {
        // The first root is done. Rows still inside the scan's transaction read
        // as zero here, and a listener is owed the opposite: what a scan has
        // finished with is finished.
        seen.push((listener.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number }).n);
      }
      return walkOf(`root-${walked}`, 2);
    },
  });

  assert.deepEqual(
    seen,
    [2],
    'the first root’s files are visible before the second root is walked',
  );

  listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the scan lets go of the lock between batches, so a save lands mid-root', () => {
  // One root, far more files than one transaction should carry. Every batch
  // boundary is a moment the scan has committed and holds nothing, and the
  // saves below are made exactly there — which is the only place outside a
  // synchronous scan they can be made from.
  const { dir, path } = tempDb();
  const db = openDb(path);
  const listener = openDb(path);

  let saves = 0;
  const counters = scan(db, ['/collection'], {
    walk: () => walkOf('album', 2000),
    onBatch: () => {
      playlists.create(listener, `save-${saves}`, []);
      saves += 1;
    },
  });

  assert.ok(
    saves > 1,
    `expected the root to be written in more than one transaction, saw ${saves}`,
  );
  assert.equal(counters.files, 2000);
  assert.equal(
    (listener.prepare('SELECT COUNT(*) AS n FROM playlist').get() as { n: number }).n,
    saves,
    'every save made between batches is there',
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number }).n,
    2000,
    'and the scan finished its own work',
  );

  listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
