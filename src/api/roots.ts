import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DatabaseSync } from '../db/index.ts';
import { rootKey } from '../scan/scan.ts';
import { parseRoots } from './scanner.ts';

/**
 * The directories this deployment serves, as an operator sees them.
 *
 * The scanner has always recorded its roots in the `root` table — it is the
 * table the classification hangs off, and every folder, file and album carries
 * the root it was found under. What was missing is a way to *manage* them
 * without editing the command line a scan is run with: an operator who wants to
 * add a shelf, or stop serving one, had to change whatever starts the scan and
 * then run it themselves.
 *
 * **Adding and scanning are separate.** A root is a statement about what this
 * deployment reads; a scan is the reading. An added root that has never been
 * scanned is a real and useful state — it is what "configured but not yet read"
 * looks like — and the count under it is zero rather than absent.
 *
 * **Identity is the scanner's notion, not the string's.** `rootKey` is what
 * `scan.ts` already uses to decide whether a typed path is a directory it knows,
 * and it is asked here for the same reason: `/srv/music`, `/srv/music/` and
 * `S:\Music` on Windows are one directory, and two rows for one directory is a
 * library that reads everything under it twice.
 */

export interface RootView {
  id: number;
  /** Absolute, as it is stored: what a scan is given. */
  path: string;
  alias: string | null;
  createdAt: string;
  folders: number;
  files: number;
  albums: number;
  /** When a scan last read this root, or nothing when none has. */
  lastScannedAt: string | null;
  lastScanStatus: string | null;
}

/**
 * Every root, with what is under it.
 *
 * The counts are per root rather than a total, because the question the listing
 * answers is "where did my library come from" — a root with nothing under it is
 * either a shelf that has not been scanned yet or a path that leads somewhere
 * empty, and those want different answers from whoever is reading.
 */
export function listRoots(db: DatabaseSync): RootView[] {
  const rows = db
    .prepare('SELECT id, path, alias, created_at FROM root ORDER BY path')
    .all() as { id: number; path: string; alias: string | null; created_at: string }[];

  const runs = recentRuns(db);

  return rows.map((row) => {
    // Found once: the two fields below are one run read twice, and asking for it
    // twice walked the fifty runs twice for every root.
    const last = lastRunFor(runs, rootKey(row.path));
    return {
      id: row.id,
      path: row.path,
      alias: row.alias,
      createdAt: row.created_at,
      folders: countOf(db, 'folder', row.id),
      files: countOf(db, 'file', row.id, "AND kind = 'audio'"),
      albums: countOf(db, 'album', row.id),
      lastScannedAt: last?.finished_at ?? null,
      lastScanStatus: last?.status ?? null,
    };
  });
}

/**
 * Configure a directory as a root.
 *
 * **It has to be there.** A root naming a directory that does not exist is a
 * deployment that will scan nothing and report success — the classic shape of a
 * mistyped path — so the path is checked while the operator is still looking at
 * the answer. The check is a `stat` and not a walk: what is under it is the
 * scan's business.
 *
 * Adding one that is already a root is not an error and not a second row. It is
 * the same directory, whoever says so — and the answer says it was already
 * there, because an operator who thought they were adding a shelf should know
 * they did not.
 */
export function addRoot(db: DatabaseSync, given: string): { root: RootView; already: boolean } {
  const path = resolve(given);

  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    // The sentence below covers both a path that is not there and one that
    // cannot be read, and the second is rarer than the first by a long way.
    isDirectory = false;
  }
  if (!isDirectory) throw new Error(`not a directory on this machine: ${path}`);

  const rows = db.prepare('SELECT id, path, alias, created_at FROM root').all() as {
    id: number;
    path: string;
    alias: string | null;
    created_at: string;
  }[];

  const key = rootKey(path);
  const known = rows.find((row) => rootKey(row.path) === key);

  if (known !== undefined) {
    // The row is kept as it is, and the stored spelling is left alone: it is
    // what the operator typed when they configured it, and a listing that
    // silently rewrote it would be reporting a path nobody chose. A scan
    // canonicalises it, which is the place that has the filesystem's answer.
    return { root: view(db, known.id), already: true };
  }

  const inserted = db
    .prepare('INSERT INTO root (path, created_at) VALUES (?, ?)')
    .run(path, new Date().toISOString());

  return { root: view(db, Number(inserted.lastInsertRowid)), already: false };
}

/**
 * Stop serving a directory, and take what came from it with it.
 *
 * **This is the destructive verb, and the cascade is deliberate.** Every folder,
 * file, album and track under this root is derived from it — `scan.ts` says so
 * in the schema, `ON DELETE CASCADE` all the way down — so a root that stayed
 * while its rows did would be a library still serving music from a shelf the
 * operator had removed from the deployment. The files on disk are untouched:
 * this is a statement about what this server reads, not about the disk.
 *
 * The answer carries the count, because "removed" and "removed a third of your
 * library" are the same word and not the same event.
 */
export function removeRoot(
  db: DatabaseSync,
  given: string,
): { root: RootView; songs: number; albums: number } | null {
  const key = rootKey(resolve(given));

  const rows = db.prepare('SELECT id, path FROM root').all() as { id: number; path: string }[];
  const doomed = rows.find((row) => rootKey(row.path) === key);
  if (doomed === undefined) return null;

  const before = view(db, doomed.id);

  // One transaction, and `IMMEDIATE` like every other write here: a cascade
  // that unwound halfway would leave a root whose rows are some of what it had.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM root WHERE id = ?').run(doomed.id);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already unwound; the original error is what matters.
    }
    throw err;
  }

  return { root: before, songs: before.files, albums: before.albums };
}

/** One root, counted the way the listing counts them. */
function view(db: DatabaseSync, id: number): RootView {
  const row = db.prepare('SELECT id, path, alias, created_at FROM root WHERE id = ?').get(id) as {
    id: number;
    path: string;
    alias: string | null;
    created_at: string;
  };

  const runs = recentRuns(db);
  const last = lastRunFor(runs, rootKey(row.path));

  return {
    id: row.id,
    path: row.path,
    alias: row.alias,
    createdAt: row.created_at,
    folders: countOf(db, 'folder', row.id),
    files: countOf(db, 'file', row.id, "AND kind = 'audio'"),
    albums: countOf(db, 'album', row.id),
    lastScannedAt: last?.finished_at ?? null,
    lastScanStatus: last?.status ?? null,
  };
}

function countOf(db: DatabaseSync, table: string, rootId: number, extra = ''): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE root_id = ? ${extra}`)
    .get(rootId) as { n: number };
  return row.n;
}

/**
 * The runs a root's last reading can be found in.
 *
 * Read from `scan_run` and matched in JavaScript rather than asked for with
 * `LIKE`: the table keeps its roots as a JSON array, and a path is a string that
 * can contain the wildcards a `LIKE` pattern is made of. There are as many rows
 * here as there have been scans, and a scan is not something that happens often.
 *
 * **Canonicalised once per distinct path, and it took two passes to get there.**
 * `rootKey` asks the filesystem (`realpathSync.native`, measured at 0.219 ms).
 * The first version called it inside the search — every path of every run, once
 * per root being listed; on four roots that was **80 ms** against 2.7 ms on two.
 * The fix moved it out of the search and still left it per run: fifty runs × two
 * roots is a hundred filesystem calls, and `GET /roots` still measured **18.8 ms**
 * on two roots. What is expensive is the *path*, not the comparison, so what is
 * memoised now is the path.
 */
interface Run {
  status: string;
  finished_at: string | null;
  /** The runs's roots as canonical keys, not as the paths it was given. */
  keys: string[];
}

function recentRuns(db: DatabaseSync): Run[] {
  const rows = db
    .prepare('SELECT status, finished_at, roots_json FROM scan_run ORDER BY id DESC LIMIT 50')
    .all() as { status: string; finished_at: string | null; roots_json: string }[];

  // The same two or three shelves appear in every one of the fifty runs, so the
  // answer for a path is asked for once and kept.
  const keys = new Map<string, string>();
  const keyOf = (path: string): string => {
    const known = keys.get(path);
    if (known !== undefined) return known;
    const key = rootKey(path);
    keys.set(path, key);
    return key;
  };

  return rows.map((row) => ({
    status: row.status,
    finished_at: row.finished_at,
    keys: parseRoots(row.roots_json).map(keyOf),
  }));
}

function lastRunFor(runs: Run[], key: string): { status: string; finished_at: string | null } | undefined {
  return runs.find((run) => run.keys.includes(key));
}
