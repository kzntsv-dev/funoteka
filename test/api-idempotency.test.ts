import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { KEEP_MS, recall, remember } from '../src/api/idempotency.ts';
import { openDb } from '../src/db/index.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The record of what a key answered.
 *
 * Asked directly rather than through a socket, because the properties that
 * matter are about *time* — what happens a day later, and what happens after the
 * process that wrote the row has died. A route test cannot ask either.
 */

function db() {
  return openDb(':memory:');
}

test('a key nobody has used is fresh', () => {
  const store = db();

  assert.deepEqual(recall(store, 'k-1', 'POST', '/config'), { kind: 'fresh' });
  // An empty key is not a key: a caller that sent none asked for the ordinary
  // behaviour, and treating `''` as a value would make every such request share
  // one record.
  remember(store, '', 'POST', '/config', 200, '{}');
  assert.deepEqual(recall(store, '', 'POST', '/config'), { kind: 'fresh' });

  store.close();
});

test('the same request under the same key comes back as the answer it got', () => {
  const store = db();
  remember(store, 'k-1', 'POST', '/config', 200, '{"written":["port"]}');

  assert.deepEqual(recall(store, 'k-1', 'POST', '/config'), {
    kind: 'replay',
    recorded: { status: 200, body: '{"written":["port"]}' },
  });

  store.close();
});

test('the same key on a different request is a conflict, not a replay', () => {
  // Answering it with another operation's result would be the worst possible
  // behaviour: correct-looking, and about something else entirely.
  const store = db();
  remember(store, 'k-1', 'POST', '/config', 200, '{}');

  assert.equal(recall(store, 'k-1', 'POST', '/restart').kind, 'conflict');
  assert.equal(recall(store, 'k-1', 'DELETE', '/config').kind, 'conflict');
  assert.equal(recall(store, 'k-1', 'POST', '/config').kind, 'replay', 'and the original still replays');

  store.close();
});

test('a key written twice keeps the last answer', () => {
  // Two calls racing with one key is not an error to report — it is the case
  // this exists for, and the second answer is the one the retry is owed.
  const store = db();
  remember(store, 'k-1', 'POST', '/config', 500, '{"error":"first"}');
  remember(store, 'k-1', 'POST', '/config', 200, '{"written":[]}');

  const seen = recall(store, 'k-1', 'POST', '/config');
  assert.equal(seen.kind === 'replay' ? seen.recorded.status : 0, 200);

  store.close();
});

test('an answer older than the window is forgotten, and the work is done again', () => {
  // The window is one client's retry after a dropped connection — seconds to
  // minutes. Beyond it the row is only weight, and the table would otherwise
  // grow for ever with keys nobody will ask about again.
  const store = db();
  const clock = Date.parse('2026-09-16T00:00:00.000Z');

  remember(store, 'old', 'POST', '/config', 200, '{}', clock);
  // A second past the window, and not exactly on it: the boundary belongs to the
  // row, not to the pruning — an answer from exactly `KEEP_MS` ago is still one
  // a client could be retrying after.
  remember(store, 'new', 'POST', '/config', 200, '{}', clock + KEEP_MS + 1);

  assert.equal(recall(store, 'old', 'POST', '/config').kind, 'fresh', 'pruned by the write after it');
  assert.equal(recall(store, 'new', 'POST', '/config').kind, 'replay');

  store.close();
});

test('a record outlives the process that wrote it', () => {
  // **Why this is a table and not a map.** `POST /restart` is in this same
  // surface: the server restarts, the client's connection drops, the client
  // retries — and the process that knew the key is the one that just exited.
  const path = join(tempRoot('funoteka-idempotency-'), 'meta.db');
  const first = openDb(path);
  remember(first, 'k-1', 'POST', '/restart', 200, '{"restarting":true}');
  first.close();

  const second = openDb(path);
  try {
    assert.equal(recall(second, 'k-1', 'POST', '/restart').kind, 'replay');
  } finally {
    second.close();
  }
});
