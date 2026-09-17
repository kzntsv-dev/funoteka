import { readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

import type { DatabaseSync } from '../db/index.ts';
import { SCHEMA_VERSION } from '../db/index.ts';
import { hidden, mark, marks, resolvePath, unmark } from '../junk/marks.ts';
import { inventory as inventoryDump } from '../inventory/inventory.ts';
import { applyPlaylists } from '../playlist/import.ts';
import { exportState, isExport, restoreState } from './admin-export.ts';
import { issues, logs, stats } from './admin-library.ts';
import { guard, type Guard } from './admin-guard.ts';
import { auditLog, type AuditEntry } from './audit.ts';
import { sameSecret } from './auth.ts';
import { configReport, loadConfig, type AdminConfig, type Setting } from './config.ts';
import { health } from './health.ts';
import { readConfigFile, writeConfigFile } from './config-file.ts';
import { SERVER_VERSION } from './envelope.ts';
import { recall, remember } from './idempotency.ts';
import { addKey, listKeys, newSecret, revokeKey } from './keys.ts';
import { count, scanStatus } from './meta.ts';
import { addRoot, listRoots, removeRoot } from './roots.ts';
import { handleMessage } from '../mcp/server.ts';
import type { AdminClient } from '../mcp/tools.ts';
import type { ScanMode, Scanner } from './scanner.ts';
import { SECRET_SETTINGS, SETTINGS } from './settings.ts';

/**
 * The admin surface: a second listener, on a second port, for whoever operates
 * this server rather than for whoever listens to it.
 *
 * **Why a port of its own.** The API is what a phone talks to, and it is meant to
 * be reachable from the sofa. This is what an operator talks to, and it is meant
 * to be reachable from a laptop, a VPN, or a proxy with TLS in front of it — and
 * the deployments this server ships for want *different* answers to "who may
 * reach it". Two ports make that one firewall rule; one port would make it
 * every-route-decides, for ever.
 *
 * **Why one token and no session.** The asker is a person with `curl` or an agent
 * with this server's MCP tools, not a browser. There is no login page, no cookie
 * and no session to expire, because there is no web front end at all
 * (`requirements:49`, "Не входит: веб-морда"). A bearer token is the whole of the
 * authentication, and the whole of the gate: **no token configured means this
 * module returns no server at all**, and the port is not open.
 *
 * **The four locks, and what each is for.** The token proves who is calling; the
 * address list keeps the port from being knocked at by a machine with no business
 * knocking; the failure limit keeps a good token from being found; TLS keeps the
 * token from being read on the way. Every one of them is a setting, every one
 * defaults to the safe reading, and a deployment with none of them set is still
 * guarded by its token — the alternative, a control surface that is open because
 * somebody did not configure something, is the failure all four exist to prevent.
 *
 * Every mutation is written to an audit file (`audit.ts`) and every one of them
 * can be replayed by key (`idempotency.ts`), because the callers here are scripts
 * and agents over a network, and a network cannot tell "never arrived" from "the
 * answer was lost".
 */

/** What one admin route is given. */
export interface AdminDeps {
  db: DatabaseSync;
  config: AdminConfig;
  dbPath: string;
  /** Where the config file is: `config set` writes it, `config get` reports it. */
  configFile: string;
  /**
   * The environment as this process sees it.
   *
   * `config set` needs it, and needs it to be *this* process's: the question the
   * route answers is whether the value it just wrote is the value in force, and
   * only the environment that was read at startup can answer that.
   */
  env: NodeJS.ProcessEnv;
  /** Where the record of mutations goes. See `auditLog`. */
  audit: (entry: AuditEntry) => boolean;
  /** The scan this server can start, watch and stop. See `scanner.ts`. */
  scanner: Scanner;
  /**
   * The file this process narrates to when it was told to write one.
   *
   * Empty is the ordinary deployment — a supervisor that collects the output —
   * and then `GET /logs` reads the daemon's own `<db>.log` instead, which is
   * where a `--daemon` server's output goes.
   */
  logFile: string;
  /**
   * What to do once a restart has been answered and the answer is on the wire.
   *
   * A callback rather than a return value, because a restart is not something a
   * route can do before answering: exiting first would take the socket down
   * before `{"restarting": true}` reached the caller, and the operator would be
   * left with a connection reset and no idea whether the command was heard.
   */
  onRestart: () => void;
}

/** What a route answers, before it is rendered. */
interface Reply {
  status: number;
  body: unknown;
  /** What changed, for the audit line. Absent on a read. */
  detail?: Record<string, unknown>;
  /** A body that is not JSON — the inventory dump, which is a report for a person. */
  text?: string;
  /**
   * Something to do once the answer is on the wire.
   *
   * One route needs it: a restart is an exit, and exiting before the answer
   * reached the socket leaves the caller with a connection reset and no idea
   * whether the command was heard.
   */
  after?: () => void;
}

/**
 * The admin listener, or nothing when no token was configured.
 *
 * Nothing is the *disabled* state and it is deliberately `null` rather than a
 * server that refuses everything: a listener on the port that answers 401 to a
 * stranger is still a socket this server opened, and "off" should mean the
 * connection is refused.
 */
export function createAdminServer(deps: AdminDeps): Server | null {
  const { config } = deps;
  if (config.token === '') return null;

  const gate = guard(config.allow);
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    // Every path out of `route` is accounted for: a request body can fail to
    // arrive when a client hangs up, and an unhandled rejection in Node does not
    // end a request — it ends the process. A control surface that a dropped
    // connection can kill is worse than one that refuses.
    route(deps, gate, request, response).catch((err: unknown) => {
      process.stderr.write(`funoteka admin: ${String(err)}\n`);
      send(response, { status: 500, body: { error: 'internal error' } });
    });
  };

  return config.tls === null
    ? createHttpServer(handle)
    : createHttpsServer(tlsFor(config.tls), handle);
}

/**
 * The certificate and key, read once at startup.
 *
 * Read here rather than checked for existence: a server that started with an
 * unreadable certificate would fail on its first connection instead, which is
 * the worst moment to find out. The sentence names the file, because the path is
 * the thing that is wrong.
 */
function tlsFor(tls: { cert: string; key: string }): { cert: Buffer; key: Buffer } {
  try {
    return { cert: readFileSync(tls.cert), key: readFileSync(tls.key) };
  } catch (err) {
    throw new Error(`the admin TLS certificate or key could not be read: ${(err as Error).message}`);
  }
}

/**
 * One request, from the address to the last byte.
 *
 * The order is the whole of the security story and it is not rearrangeable:
 * **who is calling** (the address list), then **whether they may keep calling**
 * (the lockout), then **whether they know the token**, and only then the route.
 * Checking the token first would spend a comparison on a machine that was told
 * not to knock, and counting a failure before the lockout was consulted would
 * extend a lockout every time the locked-out caller tried again.
 */
async function route(
  deps: AdminDeps,
  gate: Guard,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const started = Date.now();
  const method = (request.method ?? 'GET').toUpperCase();
  const path = (request.url ?? '/').split('?')[0] ?? '/';
  const address = clientAddress(request, deps.config);

  const done = (reply: Reply): void => {
    process.stderr.write(
      `funoteka admin: ${method} ${path} ${reply.status} ${Date.now() - started}ms\n`,
    );
  };

  if (!gate.allowed(address)) {
    const reply: Reply = { status: 403, body: { error: 'this address is not allowed' } };
    record(deps, { method, path, address, status: reply.status, detail: { refused: 'address' } });
    done(reply);
    send(response, reply);
    return;
  }

  if (gate.locked(address)) {
    // Said as a time rather than as a rule, because the caller's next question is
    // how long, and both `Retry-After` and the body answer it.
    const seconds = gate.waitFor(address);
    const reply: Reply = {
      status: 429,
      body: { error: `too many failed tokens; try again in ${seconds}s`, retryAfter: seconds },
    };
    record(deps, { method, path, address, status: reply.status, detail: { refused: 'lockout' } });
    done(reply);
    send(response, reply, { 'retry-after': String(seconds) });
    return;
  }

  if (!authorised(request, deps.config.token)) {
    gate.recordFailure(address);
    const left = gate.failuresLeft(address);
    const reply: Reply = {
      status: 401,
      body:
        left === undefined
          ? { error: 'wrong or missing token' }
          : { error: `wrong token; ${left} more before this address is locked out` },
    };
    // Written down, because a wrong token is either a typo or somebody who is
    // not the operator, and a record that cannot tell the two apart is a record
    // that answers nothing.
    record(deps, { method, path, address, status: reply.status, detail: { refused: 'token' } });
    done(reply);
    send(response, reply);
    return;
  }

  gate.recordSuccess(address);

  const mutating = mutates(method);
  const key = request.headers['idempotency-key'];

  if (mutating && typeof key === 'string' && key !== '') {
    const seen = recall(deps.db, key, method, path);

    if (seen.kind === 'conflict') {
      const reply: Reply = {
        status: 422,
        body: {
          error: 'this Idempotency-Key was used for a different request',
          was: `${seen.recorded.status}`,
        },
        detail: { conflict: key },
      };
      record(deps, { method, path, address, status: reply.status, detail: reply.detail });
      done(reply);
      send(response, reply);
      return;
    }

    if (seen.kind === 'replay') {
      const reply: Reply = { status: seen.recorded.status, body: JSON.parse(seen.recorded.body) };
      // No audit line: nothing happened this time, and a second line saying it
      // did would be the record lying about the work.
      done(reply);
      send(response, reply, { 'idempotent-replay': 'true' });
      return;
    }
  }

  // **The body is read once, here, whatever the route is.** A route that takes
  // none has nothing to read, and one that takes some gets the text — which is
  // also what lets the MCP transport ask a route a question without an HTTP
  // request to ask it with.
  const asked = await read(request, RESTORE_LIMIT);
  const reply = await answer(
    deps,
    method,
    path,
    new URL(request.url ?? '/', 'http://localhost').searchParams,
    asked,
    address,
  );
  const detail = reply.detail;

  // Attached before the answer is written, and fired by the socket's own
  // `finish`: the difference between "this process is going down" and "your
  // request was heard and this process is going down" is the whole of what a
  // restart answers.
  if (reply.after !== undefined) response.once('finish', reply.after);

  if (mutating) {
    // **A refusal is recorded too, which is what `audit.ts` has always said.**
    // It did not: the audit was written only when the answer was a success, so a
    // `POST /user` refused for leaving nobody able to get in — the one refusal an
    // operator most wants to find — left no line at all.
    if (reply.status >= 400) {
      recordMutation(deps, { method, path, address, status: reply.status, detail: reply.detail });
    } else {
      // Before the answer goes out, and both of them. A record written after the
      // reply is a record that a crash can lose *after* the caller was told the
      // work was done — and then a retry does it twice, which is the whole of
      // what this pair exists to prevent.
      if (typeof key === 'string') {
        remember(deps.db, key, method, path, reply.status, JSON.stringify(reply.body));
      }
      recordMutation(deps, { method, path, address, status: reply.status, detail });
    }
  }

  done(reply);
  send(response, reply);
}

/**
 * The routes.
 *
 * A chain of `if`s rather than a table, and it has stopped being small: the
 * surface grew a stage at a time (`task:2936`–`2938`) and each addition was one
 * line, which is the argument for a chain — but a reader counting branches now
 * finds thirty, and the "one place" this promised is a long one. A `Map` keyed by
 * `${method} ${path}` is the shape it wants, and is worth doing when something
 * next changes here rather than as a change of its own.
 *
 * The `path` is exact: the admin surface has no path parameters, and a route that
 * guessed at one would be a route that answers something it was not asked.
 */
async function answer(
  deps: AdminDeps,
  method: string,
  path: string,
  query: URLSearchParams,
  asked: string | null,
  // Who asked, carried for the one route whose work happens out of sight of
  // `route`'s audit: MCP, which drives the same routes from inside this process.
  address: string,
): Promise<Reply> {
  if (path === '/health' && method === 'GET') return healthRoute(deps);
  if (path === '/status' && method === 'GET') return status(deps);
  if (path === '/config' && method === 'GET') return readConfig(deps);
  if (path === '/config' && method === 'POST') return setConfig(deps, asked);
  if (path === '/restart' && method === 'POST') return restart(deps);

  if (path === '/roots' && method === 'GET') return { status: 200, body: { roots: listRoots(deps.db) } };
  if (path === '/roots' && method === 'POST') return addRootRoute(deps, asked);
  if (path === '/roots' && method === 'DELETE') return removeRootRoute(deps, asked);

  if (path === '/scan' && method === 'GET') return { status: 200, body: { ...deps.scanner.status(), modes: modes() } };
  if (path === '/scan' && method === 'POST') return startScan(deps, asked);
  if (path === '/scan/cancel' && method === 'POST') return cancelScan(deps);
  if (path === '/scan/history' && method === 'GET') return scanHistory(deps, query);

  if (path === '/stats' && method === 'GET') return { status: 200, body: stats(deps.db, deps.dbPath) };
  if (path === '/issues' && method === 'GET') return issuesRoute(deps, query);
  if (path === '/logs' && method === 'GET') return logsRoute(deps, query);
  if (path === '/inventory' && method === 'GET') return inventoryRoute(deps);

  if (path === '/junk' && method === 'GET') {
    return { status: 200, body: { hidden: hidden(deps.db), marks: marks(deps.db) } };
  }
  if (path === '/junk' && method === 'POST') return markRoute(deps, asked);
  if (path === '/junk' && method === 'DELETE') return unmarkRoute(deps, asked);

  if (path === '/playlists/import' && method === 'POST') return importPlaylists(deps);

  if (path === '/mcp' && method === 'POST') return mcpRoute(deps, asked, address);

  if (path === '/export' && method === 'GET') {
    return { status: 200, body: exportState(deps.db, SCHEMA_VERSION) };
  }
  if (path === '/restore' && method === 'POST') return restoreRoute(deps, asked);

  if (path === '/user' && method === 'GET') return readUser(deps);
  if (path === '/user' && method === 'POST') return setUser(deps, asked);

  return { status: 404, body: { error: `no such admin route: ${method} ${path}` } };
}

/**
 * What this server is and what it is doing.
 *
 * The question an operator asks from a phone before anything else: which build,
 * how long it has been up, how big the collection is, whether a scan is running,
 * and — the part they cannot see from outside — how the admin surface itself is
 * configured. The token is not in it. The address list is, because knowing
 * whether one is in force is the difference between a locked door and one that
 * was never locked.
 */
function status(deps: AdminDeps): Reply {
  const { db, config } = deps;
  const scan = scanStatus(db);

  return {
    status: 200,
    body: {
      server: 'funoteka',
      version: SERVER_VERSION,
      uptime: Math.round(process.uptime() * 10) / 10,
      schema: SCHEMA_VERSION,
      database: {
        path: deps.dbPath,
        songs: scan.count,
        albums: count(db, "SELECT COUNT(*) AS n FROM album"),
        artists: count(db, 'SELECT COUNT(*) AS n FROM artist'),
      },
      scan,
      admin: {
        port: config.port,
        tls: config.tls === null ? false : true,
        allow: config.allow === '' ? null : config.allow,
        trustProxy: config.trustProxy,
        supervised: config.supervised,
        token: config.token === '' ? 'none' : 'set',
      },
    },
  };
}

/**
 * Every setting, in force and where it came from.
 *
 * Read from the file *now* rather than from what was loaded at startup: the
 * operator may have edited it by hand a minute ago, and a report that showed the
 * startup copy would be answering about a file that no longer exists.
 */
function readConfig(deps: AdminDeps): Reply {
  let file;
  try {
    file = readConfigFile(deps.configFile);
  } catch (err) {
    // A file broken by hand is exactly when this route is reached for, so the
    // sentence is the answer rather than a failure to answer.
    return { status: 500, body: { error: (err as Error).message } };
  }

  return {
    status: 200,
    body: {
      file: deps.configFile,
      settings: configReport(deps.env, {}, file),
    },
  };
}

/**
 * Write settings into the config file.
 *
 * **What this route is really for is not writing the file — it is the answer
 * afterwards.** The value just written may be one the environment overrides, in
 * which case it is not in force and will not be in force after a restart either;
 * the report comes back with the answer so that the operator is told that the
 * moment they do it, rather than finding out from a server that came up exactly
 * as it was. An `overridden` entry is that fact, and it is the reason the
 * `source` of a setting is recorded rather than guessed.
 *
 * Nothing here takes effect in the running process. The config is read once, at
 * startup, by design — a server whose port could change under it mid-request
 * would be a server whose behaviour depends on when you asked — so every write
 * needs a restart, and the answer says so and names the route that does it.
 */
async function setConfig(deps: AdminDeps, asked: string | null): Promise<Reply> {
  const parsed = parseBody(asked, false);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const changes = parsed.value;

  const keys = Object.keys(changes);
  if (keys.length === 0) {
    return { status: 400, body: { error: 'no settings were given' } };
  }

  // Credentials are not set through here, and the refusal says why rather than
  // letting the write happen: a password in a config file is a password in a
  // file, and the verb that owns rotating one should be the verb that decides
  // where it is kept (`task:2938`).
  const secret = keys.find((key) => SECRET_SETTINGS.has(key));
  if (secret !== undefined) {
    return {
      status: 409,
      body: {
        error: `"${secret}" is a credential and is not set here`,
        where: 'in the config file by hand, or in the environment — see DEPLOY.md',
      },
    };
  }

  // A key that is not a setting is refused before anything is written, with the
  // same vocabulary the file itself is read by.
  const unknown = keys.find((key) => SETTINGS[key] === undefined);
  if (unknown !== undefined) {
    return { status: 400, body: { error: `unknown setting "${unknown}"` } };
  }

  let written: Setting[];
  try {
    writeConfigFile(deps.configFile, changes as Record<string, string | number | boolean | null>);
    written = settingsNow(deps).settings;
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }

  const of = (key: string) => written.find((one) => one.key === key);
  const overridden = keys
    .map((key) => of(key))
    .filter((one) => one !== undefined && one.source !== 'file')
    .map((one) => ({
      key: one?.key,
      value: one?.value,
      source: one?.source,
      note:
        one?.source === 'environment'
          ? 'an environment variable is set and wins over the file — unset it for this to take effect'
          : 'a command-line flag is set and wins over the file',
    }));

  return {
    status: 200,
    body: {
      file: deps.configFile,
      written: keys,
      settings: written,
      overridden,
      restartRequired: true,
      restart: 'POST /restart',
      note: 'the config is read once, at startup: nothing here is in force until this process is restarted',
    },
    detail: {
      // **What was written, not what is in force.** The two differ exactly when
      // an environment variable overrides the file — and the audit line is a
      // record of what somebody did, so a line reading `{"port": 4611}` after
      // `config set port 7777` would say the opposite of the truth about the one
      // case the operator needed the record for. What is in force is on the
      // response, in `overridden`.
      changed: Object.fromEntries(keys.map((key) => [key, changes[key] ?? null])),
      overridden: overridden.map((one) => one.key),
    },
  };
}

/**
 * Every setting, in force and where from — read the same way by every route that
 * asks.
 *
 * Read from the file *now* rather than from what was loaded at startup: the
 * operator may have edited it by hand a minute ago, and a report showing the
 * startup copy would be answering about a file that no longer exists. `readConfig`
 * is the one reader that does not come through here, and deliberately: it
 * *answers* a file broken by hand rather than throwing, because a broken file is
 * exactly when somebody reaches for it.
 */
function settingsNow(deps: AdminDeps): { settings: Setting[]; of: (key: string) => Setting | undefined } {
  const settings = configReport(deps.env, {}, readConfigFile(deps.configFile));
  return { settings, of: (key) => settings.find((one) => one.key === key) };
}

/**
 * Who may listen: the credentials as *set or not* and where from, and the key
 * registry. Never a secret itself.
 */
function readUser(deps: AdminDeps): Reply {
  const file = readConfigFile(deps.configFile);
  const { of } = settingsNow(deps);

  // **Whether a secret is set is asked of the loaded config, never of the
  // report.** The report masks secrets — `value: null` for all three — which is
  // what makes it safe to answer with, and it is also what would make a "set"
  // computed from it read false for a deployment whose password is right there
  // in the file. The first version of this did exactly that, and the test that
  // asked a deployment with a password found it.
  const effective = loadConfig(deps.env, {}, file);

  return {
    status: 200,
    body: {
      user: of('user')?.value ?? '',
      // Reported as set-or-not and where from; never as itself. A password read
      // back over HTTP is a password in a shell history and in whatever logs the
      // response.
      password: { set: effective.password !== '', source: of('password')?.source },
      apiKey: { set: effective.apiKey !== '', source: of('apiKey')?.source },
      registry: listKeys(deps.db).map((key) => ({
        id: key.id,
        label: key.label,
        createdAt: key.createdAt,
        revokedAt: key.revokedAt,
      })),
      where: 'the password and the bootstrap key live in the config file or the environment; the registry lives in the meta layer',
    },
  };
}

/**
 * Change who may listen.
 *
 * **This is the verb `config set` refuses to be.** A credential written through
 * a general settings route would be a credential written by accident; here it is
 * the whole subject, and the route is built around the three questions that
 * matter: does the change leave anybody able to get in, is it the environment
 * that has the last word, and has the deployment been told it must be restarted.
 *
 * `POST /user {"rotate": "apiKey"}` generates one and shows it **once** — the
 * only moment it is ever readable through this surface — and writes it into the
 * config file, whose permissions are the deployment's business and which the
 * response names.
 */
async function setUser(deps: AdminDeps, asked: string | null): Promise<Reply> {
  const parsed = parseBody(asked, false);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  const changes: Record<string, string> = {};
  const given = parsed.value;

  for (const key of ['user', 'password', 'apiKey'] as const) {
    const value = given[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value === '') {
      return { status: 400, body: { error: `"${key}" is a value, and an empty one is not one` } };
    }
    changes[key] = value;
  }

  const rotated = given.rotate;
  let revealed: { what: string; value: string } | null = null;

  if (rotated !== undefined) {
    if (rotated !== 'apiKey') {
      return { status: 400, body: { error: '"rotate" is "apiKey" — rotate nothing else, and set the rest' } };
    }
    if (given.apiKey !== undefined) {
      return { status: 400, body: { error: 'give either "apiKey" or "rotate", not both' } };
    }
    const minted = newSecret();
    changes.apiKey = minted;
    revealed = { what: 'apiKey', value: minted };
  }

  if (Object.keys(changes).length === 0) {
    return { status: 400, body: { error: 'nothing to change: user, password, apiKey or rotate' } };
  }

  // **The check this route exists for.** A server with no password and no key
  // does not start at all (`api/server.ts` refuses to build one), so a rotation
  // that removed the last way in would be a change that takes the music down at
  // the next restart — refused now, while the operator is looking at the answer.
  const prospective = { ...readConfigFile(deps.configFile), ...changes };
  const after = loadConfig(deps.env, {}, prospective);
  if (after.password === '' && after.apiKey === '') {
    return {
      status: 409,
      body: {
        error: 'that would leave this server with no way in, and it would not start',
        hint: 'set a password or an apiKey, or unset nothing if the environment is what holds them',
      },
    };
  }

  let written: Setting[];
  try {
    writeConfigFile(deps.configFile, changes);
    written = settingsNow(deps).settings;
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }

  const of = (key: string) => written.find((one) => one.key === key);
  const overridden = Object.keys(changes)
    .map((key) => of(key))
    .filter((one) => one !== undefined && one.source !== 'file')
    .map((one) => ({ key: one?.key, source: one?.source,
      note: 'the environment is set and wins over the file — the rotation will not take effect until it is unset' }));

  return {
    status: 200,
    body: {
      file: deps.configFile,
      changed: Object.keys(changes),
      ...(revealed === null ? {} : { revealed }),
      overridden,
      restartRequired: true,
      restart: 'POST /restart',
      note:
        'the file is now the deployment\'s secret store for these — its permissions are yours to keep, and a copy of it is a copy of a password',
    },
    detail: { changed: Object.keys(changes).map((key) => `${key} set`), overridden: overridden.map((one) => one.key) },
  };
}

/**
 * Liveness on the admin port, which the contract asks for beside `status`.
 *
 * The same check the music port answers (`health.ts`) — the process is up and
 * its meta layer is readable — and it is here because an operator checking a
 * deployment from outside reaches this port first: the music port may be behind
 * a firewall a supervisor is not.
 */
function healthRoute(deps: AdminDeps): Reply {
  const answer = health(deps.db);
  return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> };
}

/** What the library is, in numbers the scanner already wrote down. */
function issuesRoute(deps: AdminDeps, query: URLSearchParams): Reply {
  const params = query;

  const limit = whole(params.get('limit'), 100, 1, 1000);
  if (limit === null) return { status: 400, body: { error: '"limit" is a number from 1 to 1000' } };

  // No severity means all of them: the question this route answers first is
  // "what went wrong", and a filter nobody asked for would answer a narrower one.
  const severity = params.get('severity') ?? undefined;
  return { status: 200, body: issues(deps.db, limit, severity) };
}

function logsRoute(deps: AdminDeps, query: URLSearchParams): Reply {
  const params = query;

  const lines = whole(params.get('lines'), 200, 1, 5000);
  if (lines === null) return { status: 400, body: { error: '"lines" is a number from 1 to 5000' } };

  return { status: 200, body: logs(deps.logFile, deps.dbPath, lines) };
}

/**
 * The classified collection as the CLI dumps it.
 *
 * **The same text, and not a JSON form of it.** `funoteka inventory` exists to be
 * read by a person looking at a library that came out wrong, and a second
 * rendering of it for HTTP would be a second thing to keep in step with the
 * stages — with the difference showing up as an admin API that describes a
 * library nobody has. It is text/plain, and it is as long as the collection is.
 */
function inventoryRoute(deps: AdminDeps): Reply {
  const dump = inventoryDump(deps.db, { dbPath: deps.dbPath });
  return { status: 200, body: { inventory: dump }, text: dump };
}

/**
 * What the filter is keeping out, and the edits a person made by hand.
 *
 * Two lists and not one, because they answer different questions: `hidden` is
 * what a client will not see, and `marks` is what somebody decided. An `allow`
 * on a folder the rule would have hidden keeps nothing out and appears only in
 * the second — and it is exactly the mark an operator needs to find again to
 * take back.
 */
async function markRoute(deps: AdminDeps, asked: string | null): Promise<Reply> {
  const parsed = parseBody(asked, false);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  const { path, verdict, note } = parsed.value;

  // **Both vocabularies, one meaning.** The contract says `junk list/allow/
  // block/remove`; this surface says `verdict: junk|trust`, which is what the
  // database column has always been called. A caller reading the contract and a
  // caller reading `GET /junk` should not have to translate between them, so
  // `block` and `allow` are accepted as the same two verdicts — and the answer
  // says which word it understood.
  const wanted = verdict === 'block' ? 'junk' : verdict === 'allow' ? 'trust' : verdict;

  if (typeof path !== 'string' || path === '') {
    return { status: 400, body: { error: '"path" is required: the folder to decide about' } };
  }
  if (wanted !== 'junk' && wanted !== 'trust') {
    return {
      status: 400,
      body: {
        error: '"verdict" is junk or trust, and the contract’s block or allow mean the same two',
        junk: 'not a record — keep it out of every listing',
        trust: 'a record — serve it, whatever the rule says',
        same: { block: 'junk', allow: 'trust' },
      },
    };
  }
  if (note !== undefined && typeof note !== 'string') {
    return { status: 400, body: { error: '"note" is a sentence, for whoever reads this back' } };
  }

  const where = resolvePath(deps.db, path);
  if (where === undefined) {
    // A path under no root is not an error about the collection: it is a path
    // this server has never heard of, and saying so beats marking something else.
    return { status: 404, body: { error: `no configured root contains that path: ${path}` } };
  }

  try {
    const reason = mark(deps.db, where.rootId, where.relPath, wanted, note ?? null);
    return {
      status: 200,
      body: {
        path,
        verdict: wanted,
        reason,
        hidden: reason !== null,
        note: 'the album was re-derived now — a rescan is not needed for this to take effect',
      },
      detail: { marked: path, verdict: wanted },
    };
  } catch (err) {
    // The store's own sentence: a path with no album under it is a statement
    // about nothing, and the typo has to reach the operator.
    return { status: 400, body: { error: (err as Error).message } };
  }
}

/** Take a hand edit back, and let the rule decide again. */
async function unmarkRoute(deps: AdminDeps, asked: string | null): Promise<Reply> {
  const parsed = parseBody(asked, false);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  const path = parsed.value.path;
  if (typeof path !== 'string' || path === '') {
    return { status: 400, body: { error: '"path" is required: the folder to hand back to the rule' } };
  }

  const where = resolvePath(deps.db, path);
  if (where === undefined) {
    return { status: 404, body: { error: `no configured root contains that path: ${path}` } };
  }

  try {
    const reason = unmark(deps.db, where.rootId, where.relPath);
    return {
      status: 200,
      body: {
        path,
        reason,
        hidden: reason !== null,
        note: 'the rule decides this folder again, as it did before anybody marked it',
      },
      detail: { unmarked: path },
    };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
}

/**
 * Read the collection's `.m3u` files again.
 *
 * **The one stage short enough to run inside a request, and the number is
 * measured rather than argued.** On the live collection — 472 albums, 5054
 * tracks, 27 `.m3u` files — this takes **80 ms**, and 220 ms on the first run of
 * a process, which is the cache being cold. A scan is a process of its own
 * because a walk of that same collection is tens of seconds on the one thread
 * that answers everybody; this reads no audio at all, which is where a scan's
 * time goes, and it did not read even the playlist files: `filesRead: 0` on all
 * three runs, because the stage keeps what each file said (`playlist_source_file`)
 * and only re-reads one that changed.
 *
 * **The limit of that claim, stated rather than implied:** 80 ms of one frozen
 * thread and of the write lock is a hiccup, and a collection with thousands of
 * playlist files instead of 27 is not what this was measured against. If one
 * turns up, this becomes another process, the way the scan is.
 */
function importPlaylists(deps: AdminDeps): Reply {
  const counters = applyPlaylists(deps.db);
  return {
    status: 200,
    body: { ...counters, note: 'a playlist a client made through the API is untouched — this reads the .m3u files on disk' },
    detail: { imported: counters.imported, filesRead: counters.filesRead },
  };
}

/** A query parameter that has to be a whole number inside a range, or nothing. */
function whole(value: string | null, fallback: number, least: number, most: number): number | null {
  if (value === null) return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= least && number <= most ? number : null;
}

/**
 * MCP, on the port that already has the token.
 *
 * **The HTTP transport of the protocol, and it is the same listener as
 * everything else** — same token, same address list, same lockout, same audit.
 * A third port for agents would be a third thing to keep locked, and the door
 * this one opens is the one an operator already watches.
 *
 * The tools are called *in this process*, through the same dispatcher the HTTP
 * routes go through: a tool call is an ordinary admin request with the request
 * left out. That is not a shortcut either — it is the only way the audit, the
 * idempotency record and the refusals can be the same ones, and it is why a
 * tool that changes something appears in the audit file exactly as `curl` does.
 *
 * A notification — `notifications/initialized` — has no answer, and 202 is what
 * this says to one. A client that treated that as a failure would be reading the
 * protocol's own silence as an error.
 */
async function mcpRoute(deps: AdminDeps, asked: string | null, address: string): Promise<Reply> {
  if (asked === null) {
    return { status: 400, body: { error: 'an MCP message is required: one JSON-RPC object' } };
  }

  let message: unknown;
  try {
    message = JSON.parse(asked);
  } catch (err) {
    return { status: 400, body: { error: `the body is not JSON: ${(err as Error).message}` } };
  }

  const inProcess: AdminClient = async (method, path, body, idempotencyKey) => {
    const url = new URL(path, 'http://localhost');
    const key = idempotencyKey ?? '';

    // **The same recall `route` does, for the same reason, and it was missing.**
    // A tool call never reaches `route` — that is the whole point of the design
    // above — and the idempotency check lived only there, so the surface's claim
    // that mutations are idempotent held for callers with `curl` and not for the
    // agents this transport exists for. `funoteka_user_set {"rotate":"apiKey"}`
    // is where it bites: a repeat minted a second key and invalidated the one
    // the first call had returned. Found by a test that asked for one twice.
    if (mutates(method) && key !== '') {
      const seen = recall(deps.db, key, method, url.pathname);

      if (seen.kind === 'conflict') {
        return {
          status: 422,
          body: {
            error: 'this Idempotency-Key was used for a different request',
            was: `${seen.recorded.status}`,
          },
        };
      }

      // No audit line here either, and for the reason `route` gives: nothing
      // happened this time, and a second line saying it did is the record lying
      // about the work.
      if (seen.kind === 'replay') {
        return { status: seen.recorded.status, body: JSON.parse(seen.recorded.body) };
      }
    }

    const reply = await answer(
      deps,
      method,
      url.pathname,
      url.searchParams,
      body === undefined ? null : JSON.stringify(body),
      address,
    );

    // Kept before the answer goes back, and only a success, exactly as `route`
    // keeps it: a record written after the reply is one a crash can lose *after*
    // the caller was told the work was done, and then a retry does it twice.
    if (mutates(method) && key !== '' && reply.status < 400) {
      remember(deps.db, key, method, url.pathname, reply.status, JSON.stringify(reply.body));
    }

    // **A mutation asked for through MCP is written down here, because this is
    // where it happens.** The audit lives in `route`, which a tool call never
    // reaches — so without this, the one claim this whole file makes about MCP
    // ("the same audit line as `curl`") would have been false, and the operator
    // would find out by reading an audit file that was missing an event. Found
    // by the test that asks for one.
    if (reply.status < 400 && reply.detail === undefined) return { status: reply.status, body: reply.body };
    recordMutation(
      deps,
      { method, path: url.pathname, address, status: reply.status, detail: reply.detail },
      true,
    );

    return { status: reply.status, body: reply.body };
  };

  const answered = await handleMessage(inProcess, message);
  if (answered === null) {
    return { status: 202, body: { ok: true, note: 'a notification: nothing to answer' } };
  }

  return { status: 200, body: answered };
}

/**
 * Write a document back, and say what it could not place.
 *
 * The body is the object `GET /export` answers with, sent back — a backup is
 * worth nothing that cannot be read in, and the shape is its own contract. What
 * comes back is a count of what was written and a list of what the library could
 * not answer about: an entry naming a song that is no longer on disk is left
 * out, and left out *loudly*, because a restore that silently dropped a third of
 * a playlist is indistinguishable from one that worked.
 */
async function restoreRoute(deps: AdminDeps, asked: string | null): Promise<Reply> {
  const parsed = parseBody(asked, false, RESTORE_LIMIT);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  if (!isExport(parsed.value)) {
    return {
      status: 400,
      body: {
        error: 'that is not an export document',
        expected: 'the object GET /export answers with — `funoteka: "export"` and a version',
      },
    };
  }

  const { placed, skipped } = restoreState(deps.db, parsed.value);

  return {
    status: 200,
    body: {
      placed,
      note: 'placed, not inserted: these are in place now, whether they were already there or not',
      // A document from a large library can name thousands of songs that have
      // moved since; fifty is what fits in an answer a person reads, and the
      // count of the rest is the part that must not be lost.
      skipped: skipped.slice(0, 50),
      skippedMore: Math.max(0, skipped.length - 50),
      merge: 'what this library already had was left alone',
    },
    detail: { placed },
  };
}

/**
 * How large a restore may be, and why it is not the same number as everything
 * else.
 *
 * Every other route here takes a handful of settings — 64 KB is generous for
 * them, and a body larger than that is a mistake worth refusing. A backup is the
 * opposite: it is as large as the person's own decisions, it arrives in one
 * piece, and there is no smaller way to send it.
 */
const RESTORE_LIMIT = 16 * 1024 * 1024;

/**
 * The scan modes, described rather than merely enumerated.
 *
 * The caller here is as often an agent as a person, and "incremental" alone does
 * not say what it is incremental *about*. What decides is size and mtime, which
 * is a fact about this scanner worth stating where the choice is offered.
 */
function modes(): { name: ScanMode; what: string }[] {
  return [
    {
      name: 'incremental',
      what: 'read what has moved since the last run — a file whose size and modification time are unchanged is left alone',
    },
    {
      name: 'full',
      what: 'read every file again, whether or not it looks unchanged — for when the ledger is the wrong question',
    },
  ];
}

/** Configure a directory as something this deployment reads. */
async function addRootRoute(deps: AdminDeps, asked: string | null): Promise<Reply> {
  const parsed = parseBody(asked, false);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  const path = parsed.value.path;
  if (typeof path !== 'string' || path === '') {
    return { status: 400, body: { error: '"path" is required: the directory to read' } };
  }

  try {
    const { root, already } = addRoot(deps.db, path);
    return {
      status: already ? 200 : 201,
      body: {
        root,
        // A shelf somebody thought they were adding and did not is worth saying
        // so: the alternative is a listing that grew by nothing and an operator
        // wondering whether the call worked.
        already,
        scan: 'POST /scan reads it',
      },
      detail: { added: root.path, already },
    };
  } catch (err) {
    // The store's own sentence, which names the path: a root that is not a
    // directory is the one mistake this route exists to catch while the operator
    // is still looking at the answer.
    return { status: 400, body: { error: (err as Error).message } };
  }
}

/**
 * Stop reading a directory, and take what came from it out of the library.
 *
 * The destructive one, and the answer carries the count for the reason the store
 * does: "removed" and "removed a third of your library" are the same word and
 * not the same event. The files on disk are untouched.
 */
async function removeRootRoute(deps: AdminDeps, asked: string | null): Promise<Reply> {
  const parsed = parseBody(asked, false);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  const path = parsed.value.path;
  if (typeof path !== 'string' || path === '') {
    return { status: 400, body: { error: '"path" is required: the directory to stop reading' } };
  }

  const removed = removeRoot(deps.db, path);
  if (removed === null) {
    return { status: 404, body: { error: `no such root: ${path}` } };
  }

  return {
    status: 200,
    body: {
      removed: removed.root.path,
      songs: removed.songs,
      albums: removed.albums,
      note: 'the files on disk were not touched — this is what the server reads, not what it holds',
    },
    detail: { removed: removed.root.path, songs: removed.songs, albums: removed.albums },
  };
}

/**
 * Start a scan of everything this deployment is configured to read.
 *
 * **202, because the work has not happened yet.** The answer is that a process
 * was started and where to watch it; a caller that waited for a scan would hold
 * a connection open for the length of a walk, and one answered 200 would
 * reasonably read that as "the library has been read".
 */
async function startScan(deps: AdminDeps, asked: string | null): Promise<Reply> {
  const parsed = parseBody(asked, true);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  const roots = listRoots(deps.db);
  if (roots.length === 0) {
    return { status: 409, body: { error: 'no roots are configured — POST /roots adds one' } };
  }

  const wanted = parsed.value.mode ?? 'incremental';
  if (wanted !== 'incremental' && wanted !== 'full') {
    return { status: 400, body: { error: '"mode" is either incremental or full', modes: modes() } };
  }

  const started = deps.scanner.start(wanted);
  if (!started.ok) return { status: 409, body: { error: started.reason } };

  return {
    status: 202,
    body: {
      started: { pid: started.pid, mode: wanted, roots: roots.map((one) => one.path) },
      watch: 'GET /scan',
      cancel: 'POST /scan/cancel',
    },
    detail: { scan: { pid: started.pid, mode: wanted } },
  };
}

/**
 * Stop the scan that is running, or settle the record of one that is not.
 *
 * Two different things wearing one verb, and the answer says which happened: a
 * scan this process started is killed, and a run left `running` by a process
 * that has since gone is written down as cancelled. The second is the way out of
 * a row that would otherwise refuse every later scan — and it is *marked* rather
 * than assumed, because the alternative is a server reporting a scan running for
 * ever.
 */
function cancelScan(deps: AdminDeps): Reply {
  const cancelled = deps.scanner.cancel();
  if (!cancelled.ok) return { status: 409, body: { error: cancelled.reason } };

  if (cancelled.settled !== null) {
    return {
      status: 200,
      body: {
        settledRun: cancelled.settled,
        note: 'that run was not started by this process — it is now recorded as cancelled',
      },
      detail: { settledRun: cancelled.settled },
    };
  }

  return {
    status: 200,
    body: {
      stopping: true,
      note: 'the scan was killed; its run is recorded as cancelled when the process is gone',
    },
    detail: { stopped: true },
  };
}

/** What the last few scans did, newest first. */
function scanHistory(deps: AdminDeps, query: URLSearchParams): Reply {
  const limit = whole(query.get('limit'), 20, 1, 200);
  if (limit === null) return { status: 400, body: { error: '"limit" is a number from 1 to 200' } };

  return { status: 200, body: { runs: deps.scanner.history(limit) } };
}

/**
 * A request body, parsed as the JSON object every mutating route here takes.
 *
 * One parser for all of them, so that "the body must be a JSON object" is one
 * sentence rather than four, and so that a route that takes no body at all says
 * so by asking for an empty one to be allowed rather than by not parsing.
 */
function parseBody(
  text: string | null,
  allowEmpty: boolean,
  cap: number = MAX_BODY,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (text !== null && text.length > cap) {
    return { ok: false, error: `the body is larger than ${cap} bytes` };
  }
  if (text === null) {
    return allowEmpty
      ? { ok: true, value: {} }
      : { ok: false, error: 'a JSON object is required in the body' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `the body is not JSON: ${(err as Error).message}` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'the body must be a JSON object' };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * A restart, which is an exit and a promise that something starts this again.
 *
 * **The promise is checked rather than assumed.** Where nothing supervises this
 * process — a bare `serve --daemon`, a terminal someone left — "restart" can only
 * mean "stop", and a route that answered that with a cheerful 200 would be a
 * control surface that takes the music down when asked to bring it back. So the
 * supervision is stated by whoever provides it (`FUNOTEKA_SUPERVISED=1`: the
 * compose file, the unit, the service wrapper) and a server that was not told is
 * refused, with the name of the setting in the refusal.
 */
function restart(deps: AdminDeps): Reply {
  if (!deps.config.supervised) {
    return {
      status: 409,
      body: {
        error:
          'nothing supervises this process, so a restart would only stop it. Start it under the ' +
          'service wrapper, or set FUNOTEKA_SUPERVISED=1 if something does start it again',
      },
    };
  }

  process.stderr.write('funoteka admin: restarting\n');

  return {
    status: 200,
    body: {
      restarting: true,
      note: 'this process is exiting; whatever supervises it starts it again',
    },
    detail: { restarting: true },
    after: () => deps.onRestart(),
  };
}

/**
 * Whether the caller knows the token.
 *
 * **Compared through `sameSecret`, which is the comparison this server already
 * makes for a password** — hashed on both sides, so the time it takes says
 * nothing about how nearly the guess matched or how long the token is. A second
 * copy of that reasoning living here would be a second copy to get wrong the
 * next time it is touched, and the primitive is not the interesting part of this
 * file.
 *
 * `Bearer` is the only accepted spelling. A token in a query string would end up
 * in a log line, and every log line is a file somebody copies around.
 */
function authorised(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? '';
  const given = /^Bearer[ \t]+(.+)$/iu.exec(header.trim())?.[1]?.trim();
  if (given === undefined || given === '' || token === '') return false;

  return sameSecret(given, token);
}

/**
 * Where the request came from, as far as it can be trusted.
 *
 * The socket's own address, unless a proxy has been declared: behind one, every
 * request arrives from the proxy and an address list would be a list of the
 * proxy. `trustProxy` is a statement about the deployment — that the port is
 * reachable *only* through that proxy — and it is off by default for exactly
 * that reason: the header is written by the caller, so believing it on a port
 * that can be reached directly means anyone can claim any address.
 *
 * The *last* entry of the forwarded chain is the one taken. A proxy appends the
 * address it saw to whatever the client sent, so the last is the one the nearest
 * trusted hop observed; taking the first would be reading a value the client
 * chose.
 */
function clientAddress(request: IncomingMessage, config: AdminConfig): string {
  const direct = request.socket.remoteAddress ?? '';
  if (!config.trustProxy) return direct;

  const forwarded = request.headers['x-forwarded-for'];
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  return chain.at(-1) ?? direct;
}

/** The body of a request, or null when it is missing or larger than any setting could be. */
const MAX_BODY = 64 * 1024;

async function read(request: IncomingMessage, cap: number = MAX_BODY): Promise<string | null> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    length += buffer.length;
    if (length > cap) {
      request.destroy();
      return null;
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? null : text;
}

/** Whether a method is one that changes something, and so is worth a record. */
function mutates(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/**
 * Write the record of a mutation, or of a refusal — the one rule, in one place.
 *
 * It was written twice: once for a request that arrived over the wire and once
 * for a tool call MCP makes inside this process, and the two had to be kept in
 * step by hand. A mutation with nothing to say about itself — a `restart`, whose
 * `detail` is its own line in the log — is still recorded, as a refusal is: what
 * a route has to say is not what makes it an event.
 */
function recordMutation(
  deps: AdminDeps,
  entry: {
    method: string;
    path: string;
    address: string;
    status: number;
    detail?: Record<string, unknown>;
  },
  /** Only the in-process path has nothing of its own to say. */
  whenSilent = false,
): void {
  if (entry.detail === undefined && !whenSilent) return;
  record(deps, { ...entry, detail: entry.detail ?? { refused: entry.status >= 400 } });
}

/** Write the record of a mutation, or of a refusal that got as far as the gate. */
function record(
  deps: AdminDeps,
  entry: { method: string; path: string; address: string; status: number; detail?: Record<string, unknown> },
): void {
  deps.audit({ at: new Date().toISOString(), ...entry });
}

/**
 * The answer, as it goes on the wire.
 *
 * `no-store` on every one of them: a cached answer about a server's own state is
 * an answer about the state it was in, and a proxy that replayed one would tell
 * the next caller what the previous one did.
 */
function send(response: ServerResponse, reply: Reply, headers: Record<string, string> = {}): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  const text = reply.text ?? `${JSON.stringify(reply.body)}\n`;
  response.writeHead(reply.status, {
    'content-type':
      reply.text === undefined ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(text);
}
