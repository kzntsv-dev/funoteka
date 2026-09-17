import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { rescan, tickFor } from '../src/api/rescan.ts';
import type { ScanMode, Scanner } from '../src/api/scanner.ts';
import { openDb, type DatabaseSync } from '../src/db/index.ts';
import { TAGS_METHOD } from '../src/tags/read.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The server reading the disk by itself.
 *
 * A fake scanner and a fake clock, because what is under test is *when* — the
 * work is a process of its own and a suite that let it start real scans would be
 * testing the filesystem it happens to run on. The one part that is real is the
 * watcher, in the last two tests: `fs.watch` is the operating system's, and a
 * fake of it would prove that a fake works.
 */

const HOUR = 60;

interface Rig {
  scanner: Scanner;
  starts: { mode: ScanMode; why: string }[];
  log: string[];
  run: (state: { pid: number; mode: ScanMode } | null, lastStartedAt?: string | null) => void;
  rescan: ReturnType<typeof rescan>;
  stop: () => void;
}

/** An engine over a database, a clock, and a scanner that records what it was asked. */
function rig(t: TestContext, options: {
  db: DatabaseSync;
  now: () => Date;
  watch?: boolean;
  roots?: () => string[];
  schedule?: { intervalMinutes: number; quietFrom: number; quietTo: number };
  settleMs?: number;
}): Rig {
  const starts: { mode: ScanMode; why: string }[] = [];
  const log: string[] = [];
  let running: { pid: number; mode: ScanMode; startedAt: string; cancelling: boolean } | null = null;
  let last: string | null = null;

  const scanner: Scanner = {
    start: (mode) => {
      starts.push({ mode, why: '' });
      return { ok: true, pid: 1 };
    },
    status: () => ({
      running,
      last:
        last === null
          ? null
          : { id: 1, startedAt: last, finishedAt: null, status: 'ok', roots: [] },
    }),
    cancel: () => ({ ok: false, reason: 'no scan is running' }),
    history: () => [],
  };

  const engine = rescan({
    db: options.db,
    scanner,
    // A deployment with a shelf: the engine refuses to start a scan with
    // nothing to read, so a rig with no roots would test that refusal instead
    // of whatever the test is about.
    roots: options.roots ?? (() => ['/music']),
    schedule: options.schedule ?? { intervalMinutes: 6 * HOUR, quietFrom: 3, quietTo: 6 },
    watch: options.watch ?? false,
    log: (line) => log.push(line),
    settleMs: options.settleMs ?? 50,
    // A tick nobody waits for: the tests call `check` themselves, which is the
    // same function the timer calls.
    tickMs: 60 * 60 * 1000,
    now: options.now,
    // The tests drive `check` themselves; the one that asks about the startup
    // look builds its own engine (see the last test).
    startup: false,
  });

  // **Stopping is registered, not written at the end of each test.** An
  // assertion that fails leaves an open `fs.watch` behind, and a watcher holds
  // the event loop open — so the suite would not fail, it would hang until the
  // runner gave up. Which is what the first version of this file did.
  t.after(() => engine.stop());

  return {
    scanner,
    starts,
    log,
    run: (state, lastStartedAt = undefined) => {
      // The engine asks only whether something is running, so the rest of the
      // shape is filled in here rather than asked of every test.
      running = state === null ? null : { ...state, startedAt: midnight().toISOString(), cancelling: false };
      if (lastStartedAt !== undefined) last = lastStartedAt;
    },
    rescan: engine,
    stop: engine.stop,
  };
}

test('the tick is fine enough for the interval somebody asked for', () => {
  // A tick coarser than the interval would make the setting a lie: a deployment
  // that asked for a scan every minute and got one every five would be a
  // deployment whose number does not mean what it says.
  assert.equal(tickFor({ intervalMinutes: 360, quietFrom: 3, quietTo: 6 }), 5 * 60_000);
  assert.equal(tickFor({ intervalMinutes: 1, quietFrom: 3, quietTo: 6 }), 15_000, 'a quarter of the interval');
  assert.equal(tickFor({ intervalMinutes: 100, quietFrom: 0, quietTo: 0 }), 5 * 60_000, 'and never finer than that');
  assert.equal(tickFor({ intervalMinutes: 0, quietFrom: 0, quietTo: 0 }), 5 * 60_000, 'a timer that is off still ticks');
});

test('a server with no roots says so once, and does not spawn a doomed scan', (t) => {
  // A scan with nothing to read exits with a usage error, and the line this end
  // would have written says the opposite of what happened.
  const store = db();
  const engine = rig(t, { db: store, now: midnight, roots: () => [] });

  engine.rescan.check();
  engine.rescan.check();
  engine.rescan.check();

  assert.deepEqual(engine.starts, [], 'nothing was started');
  assert.deepEqual(engine.log, ['funoteka: nothing to scan — no roots are configured'], 'said once');

  store.close();
});

/** A database with a library in it, or without one. */
function db(): DatabaseSync {
  const opened = openDb(':memory:');
  opened.prepare("INSERT INTO root (id, path, created_at) VALUES (1, '/music', 'x')").run();
  return opened;
}

function midnight(): Date {
  return new Date(2026, 8, 10, 12, 0, 0, 0);
}

test('an engine looks once when it is built, so a server that was down reads at once', (t) => {
  // The behaviour a deployment needs and a test would otherwise trip over: a
  // server that has been off for a week reads the disk when it comes up.
  const store = db();
  const starts: string[] = [];

  const engine = rescan({
    db: store,
    scanner: {
      start: () => {
        starts.push('started');
        return { ok: true, pid: 1 };
      },
      status: () => ({ running: null, last: null }),
      cancel: () => ({ ok: false, reason: 'no scan is running' }),
      history: () => [],
    },
    roots: () => ['/music'],
    schedule: { intervalMinutes: 360, quietFrom: 3, quietTo: 6 },
    watch: false,
    log: () => {},
    tickMs: 60 * 60 * 1000,
    now: midnight,
  });
  t.after(() => engine.stop());

  assert.deepEqual(starts, ['started'], 'once, without being asked');

  store.close();
});

test('a library nobody has read is read at once, and a fresh one waits for its interval', (t) => {
  const store = db();
  const engine = rig(t, { db: store, now: midnight });

  engine.rescan.check();
  assert.equal(engine.starts.length, 1, 'never read, so read now');
  assert.match(engine.log[0] ?? '', /never been read/);

  // The engine asks the scanner whether a run is in progress and when the last
  // one started, so a test drives both through it.
  engine.run(null, midnight().toISOString());
  engine.rescan.check();
  assert.equal(engine.starts.length, 1, 'six hours have not passed');

  store.close();
});

test('the interval elapsing starts one, and the quiet hours do not', (t) => {
  const store = db();
  const engine = rig(t, { db: store, now: midnight });

  engine.run(null, new Date(2026, 8, 9, 23, 0, 0).toISOString());
  engine.rescan.check();
  assert.equal(engine.starts.length, 1, 'thirteen hours since the last one');
  assert.match(engine.log[0] ?? '', /interval elapsed/);

  // Four in the morning: due, and not allowed. The engine does not queue it —
  // the next tick asks again, and the answer changes when the window closes.
  const night = rig(t, { db: store, now: () => new Date(2026, 8, 10, 4, 0, 0, 0) });
  night.run(null, new Date(2026, 8, 9, 20, 0, 0).toISOString());
  night.rescan.check();
  assert.deepEqual(night.starts, [], 'the house is asleep');

  store.close();
});

test('a scan already running is the answer to every reason to start one', (t) => {
  const store = db();
  const engine = rig(t, { db: store, now: midnight });

  engine.run({ pid: 4242, mode: 'full' }, null);
  engine.rescan.check();

  assert.deepEqual(engine.starts, [], 'not a second one');
  assert.deepEqual(engine.log, [], 'and not a line about it either');

  store.close();
});

test('a reader that changed makes the next scan happen now, and says why', (t) => {
  // The stages re-read a file whose stamp is behind by themselves; what was
  // missing was the engine knowing that the next scan is not an ordinary one.
  const store = db();
  store.prepare(
    "INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms, tags_method) " +
      "VALUES (1, 1, 'a.flac', '', 'a.flac', 'audio', 'flac', 1, 1, 0)",
  ).run();

  const engine = rig(t, { db: store, now: midnight });
  engine.run(null, midnight().toISOString());
  engine.rescan.check();

  assert.equal(engine.starts.length, 1, 'though the interval has only just been reset');
  assert.match(engine.log[0] ?? '', /read by an older method/);
  assert.match(engine.log[0] ?? '', /1 file\(s\) and 0 probe\(s\)/);

  // Once the stamps are current, the reason is gone — which is what keeps this
  // from being a scan every five minutes for ever.
  store.prepare('UPDATE file SET tags_method = ? WHERE id = 1').run(TAGS_METHOD);
  engine.rescan.check();
  assert.equal(engine.starts.length, 1, 'nothing left to re-read');

  store.close();
});

test('a change under a watched root is followed by a scan, once the disk is quiet', async (t) => {
  // **The half-write gate, as an observable property.** A file being copied in
  // emits a torrent of events and is not a file yet; what is waited for is
  // silence, so a scan never starts in the middle of one.
  const root = tempRoot('funoteka-rescan-');
  const store = db();

  const engine = rig(t, { db: store, now: midnight, watch: true, roots: () => [root], settleMs: 60 });
  assert.match(engine.log[0] ?? '', /watching .* for changes/);

  writeFileSync(join(root, 'a.flac'), 'x');
  await until('a scan to be asked for', () => engine.starts.length === 1);
  assert.match(engine.log.at(-1) ?? '', /disk has been quiet for/);

  // **A change while a scan is running is not a second scan, and not a line.**
  // The engine asks the scanner, and the scanner is the one that knows; what the
  // change means is either that the running scan will see it or that the next
  // one will. Waiting for a line here would be waiting for something this
  // deliberately does not do.
  engine.run({ pid: 9, mode: 'incremental' });
  writeFileSync(join(root, 'b.flac'), 'x');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(engine.starts.length, 1, 'one scan for a changed directory');
  assert.equal(engine.log.length, 2, 'the watching line, the quie tline, and nothing about the second event');

  store.close();
});

test('nothing is watched unless the deployment asked for it', async (t) => {
  const root = tempRoot('funoteka-rescan-');
  const store = db();

  const engine = rig(t, { db: store, now: midnight, watch: false, roots: () => [root] });
  writeFileSync(join(root, 'a.flac'), 'x');
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(engine.starts, [], 'the interval is what scans here');
  assert.deepEqual(engine.log, [], 'and nothing was said about watching');

  store.close();
});

test('a root that cannot be watched is said out loud, and the interval carries on', (t) => {
  // A watcher that is silently deaf is worse than no watcher, because the
  // deployment believes it has one.
  const store = db();
  // A share by name, and a directory that really is here: the second has to be
  // watchable *and* present, or the line would be about the directory being
  // missing rather than about watching being possible.
  const local = tempRoot('funoteka-rescan-');
  const engine = rig(t, {
    db: store,
    now: midnight,
    watch: true,
    roots: () => ['\\\\nas\\music', local],
  });

  assert.equal(engine.log.length, 2);
  assert.match(engine.log[0] ?? '', /not watching/);
  assert.match(engine.log[0] ?? '', /network path/);
  assert.equal(engine.log[1], `funoteka: watching ${local} for changes`);

  store.close();
});

/** Wait for something to become true, or give up saying what never happened. */
async function until(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
