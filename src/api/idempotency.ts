import type { DatabaseSync } from '../db/index.ts';

/**
 * The same request, made twice, answered once.
 *
 * A control surface is called by scripts and agents over a network, and a
 * network offers two failures that look identical from the caller's side: the
 * request that never arrived, and the answer that was lost coming back. A caller
 * that retries cannot tell them apart — and for a mutation it must, because
 * doing the work twice is not the same as doing it once. `Idempotency-Key` is
 * the caller saying "this is the same request"; this is where the first answer
 * waits so that the second one can be given it.
 *
 * **Kept in the database, because `POST /restart` is in this surface.** An
 * in-memory map would be cleared by the very operation a client is most likely
 * to be retrying across — the server restarts, the client's connection drops,
 * the client retries, and the process that knew the key is gone. The record has
 * to outlive the thing it was protecting.
 *
 * What a key is *for* is checked as well as what it answered: the same key on a
 * different method or path is a caller that reused one by mistake, and answering
 * it with another operation's result would be the worst possible behaviour —
 * silently correct-looking and about something else.
 */

/**
 * How long an answer stays replayable.
 *
 * A day, because the window this exists for is one client's retry after a
 * dropped connection — seconds to minutes — and the reason to bound it is that
 * the table would otherwise grow for ever with keys nobody will ask about again.
 */
export const KEEP_MS = 24 * 60 * 60 * 1000;

export interface Recorded {
  status: number;
  body: string;
}

export type Recall =
  /** No such key: the request has not been made. */
  | { kind: 'fresh' }
  /** The same request, answered before — here is that answer. */
  | { kind: 'replay'; recorded: Recorded }
  /** The key was used for a different request. */
  | { kind: 'conflict'; recorded: Recorded };

/**
 * What this key answered before, if anything.
 *
 * An empty key is not a key: a caller that sent none is asking for the ordinary
 * behaviour, and treating `''` as a value would make every such request share
 * one record.
 */
export function recall(db: DatabaseSync, key: string, method: string, path: string): Recall {
  if (key === '') return { kind: 'fresh' };

  const row = db
    .prepare('SELECT method, path, status, body FROM admin_idempotency WHERE key = ?')
    .get(key) as { method: string; path: string; status: number; body: string } | undefined;

  if (row === undefined) return { kind: 'fresh' };

  const recorded: Recorded = { status: row.status, body: row.body };
  if (row.method !== method || row.path !== path) return { kind: 'conflict', recorded };
  return { kind: 'replay', recorded };
}

/**
 * Keep this answer for this key.
 *
 * `INSERT OR REPLACE` rather than a plain insert: two callers racing with one
 * key is not an error to report, it is the case this exists for, and whoever
 * gets there second overwrites an answer that is about to be read back as the
 * same answer anyway. Pruning runs here rather than on a timer, because this is
 * the only moment the table grows.
 */
export function remember(
  db: DatabaseSync,
  key: string,
  method: string,
  path: string,
  status: number,
  body: string,
  now: number = Date.now(),
): void {
  if (key === '') return;

  db.prepare(
    'INSERT OR REPLACE INTO admin_idempotency (key, method, path, status, body, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
  ).run(key, method, path, status, body, new Date(now).toISOString());

  db.prepare('DELETE FROM admin_idempotency WHERE created_at < ?').run(
    new Date(now - KEEP_MS).toISOString(),
  );
}
