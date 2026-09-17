#!/usr/bin/env node
import type { Server } from 'node:http';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from './api/server.ts';
import { createAdminServer } from './api/admin.ts';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  loadAdminConfig,
  loadConfig,
  loadScanConfig,
  unexpanded,
  type AdminConfig,
  type ScanConfig,
  type ServerConfig,
} from './api/config.ts';
import {
  configFilePath,
  DEFAULT_CONFIG_FILE,
  readConfigFile,
  type FileValues,
} from './api/config-file.ts';
import { auditLog, auditPath } from './api/audit.ts';
import { logToFile } from './api/log-file.ts';
import { adminClient } from './mcp/client.ts';
import { serveStdio } from './mcp/server.ts';
import { rescan } from './api/rescan.ts';
import { listRoots } from './api/roots.ts';
import { scanner } from './api/scanner.ts';
import { resolveCommand } from './cli/args.ts';
import { claim, logPath, logSize, release, running, start, stop } from './cli/daemon.ts';
import { addKey, addedKey, reportKeys, revokedKey, revokeKey } from './cli/keys.ts';
import { openDb, type DatabaseSync } from './db/index.ts';
import { inventory } from './inventory/inventory.ts';
import { hidden, mark, resolvePath } from './junk/marks.ts';
import { runStages, type RunSummary } from './run.ts';

const USAGE = `funoteka — smart music library

Usage:
  funoteka scan <root...> [--full] [--db <path>]
  funoteka inventory [--db <path>]
  funoteka junk [list] [--db <path>]
  funoteka junk block|allow <path> [--note <text>] [--db <path>]
  funoteka keys [list]
  funoteka keys add|revoke <label|#id> [--db <path>]
  funoteka serve [--daemon] [--db <path>] [--host <address>] [--port <number>]
  funoteka stop [--db <path>]
  funoteka status [--db <path>]
  funoteka mcp [--url <http://host:port>]

Commands:
  scan          Read the given roots into the meta layer
  inventory     Print the classified collection as a readable dump
  junk          What the junk filter is keeping out, and the edit that overrides it
  keys          The API keys this server accepts, and taking one back
  serve         Answer the Subsonic API from the meta layer
  stop          Stop the server running on that meta layer
  status        Say whether one is running, and where
  mcp           Speak MCP on stdin/stdout, driving this server's admin API

Options:
  --db <path>   SQLite meta layer (default: FUNOTEKA_DB, then the config file,
                then funoteka.db beside the working directory)
  --full        Read every file again, whether or not it has changed. The
                ordinary scan trusts size and mtime, which is what makes a
                rescan of an unchanged library cost seconds; this is the answer
                for when that trust is the wrong question.
  --note <text> Why a folder was blocked or allowed. Kept with the mark, for the
                person who finds it in a dump six months later. junk only.
  --host <addr> Address to listen on (default: ${DEFAULT_HOST})
  --port <n>    Port to listen on (default: ${DEFAULT_PORT}, 0 to let the kernel choose)
  --daemon      Run in the background, outliving this shell. The server writes
                \`<db>.pid\` beside the meta layer and logs to \`<db>.log\`;
                stop and status find it through that file.
  -h, --help    Show this help

Environment:
  FUNOTEKA_DB, FUNOTEKA_HOST, FUNOTEKA_PORT, FUNOTEKA_USER, FUNOTEKA_PASSWORD,
  FUNOTEKA_APIKEY configure a deployed server; a flag on the command line wins.
  Credentials are environment-only: an argument is readable from the process
  list, which is not where a password belongs.

  FUNOTEKA_FFMPEG names the binary that cuts a cue track out of an MP4
  container. Only those tracks need it: without it the server still serves
  whole files, FLAC and mp3 segments, browsing and search, and refuses the
  MP4 ones with a reason.

  FUNOTEKA_LOG_FILE appends this process's own output to a file, for the
  deployments whose supervisor collects nothing. Unset means the log is
  whatever started the server — Docker, systemd, a service wrapper, a shell.

  FUNOTEKA_ADMIN_TOKEN turns on the admin surface: a second port
  (FUNOTEKA_ADMIN_PORT, default 4534) that takes POST /restart with the token
  as \`Authorization: Bearer …\`. With no token there is no admin listener at
  all. FUNOTEKA_SUPERVISED=1 says something will start this process again,
  which is what makes a restart a restart rather than a stop.

Config file:
  FUNOTEKA_CONFIG names a JSON file of the same settings (default
  ${DEFAULT_CONFIG_FILE}, in the directory the server runs in). The four layers
  are read in order — defaults, file, environment, flags — so the environment
  still wins over the file. \`funoteka.json.example\` lists every key. A file
  that cannot be read, or that names a key the server does not know, stops the
  command with a sentence naming it: a server that came up on its defaults
  beside a file it could not read looks exactly like one that was configured.
`;

/**
 * What the junk filter is keeping out, one folder to a line.
 *
 * The reason and the source both, because a count cannot tell a rule that
 * overreached from a person who marked something. An empty answer says so in
 * words rather than printing nothing: "nothing is hidden" and "this is not the
 * database you meant" look the same on a blank terminal.
 */
function reportJunk(rows: readonly { rootPath: string; relPath: string; title: string | null; junkReason: string; source: string }[]): string {
  if (rows.length === 0) return 'nothing is hidden.\n';
  const lines = rows.map(
    (row) =>
      `  ${row.source === 'hand' ? '*' : ' '} ${row.rootPath}/${row.relPath === '' ? '' : row.relPath}` +
      `  —  ${row.title ?? '(untitled)'}  (${row.junkReason})`,
  );
  return [
    `${rows.length} hidden (${rows.filter((row) => row.source === 'hand').length} by hand, marked *):`,
    ...lines,
    '',
  ].join('\n');
}

/** Parenthesised detail, or nothing at all when there is no detail to give. */
function aside(parts: (string | false)[]): string {
  const kept = parts.filter((part): part is string => part !== false && part !== '');
  return kept.length === 0 ? '' : `  (${kept.join(', ')})`;
}

/** Human-readable summary of a scan. The machine-readable form is the database. */
function report(summary: RunSummary, dbPath: string): void {
  const { scan: counters, classify: classified, tags, cues, playlists, artists, search } = summary;

  // The roots as recorded, not as typed: two spellings of one directory are one
  // root, and a report that said otherwise would be the bug it is reporting on.
  const roots = counters.rootPaths;

  const breakdown = Object.entries(counters.byKind)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(', ');

  const shapes = Object.entries(cues.byShape)
    .filter(([, n]) => n > 0)
    .map(([shape, n]) => `${shape} ${n}`)
    .join(', ');

  process.stdout.write(
    [
      `Scanned ${roots.length} root${roots.length === 1 ? '' : 's'} into ${dbPath} (run ${counters.scanRunId})`,
      // What each root gave, on the root's own line. A root that contributed
      // nothing is the reason: an empty directory and a path misspelled print
      // the same otherwise, and the run still exits 0 (task:2756).
      ...counters.perRoot.map(
        (root) =>
          `  root    ${root.path}${aside([
            `${root.folders} folders`,
            `${root.files} files`,
            root.files === 0 && 'nothing here — an empty directory and a mistyped path read alike',
          ])}`,
      ),
      // The ignored directories are the folders that are deliberately *not*
      // counted, which is why they belong beside the count they are missing
      // from rather than in a line of their own.
      `  folders ${counters.folders}${aside([
        counters.ignored > 0 &&
          `ignored ${counters.ignored} dir(s), ${counters.ignoredAudio} audio file(s)`,
      ])}`,
      `  files   ${counters.files}${aside([
        breakdown,
        counters.unchanged > 0 && `unchanged ${counters.unchanged}`,
      ])}`,
      `  albums  ${classified.albums}${aside([classified.releases > 0 && `releases ${classified.releases}`])}`,
      `  tags    ${tags.tags}${aside([
        `${tags.files} files read`,
        tags.sidecars > 0 && `sidecars ${tags.sidecars}`,
        tags.durations > 0 && `durations ${tags.durations}`,
        tags.encodings > 0 && `${tags.encodings} encodings guessed`,
      ])}`,
      `  tracks  ${cues.tracks}${aside([
        shapes,
        cues.probesReused > 0 && `probes reused ${cues.probesReused}`,
      ])}`,
      // The playlist files the collection carries, said in the two numbers that
      // matter: how many were lists of their own and how many were the folder
      // they sit in. A run that imports nothing is the ordinary run — this
      // collection has 27 playlist files and every one of them is its album.
      `  lists   ${playlists.imported} imported${aside([
        `${playlists.files} file(s) taken up`,
        playlists.filesRead > 0 && `${playlists.filesRead} read`,
        playlists.redundant > 0 && `${playlists.redundant} redundant`,
        playlists.entriesMissing > 0 && `${playlists.entriesMissing} entries unmatched`,
      ])}`,
      // The ambiguity counts belong to the artists, not to the albums they are
      // reported beside — and they are said apart, because a name merged from
      // two spellings and a name split across two folders are different
      // findings that want different answers from whoever reads the report.
      `  artists ${artists.artists}${aside([
        artists.linked > 0 && `albums linked ${artists.linked}`,
        artists.ambiguous > 0 && `${artists.ambiguous} ambiguous`,
        artists.homonyms > 0 && `${artists.homonyms} split by folder`,
      ])}`,
      // The index is a copy of what the stages above settled, so its size is the
      // one number that says the search a client is about to make will answer
      // about this collection and not an older one.
      `  search  ${search.rows} row${search.rows === 1 ? '' : 's'}`,
      `  issues  ${counters.issues + tags.issues + cues.issues + playlists.issues + artists.issues}`,
      '',
    ].join('\n'),
  );
}

/**
 * Open the meta layer, run one command against it, and close it whatever
 * happens. Both commands want the same guarantee, and differ only in the verb
 * they name when it goes wrong.
 */
function withDb(dbPath: string, command: string, work: (db: DatabaseSync) => void): void {
  const db = openDb(dbPath);
  try {
    work(db);
  } catch (err) {
    process.stderr.write(`${command} failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

/**
 * What this process exits with when it has been asked to restart.
 *
 * `EX_TEMPFAIL` from BSD's `sysexits.h`: "a temporary failure… the user is
 * invited to retry". It is the one code that means what a restart means, and it
 * exists because a Windows service wrapper restarts on failure and would read a
 * clean 0 as somebody having stopped the service on purpose.
 */
const RESTART_EXIT = 75;

/**
 * The config file, read once and before anything is decided.
 *
 * Once, because every command below resolves its settings through it and two
 * reads of one file are two chances to disagree about it. Before anything,
 * because **a file that cannot be read stops the command**. A scan that ran on
 * defaults beside a config file it could not parse would write a second database
 * next to the one the file named, and nothing about that looks like a failure
 * until somebody goes looking for their library.
 *
 * Read here rather than inside `loadConfig`, so that the parser stays a pure
 * function of a path and a string — and so that this is the one place that has
 * to decide what to do about a file.
 */
const settingsPath = configFilePath(process.env);

let settingsFile: FileValues;
try {
  settingsFile = readConfigFile(settingsPath);
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(2);
}

const invocation = resolveCommand(process.argv.slice(2));

switch (invocation.kind) {
  case 'help':
    process.stdout.write(USAGE);
    break;

  case 'error':
    process.stderr.write(`${invocation.message}\n\n${USAGE}`);
    process.exitCode = invocation.code;
    break;

  case 'inventory':
    withDb(dbPathOf(invocation.dbPath), 'inventory', (db) => {
      // **The resolved path, not the flag.** `resolveCommand` stopped defaulting
      // the database path (task:2934), so passing what the flag said prints a
      // heading with no path on every ordinary run — the two other callers of
      // `report` pass the resolved one.
      process.stdout.write(inventory(db, { dbPath: dbPathOf(invocation.dbPath) }));
    });
    break;

  case 'keys':
    withDb(dbPathOf(invocation.dbPath), 'keys', (db) => {
      // The environment's key is read from the environment and not from a
      // loaded config: `keys list` is a question about the registry, and it
      // should answer on a machine where the server's other settings are not
      // set at all — the whole point of a listing is to be readable when
      // something is wrong.
      const environmentKey = process.env.FUNOTEKA_APIKEY ?? '';

      if (invocation.action === 'list') {
        process.stdout.write(reportKeys(db, environmentKey));
        return;
      }
      if (invocation.action === 'add') {
        process.stdout.write(addedKey(addKey(db, invocation.what ?? '')));
        return;
      }
      process.stdout.write(revokedKey(revokeKey(db, invocation.what ?? '')));
    });
    break;

  case 'junk':
    withDb(dbPathOf(invocation.dbPath), 'junk', (db) => {
      if (invocation.action === 'list') {
        process.stdout.write(reportJunk(hidden(db)));
        return;
      }

      const where = resolvePath(db, invocation.path ?? '');
      if (where === undefined) {
        throw new Error(`no configured root contains that path: ${invocation.path}`);
      }

      const verdict = invocation.action === 'block' ? 'junk' : 'trust';
      const reason = mark(db, where.rootId, where.relPath, verdict, invocation.note ?? null);
      const named = where.relPath === '' ? '(the root itself)' : where.relPath;

      // Said as what the folder now *is*, not as what was written: the two come
      // from the same rule, and the sentence a person reads back should be the
      // one the listings are keeping it out by.
      process.stdout.write(
        reason === null
          ? `${named}: a record — it will be listed.\n`
          : `${named}: not a record — hidden (${reason}).\n`,
      );
    });
    break;

  case 'scan':
    withDb(dbPathOf(invocation.dbPath), 'scan', (db) => {
      // The scanner's connection is not the daemon's, and the two want opposite
      // things from the same two settings. Both come down to the same fact:
      // **this process answers nobody**. A wait here holds up no client, so the
      // scan may take the time a batch job is allowed to take — and the daemon,
      // which holds the other connection and serves every request on one thread,
      // may not (`db/index.ts` explains its own two numbers).
      //
      // **The wait.** `busy_timeout` is 250 ms by default, chosen so a client
      // waiting on a lock cannot freeze the server. Here it was survivable while
      // a scan was one transaction; it is not survivable now that a scan yields
      // the lock often enough for clients to actually write during one — and
      // every stage's transaction became a chance to lose that race. Measured
      // on the live collection with a client saving through the API every 40 ms:
      // the run died in the **tags** stage with `database is locked`. Ten
      // seconds rides out any burst of saves a person can make; a lock still
      // held after that is not a race, and failing is the right answer to it.
      //
      // **The flush.** `synchronous = NORMAL` gives up a disk flush per commit.
      // Almost everything the scanner writes is derived from the filesystem, so
      // the worst a power cut costs there is the last few commits — which is
      // what the next scan rebuilds. The exceptions are `scan_run` and `issue`,
      // which are records of a run rather than readings of a disk: losing the
      // commit that carries `finish('ok')` leaves the run looking `running`, and
      // `getScanStatus` would report a scan that had already ended. The next run
      // settles it, and that is the whole of what this setting can cost here.
      // The API's rows are the other kind entirely — a playlist is nowhere on
      // disk — which is why the daemon's connection keeps the default. In WAL
      // mode `NORMAL` is safe from corruption; what it gives up is durability
      // against a hard reboot.
      //
      // **Not a footnote to the batching — it is what pays for it.** Releasing
      // the write lock often (`scan.ts`) turned one commit into thirty, and each
      // commit is a disk flush. Measured on the live collection, same run, same
      // content: **2263 ms with the default against 1486 ms with this** on a
      // quiet machine, and **17.4 s against 5.2 s** on a busy one. A flush is
      // cheap until the disk is shared, and then it is the whole cost of the run.
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec('PRAGMA synchronous = NORMAL');

      // The chain itself lives in `run.ts`, together with the rule that settles
      // the run's status: it is the whole run's to settle, not a stage's.
      report(
        runStages(db, invocation.roots, { full: invocation.full }),
        dbPathOf(invocation.dbPath),
      );
    });
    break;

  case 'serve': {
    let config: ServerConfig;
    let admin: AdminConfig;
    let scan: ScanConfig;
    try {
      config = loadConfig(
        process.env,
        {
          dbPath: invocation.dbPath,
          host: invocation.host,
          port: invocation.port,
        },
        settingsFile,
      );
      admin = loadAdminConfig(process.env, settingsFile);
      scan = loadScanConfig(process.env, settingsFile);
    } catch (err) {
      // A flag that could not be read is the operator misusing the command, not
      // the server failing, so it exits the way every other usage error does.
      process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
      process.exitCode = 2;
      break;
    }

    if (!invocation.daemon) {
      serve(config, admin, scan);
      break;
    }

    // The child's arguments are built from the resolved config and never from
    // this process's own — which contain `--daemon`, and a child that daemonized
    // itself again would spawn a third, and so on.
    void start(config.dbPath, [
      '--db',
      config.dbPath,
      '--host',
      config.host,
      '--port',
      String(config.port),
    ]).then((started) => {
      if (started.ok) {
        process.stdout.write(
          `funoteka started, pid ${started.record?.pid} on http://${config.host}:${started.record?.port}/rest\n` +
            `  log   ${logPath(config.dbPath)}\n` +
            `  stop  funoteka stop --db ${config.dbPath}\n`,
        );
        return;
      }
      process.stderr.write(`serve --daemon: ${started.message}\n`);
      process.exitCode = 2;
    });
    break;
  }

  case 'mcp': {
    // The token comes from the same two places the server reads it from — the
    // environment, then the config file — so an agent started on the machine
    // that serves the music needs no arguments at all beyond the address.
    const admin = loadAdminConfig(process.env, settingsFile);
    if (admin.token === '') {
      // **Two ways to have no token, and the second one is worth naming.** A
      // `${...}` that nothing expanded is not an empty setting — it is a
      // setting somebody made, and the difference matters to whoever is reading
      // this: sending it would be a wrong-token attempt against a surface that
      // locks the address out after ten of them.
      const raw = String(process.env.FUNOTEKA_ADMIN_TOKEN ?? settingsFile.adminToken ?? '');
      process.stderr.write(
        unexpanded(raw)
          ? 'mcp: FUNOTEKA_ADMIN_TOKEN is still a ${...} placeholder — nothing expanded it. ' +
              'Set the variable, or send the token itself: a reference is not a token, and the ' +
              'admin surface counts a wrong one toward a lockout.\n'
          : 'mcp: no admin token — set FUNOTEKA_ADMIN_TOKEN, or put adminToken in the config file\n',
      );
      process.exitCode = 2;
      break;
    }

    // `127.0.0.1` and not the admin host: the host is what the *server* bound
    // (0.0.0.0 on a deployment), and that is not an address a client can call.
    const url = invocation.url ?? process.env.FUNOTEKA_ADMIN_URL ?? `http://127.0.0.1:${admin.port}`;

    // Never resolves: this process lives as long as the agent keeps its end of
    // the pipe open, which is what the transport is.
    void serveStdio(adminClient(url, admin.token));
    break;
  }

  case 'stop': {
    void stop(dbPathOf(invocation.dbPath)).then((stopped) => {
      process.stdout.write(`funoteka: ${stopped.message}\n`);
      if (!stopped.ok) process.exitCode = 1;
    });
    break;
  }

  case 'status': {
    const dbPath = dbPathOf(invocation.dbPath);
    const record = running(dbPath);
    if (record === null) {
      process.stdout.write(`funoteka: not running (${dbPath})\n`);
      process.exitCode = 1;
      break;
    }
    process.stdout.write(
      `funoteka: pid ${record.pid} on http://${record.host}:${record.port}/rest\n` +
        // Only when there is one: a line saying "admin —" would read as a
        // surface that is broken rather than one that was never turned on.
        (record.adminPort === undefined
          ? ''
          : `  admin     http://${record.host}:${record.adminPort}\n`) +
        `  database  ${record.dbPath}\n` +
        `  since     ${record.startedAt}\n` +
        `  log       ${logPath(dbPath)} (${logSize(dbPath)} bytes)\n`,
    );
    break;
  }
}

/**
 * Which meta layer this invocation is about.
 *
 * Resolved through the same config a server is — all four layers of it — so that
 * a daemon started with `FUNOTEKA_DB` set, or with a database named in its
 * config file, is the one `stop` finds. The alternative is a stop command that
 * only works when the operator remembers to repeat what the file already says.
 */
function dbPathOf(fromFlag: string | undefined): string {
  return loadConfig(process.env, { dbPath: fromFlag }, settingsFile).dbPath;
}

/**
 * Open the meta layer and answer on it until the process is stopped.
 *
 * The database stays open for the life of the server rather than being opened
 * per request: the same connection is what the WAL setting on it is for, and it
 * is what lets a scan write while a client is being answered.
 *
 * The address reported is the one the socket took, not the one that was asked
 * for — they differ when the port was left to the kernel, and a report that
 * echoed the request would name a port nothing is listening on.
 */
function serve(config: ServerConfig, admin: AdminConfig, scan: ScanConfig): void {
  // Before the meta layer is opened, so that a database that cannot be opened is
  // a line in the file rather than a complaint on a terminal that is gone.
  const stopLog = config.logFile === '' ? () => {} : logToFile(config.logFile);

  const db = openDb(config.dbPath);

  try {
    listen(db, config, admin, scan, stopLog);
  } catch (err) {
    // A server that could not be built must not leave its database open behind
    // it, and the reason has to reach the operator as a sentence rather than as
    // a stack trace from somewhere inside the constructor.
    db.close();
    stopLog();
    process.stderr.write(`serve failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

function listen(
  db: DatabaseSync,
  config: ServerConfig,
  admin: AdminConfig,
  scan: ScanConfig,
  stopLog: () => void,
): void {
  const api = createServer(db, config);
  // One scanner, two callers: the admin API's `POST /scan` and the timer below.
  // The same object, so `GET /scan` reports the scan the engine started and the
  // engine sees the one an operator started — two scanners would be two answers
  // to "is a scan running", and `start` would refuse across them for ever.
  const scans = scanner({
    db,
    roots: () => listRoots(db).map((one) => one.path),
    command: (mode) => ({
      file: process.execPath,
      args: [
        // The entry point as *this* build spells it: `.ts` in the repository,
        // where Node strips the types itself, and `.js` in the compiled build
        // the npm package ships — Node refuses to strip types from anything
        // under `node_modules`, so a name hard-coded to `.ts` would work here
        // and fail there, which is the one place the difference is invisible
        // until somebody runs it.
        fileURLToPath(new URL(`./cli${extname(import.meta.filename)}`, import.meta.url)),
        'scan',
        ...listRoots(db).map((one) => one.path),
        '--db',
        config.dbPath,
        ...(mode === 'full' ? ['--full'] : []),
      ],
    }),
  });

  const control = createAdminServer({
    db,
    config: admin,
    dbPath: config.dbPath,
    configFile: settingsPath,
    env: process.env,
    audit: auditLog(auditPath(config.dbPath)),
    logFile: config.logFile,
    scanner: scans,
    onRestart: () => shutdown('restart'),
  });

  if (control === null) {
    // Said plainly, because the port being closed is the whole of what keeps the
    // admin surface off — and an operator who set no token should not have to
    // discover that by having a connection refused.
    process.stderr.write('funoteka: admin surface off — no FUNOTEKA_ADMIN_TOKEN\n');
  }

  // The server reading the disk by itself. Started after the listeners are
  // built and stopped with them: a scan it starts outlives this process (it is a
  // process of its own), and what stopping means here is that no *new* one is
  // asked for.
  const engine = rescan({
    db,
    scanner: scans,
    roots: () => listRoots(db).map((one) => one.path),
    schedule: scan,
    watch: scan.watch,
    log: (line) => process.stdout.write(`${line}\n`),
  });

  const listeners: Server[] = control === null ? [api] : [api, control];

  // Two listeners, one shutdown between them, because a process left
  // half-listening is neither stopped nor serving. `POST /restart` calls this
  // same function — having first answered the caller, which is the whole reason
  // it is reachable from here at all.
  let stopping = false;
  const shutdown = (reason: string): void => {
    if (stopping) {
      process.exit(0);
      return;
    }
    stopping = true;

    process.stdout.write(`funoteka stopping (${reason})\n`);
    for (const listener of listeners) {
      // A connection still open would hold the process here for as long as the
      // client keeps it, and a server that will not stop is worse than one that
      // stops mid-answer.
      listener.close();
      listener.closeAllConnections?.();
    }
    engine.stop();
    release(config.dbPath);
    stopLog();
    db.close();

    // **The exit code is how a restart reaches a supervisor.** Docker's
    // `restart: unless-stopped` and systemd's `Restart=always` bring the process
    // back whatever it exited with, but a Windows service wrapper restarts on
    // *failure* — so a restart that exited 0 would be read as a deliberate stop
    // and the service would simply be gone. `EX_TEMPFAIL` is the conventional
    // code for "this ended and wants to be run again", and a supervisor that
    // only restarts on failure now has the same behaviour as the other two.
    //
    // Set as `exitCode` rather than exited with, because the ordinary path here
    // is that the process ends by itself the moment the loop drains — an
    // explicit `process.exit` would be a race against that.
    process.exitCode = reason === 'restart' ? RESTART_EXIT : reason === 'failed' ? 1 : 0;

    // The backstop for the path that is not ordinary: a socket in a state that
    // will not let go, where a supervisor waiting for this process to exit would
    // otherwise wait for ever.
    setTimeout(() => process.exit(process.exitCode ?? 0), 3_000).unref();
  };

  api.on('error', (err) => {
    process.stderr.write(`serve failed: ${err.message}\n`);
    shutdown('failed');
  });

  if (control !== null) {
    // The admin port is refused rather than worked around: it is how this server
    // is operated, and one that came up without it would be a server whose
    // controls silently did not exist. It is one setting to change, and the
    // message names it.
    control.on('error', (err) => {
      process.stderr.write(
        `funoteka: the admin port ${admin.port} could not be opened (${err.message}) — ` +
          'FUNOTEKA_ADMIN_PORT names it, and FUNOTEKA_ADMIN_TOKEN being empty turns it off\n',
      );
      shutdown('failed');
    });
  }

  // Both, before the claim: the pid file is a promise that this server is
  // reachable, and half a server is not what `stop` and `status` are told about.
  // **The same callback goes to both listeners**, and that is the whole of the
  // mechanism — a counter, because the report below is about a server rather
  // than about a socket. A listener handed no callback is a listener whose
  // arrival nobody counts, and the failure that produces is silent: both ports
  // answer, and the claim the two commands find the server by is never written.
  let waiting = listeners.length;
  const bothUp = (): void => {
    waiting -= 1;
    if (waiting > 0) return;

    {
      const address = api.address();
      const where = typeof address === 'object' && address !== null ? address.port : config.port;
      const controlAddress = control?.address();
      const controlPort =
        typeof controlAddress === 'object' && controlAddress !== null ? controlAddress.port : undefined;

      // The claim is written here and not before, because this is the first
      // moment at which it is true: a pid file written by a process that failed
      // to bind names a server nobody can reach, and would refuse the next start.
      claim(config.dbPath, {
        pid: process.pid,
        port: where,
        host: config.host,
        dbPath: config.dbPath,
        startedAt: new Date().toISOString(),
        ...(controlPort === undefined ? {} : { adminPort: controlPort }),
      });

      process.stdout.write(
        `funoteka serving ${config.dbPath} on http://${config.host}:${where}/rest\n` +
          (controlPort === undefined ? '' : `  admin  http://${admin.host}:${controlPort}\n`) +
          (config.logFile === '' ? '' : `  log    ${config.logFile}\n`),
      );
    }
  };

  api.listen(config.port, config.host, bothUp);
  control?.listen(admin.port, admin.host, bothUp);

  // A signal stops the server rather than killing it: the sockets are closed, the
  // meta layer closed with it, and the claim removed, so a `stop` on a machine
  // whose signals are delivered is a clean shutdown rather than a process that
  // disappeared. A second signal does not wait — whoever sent it twice means it.
  //
  // Said plainly because it is not universal: on Windows a signal has no handler
  // to reach, so `stop` there ends the process outright. That is safe rather
  // than lucky — the meta layer is SQLite in WAL mode, which is built to survive
  // a writer that stops mid-write — and the claim is checked rather than
  // believed, so a stopped server is never mistaken for a running one.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
