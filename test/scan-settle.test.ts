import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { observed, stillMoving } from '../src/scan/settle.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The half-write gate, against a real file and a window small enough to wait
 * out in a test.
 *
 * Two designs died before this one and `settle.ts` says how; what these assert
 * is the shape that survived: a file inside the window is waited out and then
 * compared, so "new and finished" and "new and still arriving" come apart.
 */

/** A root with one small file in it, and the file's true observation. */
function oneFile(bytes = 100): { root: string; relPath: string; onDisk: { size: number; mtimeMs: number } } {
  const root = tempRoot('funoteka-settle-');
  mkdirSync(join(root, 'Album'), { recursive: true });
  const relPath = 'Album/song.flac';
  writeFileSync(join(root, relPath), 'x'.repeat(bytes));
  return { root, relPath, onDisk: observed(statSync(join(root, relPath))) };
}

test('a file nothing has written to recently is not held', () => {
  // The common case, and it costs no wait: nothing is inside the window, so the
  // walk's word is the whole answer.
  const { root, relPath, onDisk } = oneFile();
  const now = Date.now();
  const started = Date.now();

  const held = stillMoving(root, [{ relPath, ...onDisk, mtimeMs: now - 60_000 }], now, 40);

  assert.deepEqual(held, []);
  assert.ok(Date.now() - started < 40, 'and nothing was waited for');

  rmSync(root, { recursive: true, force: true });
});

test('a file that grew while the window was waited out is held', () => {
  // A copy in progress: the walk saw a file that is not the file on disk, and no
  // observation at one instant can say that — which is why something is waited
  // for.
  const { root, relPath, onDisk } = oneFile(100);
  const now = Date.now();

  const held = stillMoving(root, [{ relPath, size: onDisk.size - 50, mtimeMs: now }], now, 40);

  assert.deepEqual(held, [relPath]);

  rmSync(root, { recursive: true, force: true });
});

test('a file that finished before the scan is not held, and that is the ordinary case', () => {
  // **The shape that broke the design before this one.** An album copied and then
  // scanned — one second or one hour earlier, it is the same thing — must arrive
  // whole. Nothing is written during the wait, so the two observations agree and
  // the file is recorded.
  //
  // The walk reports the file as it truly is, mtime and all, which is also what
  // puts it inside the window: a fixture written a moment ago is exactly the file
  // an operator scans after a copy. What saves it is that nothing writes to it
  // during the wait.
  const { root, relPath, onDisk } = oneFile();

  const held = stillMoving(root, [{ relPath, ...onDisk }], Date.now(), 40);

  assert.deepEqual(held, []);

  rmSync(root, { recursive: true, force: true });
});

test('a file that vanished during the wait is held', () => {
  // Gone between the two observations, or unreadable. "We could not look at it
  // again" is not "it has settled", and reading it is what the gate exists to
  // stop — so the safe reading is the one that holds it back.
  const { root, onDisk } = oneFile();
  const now = Date.now();

  const held = stillMoving(root, [{ relPath: 'Album/gone.flac', ...onDisk, mtimeMs: now }], now, 40);

  assert.deepEqual(held, ['Album/gone.flac']);

  rmSync(root, { recursive: true, force: true });
});

test('a clock that runs ahead does not make the wait longer than the window', () => {
  // **The one case where the window is a ceiling rather than a rule.** `nowMs` is
  // this process's clock and an mtime is whatever wrote the file, so the
  // subtraction can come out longer than the window: a share whose clock runs
  // ahead, an archive unpacked with the mtimes it was packed with. Measured
  // before the ceiling — a file 20 seconds ahead made a scan take 24 seconds
  // longer end to end, and the run stayed `running` the whole time, which is a
  // state nothing else can start a scan from.
  const { root, relPath, onDisk } = oneFile();
  const now = Date.now();
  const window = 100;

  const started = Date.now();
  const held = stillMoving(root, [{ relPath, ...onDisk, mtimeMs: now + 60_000 }], now, window);
  const waited = Date.now() - started;

  assert.ok(waited < window * 3, `waited ${waited} ms, which is the skew rather than the window`);
  assert.deepEqual(
    held,
    [relPath],
    'and it is held rather than recorded: a clock that disagrees is not a settled file',
  );

  rmSync(root, { recursive: true, force: true });
});

test('a window of zero is no gate at all, even for a file whose clock is ahead', () => {
  // `scan`'s default, and the difference between "no window" and "a window of
  // zero milliseconds" used to be arithmetic: the filter took every file whose
  // mtime was not in the past, and the wait then slept out the skew. Nothing is
  // looked at here at all, which is what a caller asking for no gate is asking.
  const { root, relPath, onDisk } = oneFile();
  const now = Date.now();

  const started = Date.now();
  const held = stillMoving(root, [{ relPath, ...onDisk, mtimeMs: now + 60_000 }], now, 0);

  assert.deepEqual(held, []);
  assert.ok(Date.now() - started < 50, 'and nothing was waited for');

  rmSync(root, { recursive: true, force: true });
});

test('the wait is the remainder of the window, not the whole of it', () => {
  // A file written a moment ago is the most settled file there can be that is
  // still new, and making the scan pay the full window for it would be paying
  // for nothing. The wait is measured from the file's own mtime.
  const { root, relPath, onDisk } = oneFile();
  const now = Date.now();
  const window = 300;

  const started = Date.now();
  stillMoving(root, [{ relPath, ...onDisk, mtimeMs: now - 250 }], Date.now(), window);
  const waited = Date.now() - started;

  assert.ok(waited >= 20, `waited ${waited} ms, expected the ~50 ms remainder`);
  assert.ok(waited < 250, `waited ${waited} ms, which is the whole window rather than the rest of it`);

  rmSync(root, { recursive: true, force: true });
});
