import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { entryPoint } from './entry.ts';

/**
 * The server, running on its own.
 *
 * A daemon and not a service, because the operating system's own service
 * machinery is a different thing on every platform and this is one program: a
 * process that outlives the shell that started it, a file saying which process
 * it is, and a command to stop it. Everything needed to supervise it further —
 * start it at boot, restart it after a crash — belongs to whatever supervises
 * things on the machine, and composes with this rather than being replaced by
 * it.
 *
 * The meta layer is the identity of a deployment, so its path is what names the
 * pid file and the log beside it: one database, one server, and whichever
 * command is pointed at that database is talking about that server.
 *
 * A pid file is a *claim*, and it is checked rather than believed. A process
 * that has exited leaves its pid behind for the next process to be given, so
 * every reader here asks the operating system whether that pid is still there —
 * otherwise a machine that rebooted once would refuse to start its server
 * forever, which is the worst possible way to be careful.
 */

/** What the daemon writes about itself, next to the meta layer it serves. */
export interface DaemonRecord {
  pid: number;
  /** The port the socket actually took, which is not the one asked for when 0. */
  port: number;
  host: string;
  dbPath: string;
  startedAt: string;
  /**
   * The admin port, when the admin surface is on.
   *
   * Recorded because it is the second thing an operator asks `status` about, and
   * because the port is the one the socket took rather than the one that was
   * configured — the two differ when 0 was asked for, which is what a test does
   * and what an operator whose port is taken does.
   */
  adminPort?: number;
}

function pidPath(dbPath: string): string {
  return `${dbPath}.pid`;
}

function logPath(dbPath: string): string {
  return `${dbPath}.log`;
}

/**
 * Whether a process with this pid exists right now. Signal 0 asks and sends nothing.
 *
 * `EPERM` is the answer that matters and the one an obvious implementation gets
 * wrong: it means the process is *there* and this one may not signal it. Reading
 * it as "gone" would report a running server as stopped and — worse — let the
 * next start overwrite a claim that was true. The rule is borrowed from
 * `agensyn`'s runner, where the same check guards the same decision.
 */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * What the pid file says, if it says anything and the process it names is there.
 *
 * Null for a file that is missing, unreadable, or not laid out the way this
 * wrote it — a file this cannot parse describes nothing it can act on, and
 * guessing at its contents is how a stop command signals the wrong process.
 */
export function running(dbPath: string): DaemonRecord | null {
  let record: DaemonRecord;
  try {
    record = JSON.parse(readFileSync(pidPath(dbPath), 'utf8')) as DaemonRecord;
  } catch {
    return null;
  }

  if (typeof record?.pid !== 'number' || !alive(record.pid)) return null;
  return record;
}

/**
 * Write the claim, once the socket is actually listening.
 *
 * Best-effort, and deliberately so: this runs inside the server's `listen`
 * callback, where a throw would take down a server that is up, listening and
 * answering. What is lost when the write fails is `stop` and `status` finding
 * it — which is bad, and is not as bad as the server itself — so the failure is
 * said on stderr rather than swallowed, and the server keeps serving.
 */
export function claim(dbPath: string, record: DaemonRecord): void {
  try {
    writeFileSync(pidPath(dbPath), `${JSON.stringify(record, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(
      `funoteka: serving, but could not write ${pidPath(dbPath)}: ${(err as Error).message}\n`,
    );
  }
}

export function release(dbPath: string): void {
  try {
    rmSync(pidPath(dbPath), { force: true });
  } catch {
    // A file that cannot be removed leaves a claim the next reader will check
    // against the process table and find false, which is the answer anyway.
  }
}

export interface Started {
  ok: boolean;
  message: string;
  record?: DaemonRecord;
}

/**
 * Start a server that does not belong to this shell.
 *
 * The child is the same program with the same arguments minus `--daemon`, so
 * there is exactly one implementation of serving and no second path that could
 * drift from it. It is detached and its output goes to the log rather than to a
 * terminal that will be gone in a moment — a daemon whose output goes nowhere
 * cannot say why it died.
 *
 * Readiness is the child's own report, not a timer: it writes the pid file when
 * the socket is listening, so this waits for that file rather than for a
 * number of milliseconds that would be wrong on both a slow and a fast machine.
 * A child that exits instead is a failure, and its complaint is in the log.
 */
export async function start(dbPath: string, argv: string[], timeoutMs = 15_000): Promise<Started> {
  const existing = running(dbPath);
  if (existing !== null) {
    return { ok: false, message: `already running: pid ${existing.pid} on port ${existing.port}` };
  }

  // A pid file naming a process that is gone describes a server that is not
  // there; it is cleared so that this start's readiness check cannot pass on it.
  release(dbPath);

  // Where this attempt's output starts. Everything before it belongs to an
  // earlier run, and a failure reported with a previous run's complaint in it
  // would send whoever reads it after the wrong problem.
  const mark = logSize(dbPath);

  const log = openSync(logPath(dbPath), 'a');
  const child = spawn(
    process.execPath,
    // The entry point as *this* build spells it — `.ts` beside the sources, `.js`
    // in the compiled build the npm package ships (see `cli/entry.ts`).
    [entryPoint('../cli'), 'serve', ...argv],
    {
      detached: true,
      // Nothing on stdin: a daemon that could read a terminal would be waiting
      // on a prompt nobody is there to answer.
      stdio: ['ignore', log, log],
      windowsHide: true,
      env: process.env,
    },
  );
  closeSync(log);

  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code ?? -1;
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) break;
    const record = running(dbPath);
    if (record !== null) return { ok: true, message: 'started', record };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // What it said on the way out, quoted into the message. A start that failed
  // with "see the log file" makes the operator open the log to learn a sentence
  // the daemon already knows, and the sentence is usually the whole answer —
  // "no credentials", "address already in use".
  const complaint = lastLine(dbPath, mark);

  return {
    ok: false,
    message:
      exited === null
        ? `did not start within ${Math.round(timeoutMs / 1000)}s${complaint} — see ${logPath(dbPath)}`
        : `exited with ${exited}${complaint} — see ${logPath(dbPath)}`,
  };
}

/** The last thing this attempt wrote to the log, or nothing if it wrote nothing. */
function lastLine(dbPath: string, from: number): string {
  try {
    const written = readFileSync(logPath(dbPath), 'utf8').slice(from);
    const lines = written.split(/\r?\n/).filter((line) => line.trim() !== '');
    const last = lines.at(-1);
    return last === undefined ? '' : `: ${last.trim()}`;
  } catch {
    return '';
  }
}

export interface Stopped {
  ok: boolean;
  message: string;
}

/**
 * Stop it.
 *
 * The process is killed rather than asked to stop, and on Windows there is no
 * choice: a signal has no handler to reach, so `SIGTERM` terminates the process
 * on the spot. That is safe here, and not by luck — the meta layer is SQLite in
 * WAL mode, which is built to survive a process that stops mid-write, and the
 * server holds no state that is not already on disk.
 */
export async function stop(dbPath: string, timeoutMs = 10_000): Promise<Stopped> {
  const record = running(dbPath);
  if (record === null) {
    release(dbPath);
    return { ok: false, message: 'not running' };
  }

  try {
    process.kill(record.pid);
  } catch (err) {
    return { ok: false, message: `could not stop pid ${record.pid}: ${(err as Error).message}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive(record.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (alive(record.pid)) {
    return { ok: false, message: `pid ${record.pid} is still there after ${timeoutMs / 1000}s` };
  }

  release(dbPath);
  return { ok: true, message: `stopped pid ${record.pid}` };
}

/** How big the log has grown, for `status` to say where the server has been talking. */
export function logSize(dbPath: string): number {
  try {
    return statSync(logPath(dbPath)).size;
  } catch {
    return 0;
  }
}

export { logPath, pidPath };
