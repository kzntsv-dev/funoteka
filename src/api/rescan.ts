import { watch, type FSWatcher } from 'node:fs';

import type { DatabaseSync } from '../db/index.ts';
import { dueAt, quiet, staleReadings, watchable, type Schedule } from '../scan/schedule.ts';
import { SETTLE_MS } from '../scan/settle.ts';
import type { Scanner, ScanMode } from './scanner.ts';

/**
 * The server reading the disk by itself.
 *
 * Three reasons a scan may start without anybody asking:
 *
 * - **The clock.** Every `scanInterval` minutes, unless that lands in the quiet
 *   hours — the point of which is that a scan at 03:40 is audible in a house
 *   where somebody is listening, and no reading of a disk is urgent enough to be
 *   worth that.
 * - **A change on disk**, when the deployment asked for a watcher.
 * - **A reader that changed.** The stages re-read a file whose method stamp is
 *   older than this build's on their own; what was missing was anybody knowing
 *   the next scan is not an ordinary one, so a deployment that had just been
 *   upgraded scanned in six hours instead of now.
 *
 * **It starts scans and does nothing else.** The work is `scanner`'s (a process
 * of its own, `scanner.ts`), so everything this module owns is *when* — and
 * everything about when is in `scan/schedule.ts`, where it can be asked about an
 * instant instead of waited for.
 */

export interface RescanDeps {
  db: DatabaseSync;
  scanner: Scanner;
  /** The roots as they are configured *now* — a shelf added a minute ago is watched too. */
  roots: () => string[];
  schedule: Schedule;
  watch: boolean;
  log: (line: string) => void;
  /** How long the disk must be quiet before a change is acted on. */
  settleMs?: number;
  /** How often to look at the clock. */
  tickMs?: number;
  /**
   * Whether to look once as soon as the engine is built.
   *
   * On, and it is the behaviour that matters: a server that has been down for a
   * week reads the disk when it comes up rather than after another interval. A
   * caller that drives `check` itself — a test — turns it off, because otherwise
   * the first thing it looks at is a scan it did not ask for.
   */
  startup?: boolean;
  now?: () => Date;
}

export interface Rescan {
  /** Look at the clock and the disk once, and start a scan if one is due. */
  check: () => void;
  stop: () => void;
}

/**
 * How often to look at the clock, when the interval does not ask for finer.
 *
 * Five minutes costs two counts and a row, which is nothing — but a tick coarser
 * than the interval would make the interval a lie: a deployment that asked for a
 * scan every minute and got one every five would be a deployment whose setting
 * does not mean what it says. So the tick is a quarter of the interval whenever
 * that is finer, and five minutes otherwise.
 */
const TICK_MS = 5 * 60_000;

export function tickFor(schedule: Schedule): number {
  if (schedule.intervalMinutes <= 0) return TICK_MS;
  return Math.max(1_000, Math.min(TICK_MS, (schedule.intervalMinutes * 60_000) / 4));
}

/**
 * How long the disk must be silent before a change is followed by a scan.
 *
 * **This is the watcher's half of the half-write gate, and the number belongs to
 * the other half too.** The interval scan faces the same problem with no events
 * to wait on, so it looks at a recently-written file twice instead — same rule,
 * same window, and the constant lives with that rule in `scan/settle.ts` rather
 * than here. Two numbers for one contract clause would be two rules written down
 * as agreement.
 *
 * Waiting for silence is what the watcher owes and cannot avoid: it is told
 * about an event, not about a file, so the torrent stopping is the only thing it
 * can wait for. Five seconds rather than one, because a copy over the network
 * pauses — and a pause longer than the window is the one case neither path
 * catches, which `settle.ts` states rather than hides.
 */
export function rescan(deps: RescanDeps): Rescan {
  const now = deps.now ?? (() => new Date());
  const tick = deps.tickMs ?? tickFor(deps.schedule);
  const settle = deps.settleMs ?? SETTLE_MS;

  let stopped = false;
  /**
   * Whether the operator has already been told there is nothing to read.
   *
   * Said once rather than on every tick: a server with no roots is a server
   * somebody is about to configure, and a line every five minutes for a week is
   * a log that teaches its reader to skip lines. Said again if roots come and
   * go, because then it is news again.
   */
  let saidNoRoots = false;
  let timer: NodeJS.Timeout | null = null;
  let settling: NodeJS.Timeout | null = null;


  const start = (mode: ScanMode, why: string): void => {
    const started = deps.scanner.start(mode);
    deps.log(
      started.ok
        ? `funoteka: scanning (${why})`
        : // Not an error: a scan that is already running is a scan, and the
          // reason this one was asked for is worth saying anyway — it is how
          // somebody finds out their interval is shorter than their scan.
          `funoteka: not scanning (${why}): ${started.reason}`,
    );
  };

  /**
   * The roots as they were when the watchers were last reconciled, so that a
   * tick which finds them unchanged does nothing at all.
   */
  let watched: string[] = [];

  const check = (): void => {
    if (stopped) return;

    if (deps.watch) {
      const now = deps.roots();
      if (now.join('\u0000') !== watched.join('\u0000')) {
        watched = now;
        reconcileWatchers();
      }
    }

    // A scan already on is the answer to every reason to start one.
    if (deps.scanner.status().running !== null) return;

    if (deps.roots().length === 0) {
      if (!saidNoRoots) {
        deps.log('funoteka: nothing to scan — no roots are configured');
        saidNoRoots = true;
      }
      return;
    }
    saidNoRoots = false;

    const stale = staleReadings(deps.db);
    // **The quiet hours hold here too.** They are a rule about when a scan may
    // *start*, and an upgraded deployment whose files are read by an older method
    // is not urgent enough to be the exception: the tick asks again, and when the
    // window closes it scans. The review found this trigger walking past the
    // window that the interval beside it respects.
    if ((stale.tags > 0 || stale.probes > 0) && !quiet(now(), deps.schedule)) {
      start(
        'incremental',
        `${stale.tags} file(s) and ${stale.probes} probe(s) read by an older method — this build reads them again`,
      );
      return;
    }

    const last = deps.scanner.status().last?.startedAt ?? null;
    const due = dueAt(last, now(), deps.schedule);
    if (due === null) return;
    if (due.getTime() > now().getTime()) return;

    start('incremental', last === null ? 'this library has never been read' : `its interval elapsed at ${due.toISOString()}`);
  };

  /**
   * Something changed under a root; scan once the disk has stopped changing.
   *
   * The timer is reset by every event, which is the whole of the gate: what is
   * waited for is silence, and a copy that is still running keeps pushing it
   * away.
   */
  const touched = (): void => {
    if (settling !== null) clearTimeout(settling);
    settling = setTimeout(() => {
      settling = null;
      if (stopped) return;

      // Silent when a scan is already on, and deliberately: the change is either
      // picked up by the scan that is running or by the next one, and a line per
      // event would be a log full of a copy that is still going on.
      if (deps.scanner.status().running !== null) return;
      if (deps.roots().length === 0) return;
      start('incremental', `something changed under a root and the disk has been quiet for ${settle / 1000}s`);
    }, settle);
    settling.unref?.();
  };

  /**
   * Watch what is configured *now*.
   *
   * **Called whenever the roots change, and that is the point.** The first
   * version built the watcher set once, when the engine was created — so a shelf
   * added afterwards with `POST /roots` was never watched, while the field beside
   * it promised "a shelf added a minute ago is watched too". A watcher nobody
   * notices is missing is the failure this option is careful about everywhere
   * else, and it was the one place it was not.
   */
  const watching = new Map<string, FSWatcher>();

  const reconcileWatchers = (): void => {
    const wanted = new Set(deps.roots());

    for (const [root, watcher] of watching) {
      if (wanted.has(root)) continue;
      watcher.close();
      watching.delete(root);
      deps.log(`funoteka: stopped watching ${root} — it is no longer a root`);
    }

    for (const root of wanted) {
      if (watching.has(root)) continue;

      const can = watchable(root);
      if (!can.ok) {
        // Said out loud, and the interval carries on: a watcher that is silently
        // deaf is worse than no watcher, because the deployment believes it has
        // one.
        deps.log(`funoteka: not watching ${root} — ${can.why}; the interval still scans`);
        continue;
      }

      try {
        // Recursive where the platform has it. Linux does not, and this is the
        // honest handling of that: one line, and the interval is what scans.
        const watcher = watch(root, { recursive: true }, touched);
        watcher.on('error', (err) => {
          deps.log(`funoteka: watching ${root} failed (${err.message}) — the interval still scans`);
        });
        watching.set(root, watcher);
        deps.log(`funoteka: watching ${root} for changes`);
      } catch (err) {
        deps.log(
          `funoteka: cannot watch ${root} (${(err as Error).message}) — the interval still scans`,
        );
      }
    }
  };

  if (deps.watch) {
    watched = deps.roots();
    reconcileWatchers();
  }

  timer = setInterval(check, tick);
  timer.unref?.();

  if (deps.startup !== false) check();

  return {
    check,
    stop: () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      if (settling !== null) clearTimeout(settling);
      for (const watcher of watching.values()) watcher.close();
      watching.clear();
    },
  };
}
