import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/api/config.ts';
import { resolveCommand } from '../src/cli/args.ts';
import { tempRoot } from './helpers/tmp.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/**
 * A fixture file the collection has had for a while.
 *
 * `writeFileSync` leaves an mtime of right now, and right now is exactly the
 * file the half-write gate waits the window out for — five seconds per root, on
 * a suite that spawns the real CLI a dozen times. These tests are about what the
 * CLI does, not about a copy arriving while it does it, and a fixture back-dated
 * past the window says the thing they mean: this collection was already here.
 * The gate's own behaviour is `scan-settle.test.ts`, `scan.test.ts` and the live
 * runbook.
 */
function writeSettled(absPath: string, content: string): void {
  writeFileSync(absPath, content);
  const past = new Date(Date.now() - 60_000);
  utimesSync(absPath, past, past);
}

/**
 * The address a started server says it took, as soon as it says it.
 *
 * Read off the report rather than assumed from the flags: that report is how the
 * operator learns where to point a client, so a test that guessed the port would
 * pass over the only place the two could disagree.
 */
function announced(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const failed = setTimeout(() => reject(new Error(`serve said nothing: ${seen}`)), 10_000);
    const stop = (): void => clearTimeout(failed);

    child.stdout?.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      const url = /on (http:\/\/\S+)/.exec(seen)?.[1];
      if (url !== undefined) {
        stop();
        resolve(url);
      }
    });
    child.on('exit', (code) => {
      stop();
      reject(new Error(`serve exited with ${code}: ${seen}`));
    });
  });
}

/**
 * Stop the server and wait until it has actually gone.
 *
 * Waiting is not tidiness. On Windows a process that has been killed still holds
 * its files open for a moment, and removing the directory a server was reading
 * its database from fails until it lets go. The retries cover the rest of the
 * wait, which no event announces.
 */
function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

const GONE = { force: true, maxRetries: 10, retryDelay: 100 } as const;

/** As much of an answer as a smoke test reads. */
interface Envelope {
  'subsonic-response': {
    status: string;
    scanStatus?: { scanning: boolean; count: number };
  };
}

test('scan takes its roots and leaves the database path to the config', () => {
  const inv = resolveCommand(['scan', '/music', '/backup']);
  assert.equal(inv.kind, 'scan');
  assert.deepEqual(inv.kind === 'scan' ? inv.roots : null, ['/music', '/backup']);
  // Unsaid rather than defaulted, and the same reasoning `serve` has always had:
  // a default filled in here reaches `loadConfig` as an override that beats
  // `FUNOTEKA_DB` *and* the config file, so a deployment that names its database
  // in either would have `scan` write a second one beside it (task:2934).
  assert.equal(inv.kind === 'scan' ? inv.dbPath : 'set', undefined);
});

test('--db overrides the database path', () => {
  const inv = resolveCommand(['scan', '/music', '--db', 'meta.db']);
  assert.equal(inv.kind === 'scan' ? inv.dbPath : null, 'meta.db');
});

test('--help wins over everything', () => {
  assert.equal(resolveCommand(['--help']).kind, 'help');
  assert.equal(resolveCommand(['-h']).kind, 'help');
  assert.equal(resolveCommand(['scan', '/music', '--help']).kind, 'help');
});

test('no command is a usage error', () => {
  const inv = resolveCommand([]);
  assert.equal(inv.kind, 'error');
  assert.equal(inv.kind === 'error' ? inv.code : 0, 2);
});

test('an unknown command is a usage error', () => {
  const inv = resolveCommand(['frobnicate']);
  assert.equal(inv.kind, 'error');
  assert.equal(inv.kind === 'error' ? inv.code : 0, 2);
  assert.match(inv.kind === 'error' ? inv.message : '', /frobnicate/);
});

test('scan without roots is a usage error', () => {
  const inv = resolveCommand(['scan']);
  assert.equal(inv.kind, 'error');
  assert.equal(inv.kind === 'error' ? inv.code : 0, 2);
});

test('an unknown option is a usage error rather than a crash', () => {
  const inv = resolveCommand(['scan', '/music', '--wat']);
  assert.equal(inv.kind, 'error');
  assert.equal(inv.kind === 'error' ? inv.code : 0, 2);
});

test('a token that is still a ${...} placeholder is refused, and named as one', () => {
  // **The shape a copy of an `.mcp.json` leaves behind.** An entry that says
  // `${FUNOTEKA_ADMIN_TOKEN}` is expanded by the harness when the variable is
  // set and passed through *as text* when it is not, so the CLI can find itself
  // holding the reference itself. Sending it is a wrong-token attempt, and ten
  // of those lock the address out for fifteen minutes — so it is refused, and
  // the sentence says which of the two ways to have no token this is, because
  // "set FUNOTEKA_ADMIN_TOKEN" is unhelpful advice to somebody who just did.
  const env = { ...process.env, FUNOTEKA_ADMIN_TOKEN: '${FUNOTEKA_ADMIN_TOKEN}' };
  let failed: { status?: number; stderr?: string } | undefined;
  try {
    execFileSync(process.execPath, [CLI, 'mcp'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
  } catch (err) {
    failed = err as { status?: number; stderr?: string };
  }

  assert.equal(failed?.status, 2, 'refused rather than started');
  assert.match(
    failed?.stderr ?? '',
    /still a \$\{\.\.\.\} placeholder/,
    'and the reason names the placeholder rather than a setting nobody made',
  );
});

test('the CLI scans a directory end to end', () => {
  const root = tempRoot('funoteka-cli-root-');
  const work = tempRoot('funoteka-cli-db-');
  mkdirSync(join(root, 'album'), { recursive: true });
  writeSettled(join(root, 'album', 'track.flac'), 'audio');
  writeSettled(
    join(root, 'album', 'green.cue'),
    `PERFORMER "The Cure"
TITLE "Green"
FILE "track.flac" WAVE
TRACK 01 AUDIO
TITLE "A Song"
INDEX 01 00:00:00
`,
  );

  const out = execFileSync(process.execPath, [CLI, 'scan', root, '--db', join(work, 'meta.db')], {
    encoding: 'utf8',
  });

  assert.match(out, /files\s+2/);
  assert.match(out, /audio 1/);
  assert.match(out, /cue 1/);
  // The whole chain, reported: the cue names the performer, the artist stage
  // folds it and points the album at it.
  assert.match(out, /artists 1\s+\(albums linked 1\)/);

  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

test('--full reads a library again that the ledger says has not moved', () => {
  // **The option exists for when the ledger is the wrong question.** The
  // ordinary scan trusts size and mtime — that is what makes a rescan of an
  // unchanged library cost seconds rather than minutes — and this is the answer
  // for a reader that changed its mind about a format, or for an operator who
  // wants to be sure. It is done by emptying the ledger before the walk, so it
  // reaches every stage downstream without any of them knowing the option
  // exists, which is exactly what this test is here to pin: the second run says
  // nothing about unchanged files and the third says nothing about them either.
  const root = tempRoot('funoteka-cli-full-');
  const work = tempRoot('funoteka-cli-db-');
  mkdirSync(join(root, 'album'), { recursive: true });
  writeSettled(join(root, 'album', 'track.flac'), 'audio');

  const db = join(work, 'meta.db');
  const run = (args: string[]) =>
    execFileSync(process.execPath, [CLI, 'scan', root, '--db', db, ...args], { encoding: 'utf8' });

  const first = run([]);
  assert.doesNotMatch(first, /unchanged/, 'nothing had been seen before, so nothing was unchanged');

  const again = run([]);
  assert.match(again, /unchanged 1/, 'the second run reads the ledger and skips the file');

  const full = run(['--full']);
  assert.doesNotMatch(full, /unchanged/, 'and a full run reads it whether or not it moved');
  assert.match(full, /files\s+1/, 'the file is still there exactly once');

  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

test('the CLI reports a name that two artist folders both claimed', () => {
  // The counter is the only thing that tells a scan of a clean collection apart
  // from a scan that quietly split a band in two, so it is worth a line of its
  // own rather than being folded into the ambiguity count beside it.
  const root = tempRoot('funoteka-cli-homonym-');
  const work = tempRoot('funoteka-cli-db-');

  const folders: [string, string][] = [
    ['Music/Nirvana', 'Nevermind'],
    ['Other/Nirvana', 'Bleach'],
  ];
  for (const [where, album] of folders) {
    mkdirSync(join(root, where, album), { recursive: true });
    writeSettled(join(root, where, album, 'track.flac'), 'audio');
    writeSettled(
      join(root, where, album, 'green.cue'),
      `PERFORMER "Nirvana"
TITLE "An Album"
FILE "track.flac" WAVE
TRACK 01 AUDIO
TITLE "A Song"
INDEX 01 00:00:00
`,
    );
  }

  const out = execFileSync(process.execPath, [CLI, 'scan', root, '--db', join(work, 'meta.db')], {
    encoding: 'utf8',
  });

  assert.match(out, /artists 2/, 'two rows, one per folder');
  assert.match(out, /1 split by folder/, 'and the split is on the report, not just in the table');

  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

test('a usage error exits with code 2', () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI], { encoding: 'utf8' }),
    (err: NodeJS.ErrnoException & { status?: number }) => err.status === 2,
  );
});

test('inventory takes a database and no roots', () => {
  const inv = resolveCommand(['inventory']);
  assert.equal(inv.kind, 'inventory');
  assert.equal(inv.kind === 'inventory' ? inv.dbPath : 'set', undefined, 'and the config decides, not the parser');

  const withDb = resolveCommand(['inventory', '--db', 'meta.db']);
  assert.equal(withDb.kind === 'inventory' ? withDb.dbPath : null, 'meta.db');
});

test('inventory with a root is a usage error', () => {
  const inv = resolveCommand(['inventory', '/music']);
  assert.equal(inv.kind, 'error');
  assert.equal(inv.kind === 'error' ? inv.code : 0, 2);
});

test('junk lists by default, and the two edits take one path', () => {
  const bare = resolveCommand(['junk']);
  assert.equal(bare.kind === 'junk' ? bare.action : null, 'list', 'listing is what it does');
  assert.equal(bare.kind === 'junk' ? bare.dbPath : 'set', undefined, 'and the config decides, not the parser');

  const blocked = resolveCommand(['junk', 'block', 'C:/music/Telegram Desktop', '--note', 'files']);
  assert.equal(blocked.kind === 'junk' ? blocked.action : null, 'block');
  assert.equal(blocked.kind === 'junk' ? blocked.path : null, 'C:/music/Telegram Desktop');
  assert.equal(blocked.kind === 'junk' ? blocked.note : null, 'files');

  const allowed = resolveCommand(['junk', 'allow', '/music/rips']);
  assert.equal(allowed.kind === 'junk' ? allowed.action : null, 'allow');

  // A verb it does not have, an edit with no path, and a path with no verb are
  // all usage errors rather than a silent listing: the operator asked for
  // something and being told nothing is the one answer that cannot be acted on.
  assert.equal(resolveCommand(['junk', 'hide', '/music']).kind, 'error');
  assert.equal(resolveCommand(['junk', 'block']).kind, 'error');
  assert.equal(resolveCommand(['junk', 'block', '/a', '/b']).kind, 'error');
  assert.equal(resolveCommand(['junk', 'list', '/music']).kind, 'error');
});

test('the CLI scans a directory and dumps what it classified', () => {
  const root = tempRoot('funoteka-cli-inv-root-');
  const work = tempRoot('funoteka-cli-inv-db-');
  const dbPath = join(work, 'meta.db');
  mkdirSync(join(root, 'album'), { recursive: true });
  writeSettled(join(root, 'album', 'track.flac'), 'audio');
  writeSettled(
    join(root, 'album', 'green.cue'),
    `PERFORMER "The Cure"
TITLE "Green"
FILE "track.flac" WAVE
TRACK 01 AUDIO
TITLE "A Song"
INDEX 01 00:00:00
`,
  );

  execFileSync(process.execPath, [CLI, 'scan', root, '--db', dbPath], { encoding: 'utf8' });
  const out = execFileSync(process.execPath, [CLI, 'inventory', '--db', dbPath], {
    encoding: 'utf8',
  });

  assert.match(out, /funoteka inventory/);
  assert.match(out, /The Cure/);
  assert.match(out, /01\..*A Song/);

  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

test('serve takes a database and the address to listen on', () => {
  const bare = resolveCommand(['serve']);
  assert.equal(bare.kind, 'serve');
  // Nothing told, nothing decided: the database is as much the environment's to
  // name as the address is, and a flag that defaulted here would be an override
  // handed to `loadConfig` — which is how `FUNOTEKA_DB` came to be a variable
  // the server read and ignored, and a unit file could not point the server at
  // the meta layer at all (task:2766).
  assert.equal(bare.kind === 'serve' ? bare.dbPath : 'set', undefined, 'the environment decides');
  assert.equal(bare.kind === 'serve' ? bare.host : 'set', undefined, 'the environment decides');

  const told = resolveCommand(['serve', '--db', 'meta.db', '--host', '127.0.0.1', '--port', '8080']);
  assert.equal(told.kind === 'serve' ? told.dbPath : null, 'meta.db');
  assert.equal(told.kind === 'serve' ? told.host : null, '127.0.0.1');
  assert.equal(told.kind === 'serve' ? told.port : null, '8080');
});

test('the database the environment names is the one a started server serves', () => {
  // The end of the same thread: what `resolveCommand` leaves unsaid has to
  // survive all the way to a config the server is built from. Naming the file in
  // the unit is the only way a deployed server can be pointed at a meta layer
  // that is not the one in its working directory.
  const invocation = resolveCommand(['serve']);
  assert.equal(invocation.kind, 'serve');

  const config = loadConfig(
    { FUNOTEKA_DB: '/var/lib/funoteka/meta.db', FUNOTEKA_USER: 'demo', FUNOTEKA_PASSWORD: 'x' },
    invocation.kind === 'serve'
      ? { dbPath: invocation.dbPath, host: invocation.host, port: invocation.port }
      : {},
  );
  assert.equal(config.dbPath, '/var/lib/funoteka/meta.db');
});

test('serve with a root is a usage error', () => {
  const inv = resolveCommand(['serve', '/music']);
  assert.equal(inv.kind, 'error');
  assert.equal(inv.kind === 'error' ? inv.code : 0, 2);
});

test('a command that does not listen refuses the flags that would make it', () => {
  // scan and inventory read the meta layer and never open a socket. A port
  // accepted there would be a setting they cannot honour, and one that is
  // accepted looks honoured — which is how an operator ends up believing they
  // moved a server that never started.
  const scan = resolveCommand(['scan', '/music', '--port', '8080']);
  assert.equal(scan.kind, 'error');
  assert.equal(scan.kind === 'error' ? scan.code : 0, 2);
  assert.match(scan.kind === 'error' ? scan.message : '', /--port/);

  const inventory = resolveCommand(['inventory', '--host', '0.0.0.0']);
  assert.equal(inventory.kind, 'error');
  assert.match(inventory.kind === 'error' ? inventory.message : '', /--host/);
});

test('a port that is not a number is a usage error, not a server on the default port', () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI, 'serve', '--port', 'http'], { encoding: 'utf8' }),
    (err: NodeJS.ErrnoException & { status?: number }) => err.status === 2,
  );
});

test('a server given no credentials refuses to start, and says so', () => {
  // The failure this catches is the quiet one: a library that came up on the
  // network answering anyone. It has to fail loudly at startup instead, where
  // the operator is still watching.
  const work = tempRoot('funoteka-cli-nocreds-');
  const clean = { ...process.env };
  delete clean.FUNOTEKA_USER;
  delete clean.FUNOTEKA_PASSWORD;
  delete clean.FUNOTEKA_APIKEY;

  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [CLI, 'serve', '--db', join(work, 'meta.db')], {
          encoding: 'utf8',
          env: clean,
        }),
      (err: NodeJS.ErrnoException & { status?: number; stderr?: string }) =>
        err.status === 1 && /credentials/.test(err.stderr ?? ''),
    );
  } finally {
    rmSync(work, { recursive: true, ...GONE });
  }
});

test('the CLI serves the API from the meta layer it was pointed at', async () => {
  // The wiring itself, end to end: a scan writes a database, the server is
  // started against it, and a client's first call comes back answered from that
  // same database. Every unit test would still pass if `serve` fell over on its
  // first line, and this is the test that would not.
  const root = tempRoot('funoteka-cli-serve-root-');
  const work = tempRoot('funoteka-cli-serve-db-');
  const dbPath = join(work, 'meta.db');
  mkdirSync(join(root, 'album'), { recursive: true });
  writeSettled(join(root, 'album', 'track.flac'), 'audio');

  execFileSync(process.execPath, [CLI, 'scan', root, '--db', dbPath], { encoding: 'utf8' });

  const child = spawn(
    process.execPath,
    [CLI, 'serve', '--db', dbPath, '--host', '127.0.0.1', '--port', '0'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FUNOTEKA_USER: 'demo', FUNOTEKA_PASSWORD: 'sesame' },
    },
  );

  try {
    const url = await announced(child);
    const as = 'u=demo&p=sesame';

    const ping = (await (await fetch(`${url}/ping?f=json&${as}`)).json()) as Envelope;
    assert.equal(ping['subsonic-response'].status, 'ok');

    const status = (await (await fetch(`${url}/getScanStatus?f=json&${as}`)).json()) as Envelope;
    assert.deepEqual(status['subsonic-response'].scanStatus, { scanning: false, count: 1 });

    const stranger = (await (await fetch(`${url}/ping?f=json`)).json()) as Envelope;
    assert.equal(stranger['subsonic-response'].status, 'failed');
  } finally {
    await stopped(child);
    rmSync(root, { recursive: true, ...GONE });
    rmSync(work, { recursive: true, ...GONE });
  }
});

test('keys lists by default, and the two verbs take one name', () => {
  const bare = resolveCommand(['keys']);
  assert.equal(bare.kind === 'keys' ? bare.action : null, 'list', 'listing is what it does');
  assert.equal(bare.kind === 'keys' ? bare.dbPath : 'set', undefined, 'and the config decides, not the parser');

  const added = resolveCommand(['keys', 'add', 'the tablet']);
  assert.equal(added.kind === 'keys' ? added.action : null, 'add');
  assert.equal(added.kind === 'keys' ? added.what : null, 'the tablet');

  const revoked = resolveCommand(['keys', 'revoke', '#3']);
  assert.equal(revoked.kind === 'keys' ? revoked.what : null, '#3');

  // A verb it does not have, a verb with no name, and a listing given one are
  // usage errors rather than a silent listing — the same rule `junk` keeps, and
  // for the same reason: an add that quietly listed would tell the operator a
  // key had been made.
  assert.equal(resolveCommand(['keys', 'show']).kind, 'error');
  assert.equal(resolveCommand(['keys', 'add']).kind, 'error');
  assert.equal(resolveCommand(['keys', 'revoke', '']).kind, 'error');
  assert.equal(resolveCommand(['keys', 'add', 'a', 'b']).kind, 'error');
  assert.equal(resolveCommand(['keys', 'list', '#3']).kind, 'error');
});
