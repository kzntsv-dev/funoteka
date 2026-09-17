import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

import type { DatabaseSync } from '../db/index.ts';
import { count } from './meta.ts';

/**
 * What the library is, what went wrong reading it, and what the server has been
 * saying — the three questions an operator asks that are not about a setting.
 *
 * All reads, and all of them things the scanner has already written down: this
 * module derives nothing the stages do not already know, because a route that
 * recomputed a classification would be a second answer to a question that has
 * one. The only file it touches is the log, which is not in the database at all.
 */

export interface Stats {
  roots: number;
  folders: number;
  files: number;
  songs: number;
  albums: number;
  artists: number;
  playlists: number;
  /** Albums the filter is keeping out of the default view. */
  hidden: number;
  /** Findings the scanner recorded and could not resolve. */
  issues: number;
  /** How big the meta layer is on disk, which is the one number that grows. */
  databaseBytes: number;
}

export function stats(db: DatabaseSync, dbPath: string): Stats {
  const counted = (table: string, extra = ''): number =>
    count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE 1 = 1 ${extra}`);

  return {
    roots: counted('root'),
    folders: counted('folder'),
    files: counted('file'),
    songs: counted('file', "AND kind = 'audio'"),
    albums: counted('album'),
    artists: counted('artist'),
    playlists: counted('playlist'),
    hidden: counted('album', 'AND junk_reason IS NOT NULL'),
    issues: counted('issue'),
    // A meta layer that is missing cannot be measured, and a stat route that
    // threw over it would be answering "how big is the library" with a stack
    // trace. Zero is what a missing file comes back as — which is a number a
    // reader could act on, and is why this sentence is here rather than a claim
    // that nothing is reported at all.
    databaseBytes: sizeOf(dbPath),
  };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export interface Issue {
  id: number;
  kind: string;
  severity: string;
  detail: string | null;
  rootPath: string | null;
  relPath: string | null;
  scanRunId: number | null;
}

/**
 * What the scanner could not understand, newest first.
 *
 * The table the project has always kept — "every guess, skip and unmatched cue
 * lands here so a scan can never lose information silently" — and the one thing
 * an operator cannot get anywhere else: the API answers about the collection it
 * managed to build, and this answers about the parts it did not.
 */
export function issues(db: DatabaseSync, limit: number, severity?: string): { counts: Record<string, number>; issues: Issue[] } {
  const filter = severity === undefined ? '' : 'WHERE i.severity = ?';
  const args = severity === undefined ? [limit] : [severity, limit];

  const rows = db
    .prepare(
      `SELECT i.id AS id, i.kind AS kind, i.severity AS severity, i.detail AS detail,
              r.path AS rootPath, i.rel_path AS relPath, i.scan_run_id AS scanRunId
         FROM issue i LEFT JOIN root r ON r.id = i.root_id
         ${filter}
        ORDER BY i.id DESC LIMIT ?`,
    )
    .all(...args) as unknown as Issue[];

  const counted = db
    .prepare('SELECT kind, COUNT(*) AS n FROM issue GROUP BY kind ORDER BY n DESC')
    .all() as { kind: string; n: number }[];

  return { counts: Object.fromEntries(counted.map((row) => [row.kind, row.n])), issues: rows };
}

/**
 * The last lines of whatever file this server is narrating to.
 *
 * **Two files, and which one is the deployment's shape.** A server started with
 * `--daemon` has its output redirected to `<db>.log` beside the meta layer; a
 * server in a container or under systemd has its supervisor collecting it, and
 * if it also has `logFile` set it writes its own. The configured file wins,
 * because it is the one somebody asked for, and the daemon's is the fallback
 * because it is the one that exists.
 *
 * Read from the end rather than the whole file: a log that has been running for
 * a month is not a thing to load into memory to answer "what did it just say".
 */
export interface Logs {
  file: string;
  lines: string[];
  /** Whether there is more above the lines returned. */
  truncated: boolean;
}

/**
 * How much of the end of a log is read.
 *
 * The deployment this was built for has a **24 MB** log, and reading all of it
 * to answer "what did it just say" is 24 MB into the one thread that answers
 * every client — for five lines. A quarter of a megabyte is tens of thousands of
 * lines, which is more than anyone reads back, and it is the same size whatever
 * the file has grown to.
 */
const LOG_TAIL_BYTES = 256 * 1024;

export function logs(logFile: string, dbPath: string, wanted: number): Logs {
  const file = logFile === '' ? `${dbPath}.log` : logFile;

  let all: string[];
  let whole: boolean;

  try {
    const read = tail(file, LOG_TAIL_BYTES);
    whole = read.whole;
    all = read.text.split(/\r?\n/);

    // **The first line of a tail is usually half a line.** It is whatever the
    // read happened to start in the middle of, and a reader shown a fragment
    // presented as a log line has been shown something nobody wrote. Dropped —
    // and `truncated` is what says there are more above.
    if (!whole) all = all.slice(1);
  } catch {
    // No log is not an error: a supervisor that collects the output itself is
    // the ordinary deployment, and the answer says which file it looked in so
    // that "nothing there" is checkable rather than mysterious.
    return { file, lines: [], truncated: false };
  }

  // A trailing newline is how a line ends, not an empty line.
  if (all.at(-1) === '') all.pop();

  return {
    file,
    lines: all.slice(-wanted),
    truncated: !whole || all.length > wanted,
  };
}

/**
 * The last `cap` bytes of a file, and whether that was the whole of it.
 *
 * Positioned reads rather than a stream: this answers one question about one
 * offset, and a stream would pump the entire file through the event loop to
 * throw all but the end of it away.
 */
function tail(file: string, cap: number): { text: string; whole: boolean } {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - cap);
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    return { text: buffer.toString('utf8'), whole: from === 0 };
  } finally {
    closeSync(fd);
  }
}
