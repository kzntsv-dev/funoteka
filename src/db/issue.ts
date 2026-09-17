import type { DatabaseSync } from './index.ts';

/**
 * The stages that file issues.
 *
 * A union rather than a free string, and the value is bound to the insert as
 * well as passed here — so the two cannot disagree. A stage name typed twice as
 * a literal is a stage name that drifts, and the drift is silent: a clear would
 * simply match nothing and restore the growth it exists to prevent.
 *
 * `classify` files no derived rows of its own — it is here because a failure in
 * it has to be recorded against its name, like any other stage of the chain.
 * See `run.ts`.
 */
export type Stage =
  | 'scan'
  | 'classify'
  | 'cues'
  | 'playlists'
  | 'artists'
  | 'tags'
  | 'shelves'
  | 'collisions'
  | 'search'
  | 'planner';

/**
 * Clear the issues a stage owns, so it can write the current run's.
 *
 * A stage that *derives* its rows must call this or it grows without bound:
 * every reader scopes by run, so an earlier run's rows are read by nobody and
 * removed by nobody. A collection rescanned daily grew one run's worth per day.
 *
 * A stage that records *events* must not. A healed root path and a twin whose
 * rows were dropped happen once, and an unchanged root raises nothing on the
 * next run — clearing would not replace those rows with an equal report, it
 * would delete the only record that the event happened.
 *
 * Which of the two a row is decides the scope, and there are three:
 *
 *   - the whole stage, for `cues` and `artists`, which walk every root on every
 *     run and re-derive all of it;
 *   - one kind, for `scan`, which does both: its root-settlement issues are
 *     events, while `walk_skipped` is re-read off the filesystem every time —
 *     the symlink it could not follow is still there next run;
 *   - one file, for `tags` and `playlists`, which re-read only the files the
 *     ledger reports changed or never read. Their rows describe the last
 *     attempt on that file, so the replacement is per file — and a file left
 *     unstamped on purpose (a permission error is transient, so the next scan
 *     retries) is reported again each run, which is exactly what a per-file
 *     clear keeps bounded.
 */
/**
 * Write a stage failure down, and say the run it belongs to is not ok.
 *
 * `scan_run.status` is a property of the whole run, and `scan` settles it when
 * its own walk is done — which is right for the walk and wrong for the run: the
 * stages after it can throw, and each rolls back only its own transaction, so
 * the database is left holding some stages and not others under a row that says
 * `ok`. A reader of that dump sees a healthy run over albums with no tracks, and
 * cannot tell it from a collection that really is that empty. The status is
 * settled here instead, and the failure is written down as well as raised:
 * stderr is gone by the time anyone opens the database.
 *
 * `scan` is the other caller, and the reason this cannot simply live in the run:
 * it throws before its transaction too — a statement that will not compile, a
 * disk that will not read — and the run row is inserted before that transaction,
 * so no rollback reaches it. The run id is what `scan` returns, so the caller
 * cannot file the failure either. Left unwritten, the database says the scan is
 * still going, indefinitely.
 *
 * The row is an *event*, not a derivation — nothing re-reads a stage failure off
 * the filesystem — so no stage clears it wholesale. It describes one attempt,
 * and it is scoped to the run that made it, which is what every reader scopes
 * by. A later run that succeeds supersedes it in the only sense that matters.
 */
export function recordStageFailure(
  db: DatabaseSync,
  runId: number,
  stage: Stage,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);

  db.prepare(
    `INSERT INTO issue (scan_run_id, stage, root_id, rel_path, kind, severity, detail)
     VALUES (?, ?, NULL, NULL, ?, 'warn', ?)`,
  ).run(runId, stage, `${stage}-failed`, `${stage} threw: ${message}`);

  db.prepare('UPDATE scan_run SET status = ? WHERE id = ?').run('failed', runId);
}

export function clearIssues(
  db: DatabaseSync,
  stage: Stage,
  scope: { kind?: string; rootId?: number; relPath?: string } = {},
): void {
  const conditions = ['stage = ?'];
  const values: (string | number)[] = [stage];

  if (scope.kind !== undefined) {
    conditions.push('kind = ?');
    values.push(scope.kind);
  }
  if (scope.rootId !== undefined) {
    conditions.push('root_id = ?');
    values.push(scope.rootId);
  }
  if (scope.relPath !== undefined) {
    conditions.push('rel_path = ?');
    values.push(scope.relPath);
  }

  db.prepare(`DELETE FROM issue WHERE ${conditions.join(' AND ')}`).run(...values);
}
