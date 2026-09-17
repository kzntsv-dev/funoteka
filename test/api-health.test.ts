import { test } from 'node:test';
import assert from 'node:assert/strict';

import { health } from '../src/api/health.ts';
import { SCHEMA_VERSION, openDb } from '../src/db/index.ts';
import { ask } from './helpers/api.ts';

/**
 * The health route, tested both ways round: what it makes of the meta layer,
 * and what a supervisor actually gets when it asks over a socket.
 *
 * The second half matters as much as the first. This route's whole reason to
 * exist is that an *unauthenticated* asker can reach it — and every other route
 * on this server refuses one — so "it answers without credentials" is not an
 * implementation detail to be assumed from reading the code. It is the property,
 * and it is checked through a socket.
 */

test('a server that can read its own meta layer is healthy, and says what it is', () => {
  const db = openDb(':memory:');
  const answer = health(db, 12.34);

  assert.equal(answer.status, 200);
  const body = JSON.parse(answer.body) as Record<string, unknown>;
  assert.equal(body.status, 'ok');
  assert.equal(body.server, 'funoteka');
  assert.equal(typeof body.version, 'string');
  assert.equal(body.schema, SCHEMA_VERSION, 'the schema the file is at, not the one the build expects');
  assert.equal(body.uptime, 12.3, 'rounded to a tenth, because nobody reads more than that');
  assert.equal(body.error, undefined);

  db.close();
});

test('a server that cannot read its meta layer says so, and does not claim to be well', () => {
  // The state this exists for. The process is up and answering, and what it
  // serves it cannot read — a supervisor that only checked "is the port open"
  // would call this healthy and leave it running for a week.
  const db = openDb(':memory:');
  db.close();

  const answer = health(db, 1);

  assert.equal(answer.status, 503);
  const body = JSON.parse(answer.body) as Record<string, unknown>;
  assert.equal(body.status, 'failed');
  assert.notEqual(body.error, undefined, 'and the reason is in it, for whoever reads the log');
  assert.equal(body.schema, undefined);
});

test('health answers a stranger, while every route under /rest/ still does not', async () => {
  const db = openDb(':memory:');

  const asked = await ask(db, '/health');
  assert.equal(asked.status, 200);
  const body = JSON.parse(asked.body.toString('utf8')) as Record<string, unknown>;
  assert.equal(body.status, 'ok');

  // The contrast, in the same test and on the same server: this is the one
  // public surface, and the guard on the others is not weakened by it.
  const api = await ask(db, 'ping?f=json');
  assert.equal(api.status, 200);
  const envelope = JSON.parse(api.body.toString('utf8')) as {
    'subsonic-response': { status: string };
  };
  assert.equal(envelope['subsonic-response'].status, 'ok', 'and the API still answers an authenticated caller');

  db.close();
});

test('what is not the API and not health is not answered as either', async () => {
  // A path outside `/rest/` that nobody claimed is a missing page, and it stays
  // that way: the health route is one name, not a hole in the prefix.
  const db = openDb(':memory:');

  const missing = await ask(db, '/healthz');
  assert.equal(missing.status, 404);

  db.close();
});

test('health is reached on the port a client already has', async () => {
  // Said as a fact about the server rather than about the route: the port the
  // supervisor probes is the one the config names, and a second listener for a
  // probe would be a second thing to keep open.
  const db = openDb(':memory:');
  const asked = await ask(db, '/health', {}, { port: 0, host: '127.0.0.1' });

  assert.equal(asked.status, 200);
  assert.match(asked.headers.get('content-type') ?? '', /application\/json/);
  db.close();
});

test('a health answer is not an envelope', () => {
  // Not a Subsonic response and it must not pretend to be one: a client that
  // read `subsonic-response` here would be reading a shape this route does not
  // have, and the envelope's own `version` means the *protocol's* version.
  const db = openDb(':memory:');
  const body = JSON.parse(health(db, 1).body) as Record<string, unknown>;

  assert.equal(body['subsonic-response'], undefined);
  db.close();
});
