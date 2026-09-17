import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { addKey, keyHolds, listKeys, newSecret, revokeKey } from '../src/api/keys.ts';
import { createServer } from '../src/api/server.ts';
import type { ServerConfig } from '../src/api/config.ts';
import { ERROR } from '../src/api/envelope.ts';
import { openDb } from '../src/db/index.ts';

type Db = ReturnType<typeof openDb>;

const CONFIG: ServerConfig = {
  dbPath: ':memory:',
  host: '127.0.0.1',
  port: 0,
  user: 'demo',
  password: 'sesame',
  // The bootstrap credential, which is what the daemon has in `start.cmd`.
  apiKey: 'the-environment-key',
  ffmpeg: 'funoteka-no-such-ffmpeg',
  cacheDir: '/tmp/funoteka-cache-test',
  logFile: '',
  logRequests: false,
  cors: false,
  showJunk: false,
};

/** One request against a server up only for the length of it. */
async function askRaw(db: Db, path: string): Promise<Record<string, any>> {
  const server = createServer(db, CONFIG);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return (await response.json()) as Record<string, any>;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test('a registered key is a credential on its own', async () => {
  // The extension's first promise, and the shape the specification is explicit
  // about: `apiKey` arrives alone, and `u` beside it is an error 43. A key that
  // only worked in company would be a key no client sends.
  const db = openDb(':memory:');
  const key = addKey(db, 'the tablet');

  const answer = await askRaw(db, `/rest/ping?apiKey=${key.secret}&f=json`);
  assert.equal(answer['subsonic-response'].status, 'ok');

  const withUser = await askRaw(db, `/rest/ping?apiKey=${key.secret}&u=demo&f=json`);
  assert.equal(withUser['subsonic-response'].error?.code, ERROR.conflictingAuthMechanisms);

  db.close();
});

test('a key taken back stops working at once, with no restart', async () => {
  // **The second promise, and the whole reason for the registry.** Before it,
  // taking a key away from a device somebody lost meant editing `start.cmd` and
  // restarting the daemon — which drops every session, including the one of
  // whoever is listening. The check reads the table per request for exactly
  // this: a key revoked a minute ago must be refused now.
  const db = openDb(':memory:');
  const key = addKey(db, 'the phone that was stolen');

  assert.equal((await askRaw(db, `/rest/ping?apiKey=${key.secret}&f=json`))['subsonic-response'].status, 'ok');

  revokeKey(db, 'the phone that was stolen');

  const after = await askRaw(db, `/rest/ping?apiKey=${key.secret}&f=json`);
  assert.equal(after['subsonic-response'].status, 'failed');
  assert.equal(after['subsonic-response'].error?.code, ERROR.wrongCredentials);
  assert.equal(keyHolds(db, key.secret), false);

  db.close();
});

test('the environment key is not in the registry, and revoking cannot touch it', () => {
  // It is the credential that has to survive the database — a key whose only
  // copy is in the database cannot recover that database — and a `revoke` that
  // silently undid it on the next restart would be worse than no revoke at all.
  const db = openDb(':memory:');

  assert.deepEqual(listKeys(db), [], 'nothing is registered until somebody adds a key');
  assert.equal(keyHolds(db, CONFIG.apiKey), false, 'and the environment key is not one of them');

  assert.throws(() => revokeKey(db, 'the-environment-key'), /no active key/);

  db.close();
});

test('a label names one key or revokes nothing', () => {
  // `revoke tablet` with two keys called "tablet" would take back one the
  // person did not name, and this is the operation where being wrong is
  // invisible until a device stops working. So it refuses and says which.
  const db = openDb(':memory:');
  addKey(db, 'tablet');
  addKey(db, 'tablet');
  const other = addKey(db, 'laptop');

  assert.throws(() => revokeKey(db, 'tablet'), /2 active keys match/);
  assert.equal(listKeys(db).filter((key) => key.revokedAt === null).length, 3, 'nothing was revoked');

  // The id is unambiguous even when the label is not — `keys list` prints it.
  const taken = revokeKey(db, String(other.id));
  assert.equal(taken.label, 'laptop');
  assert.equal(taken.revokedAt !== null, true);

  db.close();
});

test('a secret that was revoked is never handed out again', () => {
  // Revoked rows are kept rather than deleted, and the unique index covers
  // them: silently accepting a secret somebody deliberately took back would be
  // the revoke undoing itself, which is the one thing a revoke may not do.
  const db = openDb(':memory:');
  const secret = newSecret();
  addKey(db, 'first', secret);
  revokeKey(db, 'first');

  assert.throws(() => addKey(db, 'second', secret), /was revoked on/);
  assert.equal(listKeys(db).length, 1, 'and the refusal left nothing behind');

  db.close();
});

test('a key needs a label a person could act on', () => {
  const db = openDb(':memory:');
  assert.throws(() => addKey(db, '   '), /needs a label/);
  db.close();
});

test('the registry keeps every key it has ever held, active ones first', () => {
  const db = openDb(':memory:');
  const first = addKey(db, 'old');
  addKey(db, 'new');
  revokeKey(db, String(first.id));

  const all = listKeys(db);
  assert.equal(all.length, 2);
  assert.equal(all.filter((key) => key.revokedAt === null).length, 1, 'one active');
  assert.equal(all.find((key) => key.id === first.id)?.revokedAt !== null, true);
  // The secret stays readable after revocation, because "was that ever given
  // out" is a question the registry should still be able to answer.
  assert.equal(all.find((key) => key.id === first.id)?.secret, first.secret);

  db.close();
});

test('the form the listing prints is a form revoke accepts', async () => {
  // **The one rule this test exists for: what a command prints, a command has
  // to read back.** `keys list` shows `#3  the tablet`, the ambiguity refusal
  // says "name one by number: #12 (label)", and the usage line offers
  // `<label|#id>` — and none of that worked, because `Number('#3')` is `NaN`
  // and the id went to the query as −1. The parse test in `cli.test.ts` held
  // only that the *argument* survives, so the hole was in the half nobody
  // checked (task:2924).
  const db = openDb(':memory:');
  const key = addKey(db, 'the tablet');

  // The exact spelling the CLI hands the operator, built from the same value
  // the listing prints rather than typed here.
  const taken = revokeKey(db, `#${key.id}`);

  assert.equal(taken.id, key.id);
  assert.equal(taken.revokedAt !== null, true, 'and it is the one that was named');
  assert.equal(listKeys(db).filter((row) => row.revokedAt === null).length, 0);

  db.close();
});

test('a number that is not there says so, and does not take a label with it', () => {
  // The `#` is a spelling, not a search: `#99` names no key, and the refusal
  // has to be about the number rather than about a label literally called
  // `#99` — which is what the old code was accidentally looking for.
  const db = openDb(':memory:');
  addKey(db, 'the tablet');

  assert.throws(() => revokeKey(db, '#99'), /no active key called or numbered "#99"/);
  assert.equal(listKeys(db).filter((row) => row.revokedAt === null).length, 1, 'nothing was revoked');

  db.close();
});
