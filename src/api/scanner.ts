import { spawn, type ChildProcess } from 'node:child_process';

import type { DatabaseSync } from '../db/index.ts';

/**
 * A scan, run from the server without stopping it.
 *
 * **The scan is a process of its own, and that is not a detail.** The server
 * answers every client on one thread, and `node:sqlite` is synchronous: a scan
 * running inside this process would hold that thread for the length of a walk —
 * measured on the live collection, a full pass is tens of seconds — and every
 * phone in the house would wait for it. So `POST /scan` starts the same command
 * an operator would have run by hand, and what this module owns is the handle to
 * it, not the work.
 *
 * It also means the scanner's own guarantees are unchanged: one connection, its
 * longer `busy_timeout`, its `synchronous = NORMAL` — all decided by the CLI
 * that starts it, and none of them re-decided here.
 *
 * **What this is not, yet.** The rescan engine (`task:2940`) owns the timer, the
 * watcher and the gate against two scans at once. What is here is the primitive
 * it will use: start one, watch it, stop it, and see what the last ones did.
 * One gap is worth naming because it is not obvious: a scan outlives a restart
 * of the server — it is a separate process — and a restarted server has no
 * handle to a scan it did not start. So "is a scan running" is answered from the
 * database and not from the child handle alone, and `cancel` settles a run this
 * process is not running.
 */

export type ScanMode = 'incremental' | 'full';

export interface ScanRunRow {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  roots: string[];
}

export interface ScanState {
  /** The scan this process is running, or nothing. */
  running: { pid: number; mode: ScanMode; startedAt: string; cancelling: boolean } | null;
  /** The newest run in the database, whatever process ran it. */
  last: ScanRunRow | null;
}

export type Started = { ok: true; pid: number } | { ok: false; reason: string };
export type Cancelled = { ok: true; settled: number | null } | { ok: false; reason: string };

export interface Scanner {
  start(mode: ScanMode): Started;
  status(): ScanState;
  cancel(): Cancelled;
  history(limit: number): ScanRunRow[];
}

export interface ScannerDeps {
  db: DatabaseSync;
  /** The directories this deployment reads; a scan with none of them reads nothing. */
  roots: () => string[];
  /** The command to run, as the CLI would be run by hand. */
  command: (mode: ScanMode) => { file: string; args: string[] };
}

export function scanner(deps: ScannerDeps): Scanner {
  let child: ChildProcess | null = null;
  let mode: ScanMode = 'incremental';
  let startedAt = '';
  let cancelling = false;

  const finish = (): void => {
    child = null;
    cancelling = false;
  };

  return {
    start(next: ScanMode): Started {
      if (child !== null) {
        return { ok: false, reason: `a scan is already running (pid ${child.pid ?? '?'})` };
      }

      // **A run the database still calls `running` is a run in the way**, whoever
      // started it. Two scans on one file do not corrupt it — SQLite sees to
      // that — but they read the whole collection twice and each reports half of
      // what happened, and the operator asked for one. `cancel` is the way out
      // of a row whose process is gone, and it says when it is settling one.
      const last = newest(deps.db);
      if (last?.status === 'running') {
        return {
          ok: false,
          reason:
            `run ${last.id} is still recorded as running (started ${last.started_at}). ` +
            'If its process is gone, POST /scan/cancel settles it',
        };
      }

      // **A scan with nothing to read is refused here rather than spawned.**
      // The child would exit with a usage error — `scan needs at least one root`
      // — and this end would have logged "scanning" about it, which is a line
      // that says the opposite of what happened. Found on a live server whose
      // engine started before any root was configured.
      const roots = deps.roots();
      if (roots.length === 0) {
        return { ok: false, reason: 'no roots are configured — POST /roots adds one' };
      }

      const { file, args } = deps.command(next);
      mode = next;
      startedAt = new Date().toISOString();
      cancelling = false;

      const started = spawn(file, args, {
        // The scanner's own narration goes where this server's goes: the log a
        // deployment already collects. Piped and re-emitted, a child's output
        // arrives in the server's process and can be lost with it; inherited, it
        // is written by the process that produced it.
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
      });

      child = started;
      started.once('exit', () => {
        // The row is left as the run settled it — `ok` or `failed`, written by
        // the scanner itself. Only a cancellation has to be written from here,
        // because the process was killed before it could say so.
        if (cancelling) settleCancelled(deps.db, startedAt);
        finish();
      });
      started.once('error', finish);

      return { ok: true, pid: started.pid ?? 0 };
    },

    status(): ScanState {
      return {
        running:
          child === null || child.pid === undefined
            ? null
            : { pid: child.pid, mode, startedAt, cancelling },
        last: asRow(newest(deps.db)),
      };
    },

    cancel(): Cancelled {
      // A child of this process is killed first, and it is killed whether or not
      // its run has already recorded its end: a process that has finished its
      // work and has not exited yet is still a process, and the handle is ours.
      // (Measured on a live server: a run over 2400 files finished in 353 ms and
      // its child was still there a second later. Killing it was right; the row
      // it had already settled is left alone by `settleCancelled`.)
      if (child !== null) {
        cancelling = true;
        // Killed rather than asked to stop, and on Windows there is no choice: a
        // signal has no handler to reach. Safe here for the same reason it is
        // safe for the server: the meta layer is SQLite in WAL, built to survive
        // a writer that stops mid-write, and the stages rebuild their own rows
        // from the present — which is what makes a half-finished run something
        // the next one repairs rather than something that has to be undone.
        child.kill();
        return { ok: true, settled: null };
      }

      // Nothing of ours is running, so what is left to stop is a *row* — one a
      // process that has since gone left `running`, which is a server restarted
      // mid-scan or a scan killed with the machine. Settling it is the whole of
      // what cancel can mean here, and saying which of the two it did is the
      // difference between "stopped" and "marked as stopped".
      const last = newest(deps.db);
      if (last?.status !== 'running') return { ok: false, reason: 'no scan is running' };

      settleCancelled(deps.db, last.started_at);
      return { ok: true, settled: last.id };
    },

    history(limit: number): ScanRunRow[] {
      const rows = deps.db
        .prepare(
          'SELECT id, started_at, finished_at, status, roots_json FROM scan_run ORDER BY id DESC LIMIT ?',
        )
        .all(limit) as unknown as RawRun[];

      return rows.map((row) => ({
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        roots: parseRoots(row.roots_json),
      }));
    },
  };
}

interface RawRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  roots_json: string;
}

/**
 * The newest run, which is the one a question about "the scan" is about.
 *
 * Read from the database rather than remembered from this process's own child,
 * because a scan outlives a restart of the server: a server that has just come
 * up has no handle to a walk that is still going, and reporting "nothing is
 * running" beside a row that says otherwise would be two answers to one
 * question.
 */
function newest(db: DatabaseSync): RawRun | null {
  return (
    (db
      .prepare(
        'SELECT id, started_at, finished_at, status, roots_json FROM scan_run ORDER BY id DESC LIMIT 1',
      )
      .get() as RawRun | undefined) ?? null
  );
}

/** A run row as the surface reports it, or nothing when there is no row. */
function asRow(row: RawRun | null): ScanRunRow | null {
  if (row === null) return null;
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    roots: parseRoots(row.roots_json),
  };
}

/**
 * Write down that a run was stopped.
 *
 * `cancelled` is a fourth value in a column whose comment names three — the
 * alternative was leaving the row `running` for ever, which is worse in every
 * direction: `getScanStatus` would keep telling every client that a scan is on,
 * and `start` would refuse to start one. Readers that ask `=== 'running'` read
 * it as not running, which is what it is.
 *
 * The row is found by the time the run started rather than by its id, because
 * the id is the scanner's to create and this process never saw it: a run started
 * after this one cannot be the one being settled.
 */
function settleCancelled(db: DatabaseSync, since: string): void {
  db.prepare(
    "UPDATE scan_run SET status = 'cancelled', finished_at = ? WHERE status = 'running' AND started_at >= ?",
  ).run(new Date().toISOString(), since);
}

export function parseRoots(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [];
  } catch {
    return [];
  }
}
