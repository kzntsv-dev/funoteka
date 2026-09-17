import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

import { createAdminServer, type AdminDeps } from '../src/api/admin.ts';
import { adminClient } from '../src/mcp/client.ts';
import type { Scanner } from '../src/api/scanner.ts';
import { MAX_FAILURES } from '../src/api/admin-guard.ts';
import type { AdminConfig } from '../src/api/config.ts';
import { openDb, SCHEMA_VERSION } from '../src/db/index.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The admin surface, tested through its socket.
 *
 * Everything here is a fact about what a stranger on the port can and cannot do,
 * and almost none of it can be read off the code: whether the listener exists at
 * all without a token, what a wrong token gets, whether an address list refuses
 * before the token is even compared, and what a restart actually does to the
 * process. Those are the properties the whole surface rests on.
 *
 * The pieces that *are* pure — the address comparison, the lockout counter — are
 * tested in `admin-guard.test.ts`, where they can be asked about a
 * fifteen-minute lockout without waiting fifteen minutes.
 */

const CONFIG: AdminConfig = {
  port: 0,
  host: '127.0.0.1',
  token: 's3cret',
  allow: '',
  trustProxy: false,
  tls: null,
  supervised: false,
};

const BEARER = { authorization: 'Bearer s3cret' };

interface Answer {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

interface Admin {
  call: (path: string, init?: RequestInit) => Promise<Answer>;
  /** The port it listens on, for the client that has to reach it over HTTP. */
  port: number;
  /** A route that answers with something other than JSON — the inventory dump. */
  raw: (path: string, init?: RequestInit) => Promise<{ status: number; headers: Headers; text: string }>;
  restarts: () => number;
  /** The meta layer itself, for the tests that change rows mid-flight. */
  db: () => ReturnType<typeof openDb>;
  /** The audit lines written so far, as they were passed to the writer. */
  audited: () => Record<string, unknown>[];
  /** The config file as it is on disk, or null when there is none. */
  file: () => string | null;
}

/** A config file for one test, in a directory of its own. */
function configFile(text: string | null): string {
  const path = join(tempRoot('funoteka-admin-'), 'funoteka.json');
  if (text !== null) writeFileSync(path, text);
  return path;
}

/** The listener on a port the kernel picks, with everything it needs faked down to a value. */
async function withAdmin(
  options: {
    config?: Partial<AdminConfig>;
    env?: NodeJS.ProcessEnv;
    file?: string;
    scanner?: Scanner;
    /** The file this server narrates to, for the `logs` route. */
    logFile?: string;
    /** Rows to put in the meta layer before the server starts. */
    seed?: (db: ReturnType<typeof openDb>) => void;
  },
  work: (admin: Admin) => Promise<void>,
): Promise<void> {
  let restarts = 0;
  const lines: Record<string, unknown>[] = [];
  const db = openDb(':memory:');
  const path = options.file ?? configFile(null);
  options.seed?.(db);

  const deps: AdminDeps = {
    db,
    config: { ...CONFIG, ...options.config },
    dbPath: 'test.db',
    configFile: path,
    env: options.env ?? {},
    logFile: options.logFile ?? '',
    audit: (entry) => {
      lines.push(entry as unknown as Record<string, unknown>);
      return true;
    },
    // A scanner that starts nothing: the routes around it are what these tests
    // are about, and a suite that spawned real scans would be testing the
    // filesystem it happens to run on. `scanner.ts` spawns a real one, and the
    // live run is where that is verified.
    scanner: options.scanner ?? {
      start: () => ({ ok: true, pid: 4242 }),
      status: () => ({ running: null, last: null }),
      cancel: () => ({ ok: true, settled: null }),
      history: () => [],
    },
    onRestart: () => {
      restarts += 1;
    },
  };

  const server = createAdminServer(deps);
  assert.notEqual(server, null, 'this helper is for the cases where there is a listener');
  if (server === null) return;

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const raw = async (
      callPath: string,
      init: RequestInit = {},
    ): Promise<{ status: number; headers: Headers; text: string }> => {
      const response = await fetch(`http://127.0.0.1:${port}${callPath}`, { method: 'POST', ...init });
      return { status: response.status, headers: response.headers, text: await response.text() };
    };

    await work({
      call: async (callPath, init = {}) => {
        const { status, headers, text } = await raw(callPath, init);
        return { status, headers, body: JSON.parse(text) as Record<string, unknown> };
      },
      port,
      raw,
      restarts: () => restarts,
      db: () => db,
      audited: () => lines,
      file: () => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return null;
        }
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

/** Wait for something to become true, or give up saying what never happened. */
async function until(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('no token means no listener, rather than one that refuses everybody', () => {
  // **The rule the port rests on.** A socket that answers 401 is still a socket
  // this server opened, on a port an operator was told is the control surface —
  // and "off" has to mean a connection refused, or the difference between the
  // two states is a header rather than a decision the operator made.
  const deps = {
    db: openDb(':memory:'),
    dbPath: 'test.db',
    configFile: 'test.json',
    env: {},
    logFile: '',
    audit: () => true,
    scanner: {
      start: () => ({ ok: true as const, pid: 1 }),
      status: () => ({ running: null, last: null }),
      cancel: () => ({ ok: true as const, settled: null }),
      history: () => [],
    },
    onRestart: () => {},
  };

  assert.equal(createAdminServer({ ...deps, config: { ...CONFIG, token: '' } }), null);
  assert.notEqual(createAdminServer({ ...deps, config: CONFIG }), null);
  deps.db.close();
});

test('a caller without the token is refused, and one with it is not', async () => {
  await withAdmin({}, async (admin) => {
    assert.equal((await admin.call('/restart')).status, 401);
    assert.equal(
      (await admin.call('/restart', { headers: { authorization: 'Bearer nope' } })).status,
      401,
    );

    // A token is not a query parameter: a query string is what ends up in a log
    // line, on the first hop's proxy, and in whatever reads that proxy's log.
    assert.equal((await admin.call('/restart?token=s3cret')).status, 401);

    const right = await admin.call('/status', { method: 'GET', headers: BEARER });
    assert.equal(right.status, 200, 'the token this listener was given is the token it takes');
  });
});

test('a 401 says how many wrong tokens this address has left', async () => {
  // The limit is only useful if it is visible before it lands. An operator who
  // meets it without warning reads it as a broken server, and the difference
  // between the two is one sentence in the refusal they already got.
  await withAdmin({}, async (admin) => {
    const first = await admin.call('/status', { method: 'GET', headers: { authorization: 'Bearer no' } });

    assert.equal(first.status, 401);
    assert.match(String(first.body.error), new RegExp(`${MAX_FAILURES - 1} more`));
  });
});

test('an address that is not allowed is refused before its token is looked at', async () => {
  // The order is the point. Spending a comparison on a machine that was told not
  // to knock is the smaller half of it; the larger half is that a refusal for the
  // *address* and a refusal for the *token* tell the caller different things, and
  // a wrong token from a refused address must not be told which of the two it
  // got wrong.
  await withAdmin({ config: { allow: '10.0.0.0/8' } }, async (admin) => {
    const wrongToken = await admin.call('/status', { method: 'GET', headers: { authorization: 'Bearer no' } });
    const rightToken = await admin.call('/status', { method: 'GET', headers: BEARER });

    assert.equal(wrongToken.status, 403);
    assert.equal(rightToken.status, 403, 'and the right token does not get in either');
    assert.match(String(rightToken.body.error), /not allowed/);
  });
});

test('an address list holds the address it names, however the socket spells it', async () => {
  // A socket reached over IPv4 on a machine with IPv6 reports it mapped —
  // `::ffff:127.0.0.1` — so a rule written as `127.0.0.1` would refuse the very
  // address it names if the two were compared as strings.
  for (const allow of ['127.0.0.1', '127.0.0.0/8', '::ffff:127.0.0.1']) {
    await withAdmin({ config: { allow } }, async (admin) => {
      const answer = await admin.call('/status', { method: 'GET', headers: BEARER });
      assert.equal(answer.status, 200, `"${allow}" should have allowed this test's own address`);
    });
  }
});

test('a forwarded address is believed only when the deployment says so', async () => {
  // `X-Forwarded-For` is written by the caller. Believing it on a port that can
  // be reached directly means anyone may claim any address and walk through the
  // allowlist — which is why it is off unless a proxy is the only way in.
  const forwarded = { 'x-forwarded-for': '10.1.2.3' };

  await withAdmin({ config: { allow: '10.0.0.0/8', trustProxy: false } }, async (admin) => {
    const answer = await admin.call('/status', { method: 'GET', headers: { ...BEARER, ...forwarded } });
    assert.equal(answer.status, 403, 'the header is the caller talking about itself');
  });

  await withAdmin({ config: { allow: '10.0.0.0/8', trustProxy: true } }, async (admin) => {
    const answer = await admin.call('/status', { method: 'GET', headers: { ...BEARER, ...forwarded } });
    assert.equal(answer.status, 200, 'and here it is the proxy talking about the caller');
  });
});

test('too many wrong tokens lock the address out, right token or not', async () => {
  await withAdmin({ config: { token: 's3cret' } }, async (admin) => {
    const wrong = { authorization: 'Bearer no' };
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      await admin.call('/status', { method: 'GET', headers: wrong });
    }

    const locked = await admin.call('/status', { method: 'GET', headers: BEARER });
    assert.equal(locked.status, 429);
    assert.match(String(locked.body.error), /too many failed tokens/);
    assert.ok(Number(locked.headers.get('retry-after')) > 0, 'and it says for how long');
  });
});

test('a right token clears the count, so a typo is not one attempt from a lockout', async () => {
  await withAdmin({}, async (admin) => {
    const wrong = { authorization: 'Bearer no' };
    for (let attempt = 0; attempt < MAX_FAILURES - 2; attempt += 1) {
      await admin.call('/status', { method: 'GET', headers: wrong });
    }

    await admin.call('/status', { method: 'GET', headers: BEARER });

    const after = await admin.call('/status', { method: 'GET', headers: wrong });
    assert.equal(after.status, 401, 'not locked, and the count started over');
    assert.match(String(after.body.error), new RegExp(`${MAX_FAILURES - 1} more`));
  });
});

test('the same key twice does the work once, and answers the same thing twice', async () => {
  // **What the key is for.** A script whose connection dropped cannot tell "the
  // request never arrived" from "the answer was lost", and for a mutation those
  // are not the same thing. The second call is answered out of the record, and
  // the header says so — a caller that got a *different* body the second time
  // would be right to conclude the work ran twice.
  await withAdmin({ file: configFile('{"port": 8080}\n') }, async (admin) => {
    const once = await admin.call('/config', {
      headers: { ...BEARER, 'content-type': 'application/json', 'idempotency-key': 'k-1' },
      body: JSON.stringify({ port: 9090 }),
    });
    const again = await admin.call('/config', {
      headers: { ...BEARER, 'content-type': 'application/json', 'idempotency-key': 'k-1' },
      body: JSON.stringify({ port: 9090 }),
    });

    assert.equal(once.status, 200);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, once.body, 'the same answer, not a second one');
    assert.equal(again.headers.get('idempotent-replay'), 'true');

    // One mutation in the audit, not two: the second request did nothing, and a
    // record saying it did is the record lying about the work.
    const mutations = admin.audited().filter((line) => line.status === 200);
    assert.equal(mutations.length, 1);
  });
});

test('a key reused for a different request is refused rather than answered', async () => {
  // The worst possible behaviour here would look like success: the caller gets a
  // correct-looking answer about an operation it did not ask for.
  await withAdmin({ config: { supervised: true } }, async (admin) => {
    const first = await admin.call('/config', {
      headers: { ...BEARER, 'content-type': 'application/json', 'idempotency-key': 'shared' },
      body: JSON.stringify({ port: 9090 }),
    });
    assert.equal(first.status, 200, 'the key belongs to a real request first');

    const reused = await admin.call('/restart', {
      headers: { ...BEARER, 'idempotency-key': 'shared' },
    });

    assert.equal(reused.status, 422);
    assert.match(String(reused.body.error), /different request/);
    assert.equal(admin.restarts(), 0, 'and the restart did not happen');
  });
});

test('a restart is refused where nothing would start the process again', async () => {
  // A bare `serve --daemon` has no supervisor: "restart" there can only mean
  // "stop", and a 200 would be a control surface that takes the music down when
  // it is asked to bring it back. The refusal names the setting that would make
  // it true, because that is the whole of what the operator has to do.
  await withAdmin({ config: { supervised: false } }, async (admin) => {
    const answer = await admin.call('/restart', { headers: BEARER });

    assert.equal(answer.status, 409);
    assert.match(String(answer.body.error), /FUNOTEKA_SUPERVISED/);
    assert.equal(admin.restarts(), 0, 'and the process was not touched');
  });
});

test('a supervised restart answers first, and ends the process after', async () => {
  await withAdmin({ config: { supervised: true } }, async (admin) => {
    const answer = await admin.call('/restart', { headers: BEARER });

    assert.equal(answer.status, 200);
    assert.equal(answer.body.restarting, true);
    await until('the process to be told to end', () => admin.restarts() === 1);
  });
});

test('status answers about the server, and never hands back the token', async () => {
  await withAdmin({ config: { tls: null, supervised: true } }, async (admin) => {
    const answer = await admin.call('/status', { method: 'GET', headers: BEARER });

    assert.equal(answer.status, 200);
    assert.equal(answer.body.server, 'funoteka');
    assert.equal(answer.body.schema, SCHEMA_VERSION);
    assert.equal((answer.body.database as Record<string, unknown>).songs, 0);
    // What the operator needs to know about the gate is *that* it is closed, not
    // what it is closed with.
    assert.equal((answer.body.admin as Record<string, unknown>).token, 'set');
    assert.equal((answer.body.admin as Record<string, unknown>).supervised, true);
    assert.equal(typeof answer.body.uptime, 'number');
  });
});

test('what is not an admin route is answered as a missing one', async () => {
  await withAdmin({}, async (admin) => {
    // The route it is not, and the method it is not: a restart is a POST because
    // it does something, and a GET of it must not become a second way to do it.
    assert.equal((await admin.call('/shelves', { headers: BEARER })).status, 404);
    assert.equal((await admin.call('/restart', { method: 'GET', headers: BEARER })).status, 404);
    assert.equal(admin.restarts(), 0);
  });
});

test('config get says what is in force and which layer said so', async () => {
  const file = configFile('{"port": 8080}\n');
  await withAdmin({ file, env: { FUNOTEKA_HOST: '127.0.0.1' } }, async (admin) => {
    const answer = await admin.call('/config', { method: 'GET', headers: BEARER });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.file, file);

    const settings = answer.body.settings as { key: string; value: unknown; source: string; secret: boolean }[];
    const of = (key: string) => settings.find((one) => one.key === key);

    assert.equal(of('port')?.value, 8080);
    assert.equal(of('port')?.source, 'file');
    assert.equal(of('host')?.source, 'environment');
    assert.equal(of('dbPath')?.source, 'default');
    assert.equal(of('adminToken')?.value, null, 'a secret is reported as set, not as itself');
    assert.equal(of('adminToken')?.secret, true);
  });
});

test('config set writes the file, and says what is not in force', async () => {
  // **The reason this route exists is the answer, not the write.** A value the
  // environment overrides is not in force now and will not be in force after a
  // restart either — and an operator who is not told that will spend the next
  // hour on a server that came up exactly as it was.
  const file = configFile('{"port": 8080, "//": "a note from before"}\n');
  await withAdmin({ file, env: { FUNOTEKA_PORT: '4533' } }, async (admin) => {
    const answer = await admin.call('/config', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ port: 9090, logRequests: true }),
    });

    assert.equal(answer.status, 200);
    assert.equal(answer.body.restartRequired, true);
    assert.deepEqual(answer.body.written, ['port', 'logRequests']);

    // The file was written — including a key that was not in it — and the note
    // that was in it is still there.
    const text = admin.file() ?? '';
    assert.match(text, /a note from before/);
    assert.equal(JSON.parse(text).logRequests, true);

    // `port` was written and is not in force, because the environment says
    // otherwise; `logRequests` was written and is.
    const overridden = answer.body.overridden as { key: string; source: string; note: string }[];
    assert.deepEqual(overridden.map((one) => one.key), ['port']);
    assert.equal(overridden[0]?.source, 'environment');
    assert.match(String(overridden[0]?.note), /wins over the file/);

    // And the audit says what was *written*, which is not what is in force: a
    // line reading `{"port": 4533}` after `config set port 9090` would be the
    // record disagreeing with the file, in the one case it is read for.
    const [line] = admin.audited();
    assert.deepEqual(line?.detail, { changed: { port: 9090, logRequests: true }, overridden: ['port'] });
  });
});

test('config set refuses a credential and a key that is not a setting', async () => {
  await withAdmin({}, async (admin) => {
    const credential = await admin.call('/config', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
    });
    assert.equal(credential.status, 409);
    assert.match(String(credential.body.error), /credential/);
    assert.equal(admin.file(), null, 'and nothing was written');

    const unknown = await admin.call('/config', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ prot: 1 }),
    });
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.body.error), /unknown setting "prot"/);
  });
});

test('config set refuses a body that is not settings, and says what it got', async () => {
  await withAdmin({}, async (admin) => {
    const empty = await admin.call('/config', { headers: BEARER });
    assert.equal(empty.status, 400);

    const list = await admin.call('/config', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: '[8080]',
    });
    assert.equal(list.status, 400);
    assert.match(String(list.body.error), /must be a JSON object/);

    const broken = await admin.call('/config', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: '{not json}',
    });
    assert.equal(broken.status, 400);
    assert.match(String(broken.body.error), /not JSON/);
  });
});

test('a setting is handed back to the environment by writing null', async () => {
  const file = configFile('{"port": 8080}\n');
  await withAdmin({ file }, async (admin) => {
    const answer = await admin.call('/config', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ port: null }),
    });

    assert.equal(answer.status, 200);
    const settings = answer.body.settings as { key: string; value: unknown; source: string }[];
    assert.equal(settings.find((one) => one.key === 'port')?.value, 4533);
    assert.equal(settings.find((one) => one.key === 'port')?.source, 'default');
  });
});

test('a mutation is written down, and a read is not', async () => {
  // The audit is about changing things. A record that also carries every look
  // buries the lines somebody will actually be reading it for.
  await withAdmin({}, async (admin) => {
    await admin.call('/status', { method: 'GET', headers: BEARER });
    assert.equal(admin.audited().length, 0, 'looking is not an event');

    await admin.call('/config', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ port: 9090 }),
    });

    const [line] = admin.audited();
    assert.equal(line?.method, 'POST');
    assert.equal(line?.path, '/config');
    assert.equal(line?.status, 200);
    assert.equal(typeof line?.at, 'string');
    assert.deepEqual(line?.detail, { changed: { port: 9090 }, overridden: [] });
  });
});

test('a refused caller is written down too', async () => {
  // A wrong token is either a typo or somebody who is not the operator, and a
  // record that cannot tell the two apart answers nothing.
  await withAdmin({}, async (admin) => {
    await admin.call('/restart', { headers: { authorization: 'Bearer nope' } });

    const [line] = admin.audited();
    assert.equal(line?.status, 401);
    assert.deepEqual(line?.detail, { refused: 'token' });
    assert.equal(line?.address, '127.0.0.1');
  });
});

test('a root is added, listed and taken away, and the answer says what went', async () => {
  const shelf = join(tempRoot('funoteka-admin-roots-'), 'music');
  mkdirSync(shelf, { recursive: true });

  await withAdmin({}, async (admin) => {
    const json = { ...BEARER, 'content-type': 'application/json' };
    const params = (path: string) => ({ headers: json, body: JSON.stringify({ path }) });

    const empty = await admin.call('/roots', { method: 'GET', headers: BEARER });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.roots, []);

    const added = await admin.call('/roots', params(shelf));
    assert.equal(added.status, 201, 'a new root was made');
    assert.equal((added.body.root as { path: string }).path, resolve(shelf));
    assert.equal(added.body.already, false);

    // The same directory is not a second root, and the answer says which of the
    // two happened: a listing that grew by nothing, with no word about why, is
    // an operator wondering whether the call worked.
    const again = await admin.call('/roots', params(shelf));
    assert.equal(again.status, 200);
    assert.equal(again.body.already, true);

    const listed = await admin.call('/roots', { method: 'GET', headers: BEARER });
    assert.equal((listed.body.roots as unknown[]).length, 1);

    const gone = await admin.call('/roots', {
      method: 'DELETE',
      headers: json,
      body: JSON.stringify({ path: shelf }),
    });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.songs, 0, 'and what came from it, which is nothing here');
    assert.equal(gone.body.removed as string, resolve(shelf));

    const missing = await admin.call('/roots', {
      method: 'DELETE',
      headers: json,
      body: JSON.stringify({ path: shelf }),
    });
    assert.equal(missing.status, 404, 'a root that is not there is not there');
  });
});

test('a directory that is not one is refused while the operator is looking', async () => {
  const shelf = join(tempRoot('funoteka-admin-roots-'), 'music');
  mkdirSync(shelf, { recursive: true });

  await withAdmin({}, async (admin) => {
    const json = { ...BEARER, 'content-type': 'application/json' };

    const nowhere = await admin.call('/roots', {
      headers: json,
      body: JSON.stringify({ path: join(shelf, 'no-such-shelf') }),
    });
    assert.equal(nowhere.status, 400);
    assert.match(String(nowhere.body.error), /not a directory/);

    const nameless = await admin.call('/roots', { headers: json, body: JSON.stringify({}) });
    assert.equal(nameless.status, 400);
    assert.match(String(nameless.body.error), /"path" is required/);

    const listed = await admin.call('/roots', { method: 'GET', headers: BEARER });
    assert.deepEqual(listed.body.roots, [], 'and nothing was configured');
  });
});

test('a scan is started, watched and stopped through the surface', async () => {
  const shelf = join(tempRoot('funoteka-admin-roots-'), 'music');
  mkdirSync(shelf, { recursive: true });

  let started: string[] = [];
  let cancelled = 0;
  const fake: Scanner = {
    start: (mode) => {
      started = [...started, mode];
      return { ok: true, pid: 777 };
    },
    status: () => ({
      running: { pid: 777, mode: 'full', startedAt: '2026-09-16T00:00:00.000Z', cancelling: false },
      last: { id: 4, startedAt: 'x', finishedAt: null, status: 'running', roots: [shelf] },
    }),
    cancel: () => {
      cancelled += 1;
      return { ok: true, settled: null };
    },
    history: () => [{ id: 4, startedAt: 'x', finishedAt: null, status: 'running', roots: [shelf] }],
  };

  await withAdmin({ scanner: fake }, async (admin) => {
    const json = { ...BEARER, 'content-type': 'application/json' };
    await admin.call('/roots', { headers: json, body: JSON.stringify({ path: shelf }) });

    const asked = await admin.call('/scan', {
      headers: json,
      body: JSON.stringify({ mode: 'full' }),
    });
    assert.equal(asked.status, 202, 'the work has not happened yet, and the answer says so');
    assert.deepEqual(started, ['full']);
    assert.equal((asked.body.started as { pid: number }).pid, 777);
    assert.deepEqual((asked.body.started as { roots: string[] }).roots, [resolve(shelf)]);

    // No body at all is the ordinary case, and it means incremental.
    await admin.call('/scan', { headers: BEARER });
    assert.deepEqual(started, ['full', 'incremental']);

    const weird = await admin.call('/scan', {
      headers: json,
      body: JSON.stringify({ mode: 'thorough' }),
    });
    assert.equal(weird.status, 400);
    assert.equal((weird.body.modes as unknown[]).length, 2, 'and the two it does have are in the answer');

    const watched = await admin.call('/scan', { method: 'GET', headers: BEARER });
    assert.equal(watched.status, 200);
    assert.equal((watched.body.running as { pid: number }).pid, 777);
    assert.equal((watched.body.last as { id: number }).id, 4);

    const stopped = await admin.call('/scan/cancel', { headers: BEARER });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.stopping, true);
    assert.equal(cancelled, 1);

    const history = await admin.call('/scan/history', { method: 'GET', headers: BEARER });
    assert.equal((history.body.runs as unknown[]).length, 1);

    const silly = await admin.call('/scan/history?limit=none', { method: 'GET', headers: BEARER });
    assert.equal(silly.status, 400, 'a limit that is not one is refused rather than guessed at');
  });
});

test('a scan with nothing to read is refused, and names what to do about it', async () => {
  // The first thing an operator does on a fresh deployment is start a scan, and
  // on a fresh deployment there is no root yet. The refusal is the instruction.
  await withAdmin({}, async (admin) => {
    const answer = await admin.call('/scan', { headers: BEARER });

    assert.equal(answer.status, 409);
    assert.match(String(answer.body.error), /POST \/roots/);
  });
});

test('a scan that cannot start says why, rather than answering as though it had', async () => {
  const shelf = join(tempRoot('funoteka-admin-roots-'), 'music');
  mkdirSync(shelf, { recursive: true });

  const busy: Scanner = {
    start: () => ({ ok: false, reason: 'a scan is already running (pid 9)' }),
    status: () => ({ running: null, last: null }),
    cancel: () => ({ ok: false, reason: 'no scan is running' }),
    history: () => [],
  };

  await withAdmin({ scanner: busy }, async (admin) => {
    const json = { ...BEARER, 'content-type': 'application/json' };
    await admin.call('/roots', { headers: json, body: JSON.stringify({ path: shelf }) });

    const refused = await admin.call('/scan', { headers: BEARER });
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.error), /already running/);

    const nothing = await admin.call('/scan/cancel', { headers: BEARER });
    assert.equal(nothing.status, 409);
    assert.match(String(nothing.body.error), /no scan is running/);
  });
});

/** A meta layer with a small library in it: two roots, albums, files, an issue. */
function seedLibrary(db: ReturnType<typeof openDb>): void {
  db.prepare("INSERT INTO root (id, path, created_at) VALUES (1, '/music', '2026-09-01T00:00:00.000Z')").run();
  db.prepare(
    "INSERT INTO scan_run (id, started_at, finished_at, status, roots_json) VALUES (1, ?, ?, 'ok', ?)",
  ).run('2026-09-01T00:00:00.000Z', '2026-09-01T00:01:00.000Z', JSON.stringify(['/music']));

  for (const [id, title, junk] of [
    [1, 'Dookie', null],
    [2, 'Telegram Desktop', '6 files that are not music, against 0 that are'],
  ] as [number, string, string | null][]) {
    db.prepare(
      'INSERT INTO album (id, root_id, rel_path, title, junk_reason) VALUES (?, 1, ?, ?, ?)',
    ).run(id, `Artist ${id}`, title, junk);
  }

  db.prepare("INSERT INTO folder (root_id, rel_path, parent_rel_path) VALUES (1, 'Artist 2', NULL)").run();
  db.prepare(
    "INSERT INTO file (root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms) " +
      "VALUES (1, 'Artist 1/a.flac', 'Artist 1', 'a.flac', 'audio', 'flac', 10, 1)",
  ).run();
  // Six strangers and no music: five is the floor and none may be outnumbered
  // ten to one, so this folder is one the *rule* hides — which is what makes the
  // unmark below a real test rather than a fixture agreeing with itself.
  for (let n = 0; n < 6; n += 1) {
    db.prepare(
      "INSERT INTO file (root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms) " +
        "VALUES (1, ?, 'Artist 2', ?, 'other', 'exe', 10, 1)",
    ).run(`Artist 2/setup${n}.exe`, `setup${n}.exe`);
  }
  db.prepare(
    "INSERT INTO issue (scan_run_id, root_id, rel_path, kind, severity, detail) " +
      "VALUES (1, 1, 'Artist 2', 'root_nested', 'warn', 'a folder that is also a root')",
  ).run();
}

test('stats is what the scanner already wrote down', async () => {
  await withAdmin({ seed: seedLibrary }, async (admin) => {
    const answer = await admin.call('/stats', { method: 'GET', headers: BEARER });

    assert.equal(answer.status, 200);
    assert.equal(answer.body.albums, 2);
    assert.equal(answer.body.songs, 1, 'audio files, which is what a person counts as songs');
    assert.equal(answer.body.files, 7, 'and everything else the walk met');
    assert.equal(answer.body.issues, 1);
    assert.equal(answer.body.hidden, 1, 'the album the filter is keeping out');
    assert.equal(answer.body.roots, 1);
    assert.equal(typeof answer.body.databaseBytes, 'number');
  });
});

test('issues are what the scanner could not understand, with a count of each kind', async () => {
  // The one thing an operator cannot get anywhere else: the API answers about
  // the collection it managed to build, and this answers about the parts of the
  // disk it could not.
  await withAdmin({ seed: seedLibrary }, async (admin) => {
    const answer = await admin.call('/issues', { method: 'GET', headers: BEARER });

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.counts, { root_nested: 1 });
    const rows = answer.body.issues as { kind: string; rootPath: string; detail: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, 'root_nested');
    assert.equal(rows[0]?.rootPath, '/music', 'and it says which root it came from');

    const narrowed = await admin.call('/issues?severity=info', { method: 'GET', headers: BEARER });
    assert.deepEqual(narrowed.body.issues, [], 'a severity nobody recorded answers nothing');

    const silly = await admin.call('/issues?limit=0', { method: 'GET', headers: BEARER });
    assert.equal(silly.status, 400, 'a limit that is not one is refused rather than guessed at');
  });
});

test('logs reads the end of the file this server was told to write', async () => {
  const dir = tempRoot('funoteka-admin-logs-');
  const logFile = join(dir, 'funoteka.log');
  writeFileSync(logFile, `${Array.from({ length: 50 }, (_, n) => `line ${n}`).join('\n')}\n`);

  await withAdmin({ logFile }, async (admin) => {
    const answer = await admin.call('/logs?lines=3', { method: 'GET', headers: BEARER });

    assert.equal(answer.status, 200);
    assert.equal(answer.body.file, logFile);
    assert.deepEqual(answer.body.lines, ['line 47', 'line 48', 'line 49'], 'the last three, in order');
    assert.equal(answer.body.truncated, true, 'and it says there is more above them');

    const all = await admin.call('/logs?lines=5000', { method: 'GET', headers: BEARER });
    assert.equal(all.body.truncated, false);
    assert.equal((all.body.lines as string[]).length, 50, 'the trailing newline is not an empty line');
  });
});

test('a log bigger than the tail is read from its end, and never as a fragment', async () => {
  // The deployment this was built for has a 24 MB log, and reading all of it to
  // answer "what did it just say" is 24 MB into the one thread that answers
  // every client — for five lines. So the read is bounded, and the bound is
  // visible twice in the answer: `truncated` says there is more above, and the
  // first line returned is a whole line rather than whatever the read happened
  // to start in the middle of.
  const dir = tempRoot('funoteka-admin-logs-');
  const logFile = join(dir, 'big.log');
  const body = 'x'.repeat(120);
  const lines = Array.from({ length: 4000 }, (_, n) => `${n} ${body}`);
  writeFileSync(logFile, `${lines.join('\n')}\n`);

  await withAdmin({ logFile }, async (admin) => {
    const answer = await admin.call('/logs?lines=5000', { method: 'GET', headers: BEARER });
    const returned = answer.body.lines as string[];

    assert.ok(returned.length > 1000, `the tail held ${returned.length} lines`);
    assert.ok(returned.length < lines.length, 'and not the whole file, which is the point');
    assert.match(returned[0] ?? '', /^\d+ x+$/, 'the first is a whole line, not half of one');
    assert.equal(returned.at(-1), lines.at(-1), 'and the last is the last thing written');
    assert.equal(answer.body.truncated, true);
  });
});

test('a server with no log file says which file it looked in', async () => {
  // Not an error: a supervisor that collects the output itself is the ordinary
  // deployment. The path is in the answer so that "nothing there" is checkable.
  await withAdmin({ logFile: join(tempRoot('funoteka-admin-logs-'), 'nothing.log') }, async (admin) => {
    const answer = await admin.call('/logs', { method: 'GET', headers: BEARER });

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.lines, []);
    assert.match(String(answer.body.file), /nothing\.log$/);
  });
});

test('the inventory is the dump the CLI prints, and it is text', async () => {
  await withAdmin({ seed: seedLibrary }, async (admin) => {
    const answer = await admin.raw('/inventory', { method: 'GET', headers: BEARER });

    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('content-type')?.startsWith('text/plain'), true);
    assert.match(answer.text, /Dookie/, 'and it is the collection it describes');
    assert.match(answer.text, /Telegram Desktop/, 'both albums, including the one being kept out');
  });
});

test('the filter can be listed, overruled by hand, and handed back to the rule', async () => {
  await withAdmin({ seed: seedLibrary }, async (admin) => {
    const json = { ...BEARER, 'content-type': 'application/json' };

    const listed = await admin.call('/junk', { method: 'GET', headers: BEARER });
    assert.equal((listed.body.hidden as unknown[]).length, 1, 'what a client will not see');
    assert.deepEqual(listed.body.marks, [], 'and no hand edits yet');

    // An `allow` on the folder the rule hid. The album is re-derived on the
    // spot, which is the whole promise of the mark: an operator who marks a
    // folder and then looks at a client must not be shown the old answer.
    const allowed = await admin.call('/junk', {
      headers: json,
      body: JSON.stringify({ path: '/music/Artist 2', verdict: 'trust', note: 'the installers are wanted' }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.reason, null, 'nothing keeps it out now');
    assert.equal(allowed.body.hidden, false);

    const after = await admin.call('/junk', { method: 'GET', headers: BEARER });
    assert.deepEqual(after.body.hidden, [], 'and the listing agrees');
    const marks = after.body.marks as { relPath: string; verdict: string; note: string }[];
    assert.equal(marks.length, 1);
    assert.equal(marks[0]?.verdict, 'trust');
    assert.equal(marks[0]?.note, 'the installers are wanted');

    // And back: the rule decides again, which is the third verb. Without it the
    // album would carry a person's word for ever.
    const taken = await admin.call('/junk', {
      method: 'DELETE',
      headers: json,
      body: JSON.stringify({ path: '/music/Artist 2' }),
    });
    assert.equal(taken.status, 200);
    assert.match(String(taken.body.reason), /not music/, 'the rule speaks again');
    assert.equal(taken.body.hidden, true);
  });
});

test('junk refuses a verdict it does not have, and a path under no root', async () => {
  await withAdmin({ seed: seedLibrary }, async (admin) => {
    const json = { ...BEARER, 'content-type': 'application/json' };

    const weird = await admin.call('/junk', {
      headers: json,
      body: JSON.stringify({ path: '/music/Artist 1', verdict: 'maybe' }),
    });
    assert.equal(weird.status, 400);
    assert.equal((weird.body as { junk: string }).junk !== undefined, true, 'and says what the two verdicts mean');

    const elsewhere = await admin.call('/junk', {
      headers: json,
      body: JSON.stringify({ path: 'D:/somewhere else', verdict: 'junk' }),
    });
    assert.equal(elsewhere.status, 404, 'a path under no root is one this server never heard of');

    // A path under a root with no album under it is a statement about nothing —
    // a typo the operator would otherwise never hear about.
    const nothing = await admin.call('/junk', {
      headers: json,
      body: JSON.stringify({ path: '/music/Nowhere', verdict: 'junk' }),
    });
    assert.equal(nothing.status, 400);
    assert.match(String(nothing.body.error), /no album at that path/);
  });
});

test('importing playlists answers with what it did, and is written down', async () => {
  // The one stage short enough to run inside a request: 80 ms on the live
  // collection, and it reads no audio at all. See `importPlaylists` in
  // `admin.ts` for the measurement and for what it does not cover.
  await withAdmin({ seed: seedLibrary }, async (admin) => {
    const answer = await admin.call('/playlists/import', { headers: BEARER });

    assert.equal(answer.status, 200);
    assert.equal(typeof answer.body.files, 'number');
    assert.equal(typeof answer.body.imported, 'number');

    const [line] = admin.audited().filter((one) => one.path === '/playlists/import');
    assert.equal(line?.status, 200, 'a mutation is a mutation, even when it changed nothing');
  });
});

test('who may listen is reported without the secrets themselves', async () => {
  await withAdmin(
    { file: configFile('{"user": "demo", "password": "hunter2"}\n'), env: { FUNOTEKA_APIKEY: 'env-key' } },
    async (admin) => {
      const answer = await admin.call('/user', { method: 'GET', headers: BEARER });

      assert.equal(answer.status, 200);
      assert.equal(answer.body.user, 'demo', 'the name is not a secret and is answered');
      assert.deepEqual(answer.body.password, { set: true, source: 'file' });
      assert.deepEqual(answer.body.apiKey, { set: true, source: 'environment' });
      assert.equal(JSON.stringify(answer.body).includes('hunter2'), false, 'and the password is not in the answer');
      assert.equal(JSON.stringify(answer.body).includes('env-key'), false, 'nor the key');
      assert.deepEqual(answer.body.registry, [], 'no keys registered yet');
    },
  );
});

test('a credential is rotated into the file, and the answer says what that makes the file', async () => {
  // **The verb `config set` refuses to be.** A password written through a
  // general settings route would be one written by accident; here it is the
  // whole subject.
  const file = configFile('{"user": "demo", "password": "old"}\n');
  await withAdmin({ file }, async (admin) => {
    const answer = await admin.call('/user', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'new-one' }),
    });

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.changed, ['password']);
    assert.equal(answer.body.restartRequired, true, 'credentials are read at startup like everything else');
    assert.match(JSON.parse(admin.file() ?? '{}').password, /^new-one$/);

    // The audit says that a credential changed and never what it became: an
    // audit file that recorded passwords would be the worst file in the
    // deployment.
    const [line] = admin.audited();
    assert.deepEqual(line?.detail, { changed: ['password set'], overridden: [] });
    assert.equal(JSON.stringify(admin.audited()).includes('new-one'), false);
  });
});

test('a rotation the environment overrides says so rather than looking as though it worked', async () => {
  await withAdmin(
    { file: configFile('{"user": "demo", "password": "old"}\n'), env: { FUNOTEKA_PASSWORD: 'from-env' } },
    async (admin) => {
      const answer = await admin.call('/user', {
        headers: { ...BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'new-one' }),
      });

      assert.equal(answer.status, 200);
      const overridden = answer.body.overridden as { key: string; note: string }[];
      assert.deepEqual(overridden.map((one) => one.key), ['password']);
      assert.match(String(overridden[0]?.note), /wins over the file/);
    },
  );
});

test('a rotation that would leave nobody able to get in is refused', async () => {
  // A server with no password and no key does not start at all, so a change that
  // removed the last way in would be a change that takes the music down at the
  // next restart — refused while the operator is looking at the answer.
  await withAdmin({ file: configFile('{"user": "demo"}\n') }, async (admin) => {
    const answer = await admin.call('/user', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'someone-else' }),
    });

    assert.equal(answer.status, 409);
    assert.match(String(answer.body.error), /no way in/);
    assert.equal(admin.file(), '{"user": "demo"}\n', 'and nothing was written');
  });
});

test('a key can be minted, and it is shown once', async () => {
  // The only moment this surface ever hands a secret back. It is the point of
  // rotating one — an operator who cannot read the new key has not rotated
  // anything — and it is why the answer also says where the key now lives.
  await withAdmin({ file: configFile('{"user": "demo", "password": "old"}\n') }, async (admin) => {
    const answer = await admin.call('/user', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: JSON.stringify({ rotate: 'apiKey' }),
    });

    assert.equal(answer.status, 200);
    const revealed = answer.body.revealed as { what: string; value: string };
    assert.equal(revealed.what, 'apiKey');
    assert.ok(revealed.value.length >= 32, 'a key long enough that guessing it is not a thing anyone tries');
    assert.equal(JSON.parse(admin.file() ?? '{}').apiKey, revealed.value, 'and the file is what holds it now');

    const after = await admin.call('/user', { method: 'GET', headers: BEARER });
    assert.deepEqual(after.body.apiKey, { set: true, source: 'file' });
    assert.equal(JSON.stringify(after.body).includes(revealed.value), false, 'read back as set, never as itself');
  });
});

test('rotating anything but a key, or both at once, is refused with what to do instead', async () => {
  await withAdmin({ file: configFile('{"user": "demo", "password": "old"}\n') }, async (admin) => {
    const json = { ...BEARER, 'content-type': 'application/json' };

    const wrong = await admin.call('/user', { headers: json, body: JSON.stringify({ rotate: 'password' }) });
    assert.equal(wrong.status, 400);
    assert.match(String(wrong.body.error), /rotate nothing else/);

    const both = await admin.call('/user', {
      headers: json,
      body: JSON.stringify({ rotate: 'apiKey', apiKey: 'chosen' }),
    });
    assert.equal(both.status, 400);

    const empty = await admin.call('/user', { headers: json, body: JSON.stringify({}) });
    assert.equal(empty.status, 400);
    assert.match(String(empty.body.error), /nothing to change/);

    const nothing = await admin.call('/user', {
      headers: json,
      body: JSON.stringify({ password: '' }),
    });
    assert.equal(nothing.status, 400, 'an empty credential is an absence pretending to be a value');
  });
});

/** A library with the two things an export is about: a whole file and a segment. */
function seedListener(db: ReturnType<typeof openDb>): void {
  db.prepare("INSERT INTO root (id, path, created_at) VALUES (1, '/music', '2026-09-01T00:00:00.000Z')").run();
  db.prepare(
    "INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms) " +
      "VALUES (1, 1, 'Artist/album.flac', 'Artist', 'album.flac', 'audio', 'flac', 10, 1)",
  ).run();
  // Two songs out of one file: the whole of it, and a segment. A backup keyed on
  // row ids could not tell these apart after a rescan put them back in another
  // order, which is the failure the natural key exists to prevent.
  db.prepare(
    "INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms) VALUES (1, NULL, 1, 'Whole', 1, NULL)",
  ).run();
  db.prepare(
    "INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms) VALUES (2, NULL, 2, 'Segment', 1, 30000)",
  ).run();
}

test('an export holds what a rescan cannot rebuild, and says what it left out', async () => {
  await withAdmin({ seed: seedListener }, async (admin) => {
    const db = admin.db();
    db.prepare("INSERT INTO track_annotation (track_id, starred_at, rating) VALUES (1, '2026-09-10T00:00:00.000Z', 5)").run();
    db.prepare("INSERT INTO playlist (id, name, comment, public, created_at, changed_at) VALUES (7, 'Driving', NULL, 1, ?, ?)")
      .run('2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z');
    db.prepare('INSERT INTO playlist_track (playlist_id, position, track_id) VALUES (7, 0, 2)').run();
    db.prepare("INSERT INTO junk_mark (root_id, rel_path, verdict, note, marked_at) VALUES (1, 'Artist', 'junk', 'not music', ?)")
      .run('2026-09-10T00:00:00.000Z');

    const answer = await admin.call('/export', { method: 'GET', headers: BEARER });

    assert.equal(answer.status, 200);
    assert.equal(answer.body.funoteka, 'export');
    assert.equal(answer.body.version, 1);

    const playlists = answer.body.playlists as { name: string; public: boolean; entries: unknown[] }[];
    assert.equal(playlists.length, 1);
    assert.equal(playlists[0]?.name, 'Driving');
    assert.equal(playlists[0]?.public, true);
    // **The key, and not the row id.** These two songs share one file and differ
    // only in where the segment starts, which is the distinction a rescan
    // preserves and an id does not.
    assert.deepEqual(playlists[0]?.entries, [{ root: '/music', file: 'Artist/album.flac', at: 30000 }]);

    const tracks = (answer.body.starred as { tracks: unknown[] }).tracks;
    assert.deepEqual(tracks, [
      { root: '/music', file: 'Artist/album.flac', at: null, starredAt: '2026-09-10T00:00:00.000Z', rating: 5 },
    ]);

    assert.deepEqual((answer.body.junkMarks as { note: string }[])[0]?.note, 'not music');
    assert.equal(typeof answer.body.sensitive, 'string', 'and it says the document is worth something');
    assert.equal(
      (answer.body.notIncluded as Record<string, string>).scan !== undefined,
      true,
      'a reader is told what it is not holding',
    );
  });
});

test('a restore puts the statements back on the songs, after a rescan changed their ids', async () => {
  // **The property the whole design is for.** The cue stage clears its rows and
  // rebuilds them, so after a rescan the ids that meant these two songs mean
  // nothing, or something else. A restore keyed on ids would put somebody's
  // rating on a different song and say it worked.
  await withAdmin({ seed: seedListener }, async (admin) => {
    const db = admin.db();
    db.prepare("INSERT INTO track_annotation (track_id, starred_at, rating) VALUES (2, '2026-09-10T00:00:00.000Z', 4)").run();
    db.prepare("INSERT INTO playlist (id, name, comment, public, created_at, changed_at) VALUES (7, 'Driving', NULL, 0, ?, ?)")
      .run('2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z');
    db.prepare('INSERT INTO playlist_track (playlist_id, position, track_id) VALUES (7, 0, 2)').run();

    const exported = (await admin.call('/export', { method: 'GET', headers: BEARER })).body;

    // A rescan, as the cue stage does it: the rows go and come back as different
    // rows that mean the same songs.
    db.exec('DELETE FROM playlist_track');
    db.exec('DELETE FROM playlist');
    db.exec('DELETE FROM track_annotation');
    db.exec('DELETE FROM track');
    db.prepare(
      "INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms) VALUES (11, NULL, 1, 'Whole', 1, NULL)",
    ).run();
    db.prepare(
      "INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms) VALUES (12, NULL, 2, 'Segment', 1, 30000)",
    ).run();

    const answer = await admin.call('/restore', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: JSON.stringify(exported),
    });

    assert.equal(answer.status, 200);
    assert.equal((answer.body.placed as Record<string, number>).trackStars, 1);
    assert.deepEqual(answer.body.skipped, [], 'nothing was left unplaced');

    // On the *same song*, which is now track 12 and was track 2.
    // Spread into a plain object first: `node:sqlite` hands rows back with a null
    // prototype, and a strict comparison is about the object as well as its values.
    const star = (db.prepare('SELECT track_id, rating FROM track_annotation').all() as {
      track_id: number;
      rating: number;
    }[]).map((row) => ({ ...row }));
    assert.deepEqual(star, [{ track_id: 12, rating: 4 }]);

    const entries = (
      db.prepare(
        'SELECT pt.position, t.segment_start_ms FROM playlist_track pt JOIN track t ON t.id = pt.track_id',
      ).all() as { position: number; segment_start_ms: number | null }[]
    ).map((row) => ({ ...row }));
    assert.deepEqual(entries, [{ position: 0, segment_start_ms: 30000 }], 'and the playlist names the same segment');
  });
});

test('a restore says what it could not place, rather than dropping it quietly', async () => {
  // A restore that silently dropped the third of a playlist whose files had
  // moved is indistinguishable from one that worked, and the operator finds out
  // by listening.
  await withAdmin({ seed: seedListener }, async (admin) => {
    const document = {
      funoteka: 'export',
      version: 1,
      playlists: [
        {
          name: 'Gone',
          comment: null,
          public: false,
          createdAt: 'x',
          changedAt: 'x',
          entries: [
            { root: '/music', file: 'Artist/album.flac', at: null },
            { root: '/music', file: 'Artist/removed.flac', at: null },
            { root: '/other-shelf', file: 'Artist/album.flac', at: null },
          ],
        },
      ],
      starred: { tracks: [], albums: [], artists: [] },
      bookmarks: [],
      junkMarks: [{ root: '/nowhere', rel: 'Artist', verdict: 'junk', note: null, markedAt: 'x' }],
      apiKeys: [],
    };

    const answer = await admin.call('/restore', {
      headers: { ...BEARER, 'content-type': 'application/json' },
      body: JSON.stringify(document),
    });

    assert.equal(answer.status, 200);
    assert.equal((answer.body.placed as Record<string, number>).playlistEntries, 1, 'the one that resolves');
    const skipped = answer.body.skipped as { what: string; why: string }[];
    assert.equal(skipped.length, 3);
    assert.match(skipped[0]?.what ?? '', /removed\.flac/);
    assert.match(skipped[0]?.why ?? '', /no such file/);
    assert.match(skipped[2]?.why ?? '', /root it was made under is not configured/);
    assert.equal(answer.body.skippedMore, 0);
  });
});

test('a restore merges, and refuses what is not an export', async () => {
  await withAdmin({ seed: seedListener }, async (admin) => {
    const json = { ...BEARER, 'content-type': 'application/json' };
    const document = {
      funoteka: 'export',
      version: 1,
      playlists: [
        { name: 'Kept', comment: null, public: false, createdAt: 'x', changedAt: 'x', entries: [] },
      ],
      starred: { tracks: [], albums: [], artists: [] },
      bookmarks: [],
      junkMarks: [],
      apiKeys: [],
    };

    await admin.call('/restore', { headers: json, body: JSON.stringify(document) });
    const again = await admin.call('/restore', { headers: json, body: JSON.stringify(document) });

    assert.equal((again.body.placed as Record<string, number>).playlists, 0, 'the second time made nothing new');
    const count = admin.db().prepare('SELECT COUNT(*) AS n FROM playlist').get() as { n: number };
    assert.equal(count.n, 1, 'and there is still one playlist');

    const wrong = await admin.call('/restore', { headers: json, body: JSON.stringify({ hello: 'world' }) });
    assert.equal(wrong.status, 400);
    assert.match(String(wrong.body.error), /not an export document/);

    const [line] = admin.audited().filter((one) => one.path === '/restore');
    assert.equal(line?.status, 200, 'a restore is a mutation like any other');
  });
});

test('MCP on the admin port drives the same routes, and the audit says so', async () => {
  // **The whole point of MCP being *over* the admin API.** A tool call is an
  // ordinary admin request with the request left out, so it meets the same gate,
  // the same refusals and the same audit — and the audit shows the work, not the
  // transport that asked for it.
  await withAdmin({ seed: seedLibrary }, async (admin) => {
    const json = { ...BEARER, 'content-type': 'application/json' };
    const mcp = (message: unknown) => ({ headers: json, body: JSON.stringify(message) });

    const listed = await admin.call(
      '/mcp',
      mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    );
    assert.equal(listed.status, 200);
    const tools = (listed.body.result as { tools: { name: string }[] }).tools;
    assert.ok(tools.length >= 20, `the surface is published: ${tools.length} tools`);
    assert.ok(tools.some((tool) => tool.name === 'funoteka_scan_start'));

    const called = await admin.call(
      '/mcp',
      mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'funoteka_stats' } }),
    );
    const result = (called.body.result as { content: { text: string }[] }).content[0]?.text ?? '';
    assert.equal(JSON.parse(result).albums, 2, 'and the answer is the route\u2019s own answer');

    const marked = await admin.call(
      '/mcp',
      mcp({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'funoteka_junk_mark', arguments: { path: '/music/Artist 2', verdict: 'trust' } },
      }),
    );
    assert.equal((marked.body.result as { isError: boolean }).isError, false);

    const audited = admin.audited();
    assert.deepEqual(audited.map((line) => line.path), ['/junk'], 'the work is the event, not the transport');

    // A notification has no answer, and 202 is what this says to one.
    const quiet = await admin.call(
      '/mcp',
      mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    assert.equal(quiet.status, 202);
  });
});

test('a tool call given a retry key is answered out of the record, not done twice', async () => {
  // The HTTP surface takes an `Idempotency-Key` header. A tool call is one JSON
  // object with nowhere to put a header, so the key arrives as an argument —
  // and it has to reach the same record, because the contract asks for idempotent
  // mutations without qualifying the transport (§3).
  //
  // **The tool that most needs it is `funoteka_user_set {"rotate":"apiKey"}`**,
  // where a repeat is not harmless: it mints a second key and invalidates the one
  // the first call handed back. `junk_mark` is what this proves it on, because
  // the audit count is observable — a replay writes no line, so "the work
  // happened once" is a number here rather than a reading of the answer.
  await withAdmin({ seed: seedLibrary }, async (admin) => {
    const json = { ...BEARER, 'content-type': 'application/json' };
    const mark = (id: number, args: Record<string, unknown>) =>
      admin.call('/mcp', {
        headers: json,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'funoteka_junk_mark', arguments: args },
        }),
      });

    const asked = { path: '/music/Artist 2', verdict: 'trust', idempotencyKey: 'retry-1' };

    const first = await mark(1, asked);
    assert.equal((first.body.result as { isError: boolean }).isError, false);
    assert.equal(admin.audited().length, 1, 'the first call is work, and it is written down');

    const repeated = await mark(2, asked);
    assert.equal(repeated.status, 200);
    assert.deepEqual(
      (repeated.body as { result: unknown }).result,
      (first.body as { result: unknown }).result,
      'a repeat gets the first answer',
    );
    assert.equal(admin.audited().length, 1, 'and is not work, so it is not an event');

    // The same arguments with no key are a call like any other: it does the work.
    // Without this the line above would pass on a surface that simply refused to
    // act twice, and the record would be doing nothing.
    const unkeyed = await mark(3, { path: '/music/Artist 2', verdict: 'trust' });
    assert.equal((unkeyed.body.result as { isError: boolean }).isError, false);
    assert.equal(admin.audited().length, 2, 'without the key there is nothing to answer from');
  });
});

test('the stdio client carries the retry key as the header the port reads', async () => {
  // `adminClient` is what `funoteka mcp` runs on: an agent starts it as a process
  // and every tool call leaves it as one authenticated HTTP request. It
  // implements `AdminClient`, whose retry key is the fourth argument — and a
  // function that ignores an argument is not a type error, so this client
  // dropped the key for as long as the argument has existed. Nothing caught it:
  // the tool layer is tested against a recorder and the port against `fetch`,
  // and this client is the join that neither covered.
  //
  // Held against the real port rather than a fake, because the thing asserted is
  // that the key *arrives* — and a fake would have been written by whoever wrote
  // the omission.
  await withAdmin({ seed: seedLibrary }, async (admin) => {
    const client = adminClient(`http://127.0.0.1:${admin.port}`, CONFIG.token);
    const mark = (key?: string) =>
      client(
        'POST',
        '/junk',
        { path: '/music/Artist 2', verdict: 'trust' },
        key,
      ) as Promise<{ status: number; body: unknown }>;

    const first = await mark('retry-9');
    assert.equal(first.status, 200);
    assert.equal(admin.audited().length, 1, 'the first call is work');

    const repeated = await mark('retry-9');
    assert.equal(repeated.status, first.status);
    assert.deepEqual(repeated.body, first.body, 'the first answer, not a second one');
    assert.equal(admin.audited().length, 1, 'answered out of the record, so not an event');
  });
});
