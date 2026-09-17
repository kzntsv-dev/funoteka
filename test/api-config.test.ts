import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';

import { DEFAULT_HOST, DEFAULT_PORT, loadConfig, parsePort } from '../src/api/config.ts';

test('the request log is off unless it was asked for', () => {
  // Off by default: a server that narrates every request is noise, and the one
  // that matters is the log of a server somebody is trying to make a phone talk
  // to. Anything that reads as "no" is off, so `=0` does what it says.
  assert.equal(loadConfig({}).logRequests, false);
  assert.equal(loadConfig({ FUNOTEKA_LOG_REQUESTS: '' }).logRequests, false);
  assert.equal(loadConfig({ FUNOTEKA_LOG_REQUESTS: '0' }).logRequests, false);
  assert.equal(loadConfig({ FUNOTEKA_LOG_REQUESTS: 'off' }).logRequests, false);
  assert.equal(loadConfig({ FUNOTEKA_LOG_REQUESTS: '1' }).logRequests, true);
  assert.equal(loadConfig({ FUNOTEKA_LOG_REQUESTS: 'yes' }).logRequests, true);
});

test('a server told nothing reads the default database on the standard port', () => {
  const config = loadConfig({});

  assert.equal(config.dbPath, 'funoteka.db');
  assert.equal(config.host, DEFAULT_HOST);
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.port, 4533, "Subsonic's own port, so a client's default guess lands");
  assert.equal(config.password, '', 'and nothing to let anyone in with');
  assert.equal(config.apiKey, '');
  // The re-encoded answers live beside the meta layer unless told otherwise, so
  // a deployment has one directory it knows about and not two.
  assert.equal(config.cacheDir, join(dirname(config.dbPath), 'cache'), 'beside the meta layer');
});

test('the environment configures a deployed server', () => {
  // Deployment hands a service its settings as environment, so these names are
  // the unit file's interface and not an implementation detail.
  const config = loadConfig({
    FUNOTEKA_DB: '/var/lib/funoteka/meta.db',
    FUNOTEKA_HOST: '127.0.0.1',
    FUNOTEKA_PORT: '8080',
    FUNOTEKA_USER: 'demo',
    FUNOTEKA_PASSWORD: 'sesame',
    FUNOTEKA_APIKEY: 'k-1234',
    FUNOTEKA_FFMPEG: '/opt/ffmpeg/bin/ffmpeg',
    FUNOTEKA_CACHE: '/var/cache/funoteka',
  });

  assert.deepEqual(config, {
    dbPath: '/var/lib/funoteka/meta.db',
    host: '127.0.0.1',
    port: 8080,
    user: 'demo',
    password: 'sesame',
    apiKey: 'k-1234',
    cacheDir: '/var/cache/funoteka',
    ffmpeg: '/opt/ffmpeg/bin/ffmpeg',
    // No file unless one was named: what a supervisor that redirects for this
    // process already collects (task:2934).
    logFile: '',
    logRequests: false,
    cors: true,
    // Hidden by default, which is the contract: junk is out of the default view
    // and the switch shows it (requirements:47 §11).
    showJunk: false,
  });
});

test('the junk switch is off unless it was asked for', () => {
  assert.equal(loadConfig({}).showJunk, false, 'the contract hides junk by default');
  assert.equal(loadConfig({ FUNOTEKA_SHOW_JUNK: '1' }).showJunk, true);
  // The reading every other on/off setting here keeps: a value that says no is a
  // no, and any other value was set on purpose.
  assert.equal(loadConfig({ FUNOTEKA_SHOW_JUNK: 'off' }).showJunk, false);
  assert.equal(loadConfig({ FUNOTEKA_SHOW_JUNK: 'yes' }).showJunk, true);
});

test('a flag wins over the environment', () => {
  // Running the server by hand against another database is the whole reason the
  // flags exist, and it would not work if the environment kept the last word.
  const config = loadConfig(
    { FUNOTEKA_DB: 'from-env.db', FUNOTEKA_PORT: '8080', FUNOTEKA_USER: 'env' },
    { dbPath: 'from-flag.db', port: '9090', user: 'flag' },
  );

  assert.equal(config.dbPath, 'from-flag.db');
  assert.equal(config.port, 9090);
  assert.equal(config.user, 'flag');
});

test('a port that is not one is refused, and the refusal names where it came from', () => {
  // A server that silently fell back to the default would come up on a port the
  // operator did not choose and could not explain — and the two sources send
  // that operator to different files.
  assert.throws(() => loadConfig({ FUNOTEKA_PORT: 'http' }), /FUNOTEKA_PORT is not a port number/);
  assert.throws(() => loadConfig({}, { port: '70000' }), /--port is not a port number/);
  assert.throws(() => parsePort('80.5', '--port'), /not a port number/);
});

test('an empty credential is absent, not a config of its own', () => {
  // Empty means the server was given no password. It must not read as a password
  // that happens to be the empty string, or auth would have nothing to refuse.
  const config = loadConfig({ FUNOTEKA_USER: '', FUNOTEKA_PASSWORD: '' });

  assert.equal(config.user, '');
  assert.equal(config.password, '');
});
