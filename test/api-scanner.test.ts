import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanner } from '../src/api/scanner.ts';
import { openDb } from '../src/db/index.ts';

/**
 * The runner, with a real child process.
 *
 * `node -e ""` rather than a scan: what is under test is the handle, the row and
 * the words the surface gets back, and a test that walked a real collection
 * would be testing the filesystem it happens to run on. The child is real
 * because the thing being asked about is *a process* — started, watched, killed
 * — and every fake of that is a test of the fake.
 *
 * Two of these cover paths a live server has to reach and a fake cannot: a run
 * left `running` by a process that is gone, which is the way out of a scan
 * nobody can stop, and a row that says `ok` beside a handle that is still
 * there — measured on a live server, where a run over 2400 files finished in
 * 353 ms and its process was still around a second later.
 */

/** Wait for something to become true, or give up saying what never happened. */
async function until(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A runner whose command is a process that sits still until it is killed. */
function idle(): ReturnType<typeof scanner> {
  return scanner({
    db: openDb(':memory:'),
    roots: () => ['/music'],
    command: () => ({ file: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] }),
  });
}

/** A run row, as a scan would have left it. */
function runningRow(db: ReturnType<typeof openDb>, id = 1, status = 'running'): void {
  db.prepare(
    'INSERT INTO scan_run (id, started_at, status, roots_json) VALUES (?, ?, ?, ?)',
  ).run(id, '2026-09-16T00:00:00.000Z', status, JSON.stringify(['/music']));
}

test('a scan that is started is a process, and it is reported as one', async () => {
  const runner = idle();

  const started = runner.start('full');
  assert.equal(started.ok, true);

  const state = runner.status();
  assert.equal(state.running?.mode, 'full');
  assert.ok((state.running?.pid ?? 0) > 0, 'and the pid is a real one, because the child is');
  assert.equal(state.last, null, 'nothing has been written about a run yet — the child would write it');

  runner.cancel();
  await until('the child to be gone', () => runner.status().running === null);
});

test('a scan with nothing to read is refused here, rather than spawned to fail', async () => {
  // The child would exit with a usage error and this end would have logged
  // "scanning" about it — a line saying the opposite of what happened. Found on
  // a live server whose engine started before any root was configured.
  const db = openDb(':memory:');
  const runner = scanner({ db, roots: () => [], command: () => ({ file: process.execPath, args: ['-e', ''] }) });

  const refused = runner.start('incremental');

  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.reason : '', /no roots are configured/);
  assert.equal(runner.status().running, null, 'and no process was started for it');

  db.close();
});

test('a second scan is refused while one is running', async () => {
  const runner = idle();

  runner.start('incremental');
  const again = runner.start('incremental');

  assert.equal(again.ok, false);
  assert.match(again.ok === false ? again.reason : '', /already running/);

  runner.cancel();
  await until('the child to be gone', () => runner.status().running === null);
});

test('cancelling settles a run this process never started', async () => {
  // The way out of a row left `running` by a process that has since gone — a
  // server that was restarted mid-scan, or a scan that was killed with the
  // machine. Without it, every later scan would be refused for ever.
  const db = openDb(':memory:');
  const runner = scanner({ db, roots: () => ['/music'], command: () => ({ file: process.execPath, args: ['-e', ''] }) });
  runningRow(db, 7);

  const cancelled = runner.cancel();

  assert.deepEqual(cancelled, { ok: true, settled: 7 });
  assert.equal(
    (db.prepare('SELECT status FROM scan_run WHERE id = 7').get() as { status: string }).status,
    'cancelled',
  );
  assert.notEqual(runner.status().last?.finishedAt, null, 'and it says when it stopped');

  db.close();
});

test('nothing to cancel is a refusal, and not a quiet success', async () => {
  // The wrong answer here is the expensive one: a caller told a scan was stopped
  // has no reason to look again, and the run it meant to stop is still going.
  const db = openDb(':memory:');
  const runner = scanner({ db, roots: () => ['/music'], command: () => ({ file: process.execPath, args: ['-e', ''] }) });

  const nothing = runner.cancel();
  assert.equal(nothing.ok, false);
  assert.match(nothing.ok === false ? nothing.reason : '', /no scan is running/);

  // **A finished run is not a scan to stop.** With no child of ours, the row is
  // the only thing left that could be running, and a row that says `ok` is not.
  runningRow(db, 3, 'ok');
  assert.equal(runner.cancel().ok, false);

  db.close();
});

test('a run recorded as running is in the way of the next one', async () => {
  const db = openDb(':memory:');
  const runner = scanner({ db, roots: () => ['/music'], command: () => ({ file: process.execPath, args: ['-e', ''] }) });
  runningRow(db, 9);

  const refused = runner.start('incremental');

  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.reason : '', /run 9 is still recorded as running/);
  assert.match(refused.ok === false ? refused.reason : '', /scan\/cancel/, 'and names the way out');

  runner.cancel();
  assert.equal(runner.start('incremental').ok, true, 'which works');

  db.close();
});

test('history is the runs, newest first', () => {
  const db = openDb(':memory:');
  const runner = scanner({ db, roots: () => ['/music'], command: () => ({ file: process.execPath, args: ['-e', ''] }) });

  runningRow(db, 1, 'ok');
  runningRow(db, 2, 'failed');

  const runs = runner.history(10);

  assert.deepEqual(runs.map((one) => one.id), [2, 1]);
  assert.equal(runs[0]?.status, 'failed');
  assert.deepEqual(runs[0]?.roots, ['/music'], 'with the roots that run covered');

  db.close();
});
