import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db/index.ts';
import { PROBE_METHOD } from '../src/probe/ffprobe.ts';
import { dueAt, quiet, quietUntil, staleReadings, watchable, type Schedule } from '../src/scan/schedule.ts';
import { TAGS_METHOD } from '../src/tags/read.ts';

/**
 * When this server reads the disk by itself, asked directly.
 *
 * The rules here are the ones somebody will argue with — a scan that began at
 * 03:40 and made the house's music stutter is a scan whose *schedule* is the
 * bug — and every one of them is about an instant. A test that had to wait six
 * hours to see what the schedule does would not be written, which is why the
 * clock is a parameter and the whole file is arithmetic.
 */

const NIGHT: Schedule = { intervalMinutes: 360, quietFrom: 3, quietTo: 6 };

/** An instant, local time, so that "the hour of the day" means what it says. */
function at(hour: number, minute = 0, day = 10): Date {
  return new Date(2026, 8, day, hour, minute, 0, 0);
}

test('a schedule that never scans answers nothing', () => {
  // Zero turns the timer off: a deployment with a cron job of its own says so
  // with a number and needs no second setting to say it with.
  assert.equal(dueAt(null, at(12), { ...NIGHT, intervalMinutes: 0 }), null);
  assert.equal(dueAt(null, at(12), { ...NIGHT, intervalMinutes: -1 }), null);
});

test('a library that has never been read is due now, and a fresh one is not', () => {
  // Except in the quiet hours, which is the whole point of them: the first scan
  // of a deployment that was installed at midnight waits until morning.
  assert.deepEqual(dueAt(null, at(12), NIGHT), at(12));
  assert.deepEqual(dueAt(null, at(4), NIGHT), at(6), 'installed at four in the morning, read at six');

  const justRead = at(11).toISOString();
  assert.deepEqual(dueAt(justRead, at(12), NIGHT), at(11 + 6), 'six hours after the last one');
  assert.deepEqual(dueAt(justRead, at(18), NIGHT), at(18), 'and now, once that has passed');
});

test('a due time inside the quiet hours is moved to the end of them', () => {
  // Moved rather than skipped: a deployment whose interval always lands in the
  // quiet window would otherwise never scan again.
  // Read at ten in the evening, six hours later is four in the morning — which
  // is inside the window, and waits for the end of it.
  const readAtTen = at(22, 0, 9).toISOString();
  assert.deepEqual(dueAt(readAtTen, at(3), NIGHT), at(6), 'due at 04:00, moved to the end of the window');

  // And a clock that is *already* inside the window with the interval long past:
  // the scan happens when the window closes, not never.
  assert.deepEqual(dueAt(at(1, 0, 9).toISOString(), at(4), NIGHT), at(6));
  assert.deepEqual(quietUntil(at(3, 30), NIGHT), at(6));
  assert.deepEqual(quietUntil(at(5, 59), NIGHT), at(6));
  assert.deepEqual(quietUntil(at(6), NIGHT), at(6), 'the hour it may start again is not quiet');
  assert.deepEqual(quietUntil(at(12), NIGHT), at(12), 'and nothing outside the window moves');
});

test('a window that crosses midnight is the hours at or after it, and before its end', () => {
  // The shape it has for anybody who works late: 23 to 6 is not "the interval
  // between 23 and 6" — it is the evening *and* the small hours.
  const evening: Schedule = { ...NIGHT, quietFrom: 23, quietTo: 6 };

  assert.equal(quiet(at(23), evening), true);
  assert.equal(quiet(at(2), evening), true);
  assert.equal(quiet(at(5), evening), true);
  assert.equal(quiet(at(6), evening), false);
  assert.equal(quiet(at(12), evening), false);
  assert.equal(quiet(at(22), evening), false);

  assert.deepEqual(quietUntil(at(23, 30), evening), at(6, 0, 11), 'and the end of it is tomorrow');
  assert.equal(quiet(at(12), { ...NIGHT, quietFrom: 5, quietTo: 5 }), false, 'from === to is no window at all');
});

test('a network share is not watched, and a local directory is', () => {
  // **The honest half of "auto-detect".** Notifications do not cross a network:
  // inotify cannot hear about a change made on another machine, and a UNC path on
  // Windows has no change journal to subscribe to. A watcher that is silently
  // deaf there is worse than no watcher, because the deployment believes it has
  // one.
  assert.equal(watchable('\\\\server\\music').ok, false);
  assert.equal(watchable('//server/music').ok, false);
  assert.equal(watchable('/srv/music').ok, true);
  assert.equal(watchable('C:\\Users\\demo\\Music').ok, true);

  const why = watchable('\\\\nas\\music');
  assert.match(why.ok === false ? why.why : '', /network path/);
});

test('what an older reader left behind is counted, and a current library counts nothing', () => {
  // The stages re-read a file whose stamp is behind on their own; what this
  // answers is whether the *next* scan is an ordinary one, which is what tells
  // the engine to scan now instead of in six hours.
  const db = openDb(':memory:');
  db.prepare("INSERT INTO root (id, path, created_at) VALUES (1, '/music', 'x')").run();
  db.prepare(
    "INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms, tags_method) " +
      "VALUES (1, 1, 'a.flac', '', 'a.flac', 'audio', 'flac', 1, 1, ?)",
  ).run(TAGS_METHOD);
  db.prepare(
    "INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms, tags_method) " +
      "VALUES (2, 1, 'b.flac', '', 'b.flac', 'audio', 'flac', 1, 1, 0)",
  ).run();

  assert.deepEqual(staleReadings(db), { tags: 1, probes: 0 }, 'the one read by an older method');

  db.prepare('UPDATE file SET tags_method = ? WHERE id = 2').run(TAGS_METHOD);
  db.prepare(
    "INSERT INTO audio_probe (file_id, probe_method) VALUES (1, ?)",
  ).run(PROBE_METHOD - 1);

  assert.deepEqual(staleReadings(db), { tags: 0, probes: 1 }, 'and the probe that is behind');

  db.close();
});
