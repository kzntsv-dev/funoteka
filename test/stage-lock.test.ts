import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { applyArtists } from '../src/artist/apply.ts';
import { applyCues } from '../src/cue/engine.ts';
import { openDb } from '../src/db/index.ts';
import { rebuildSearchIndex } from '../src/search/index.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * A stage that meets a client's save must wait for it, not refuse to start.
 *
 * Every stage writes inside one transaction, and it is opened with `BEGIN
 * IMMEDIATE` for the rule `db/index.ts` states. The rule exists because of one
 * specific failure: a *deferred* transaction is a reader until its first write,
 * and the write that turns it into a writer is an **upgrade** — when another
 * connection holds the lock, SQLite refuses the upgrade at once and never calls
 * the busy handler `busy_timeout` installs. Measured in `db/index.ts`: 2.6–17 ms
 * to fail. `playlist/store.ts` was fixed for it first (task:2870).
 *
 * It stayed in the stages until scans began yielding the lock often enough for
 * clients to actually save during one, and then a run died in whichever stage
 * met a save: measured on the live collection with a save through the API every
 * 40 ms, the run failed in `tags` with `database is locked` (task:2871).
 *
 * **What is asserted below is the wait, not the word.** The three stages are
 * held to one contract — a held lock is waited out rather than refused — and
 * only `search` tells `IMMEDIATE` from a plain `BEGIN` today: its first
 * statement is an FTS5 `DELETE`, which reads before it writes, so a deferred
 * `BEGIN` there refuses in **0 ms**. `cues` and `artists` write first, and a
 * deferred transaction whose first statement is a write *does* ask the busy
 * handler — they pass either way. They stay because the contract is worth
 * pinning wherever it holds, and because what makes them pass is the *order of
 * their statements*, which is what an edit changes.
 *
 * `tags` is the fourth stage and is not here: it writes only per file the ledger
 * says is due, so on a database with nothing due it never reaches a write and
 * there is no upgrade to refuse.
 */

function heldByAClient(): {
  dir: string;
  stage: ReturnType<typeof openDb>;
  client: ReturnType<typeof openDb>;
  cleanUp: () => void;
} {
  const dir = tempRoot('funoteka-stage-lock-');
  const path = join(dir, 'funoteka.db');

  const stage = openDb(path);
  const client = openDb(path);

  // The client is mid-save and has not committed. `IMMEDIATE` for the same
  // reason the stages need it: this is standing in for a save that holds the
  // write lock, and a deferred transaction holding no lock would stand for
  // nothing.
  client.exec('BEGIN IMMEDIATE');
  client.prepare('INSERT INTO scan_run (started_at, status, roots_json) VALUES (?, ?, ?)').run(
    'now',
    'running',
    '[]',
  );

  // Long enough that a wait and an instant refusal cannot be confused — the
  // refused-in-17-ms case is two orders of magnitude away from this.
  stage.exec('PRAGMA busy_timeout = 900');

  return {
    dir,
    stage,
    client,
    cleanUp: () => {
      try {
        client.exec('ROLLBACK');
      } catch {
        // The stage may have been the one to unwind it; nothing to do either way.
      }
      client.close();
      stage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs `work` and answers how long it took and how it ended. */
function timed(work: () => void): { ms: number; error: string | null } {
  const started = process.hrtime.bigint();
  try {
    work();
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, error: null };
  } catch (err) {
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, error: (err as Error).message };
  }
}

const STAGES: [string, (db: ReturnType<typeof openDb>) => unknown][] = [
  ['cues', (db) => applyCues(db)],
  ['artists', (db) => applyArtists(db)],
  ['search', (db) => rebuildSearchIndex(db)],
];

for (const [name, run] of STAGES) {
  test(`${name} waits out a client's save instead of refusing to start`, () => {
    const { stage, cleanUp } = heldByAClient();
    try {
      const { ms, error } = timed(() => run(stage));

      assert.ok(error !== null, `${name} cannot finish while the client holds the lock`);
      assert.match(error, /locked/i);
      assert.ok(
        ms >= 600,
        `${name} gave up in ${ms.toFixed(0)} ms — a transaction that reads before it writes ` +
          `and opens deferred is refused at once, never reaching the busy handler`,
      );
    } finally {
      cleanUp();
    }
  });
}
