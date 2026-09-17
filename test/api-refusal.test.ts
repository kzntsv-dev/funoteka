import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { ask } from './helpers/api.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * A save this server could not make has to say that it could not make it.
 *
 * The meta layer has two writers by design — the daemon and a scan — and they
 * take turns. When the daemon loses that turn it refuses the request, which is
 * the arrangement working. What it must not do is refuse it in a way the client
 * can read as success.
 *
 * **Measured on the live daemon before this was fixed** (task:2884): saving a
 * playlist through the API every 40 ms while a scan ran, 4 saves in 100 were
 * refused — and every one of them was simply lost. The protocol has no code for
 * "busy", so the refusal is a generic failure, and the words are the only place
 * the loss can be stated. "Try again" states a hope, not a fact: a Subsonic
 * client does not retry on its own, and a client that shows the user nothing has
 * left a playlist that exists in the UI and not on the server.
 *
 * The other half of this — refusing less often — is `task:2880`, and it is a
 * measurement rather than a message.
 */

test('a write refused by the lock says that nothing was saved', async () => {
  const dir = tempRoot('funoteka-refusal-');
  const path = join(dir, 'funoteka.db');
  const db = openDb(path);
  const other = openDb(path);

  // The second writer, holding the lock and not letting go — which is what a
  // scan's stage does for seconds at a time.
  other.exec('BEGIN IMMEDIATE');

  try {
    const served = await ask(db, 'createPlaylist?name=Refused&f=json');
    const answer = JSON.parse(served.body.toString('utf8'))['subsonic-response'];

    assert.equal(answer.status, 'failed', 'the request could not be answered');
    assert.match(
      answer.error.message,
      /nothing was saved/i,
      'a client told only to retry may take the save as having gone through',
    );
  } finally {
    other.exec('ROLLBACK');
    other.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
