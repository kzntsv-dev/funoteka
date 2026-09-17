import { readFileSync } from 'node:fs';

import type { DatabaseSync } from '../db/index.ts';
import { PROBE_METHOD } from '../probe/ffprobe.ts';
import { TAGS_METHOD } from '../tags/read.ts';

/**
 * When this server reads the disk by itself, and when it should not.
 *
 * Everything here is a decision rather than an action: given when the last scan
 * ran and what the deployment asked for, when may the next one start. That
 * matters because these are the rules somebody will argue with — a scan that
 * began at 03:40 and made the whole house's music stutter is a scan whose
 * schedule is the bug — and a rule that can be asked about an instant is a rule
 * that can be checked without waiting six hours to see what it does.
 */

export interface Schedule {
  /** How often to scan, in minutes. Zero or less means never, on its own. */
  intervalMinutes: number;
  /** The first hour a scan may not start, 0–23. */
  quietFrom: number;
  /** The hour it may start again, 0–23. */
  quietTo: number;
}

/**
 * The instant a scan may next start, or nothing when this server does not scan
 * by itself at all.
 *
 * Two rules and they compose in one direction: the interval says *when* the
 * reading is old enough, and the quiet hours say *when* it is allowed to happen.
 * A due time that lands inside the quiet window is pushed to the end of it — not
 * skipped, because skipping would mean a deployment that is always in a quiet
 * window never scans again.
 *
 * The window may cross midnight (`23` to `6`), which is the shape it has for
 * anybody who works late, and `from === to` is an empty window rather than a
 * whole-day one.
 */
export function dueAt(lastStartedAt: string | null, now: Date, schedule: Schedule): Date | null {
  if (schedule.intervalMinutes <= 0) return null;

  const last = lastStartedAt === null ? null : Date.parse(lastStartedAt);
  const base = last === null || Number.isNaN(last) ? now.getTime() : last + schedule.intervalMinutes * 60_000;
  const due = new Date(Math.max(base, now.getTime()));

  return quietUntil(due, schedule);
}

/** The same instant, moved out of the quiet hours when it lands inside them. */
export function quietUntil(when: Date, schedule: Schedule): Date {
  if (!quiet(when, schedule)) return when;

  const end = new Date(when);
  end.setMinutes(0, 0, 0);
  end.setHours(schedule.quietTo);

  // A window that crosses midnight is entered before it ends, so the end is
  // tomorrow's — and an hour of `to` that is *behind* the hour of `when` is
  // exactly that case and not a window that has already passed.
  if (end.getTime() <= when.getTime()) end.setDate(end.getDate() + 1);

  return end;
}

/** Whether an instant falls in the quiet hours. */
export function quiet(when: Date, schedule: Schedule): boolean {
  const hour = when.getHours();
  const { quietFrom: from, quietTo: to } = schedule;

  if (from === to) return false;
  // `23` to `6`: the hours that are quiet are the ones at or after `from`, or
  // before `to` — the window is the union rather than the interval between.
  if (from > to) return hour >= from || hour < to;
  return hour >= from && hour < to;
}

/**
 * Whether watching this directory for changes is worth trying at all.
 *
 * **The honest answer is "not always", so it is asked rather than assumed.**
 * Filesystem notifications on a network share are the classic thing that appears
 * to work and does not: inotify has no way to hear about a change made on
 * another machine, and on Windows a UNC path has no change journal this process
 * can subscribe to. A watcher that is silent there is worse than no watcher,
 * because the deployment believes it has one — so a share is recognised and the
 * interval takes over, which is what the contract asks for and what the log
 * says happened.
 *
 * What this cannot answer is a *mapped* drive letter on Windows pointing at a
 * share: telling that apart from a local disk needs a syscall Node does not
 * expose. The runtime covers that case instead — `fs.watch` on such a path
 * either throws or delivers nothing, and the engine falls back with a line
 * saying so.
 */
export function watchable(rootPath: string): { ok: true } | { ok: false; why: string } {
  if (/^[\\/]{2}/.test(rootPath)) {
    return { ok: false, why: 'a network path: nothing this process can subscribe to reports changes made elsewhere' };
  }

  // Linux says what a mount is; the others do not have a file that answers it.
  if (process.platform === 'linux') {
    const mounted = mountTypeOf(rootPath);
    if (mounted !== null && NETWORK_FILESYSTEMS.some((kind) => mounted.startsWith(kind))) {
      return { ok: false, why: `a ${mounted} mount: no inotify event arrives for a change made on another machine` };
    }
  }

  return { ok: true };
}

/** The filesystems whose notifications do not cross a network. */
const NETWORK_FILESYSTEMS = ['nfs', 'cifs', 'smbfs', 'smb3', 'fuse.sshfs', 'fuse.rclone', '9p'];

/**
 * The filesystem type a path is on, as `/proc/mounts` describes it.
 *
 * The longest matching mount point wins, because `/` and `/mnt/media` are both
 * mounts and a file under the second is not on the first. Nothing here throws: a
 * machine without `/proc` (a container, another platform) simply does not
 * answer, and the fallback above is the interval either way.
 */
function mountTypeOf(path: string): string | null {
  let mounts: string;
  try {
    mounts = readFileSync('/proc/mounts', 'utf8');
  } catch {
    return null;
  }

  const normal = path.replace(/\/+$/, '');
  let best: { point: string; type: string } | null = null;

  for (const line of mounts.split('\n')) {
    const [device, point, type] = line.split(' ');
    if (point === undefined || type === undefined) continue;

    const decoded = point.replace(/\\040/g, ' ');
    if (normal === decoded || normal.startsWith(`${decoded.replace(/\/+$/, '')}/`)) {
      if (best === null || decoded.length > best.point.length) best = { point: decoded, type };
    }
  }

  return best?.type ?? null;
}

/**
 * How much of the library is read by a method older than this build's.
 *
 * **This is the classifier-version trigger, and it is a question rather than a
 * mechanism.** The stages already re-read a file whose stamp is behind
 * (`tags/apply.ts` selects `f.tags_method <> ?` among the reasons a file is due),
 * so a changed reader is picked up by the next scan without anyone arranging it
 * — what was missing is anybody *knowing* that the next scan is not an ordinary
 * one. An operator sees a number here, and the engine uses it to scan now
 * instead of in six hours.
 */
export function staleReadings(db: DatabaseSync): { tags: number; probes: number } {
  const count = (sql: string, method: number): number =>
    (db.prepare(sql).get(method) as { n: number }).n;

  return {
    tags: count("SELECT COUNT(*) AS n FROM file WHERE kind = 'audio' AND tags_method <> ?", TAGS_METHOD),
    probes: count('SELECT COUNT(*) AS n FROM audio_probe WHERE probe_method <> ?', PROBE_METHOD),
  };
}
