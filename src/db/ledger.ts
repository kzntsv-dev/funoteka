import type { DatabaseSync } from './index.ts';

/**
 * The ledger: what the last walk observed of each file, and what that is worth.
 *
 * `scan_state` is written by the scan and read by stages that own nothing of
 * it. Tags asks which files need reading, the cue stage whether a stored
 * measurement is still good, the dump whether a run found anything unmoved —
 * and each of them used to join the table and decide for itself what `changed`
 * and the run stamp meant, which made one rule with four copies (task:2683).
 * The key, the verdict, and the currency of a verdict live here; a reader asks
 * for the fragment it needs by the alias it gave the ledger.
 *
 * The sweep of the same table is the other reading of the same stamp, and lives
 * in `sweep.ts`: this module asks what a row says about a file that is still
 * there, that one asks what to do with a row whose file is not.
 */

/**
 * Join a file to the ledger entry describing it.
 *
 * A file and its entry are keyed alike — the root and the relative path — and
 * that pair is the whole of the relationship, so it is written once and asked
 * for by alias. Whether the caller writes `JOIN` or `LEFT JOIN` stays the
 * caller's business: a file the walk has not seen twice has no entry at all,
 * and whether that disqualifies it depends on the question being asked.
 */
export function ledgerEntry(file: string, ledger: string): string {
  return `${ledger}.root_id = ${file}.root_id AND ${ledger}.rel_path = ${file}.rel_path`;
}

/**
 * The recorded verdict that the filesystem reported the file exactly as the
 * previous observation left it.
 *
 * Read, never recomputed. The comparison against the filesystem happened once,
 * in the walk, where the size and the mtime were already in hand — `movedSince`
 * is that comparison, and a reader that made it again would be stat-ing a file
 * the walk has just walked. False for a file with no entry: nothing was
 * observed, so nothing is known to be unchanged.
 */
export function unmoved(ledger: string): string {
  return `${ledger}.changed = 0`;
}

/** The recorded verdict that the file moved since the previous observation. */
export function moved(ledger: string): string {
  return `${ledger}.changed = 1`;
}

/**
 * The currency of a verdict: the entry was written by the run that last walked
 * this file's root.
 *
 * A verdict is only worth anything while the run that wrote it is the run that
 * last walked *that root*: naming one root in an invocation says nothing about
 * another, and a verdict from a run that never saw the file would be worse than
 * none. Asking for this is the caller's call — a stored whole-file duration is
 * forgiven a stale verdict, the closing bound of a cue split is not.
 */
export function current(ledger: string): string {
  const earlier = `earlier_${ledger}`;
  return (
    `${ledger}.last_seen_run_id = ` +
    `(SELECT MAX(${earlier}.last_seen_run_id) FROM scan_state ${earlier} ` +
    `WHERE ${earlier}.root_id = ${ledger}.root_id)`
  );
}

/**
 * An observation of a file, in the spelling the ledger row uses.
 *
 * Snake, because this is what a `SELECT` off `scan_state` hands back and what
 * gets written into it — and because spelling it twice, once per side of the
 * comparison, is what these two interfaces are here to keep honest.
 */
interface Observation {
  size: number;
  mtime_ms: number;
}

/** The same observation as the walk reports it, which spells the two camel. */
interface Observed {
  size: number;
  mtimeMs: number;
}

/**
 * Did the file move since the ledger recorded it?
 *
 * The comparison behind `changed`, and the only place it is made. It is then
 * *stored* rather than left to readers, because the walk has already read the
 * filesystem's answer and every later stage would have to read it again to
 * reach the same verdict — which is the whole cost the ledger exists to avoid.
 * A file the ledger holds no observation of has moved as far as anyone knows.
 */
export function movedSince(previous: Observation | undefined, observed: Observed): boolean {
  return previous === undefined || previous.size !== observed.size || previous.mtime_ms !== observed.mtimeMs;
}

/**
 * How many files the given run found exactly as the previous one left them.
 *
 * Scoped by the run named, not by the root: this answers "what did this run
 * report", which is what a dump of that run is about.
 */
export function unchangedCount(db: DatabaseSync, runId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM scan_state WHERE last_seen_run_id = ? AND ${unmoved('scan_state')}`)
    .get(runId) as { n: number };
  return row.n;
}
