import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The daemon, tested by running it.
 *
 * Nothing here is mocked, because everything it does is a fact about this
 * machine: a process that outlives the shell that started it, a file holding its
 * pid, a socket that answers. A test that stubbed any of those would be testing
 * the stub.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const ENV = {
  ...process.env,
  FUNOTEKA_USER: 'demo',
  FUNOTEKA_PASSWORD: 'sesame',
};

interface Pid {
  pid: number;
  port: number;
  host: string;
  dbPath: string;
  startedAt: string;
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

/** One CLI invocation, with its exit code rather than an exception. */
function cli(args: string[], env: NodeJS.ProcessEnv = ENV): Ran {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const failed = err as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

/** Wait for something to become true, or give up saying what never happened. */
async function until(what: string, check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * What the pid file says, waiting for it to be readable rather than only present.
 *
 * A file that exists and is still being written parses as nothing, and reading it
 * the moment it appears is a race — which is what made this suite fail now and
 * then on a loaded machine, in the shape of a JSON error in a test about
 * daemons.
 */
async function readPid(pidPath: string): Promise<Pid> {
  await until('the pid file to be readable', () => {
    try {
      return typeof (JSON.parse(readFileSync(pidPath, 'utf8')) as Pid).pid === 'number';
    } catch {
      return false;
    }
  });
  return JSON.parse(readFileSync(pidPath, 'utf8')) as Pid;
}

/**
 * Remove a workspace, waiting for the daemon's handles to go with it.
 *
 * On Windows a file another process holds open cannot be removed, and a process
 * that has been killed does not release its handles the instant it dies — so
 * cleaning up the moment `stop` returned deleted nothing and failed the test on
 * its own housekeeping rather than on anything it was testing. The wait is
 * bounded: a directory that is still there after a few seconds is left to the
 * operating system, because a stray temp directory is not a finding about the
 * daemon and failing over one would teach whoever reads the suite to ignore it.
 */
async function removeWorkspace(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function workspace(): { dir: string; dbPath: string; pidPath: string } {
  const dir = tempRoot('funoteka-daemon-');
  const dbPath = join(dir, 'meta.db');
  return { dir, dbPath, pidPath: `${dbPath}.pid` };
}

/** A daemon started for one test, and taken down however the test ends. */
async function withDaemon(
  work: (context: { dir: string; dbPath: string; pidPath: string; record: Pid }) => Promise<void>,
): Promise<void> {
  const { dir, dbPath, pidPath } = workspace();
  try {
    const started = cli(['serve', '--daemon', '--db', dbPath, '--host', '127.0.0.1', '--port', '0']);
    assert.equal(started.status, 0, started.stderr);
    const record = await readPid(pidPath);
    await work({ dir, dbPath, pidPath, record });

    cli(['stop', '--db', dbPath]);
    await until('the daemon to be gone', () => !existsSync(pidPath));
  } finally {
    await removeWorkspace(dir);
  }
}

test('a daemon outlives the command that started it, and answers on a socket', async () => {
  await withDaemon(async ({ record }) => {
    assert.ok(record.pid > 0, 'a pid was recorded');
    assert.ok(record.port > 0, 'the port the socket actually took, not the one that was asked for');

    // The whole point: the shell that started it is gone by now, and this is a
    // different process talking to a server that is still there.
    const query = new URLSearchParams({ u: 'demo', p: 'sesame', f: 'json' });
    const response = await fetch(`http://127.0.0.1:${record.port}/rest/ping?${query}`);
    const body = (await response.json()) as Record<string, { status: string } | undefined>;
    assert.equal(body['subsonic-response']?.status, 'ok');
  });
});

test('status says whether it is running, and answers in its exit code', async () => {
  await withDaemon(async ({ dbPath, record }) => {
    const running = cli(['status', '--db', dbPath]);
    assert.equal(running.status, 0);
    assert.match(running.stdout, new RegExp(String(record.pid)));
    assert.match(running.stdout, new RegExp(String(record.port)));

    // Stopped is not an error, it is an answer — and a script asking has to be
    // able to tell the two apart without reading English.
    cli(['stop', '--db', dbPath]);
    await until('the daemon to be gone', () => !existsSync(`${dbPath}.pid`));

    const stopped = cli(['status', '--db', dbPath]);
    assert.equal(stopped.status, 1);
    assert.match(stopped.stdout, /not running/);
  });
});

test('a second daemon for the same meta layer is refused, and does not start', async () => {
  // Two servers reading one database is not a race the meta layer is built for,
  // and the second would fail on the port anyway — but it would fail after
  // spawning, and the pid file would name whichever wrote it last.
  await withDaemon(async ({ dbPath, record }) => {
    const again = cli(['serve', '--daemon', '--db', dbPath, '--host', '127.0.0.1', '--port', '0']);

    assert.equal(again.status, 2);
    assert.match(again.stderr, /already running/);

    const still = await readPid(`${dbPath}.pid`);
    assert.equal(still.pid, record.pid, 'the running daemon is the one still named');
  });
});

test('stop takes the server down, and the pid file with it', async () => {
  await withDaemon(async ({ dbPath, pidPath, record }) => {
    const stopped = cli(['stop', '--db', dbPath]);
    assert.equal(stopped.status, 0);
    assert.match(stopped.stdout, new RegExp(String(record.pid)));

    await until('the pid file to go', () => !existsSync(pidPath), 10_000);
    assert.throws(() => process.kill(record.pid, 0), 'the process is gone');
  });
});

test('a daemon that cannot start leaves nothing behind but the reason', async () => {
  // A pid file naming a process that never came up is worse than no file: the
  // next start would refuse to run, and `status` would report a server that is
  // not there. The child's own complaint is what the caller gets.
  const { dir, dbPath, pidPath } = workspace();
  try {
    const refused = cli(['serve', '--daemon', '--db', dbPath, '--port', '0'], {
      ...process.env,
      FUNOTEKA_USER: '',
      FUNOTEKA_PASSWORD: '',
    });

    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /credential/i);
    assert.equal(existsSync(pidPath), false, 'no pid file for a server that is not running');
  } finally {
    await removeWorkspace(dir);
  }
});

test('a server with an admin surface comes up on both ports, and claims once', async () => {
  // **Two listeners, and the claim waits for the second.** It used to be written
  // by whichever one reported first, which for a server with an admin token was
  // never: the "both are up" callback was attached to the API listener alone, so
  // the counter never reached zero and neither the claim nor the banner was ever
  // written. Every test passed — the API answered, the admin port answered, the
  // listeners were each tested on their own — and a deployed server quietly had
  // no pid file, which is what `stop` and `status` find it by.
  //
  // So this one asks the whole thing: run it the way a deployment does, and
  // require the claim before believing either port.
  const dir = tempRoot('funoteka-daemon-admin-');
  const dbPath = join(dir, 'meta.db');
  try {
    const started = cli(['serve', '--daemon', '--db', dbPath, '--host', '127.0.0.1', '--port', '0'], {
      ...ENV,
      FUNOTEKA_ADMIN_TOKEN: 'test-token',
      FUNOTEKA_ADMIN_PORT: '0',
    });
    assert.equal(started.status, 0, started.stderr);

    const record = (await readPid(`${dbPath}.pid`)) as Pid & { adminPort?: number };
    assert.ok(record.adminPort !== undefined && record.adminPort > 0, 'the admin port is in the claim');

    const health = await fetch(`http://127.0.0.1:${record.port}/health`);
    assert.equal(health.status, 200);

    const refused = await fetch(`http://127.0.0.1:${record.adminPort}/restart`, { method: 'POST' });
    assert.equal(refused.status, 401, 'and the admin port is the guarded one');

    cli(['stop', '--db', dbPath]);
    await until('the daemon to be gone', () => !existsSync(`${dbPath}.pid`));
  } finally {
    await removeWorkspace(dir);
  }
});

test('a pid file left by a machine that rebooted is not a running server', async () => {
  // The pid of a process that is gone can be handed to another one, so the file
  // is only ever a claim — and the claim is checked by asking whether that
  // process is still there. A stale file must not stop the server from starting,
  // which is the failure that would leave a deployment down after a crash.
  const { dir, dbPath, pidPath } = workspace();
  try {
    writeFileSync(
      pidPath,
      JSON.stringify({ pid: 999_999_999, port: 4533, host: '0.0.0.0', dbPath, startedAt: 'x' }),
    );

    const status = cli(['status', '--db', dbPath]);
    assert.equal(status.status, 1);
    assert.match(status.stdout, /not running/);

    const started = cli(['serve', '--daemon', '--db', dbPath, '--host', '127.0.0.1', '--port', '0']);
    assert.equal(started.status, 0, started.stderr);

    await until('the daemon to write its own pid', () => {
      if (!existsSync(pidPath)) return false;
      return (JSON.parse(readFileSync(pidPath, 'utf8')) as Pid).pid !== 999_999_999;
    });

    cli(['stop', '--db', dbPath]);
    await until('the daemon to be gone', () => !existsSync(pidPath));
  } finally {
    await removeWorkspace(dir);
  }
});
