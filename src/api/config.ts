import { dirname, join } from 'node:path';

import type { FileValues } from './config-file.ts';
import { DEFAULT_DB } from '../db/index.ts';
import type { Schedule } from '../scan/schedule.ts';
import { SECRET_SETTINGS, SETTINGS, isPort } from './settings.ts';

/**
 * What the server needs to know before it can answer anything.
 *
 * A deployed server is configured by its environment, because that is how a
 * service manager hands over a database path and a port — and because a password
 * in an environment variable is not readable from the process list the way one
 * in an argument is. The flags `serve` takes are the same fields for the times
 * the server is run by hand, and they win, being the more specific request.
 *
 * **Four layers, in this order: defaults, then the config file, then the
 * environment, then a flag.** The file is the one a person edits and the
 * environment is the one a service manager sets, so the later layer is always
 * the more specific request — and a file that could override an environment
 * variable would make a deployed unit's settings unreadable from the machine,
 * which is where anyone debugging them is standing.
 *
 * Flags and environment arrive as strings and this is where they become a
 * config, so there is one place that decides what a field means and one place
 * that can refuse a value that is not one.
 */
export interface ServerConfig {
  /**
   * The meta layer to open.
   *
   * Two writers, and they own different halves: the scanner writes the
   * classified model, and the API writes the listener's own rows — playlists,
   * and whatever else is a statement rather than a reading (`playlist/store.ts`).
   * Nothing else in the API writes.
   */
  dbPath: string;
  host: string;
  port: number;
  /** Empty means no credentials were given. Refusing to serve without them is auth's business. */
  user: string;
  password: string;
  /** The OpenSubsonic key, for a client that would rather not hold the password. */
  apiKey: string;
  /**
   * The binary that cuts segments out of an MP4 container.
   *
   * A path rather than a flag of its own, so that a machine with ffmpeg
   * somewhere unusual can say where — and so the absent case is reachable in a
   * test, which is the only way the degradation is ever exercised.
   */
  ffmpeg: string;
  /**
   * Where the answers ffmpeg produces are kept.
   *
   * A re-encoded song is a file of a known length, which is what makes it
   * seekable at all — so the answer has to live somewhere between requests.
   * Beside the meta layer, because that is where this deployment's own data
   * lives and the question "where is the disk going" should have one answer;
   * configurable, because a machine with a small system disk will want it
   * elsewhere. How long anything stays is `stream/recode.ts`'s to say.
   */
  cacheDir: string;
  /**
   * Whether to say, on stderr, which method each request asked for.
   *
   * Off by default because a server that logs every request is noisy, and on
   * when a client is being made to work: the first question about a phone that
   * will not sync is *which call failed*, and a server that answers it with
   * silence leaves nothing to go on. The path is logged, and so is the query —
   * masked, because a client spells its password there (`api/server.ts`,
   * `askedOf`), and because a line that does not say what was asked cannot
   * answer the question this setting exists for.
   */
  logRequests: boolean;
  /**
   * Whether a page served from somewhere else may call this API.
   *
   * On by default, because the browser clients this server is meant to be used
   * from are pages: a web player is loaded from its own site and calls the
   * server from there, and without these headers the browser refuses before the
   * request is made. Off is for a server whose owner would rather nothing else
   * in a browser could talk to it — it costs the web clients and nothing else.
   */
  cors: boolean;
  /**
   * Whether a listing offers what the scanner marked as not a record.
   *
   * Off by default, which is the contract: junk is hidden from the default view
   * and a switch shows it (requirements:47 §11). On is for the operator checking
   * the filter's work, and for the one client that is being used to look at the
   * folders rather than at the music. `visibility.ts` owns the reading; a
   * request may also ask for one answer with `showJunk`.
   */
  showJunk: boolean;
  /**
   * A file this process appends its own output to, or nothing for none.
   *
   * Absent is the ordinary deployment: a service manager that starts this server
   * collects its stdout and stderr itself — Docker's log driver, systemd's
   * journal, the Windows service wrapper's own file — and a second copy written
   * by the server would be a file nobody asked for. Set is for the deployments
   * whose supervisor collects nothing, where the alternative to this is no log
   * at all: a NAS running the binary by hand, a bare `serve --daemon` on a
   * machine whose terminal is gone.
   *
   * (The daemon writes `<db>.log` by redirecting, which is the same promise
   * through a different mechanism — see `cli/daemon.ts`. Both is a duplicated
   * log rather than a broken one, and neither is a setting the other reads.)
   */
  logFile: string;
}

/**
 * What the admin listener needs, which is deliberately not what the API does.
 *
 * Two surfaces with two sets of rules: the API is read by clients and answers
 * about the collection, and this is written by whoever operates the server and
 * answers about the server itself. It listens on its own port, so an operator
 * can firewall it, expose it, or point a proxy with TLS at it without touching
 * the port a phone plays music from.
 *
 * **Its whole gate is one token, and no token means no listener.** That is not a
 * hardening step that could be left for later: a control surface that exists
 * before it is guarded is a server that can be commanded by anyone who finds the
 * port, and the difference between "off" and "on" has to be a thing the operator
 * did on purpose.
 */
export interface AdminConfig {
  port: number;
  host: string;
  /** Empty means the admin surface does not exist. See above. */
  token: string;
  /**
   * The addresses that may reach this port at all, or empty for every address.
   *
   * Comma-separated, and each entry an address or a CIDR block (`10.0.0.0/8`,
   * `::1`). It is a *second* lock rather than the gate: the token is what proves
   * who is calling, and this is what keeps the port from being knocked at by a
   * machine that has no business knocking — the difference between a control
   * surface behind a VPN and one on the open internet with a good password.
   */
  allow: string;
  /**
   * Whether `X-Forwarded-For` may be believed when deciding `allow`.
   *
   * Off by default, and it has to be: the header is written by the caller, so
   * believing it on a port that is directly reachable means anyone can claim any
   * address and walk through the allowlist. On is for a deployment where a proxy
   * is the only way in, and then it is a statement about that proxy.
   */
  trustProxy: boolean;
  /**
   * The certificate and key to serve TLS with, or nothing for plain HTTP.
   *
   * Both files are read at startup; a path that cannot be read stops the server
   * with the path in the sentence. The alternative — terminating TLS at a
   * proxy — is a deployment choice and not a weaker one, and it is documented
   * beside this, in `DEPLOY.md`.
   */
  tls: { cert: string; key: string } | null;
  /**
   * Whether something is going to start this process again after it exits.
   *
   * Stated by whoever supervises it rather than guessed at from the process
   * tree: the deployment paths are a compose file, a unit and a service wrapper,
   * and each of them can say so in one line. It is what `POST /restart` reads —
   * a restart is "exit, and be brought back", and where nothing brings the
   * process back the honest answer is a refusal, not a server that stops.
   */
  supervised: boolean;
}

/**
 * When this server reads the disk by itself.
 *
 * Its own object rather than four more fields on `ServerConfig`, because it is
 * not what the API needs in order to answer anybody: it is what the daemon does
 * when nobody is asking. The two are read the same way and reported together —
 * one config file, one vocabulary — and they are not the same thing.
 */
export interface ScanConfig extends Schedule {
  /** Whether to watch the roots for changes instead of waiting for the interval. */
  watch: boolean;
}

/**
 * The scan schedule, layered exactly as everything else is.
 *
 * `scanInterval` is in **minutes** and defaults to six hours. Zero — or anything
 * below it — turns the timer off: a deployment that would rather scan from a
 * cron job of its own says so with a number, and needs no second setting to say
 * it with.
 */
export function loadScanConfig(env: NodeJS.ProcessEnv, file: FileValues = {}): ScanConfig {
  return scanConfig(reader(file, env));
}

function scanConfig(r: Reader): ScanConfig {
  const interval = r.pick('scanInterval', 'FUNOTEKA_SCAN_INTERVAL');
  const from = r.pick('scanQuietFrom', 'FUNOTEKA_SCAN_QUIET_FROM');
  const to = r.pick('scanQuietTo', 'FUNOTEKA_SCAN_QUIET_TO');

  return {
    intervalMinutes: interval === undefined ? DEFAULT_SCAN_INTERVAL_MINUTES : wholeNumber(interval),
    quietFrom: from === undefined ? DEFAULT_QUIET_FROM : hour(from),
    quietTo: to === undefined ? DEFAULT_QUIET_TO : hour(to),
    watch: offUnlessOn(r.pick('scanWatch', 'FUNOTEKA_SCAN_WATCH')?.value, false),
  };
}

/** A number from whichever layer named it, or a refusal naming that layer. */
function wholeNumber(picked: Picked): number {
  const value = Number(picked.value);
  if (!Number.isInteger(value)) {
    throw new Error(`${picked.source} is not a whole number: ${String(picked.value)}`);
  }
  return value;
}

/** An hour of the day, 0–23, or a refusal saying which setting was wrong. */
function hour(picked: Picked): number {
  const value = wholeNumber(picked);
  if (value < 0 || value > 23) {
    throw new Error(`${picked.source} is not an hour of the day (0-23): ${value}`);
  }
  return value;
}

/**
 * What was asked for, as the strings it was asked in.
 *
 * Both sources are strings, so both are parsed here rather than at their call
 * sites — otherwise each flag would need its own check, and a value that came
 * from the environment would get none.
 */
export interface ConfigOverrides {
  dbPath?: string;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  apiKey?: string;
  ffmpeg?: string;
  cacheDir?: string;
}

/**
 * Subsonic's own port, so a client that guesses one guesses right, and above
 * 1024 so the server does not need privileges it has no other use for.
 */
export const DEFAULT_PORT = 4533;

/**
 * The admin port: the Subsonic port plus one, because two ports that differ by
 * one are one number to remember instead of two, and 4534 is not a port anything
 * else claims.
 */
export const DEFAULT_ADMIN_PORT = 4534;

/** Reachable from the phone on the sofa, which is the whole point of the server. */
export const DEFAULT_HOST = '0.0.0.0';

/** Six hours: often enough that a change is noticed the same day, rarely enough to be quiet. */
export const DEFAULT_SCAN_INTERVAL_MINUTES = 360;

/**
 * The quiet hours: three in the morning to six.
 *
 * The hours a house is asleep in, and the reason they exist is that a scan is
 * audible — it reads every file, and on a machine that is also somebody's
 * desktop it is the difference between a library that keeps up and a library
 * that stutters while they are working. `from === to` is no quiet hours at all.
 */
export const DEFAULT_QUIET_FROM = 3;
export const DEFAULT_QUIET_TO = 6;

/** Where to look for ffmpeg, which only the m4a and MP4 segments ever need. */
export const DEFAULT_FFMPEG = 'ffmpeg';

/**
 * A setting, as the layer that set it and the value it gave.
 *
 * The source is carried out of here rather than reconstructed later, because the
 * refusal for a bad value has to name the place it came from: "FUNOTEKA_PORT is
 * not a port number" and "--port is not a port number" send their readers to two
 * different files, and a server that said only "not a port number" would leave
 * them looking in both.
 */
interface Picked {
  value: string | number | boolean;
  source: string;
}

/** Which layer a setting was read from, in the order the layers are asked. */
export type Source = 'default' | 'file' | 'environment' | 'flag';

/**
 * The four layers, as one object that remembers which of them answered.
 *
 * One reader for the whole order, so that "the environment wins over the file"
 * is a fact about this function rather than a rule each field remembers to keep.
 * A layer that is *present* wins, even when it is empty — that is what an
 * operator who wrote `FUNOTEKA_USER=` means, and reading it as "unset" would
 * give them the file's credentials instead.
 *
 * The sources are recorded rather than reconstructed, and that is not
 * bookkeeping. `config set` has to say whether the value it just wrote is the
 * value in force, and the answer is a fact about which layer answered — an
 * environment variable holding the same value as the file would make any
 * comparison of *values* report the wrong one, and the operator would be told
 * their change had taken effect when the next restart would ignore it.
 */
interface Reader {
  pick(key: string, envName: string, flag?: string, flagName?: string): Picked | undefined;
  readonly sources: Record<string, Source>;
}

function reader(file: FileValues, env: NodeJS.ProcessEnv): Reader {
  const sources: Record<string, Source> = {};

  return {
    sources,
    pick(key, envName, flag, flagName) {
      if (flag !== undefined) {
        sources[key] = 'flag';
        return { value: flag, source: flagName ?? key };
      }
      const fromEnv = env[envName];
      if (fromEnv !== undefined) {
        sources[key] = 'environment';
        return { value: fromEnv, source: envName };
      }
      const fromFile = file[key];
      if (fromFile !== undefined) {
        sources[key] = 'file';
        return { value: fromFile, source: key };
      }
      return undefined;
    },
  };
}

function serverConfig(r: Reader, overrides: ConfigOverrides): ServerConfig {
  const dbPath = String(r.pick('dbPath', 'FUNOTEKA_DB', overrides.dbPath, '--db')?.value ?? DEFAULT_DB);

  // Named together so the refusal below can say which of the three was wrong:
  // the operator who mistyped a flag, the one who mistyped a unit file, and the
  // one who mistyped the config file are looking in different places.
  const port = r.pick('port', 'FUNOTEKA_PORT', overrides.port, '--port');

  return {
    dbPath,
    host: String(r.pick('host', 'FUNOTEKA_HOST', overrides.host, '--host')?.value ?? DEFAULT_HOST),
    port:
      port === undefined || port.value === ''
        ? DEFAULT_PORT
        : parsePort(String(port.value), port.source),
    user: String(r.pick('user', 'FUNOTEKA_USER', overrides.user, '--user')?.value ?? ''),
    password: String(
      r.pick('password', 'FUNOTEKA_PASSWORD', overrides.password, '--password')?.value ?? '',
    ),
    apiKey: String(r.pick('apiKey', 'FUNOTEKA_APIKEY', overrides.apiKey, '--apikey')?.value ?? ''),
    ffmpeg: String(
      r.pick('ffmpeg', 'FUNOTEKA_FFMPEG', overrides.ffmpeg, '--ffmpeg')?.value ?? DEFAULT_FFMPEG,
    ),
    cacheDir: String(
      r.pick('cacheDir', 'FUNOTEKA_CACHE', overrides.cacheDir, '--cache')?.value ??
        join(dirname(dbPath), 'cache'),
    ),
    logFile: String(r.pick('logFile', 'FUNOTEKA_LOG_FILE')?.value ?? ''),
    logRequests: offUnlessOn(r.pick('logRequests', 'FUNOTEKA_LOG_REQUESTS')?.value, false),
    cors: onUnlessOff(r.pick('cors', 'FUNOTEKA_CORS')?.value, true),
    showJunk: offUnlessOn(r.pick('showJunk', 'FUNOTEKA_SHOW_JUNK')?.value, false),
  };
}

function adminConfig(r: Reader): AdminConfig {
  const port = r.pick('adminPort', 'FUNOTEKA_ADMIN_PORT');
  const cert = String(r.pick('adminTlsCert', 'FUNOTEKA_ADMIN_TLS_CERT')?.value ?? '');
  const key = String(r.pick('adminTlsKey', 'FUNOTEKA_ADMIN_TLS_KEY')?.value ?? '');
  const token = String(r.pick('adminToken', 'FUNOTEKA_ADMIN_TOKEN')?.value ?? '');

  // Both or neither. Half a TLS is not a weaker TLS — it is a server that would
  // have to decide whether to answer in plaintext somebody who asked for a
  // certificate, and there is no answer to that which is not a surprise.
  if ((cert === '') !== (key === '')) {
    const missing = cert === '' ? 'FUNOTEKA_ADMIN_TLS_CERT' : 'FUNOTEKA_ADMIN_TLS_KEY';
    throw new Error(`${missing} is not set, and TLS needs both the certificate and its key`);
  }

  return {
    port:
      port === undefined || port.value === ''
        ? DEFAULT_ADMIN_PORT
        : parsePort(String(port.value), port.source),
    host: String(r.pick('adminHost', 'FUNOTEKA_ADMIN_HOST')?.value ?? DEFAULT_HOST),
    // A template is not a secret — see `unexpanded`, and read the empty one the
    // same way, because the contract's answer to "no token" is a surface that is
    // off rather than a surface that is open.
    token: unexpanded(token) ? '' : token,
    allow: String(r.pick('adminAllow', 'FUNOTEKA_ADMIN_ALLOW')?.value ?? ''),
    trustProxy: offUnlessOn(r.pick('adminTrustProxy', 'FUNOTEKA_ADMIN_TRUST_PROXY')?.value, false),
    tls: cert === '' ? null : { cert, key },
    supervised: onUnlessOff(r.pick('supervised', 'FUNOTEKA_SUPERVISED')?.value, false),
  };
}

/**
 * A setting and the layer it came from, for the admin API's `config` route.
 *
 * The value of a secret is `null` and the fact that it was set is not — the
 * operator needs to know *that* a password is configured and *where* from, and
 * handing the password back over HTTP would put it in a shell history, a
 * response log and whatever proxy is in front, which is a worse answer to the
 * same question.
 */
export interface Setting {
  key: string;
  value: string | number | boolean | null;
  source: Source;
  secret: boolean;
}

/**
 * Every setting, in force and where from.
 *
 * This is what makes `config set` honest. The route reads the file, writes it,
 * and then answers with this: what the file now says, what is actually in force,
 * and which of the two the operator is looking at. A value written to the file
 * that an environment variable overrides is a change that will not survive a
 * restart either, and saying so is the whole difference between a control
 * surface that works and one that only appears to.
 */
export function configReport(
  env: NodeJS.ProcessEnv,
  overrides: ConfigOverrides = {},
  file: FileValues = {},
): Setting[] {
  const r = reader(file, env);
  const server = serverConfig(r, overrides);
  const admin = adminConfig(r);
  const scan = scanConfig(r);

  // Spelled out rather than spread from the two objects: the field names of a
  // config are not the names of its settings (`admin.token` is `adminToken`),
  // and a list a reader can check against `settings.ts` at a glance is worth
  // more here than the lines it saves. A setting missing from it is caught by
  // the test that walks the vocabulary.
  const values: Record<string, string | number | boolean> = {
    dbPath: server.dbPath,
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
    apiKey: server.apiKey,
    ffmpeg: server.ffmpeg,
    cacheDir: server.cacheDir,
    logFile: server.logFile,
    logRequests: server.logRequests,
    cors: server.cors,
    showJunk: server.showJunk,
    adminPort: admin.port,
    adminHost: admin.host,
    adminToken: admin.token,
    adminAllow: admin.allow,
    adminTrustProxy: admin.trustProxy,
    adminTlsCert: admin.tls?.cert ?? '',
    adminTlsKey: admin.tls?.key ?? '',
    supervised: admin.supervised,
    scanInterval: scan.intervalMinutes,
    scanQuietFrom: scan.quietFrom,
    scanQuietTo: scan.quietTo,
    scanWatch: scan.watch,
  };

  return Object.keys(SETTINGS).map((key) => ({
    key,
    value: SECRET_SETTINGS.has(key) ? null : (values[key] ?? null),
    source: r.sources[key] ?? 'default',
    secret: SECRET_SETTINGS.has(key),
  }));
}

/** Whether a setting that is on unless it was turned off was turned off. */
function isOff(value: string | undefined): boolean {
  return value !== undefined && ['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

/**
 * Whether a setting was turned on.
 *
 * Absent is off, and so is anything that reads as a no — an operator who writes
 * `FUNOTEKA_LOG_REQUESTS=0` means off, and one who writes `=1` means on. Any
 * other value is taken as on, because a variable that was set at all was set on
 * purpose and refusing to understand it would turn a working server into a
 * silent one.
 */
function isOn(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

/**
 * A setting that is off unless it was turned on, from whichever layer set it.
 *
 * The file gives a real boolean and the environment gives a word, and both are
 * read here — a file is JSON, so `"logRequests": true` is a boolean and there is
 * no reason to make its author write `"1"`.
 */
function offUnlessOn(value: string | number | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return isOn(String(value));
}

/** The same, for a setting that is on unless it was turned off. */
function onUnlessOff(value: string | number | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return !isOff(String(value));
}

/**
 * A value that is still a `${...}` placeholder was never expanded.
 *
 * **Nothing in this file's layering expands anything**, which is what makes the
 * question worth asking: expansion belongs to whatever wraps the process, and
 * the wrappers differ. Claude Code expands `${VAR}` in an `.mcp.json` — and,
 * when the variable is *not* set, passes the text through untouched, so the
 * literal `${FUNOTEKA_ADMIN_TOKEN}` arrives as the token. A template is not a
 * value somebody chose; it is a value somebody meant to substitute, and both
 * readings of it as a secret are bad. As the server's token it is a *published*
 * string that anyone could present; as a client's it is a wrong-token attempt,
 * and ten of those lock the address out for fifteen minutes. Reading it as no
 * token at all is the only safe one, and it is the reading the contract already
 * has for a token nobody set.
 *
 * A `$` and a `{` that are not adjacent are ordinary characters in a secret, so
 * only `$` immediately followed by `{` counts.
 */
export function unexpanded(value: string): boolean {
  return value.includes('${');
}

/**
 * The whole config, for a server about to listen.
 *
 * The two functions below are the same reading with different questions asked of
 * it — `configReport` wants to know where each value came from as well as what
 * it is — so the layering itself lives once, in `reader`, and each caller is a
 * line.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  overrides: ConfigOverrides = {},
  file: FileValues = {},
): ServerConfig {
  return serverConfig(reader(file, env), overrides);
}

/** What the admin listener is configured by, layered exactly as above. */
export function loadAdminConfig(env: NodeJS.ProcessEnv, file: FileValues = {}): AdminConfig {
  return adminConfig(reader(file, env));
}

/**
 * A port number, or a throw naming what could not be read as one.
 *
 * The range is the one a socket accepts, and 0 is inside it: it asks the kernel
 * to pick a free port, which is what a test wants and what `serve` reports back
 * as the port it actually bound.
 */
export function parsePort(value: string, source: string): number {
  const port = Number(value);
  if (!isPort(port)) {
    throw new Error(`${source} is not a port number: ${value}`);
  }
  return port;
}
