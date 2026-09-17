import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  configFilePath,
  readConfigFile,
  writeConfigFile,
  DEFAULT_CONFIG_FILE,
} from '../src/api/config-file.ts';
import { configReport, loadAdminConfig, loadConfig, unexpanded } from '../src/api/config.ts';
import { SETTINGS } from '../src/api/settings.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The config file, tested at its two seams: what it makes of a file, and what a
 * config made of that file becomes.
 *
 * Everything here goes through a real file rather than a fake reader, because
 * the whole of what this module does is read one — a stubbed filesystem would be
 * a test of the stub, and the failures this is here to catch (a typo'd key
 * ignored in silence, a broken file treated as an absent one) are failures of
 * the reading.
 */

/** A config file with exactly this text, in a directory of its own. */
function written(text: string): string {
  const path = join(tempRoot('funoteka-config-'), 'funoteka.json');
  writeFileSync(path, text);
  return path;
}

test('a server nobody gave a config file is a server told nothing', () => {
  // The ordinary case, and it must not be an error: every deployment that names
  // its settings in the environment has no file at all.
  assert.deepEqual(readConfigFile(join(tempRoot('funoteka-config-'), 'funoteka.json')), {});
  assert.equal(configFilePath({}), DEFAULT_CONFIG_FILE);
  assert.equal(configFilePath({ FUNOTEKA_CONFIG: '/etc/funoteka.json' }), '/etc/funoteka.json');
});

test('a key the server does not know is refused, and the refusal names it', () => {
  // **The failure this exists for.** A file is a place where a misspelling is
  // invisible: `"prot": 4533` reads as a setting to whoever wrote it, and a
  // server that ignored it would come up on the port they were trying to move
  // it off, with nothing anywhere saying why. So the unknown key is a refusal
  // and it names itself.
  const path = written('{"prot": 4533}\n');

  assert.throws(() => readConfigFile(path), /unknown key "prot"/);
  assert.throws(() => readConfigFile(path), /port/, 'and points at the key it looks like');
  assert.throws(() => readConfigFile(written('{"musickFolder": "/m"}\n')), /unknown key "musickFolder"/);
});

test('a value of the wrong shape is refused, and the refusal says which', () => {
  // JSON has types, so a quoted number is a person who forgot them rather than
  // a syntax the reader should guess at. The message says what was expected and
  // what was found, because those two are the whole of the fix.
  assert.throws(() => readConfigFile(written('{"port": "4533"}\n')), /"port".*number.*string/s);
  assert.throws(() => readConfigFile(written('{"logRequests": "yes"}\n')), /"logRequests".*true or false/s);
  assert.throws(() => readConfigFile(written('{"dbPath": 7}\n')), /"dbPath".*string/s);
});

test('a port in the file that is not a port is refused, and the file is what is named', () => {
  // The range is the socket's, and it is checked while reading the file rather
  // than later: an operator who wrote `70000` should be told about the file they
  // wrote it in, not about a flag they never used.
  assert.throws(() => readConfigFile(written('{"port": 70000}\n')), /"port" is not a port number/);
  assert.throws(() => readConfigFile(written('{"adminPort": -1}\n')), /"adminPort" is not a port number/);
});

test('a file that is not JSON is refused with the reason, not silently skipped', () => {
  // A server that came up on its defaults beside a config file it could not read
  // is the worst shape of this bug: everything works, nothing is configured, and
  // the file that was supposed to say so is right there saying nothing.
  assert.throws(() => readConfigFile(written('{ port: 4533 }\n')), /funoteka\.json is not JSON/);
  assert.throws(() => readConfigFile(written('[4533]\n')), /must be an object/);
  assert.throws(() => readConfigFile(written('null\n')), /must be an object/);
});

test('the file configures a server, and the environment still wins', () => {
  // The layering, in one test because it is one rule: what the file says is the
  // server's settings, and anything said later — the environment, then a flag —
  // is a more specific request than a file that sits there for every run.
  const file = readConfigFile(
    written(
      JSON.stringify({
        dbPath: '/srv/funoteka/meta.db',
        host: '127.0.0.1',
        port: 8080,
        user: 'from-file',
        apiKey: 'k-from-file',
        logRequests: true,
      }),
    ),
  );

  const fromFile = loadConfig({}, {}, file);
  assert.equal(fromFile.dbPath, '/srv/funoteka/meta.db');
  assert.equal(fromFile.port, 8080);
  assert.equal(fromFile.user, 'from-file');
  // Beside the meta layer the *file* named, and not beside the default one: the
  // answer to "where is the disk going" stays one directory.
  assert.equal(fromFile.cacheDir, join('/srv/funoteka', 'cache'));
  assert.equal(fromFile.logRequests, true, 'a boolean in the file is a boolean');

  const fromEnv = loadConfig({ FUNOTEKA_PORT: '9090', FUNOTEKA_USER: 'from-env' }, {}, file);
  assert.equal(fromEnv.port, 9090);
  assert.equal(fromEnv.user, 'from-env');
  assert.equal(
    fromEnv.dbPath,
    '/srv/funoteka/meta.db',
    'and the file keeps what the environment did not say',
  );

  const fromFlag = loadConfig({ FUNOTEKA_PORT: '9090' }, { port: '7000' }, file);
  assert.equal(fromFlag.port, 7000);
});

test('a file may say why, in the usual way of saying why in JSON', () => {
  // JSON has no comments and a config file is read by a person, so `//` and `#`
  // are accepted and ignored. This is not the "unknown key" rule being relaxed —
  // those two names are *known*, and known to mean nothing.
  //
  // It is also what makes `funoteka.json.example` copy-safe: an example that
  // explained itself with a key the reader refused would fail on the first run
  // of whoever copied it.
  const config = loadConfig(
    {},
    {},
    readConfigFile(
      written('{"//": "just a note", "#": ["and another"], "port": 8080}\n'),
    ),
  );

  assert.equal(config.port, 8080);
});

test('a file that names no database still leaves the default one', () => {
  const config = loadConfig({}, {}, readConfigFile(written('{"cors": false}\n')));

  assert.equal(config.dbPath, 'funoteka.db');
  assert.equal(config.port, 4533);
  assert.equal(config.cors, false);
});

test('the admin surface is off until it is given a token', () => {
  // **The rule the whole admin port rests on.** This server's control surface is
  // not something to expose because it was left on by default: with no token
  // there is no listener, and the port is not open at all. A token is what turns
  // it on — and the token itself is the only thing the listener authenticates,
  // which is why an empty one cannot be allowed to mean "everyone".
  const off = loadAdminConfig({}, {});
  assert.equal(off.token, '');
  assert.equal(off.port, 4534, 'the port it would take, said even while it is off');

  const fromEnv = loadAdminConfig({ FUNOTEKA_ADMIN_TOKEN: 's3cret' }, {});
  assert.equal(fromEnv.token, 's3cret');
  assert.equal(fromEnv.host, '0.0.0.0', 'reachable, because that is what an admin port is for');

  const fromFile = loadAdminConfig({}, { adminToken: 'from-file', adminPort: 4535 });
  assert.equal(fromFile.token, 'from-file');
  assert.equal(fromFile.port, 4535);

  // The environment keeps the last word here as everywhere: a token in a unit
  // file is the deployed one, and a token left in the config file must not be
  // what actually guards the port.
  assert.equal(loadAdminConfig({ FUNOTEKA_ADMIN_TOKEN: 'env' }, { adminToken: 'file' }).token, 'env');
});

test('a token that is still a ${...} placeholder is not a token', () => {
  // **The layering has no expansion of its own**, and one of the harnesses that
  // wraps it — Claude Code, over `.mcp.json` — expands `${VAR}` only when the
  // variable is set and passes the text through untouched when it is not. So a
  // template can reach here, and a template is the one value that must never be
  // taken for a secret: as the server's token it is a *published* string that
  // anyone could present, and as a client's it is a wrong-token attempt, ten of
  // which lock the address out. Off is the only safe reading, and it is the
  // reading the contract already has for a token nobody set.
  for (const raw of [
    '${FUNOTEKA_ADMIN_TOKEN}',
    '${FUNOTEKA_ADMIN_TOKEN:-none}',
    'prefix-${FUNOTEKA_ADMIN_TOKEN}',
  ]) {
    assert.equal(
      loadAdminConfig({ FUNOTEKA_ADMIN_TOKEN: raw }, {}).token,
      '',
      `unexpanded template is not a token: ${raw}`,
    );
    assert.equal(loadAdminConfig({}, { adminToken: raw }).token, '', `nor from the file: ${raw}`);
  }

  // And a token nobody wrote as a template is still a token: `$` and braces on
  // their own are ordinary characters in a secret.
  const plain = loadAdminConfig({ FUNOTEKA_ADMIN_TOKEN: '$2b$10$abcdefghijklmnop' }, {});
  assert.equal(plain.token, '$2b$10$abcdefghijklmnop');

  assert.equal(unexpanded('${X}'), true);
  assert.equal(unexpanded('a${X}b'), true);
  assert.equal(unexpanded('$2b$10$abc'), false);
  assert.equal(unexpanded('{X}'), false);
});

test('nothing is expected to bring the process back unless something says so', () => {
  // `/restart` is "close and exit, the supervisor brings it back", and that is
  // only a restart where there *is* a supervisor. So it is stated rather than
  // guessed at: the compose file, the unit and the service wrapper each say it,
  // and a bare `serve --daemon` says nothing and is not restarted.
  assert.equal(loadAdminConfig({}, {}).supervised, false);
  assert.equal(loadAdminConfig({ FUNOTEKA_SUPERVISED: '1' }, {}).supervised, true);
  assert.equal(loadAdminConfig({ FUNOTEKA_SUPERVISED: 'off' }, {}).supervised, false);
  assert.equal(loadAdminConfig({}, { supervised: true }).supervised, true);
});

test('the report says what is in force and which layer said so', () => {
  // What makes `config set` honest: the route has to tell the operator whether
  // the value it just wrote is the value in force, and that is a fact about
  // layers rather than about values — an environment variable holding the same
  // value as the file would make any comparison of values report the wrong one.
  const report = configReport({ FUNOTEKA_HOST: '127.0.0.1' }, {}, readConfigFile(written('{"port": 8080}\n')));
  const setting = (key: string) => report.find((one) => one.key === key);

  assert.equal(setting('port')?.value, 8080);
  assert.equal(setting('port')?.source, 'file');
  assert.equal(setting('host')?.source, 'environment');
  assert.equal(setting('dbPath')?.source, 'default', 'and something nothing named is the default');
  assert.equal(setting('dbPath')?.value, 'funoteka.db');

  const flagged = configReport({ FUNOTEKA_PORT: '8080' }, { port: '9090' });
  assert.equal(flagged.find((one) => one.key === 'port')?.source, 'flag');
  assert.equal(flagged.find((one) => one.key === 'port')?.value, 9090);
});

test('a secret is reported as set without being handed back', () => {
  // An operator needs to know *that* a token is configured and *where* from.
  // Handing it back over HTTP would put it in a shell history, in whatever logs
  // the response, and in the proxy in front — a worse answer to the same
  // question, and one that outlives the session that asked.
  const report = configReport({ FUNOTEKA_ADMIN_TOKEN: 's3cret' });
  const token = report.find((one) => one.key === 'adminToken');

  assert.equal(token?.value, null);
  assert.equal(token?.secret, true);
  assert.equal(token?.source, 'environment');
});

test('every setting the vocabulary knows is reported, and none of them is blank', () => {
  // The list inside `configReport` is written out by hand against `settings.ts`,
  // and a setting missing from it would be reported as `null` — an operator told
  // their ffmpeg path is unset when it is right there. This walks the vocabulary
  // instead of the list, which is the only way that stays true as one grows.
  const report = configReport({});

  assert.deepEqual(
    report.map((one) => one.key).sort(),
    Object.keys(SETTINGS).sort(),
    'the report covers the vocabulary',
  );
  assert.deepEqual(
    report.filter((one) => !one.secret && one.value === null),
    [],
    'and nothing but a secret comes back with no value at all',
  );
});

test('writing a setting keeps the file a person wrote', () => {
  // **The file is read as it is and written back with only these keys changed.**
  // Rebuilding it from the config would drop the comment, reorder the keys, and
  // lose any key this server does not know — which is exactly the note the next
  // person to open the file needed.
  const path = written('{\n  "//": "why this box exists",\n  "port": 8080,\n  "user": "demo"\n}\n');

  const after = writeConfigFile(path, { port: 9090 });

  assert.equal(after.port, 9090);
  assert.equal(after.user, 'demo', 'and what was not written is still there');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /why this box exists/);
  assert.deepEqual(Object.keys(JSON.parse(text)), ['//', 'port', 'user'], 'the order it was in');
});

test('a setting can be written into a file that was not there', () => {
  // How a deployment stops being environment-only. The file is created by the
  // first `config set`, and the key that was not mentioned is not invented.
  const path = join(tempRoot('funoteka-config-'), 'funoteka.json');

  const after = writeConfigFile(path, { port: 9090, adminPort: 9091 });

  assert.deepEqual(after, { port: 9090, adminPort: 9091 });
  assert.equal(readConfigFile(path).port, 9090, 'and it reads back');
});

test('null takes a key back out, which is how a setting is handed back its default', () => {
  const path = written('{"port": 8080, "user": "demo"}\n');

  const after = writeConfigFile(path, { port: null });

  assert.deepEqual(after, { user: 'demo' });
  assert.equal(loadConfig({}, {}, after).port, 4533, 'so the default is what answers again');
});

test('writing refuses what reading refuses, and leaves the file alone', () => {
  // The same vocabulary, one door: a value that could not be read back must not
  // be writable, or the next start is the one that finds out.
  const path = written('{"port": 8080}\n');

  assert.throws(() => writeConfigFile(path, { prot: 1 }), /unknown key "prot"/);
  assert.throws(() => writeConfigFile(path, { port: '8080' }), /must be a number/);
  assert.throws(() => writeConfigFile(path, { port: 70000 }), /is not a port number/);
  assert.equal(readFileSync(path, 'utf8'), '{"port": 8080}\n', 'nothing was written');
});

test('a file that cannot be written says which file', () => {
  assert.throws(
    () => writeConfigFile(join(tempRoot('funoteka-config-'), 'no', 'such', 'dir', 'funoteka.json'), { port: 1 }),
    /could not be written/,
  );
});

test('the log file is wherever it was told, and nowhere when it was not', () => {
  // Absent means the process keeps writing to its own stdout and stderr, which is
  // what a supervisor that redirects for it — Docker, systemd, the service
  // wrapper — already wants. Set means this server writes a file of its own, for
  // the deployments whose supervisor collects nothing.
  assert.equal(loadConfig({}, {}, {}).logFile, '');
  assert.equal(
    loadConfig({ FUNOTEKA_LOG_FILE: '/var/log/funoteka.log' }, {}, {}).logFile,
    '/var/log/funoteka.log',
  );
  assert.equal(loadConfig({}, {}, { logFile: '/srv/funoteka.log' }).logFile, '/srv/funoteka.log');
});
