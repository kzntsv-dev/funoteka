import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Access to the meta layer.
 *
 * This module is the single seam between the scanner and SQLite: everything
 * else talks to it through `DatabaseSync`, so swapping the driver (say, to
 * better-sqlite3) stays a one-file change. We use the built-in `node:sqlite`
 * because it ships with Node 24 already compiled with FTS5, which keeps the
 * project dependency-free.
 */

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const SCHEMA_VERSION = 38;

/**
 * Where the meta layer lives when nobody says otherwise.
 *
 * The scanner and the server both open it, so the name is the meta layer's own
 * and not either command's: a server started with no arguments has to find the
 * database the scan wrote, or the two halves of the project would need telling
 * about each other.
 */
export const DEFAULT_DB = 'funoteka.db';

interface Migration {
  version: number;
  path: string;
}

/** Migrations are `NNN_name.sql`; the leading number is the target version. */
function migrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ version: Number.parseInt(name.slice(0, 3), 10), path: join(MIGRATIONS_DIR, name) }))
    .filter((m) => Number.isInteger(m.version))
    .sort((a, b) => a.version - b.version);
}

/**
 * Bring the database up to `SCHEMA_VERSION`.
 *
 * Idempotent by design: every scan opens the database, so running this against
 * an already-migrated file has to be a no-op rather than an error.
 */
export function migrate(db: DatabaseSync): void {
  let current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

  for (const migration of migrations()) {
    if (migration.version <= current) continue;

    // `IMMEDIATE`, like every other transaction in this project — the rule is
    // stated below `withTransaction`, and this one broke it. It was survivable
    // only by accident: each file here happens to write first (020 opens with a
    // bare `ANALYZE`), and a deferred transaction whose *first* statement is a
    // write does ask the busy handler. A later migration that reads before it
    // writes would have been refused at once instead — and this runs inside
    // `openDb`, before any caller has had a chance to raise the timeout.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(migration.path, 'utf8'));
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already unwound; the original error is what matters.
      }
      throw err;
    }
    current = migration.version;
  }
}

/**
 * Open the meta layer, creating and migrating it if needed.
 *
 * Pass ':memory:' for an ephemeral database (tests). On disk we use WAL so a
 * scan can write while the API reads.
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);

  // Per-connection, and required for the ON DELETE CASCADE rules to fire.
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  // How long a writer waits for the other writer.
  //
  // Two things write this file: the scan, which is a process of its own, and the
  // API, which writes playlists. SQLite's default answer to the second arriving
  // while the first holds the lock is to give up at once, and "at once" is about
  // 20 ms: measured on two connections to one file, the save failed with
  // "database is locked" while the other held the lock.
  //
  // **Short, because the wait is served by blocking the thread.** `node:sqlite`
  // is synchronous, so this sleep is not a sleep this server can take while
  // answering anybody else: measured with the second writer holding the lock for
  // seven seconds, a `ping` sent during the wait came back after 5133 ms — the
  // whole daemon, stopped, for one client's save.
  //
  // A quarter of a second is set against how long the scan now holds the lock,
  // which is no longer a root: `scan.ts` writes in batches and lets go between
  // them — measured on the live collection, one batch holds the write lock **12
  // ms at the median and 96 ms at its worst**. So a save that meets a scan waits
  // out a single batch and gets in, which is what this number was always meant
  // to buy and could not buy while a scan held the lock for its whole run.
  //
  // The scan's own connection is the other half of this, and takes ten seconds
  // (`cli.ts`): there the wait holds up nobody, because a scan answers nobody.
  // What is left owed here is the length of the *stages* — `cues` still writes
  // one transaction of about two seconds, and a save arriving inside it is
  // refused (task:2880).
  db.exec('PRAGMA busy_timeout = 250');

  migrate(db);
  return db;
}

/**
 * A mutation, as one transaction.
 *
 * **Measured, and it is the whole of why this exists.** On a copy of the live
 * meta layer, a hundred entries written one statement at a time — which is what
 * SQLite does without a transaction, each commit a write to disk — took
 * **4452 ms**. The same hundred inside one transaction took **74 ms**, and a
 * single statement costs about 26 ms on its own. A server that answers every
 * request in one thread cannot spend four seconds of that on one client's save.
 *
 * The figures come from the live database and not from the suite on purpose: on
 * an empty database a commit costs about nothing, so both forms measure under a
 * millisecond there and a test cannot see the difference this makes. What it
 * costs is paid in proportion to a database that exists.
 *
 * **`IMMEDIATE`, and the word is load-bearing.** A plain `BEGIN` is deferred:
 * the transaction takes its read snapshot first and only tries to become a
 * writer at the first write — and a write that has to *upgrade* a snapshot when
 * somebody else holds the lock is refused at once, without consulting the busy
 * handler `PRAGMA busy_timeout` installs. Measured against a second connection
 * holding the lock: deferred `BEGIN` failed in 2.6–17 ms, while `BEGIN
 * IMMEDIATE` (which asks for the lock up front, where waiting is allowed) and a
 * bare `DELETE` both waited as configured. The writers here read before they
 * write — a counter, a list of entries — so a deferred begin would refuse every
 * save made while a scan was running, which is the one moment this arrangement
 * exists for.
 *
 * Nested calls join the outer transaction rather than opening a second: SQLite
 * has no nested `BEGIN`, and a stage that fell over halfway through should leave
 * nothing of itself behind.
 */
export function withTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    // Guarded, and the guard is the point: whatever threw may have unwound the
    // transaction already (`SQLITE_FULL`, a constraint that aborts), and a
    // `ROLLBACK` with nothing to roll back throws its own error — which would
    // replace the reason the caller needs with a complaint about the clean-up.
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already unwound; the original error is what matters.
    }
    throw err;
  }
}

export type { DatabaseSync };
