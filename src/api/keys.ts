import { randomBytes } from 'node:crypto';

import type { DatabaseSync } from '../db/index.ts';
import { sameSecret } from './auth.ts';

/**
 * The keys this server accepts, kept where a person can take one back.
 *
 * The `apiKeyAuthentication` extension is a pair of promises, and this is the
 * second of them: the specification says a server implementing it "**must**
 * provide some mechanism for viewing active API key(s) and allow for revoking
 * API keys". A parameter that works is not that mechanism, and until this
 * existed the project honoured the first half of the extension and said nothing
 * about the second — the key was a variable in `start.cmd`, visible only by
 * reading that file on the server and revocable only by editing it and
 * restarting, which drops every session (task:2915).
 *
 * **The environment's key is not in this registry, and that is the design.**
 * `FUNOTEKA_APIKEY` is the bootstrap credential: it is checked first, it is
 * always valid, and it is the one way in that survives a database. A registry
 * that could revoke it would either lie — because the next restart would read
 * the file and accept it again — or lock the operator out of their own server.
 * It is reported by `list`, marked as what it is, and revoked where it lives.
 */
export interface ApiKey {
  id: number;
  label: string;
  secret: string;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * A secret for a new key, from the operating system's random source.
 *
 * 32 bytes, hex: the same shape as the environment key this project already
 * uses, so that anything which accepts one accepts the other, and long enough
 * that guessing it is not a thing anyone tries twice.
 */
export function newSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Whether a presented key is one of the registered ones.
 *
 * **Every active row is compared, rather than looked up by value.** A `WHERE
 * secret = ?` would be an index probe whose duration says how nearly the guess
 * matched, which is the same leak `sameSecret` exists to close on the password;
 * a registry of keys is small enough that comparing all of them is free. Revoked
 * rows are left out — they are kept for the record, not honoured.
 */
export function keyHolds(db: DatabaseSync, given: string): boolean {
  const rows = db.prepare('SELECT secret FROM api_key WHERE revoked_at IS NULL').all() as {
    secret: string;
  }[];
  return rows.some((row) => sameSecret(given, row.secret));
}

/**
 * Register a key under a label, and answer with the row that was written.
 *
 * A secret may be given rather than generated, because a person moving their
 * setup may want the key they already have — but a secret this table has ever
 * held is refused, revoked or not. Silently accepting one would resurrect a key
 * somebody had deliberately taken back.
 */
export function addKey(
  db: DatabaseSync,
  label: string,
  secret: string = newSecret(),
  now: Date = new Date(),
): ApiKey {
  const trimmed = label.trim();
  if (trimmed === '') throw new Error('a key needs a label — what it is for, or whose it is');
  if (secret.trim() === '') throw new Error('a key needs a secret');

  const seen = db.prepare('SELECT revoked_at FROM api_key WHERE secret = ?').get(secret) as
    | { revoked_at: string | null }
    | undefined;
  if (seen !== undefined) {
    throw new Error(
      seen.revoked_at === null
        ? 'that secret is already registered to an active key'
        : `that secret was revoked on ${seen.revoked_at} and is not given out again`,
    );
  }

  const createdAt = now.toISOString();
  db.prepare('INSERT INTO api_key (label, secret, created_at) VALUES (?, ?, ?)').run(
    trimmed,
    secret,
    createdAt,
  );

  const written = db.prepare('SELECT id FROM api_key WHERE secret = ?').get(secret) as {
    id: number;
  };
  return { id: written.id, label: trimmed, secret, createdAt, revokedAt: null };
}

/** Every key the table has ever held, newest first, revoked ones included. */
export function listKeys(db: DatabaseSync): ApiKey[] {
  const rows = db
    .prepare(
      `SELECT id, label, secret, created_at AS createdAt, revoked_at AS revokedAt
       FROM api_key ORDER BY created_at DESC, id DESC`,
    )
    .all() as {
    id: number;
    label: string;
    secret: string;
    createdAt: string;
    revokedAt: string | null;
  }[];
  return rows;
}

/**
 * Take a key back, by id or by the label it was given.
 *
 * Refuses rather than answering quietly when it matches nothing or matches
 * more than one: `revoke tablet` with two keys called "tablet" would take back
 * a key the person did not name, and this is the one operation where being
 * wrong is invisible until a device stops working.
 */
export function revokeKey(db: DatabaseSync, idOrLabel: string, now: Date = new Date()): ApiKey {
  // **`#3` is a form this has to accept, because it is the form this prints.**
  // `keys list` shows `#3  the tablet`, the ambiguity refusal below says "name
  // one by number: #12 (label)", and the usage line offers `<label|#id>` — and
  // `Number('#3')` is `NaN`, so the one spelling the CLI advertised was the one
  // it could not read. Found independently by two axes of the review umbrella,
  // which is what a spelling nobody tested looks like from both sides
  // (task:2924).
  const named = idOrLabel.startsWith('#') ? idOrLabel.slice(1) : idOrLabel;
  const asId = Number(named);

  const rows = db
    .prepare(
      `SELECT id, label, secret, created_at AS createdAt, revoked_at AS revokedAt
       FROM api_key WHERE revoked_at IS NULL AND (label = ? OR id = ?)`,
    )
    .all(idOrLabel, Number.isInteger(asId) ? asId : -1) as unknown as ApiKey[];

  if (rows.length === 0) throw new Error(`no active key called or numbered "${idOrLabel}"`);
  if (rows.length > 1) {
    throw new Error(
      `${rows.length} active keys match "${idOrLabel}" — name one by number: ` +
        rows.map((row) => `#${row.id} (${row.label})`).join(', '),
    );
  }

  const revokedAt = now.toISOString();
  db.prepare('UPDATE api_key SET revoked_at = ? WHERE id = ?').run(revokedAt, rows[0]!.id);
  return { ...rows[0]!, revokedAt };
}
