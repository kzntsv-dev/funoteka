import type { DatabaseSync } from './index.ts';

/**
 * Letting go of what a run did not see.
 *
 * Every table below `root` is derived from the filesystem, so a run that only
 * ever adds and updates leaves a library describing files that are not there.
 * What makes a row disposable is the stamp: the stage that writes a row also
 * records the run it wrote it in, and a row still carrying an older stamp is a
 * row this run did not see.
 *
 * That is one rule, but it was written out once per table across two modules,
 * and the sweep's exception — the amnesty for a subtree the walk met but could
 * not read — sat in a third place (task:2683). Which tables a stage sweeps
 * stays with the stage, because the sweep has to run after the walk that
 * re-stamps the rows it is about to judge, and the order *between* stages is
 * that chronology. The order *within* one sweep is not a choice a caller can
 * get wrong, so it lives here, with the predicate it is made of.
 *
 * The other reading of the same stamp — what a row says about a file that is
 * still there — is `ledger.ts`.
 */

/** A reference to a swept table that carries no ON DELETE CASCADE. */
interface Detach {
  /**
   * How the reference is let go of: `delete` when it cannot be released —
   * `track.file_id` is NOT NULL, so a track whose file is gone has nowhere left
   * to point — and `null` when the column is nullable and the referrer outlives
   * what it named.
   */
  action: 'delete' | 'null';
  /** The table holding the reference. */
  from: string;
  /** The column holding it. */
  column: string;
}

/** A table whose rows derive from the filesystem and belong to the run that wrote them. */
interface Derived {
  table: string;
  /**
   * Whether a row can predate the stamp itself.
   *
   * `last_seen_run_id` arrived on `folder`, `album` and `release` with migration
   * 005, so a row written before that carries none — and a row with no stamp is
   * one this run did not write, which is the same verdict as an old one. `file`
   * and `scan_state` have been stamped on every walk since 001, where a NULL
   * cannot happen.
   */
  lateStamp: boolean;
  /**
   * What must be let go of before this table's rows go.
   *
   * A reference declared with ON DELETE CASCADE is not listed, because the
   * delete carries it and a list of those would be a list that drifts the next
   * time a table is added. What is listed is what does not cascade — and order
   * is not cosmetic there: a plain delete of a file a surviving track still
   * names does not lose a row, it fails the whole run on the foreign key.
   */
  detach: readonly Detach[];
}

/**
 * The tables, in the order they may be emptied.
 *
 * `album` before `release`, because an album's `release_id` names a release and
 * a release emptied first would leave the albums of that box behind. The rest
 * is the order the two stages have always emptied their tables in, and it is
 * free to be arbitrary: nothing constrains `file` and `folder`, which are
 * joined by path rather than by key.
 */
const DERIVED: readonly Derived[] = [
  {
    table: 'file',
    lateStamp: false,
    detach: [
      { action: 'delete', from: 'track', column: 'file_id' },
      { action: 'null', from: 'cue', column: 'audio_file_id' },
    ],
  },
  { table: 'folder', lateStamp: true, detach: [] },
  { table: 'scan_state', lateStamp: false, detach: [] },
  { table: 'album', lateStamp: true, detach: [] },
  {
    table: 'release',
    lateStamp: true,
    // Belt and braces, and said plainly rather than dressed up: nothing reaches
    // this today. Every album that outlives the sweep above was re-derived from
    // a surviving folder on this run, and re-deriving an album writes its
    // `release_id` itself — so no surviving album can still name a doomed
    // release. Removing this changes no test. It stays because the foreign key
    // is declared without a cascade, and the cost of being wrong about the
    // reachability is a run that fails on its last step.
    detach: [{ action: 'null', from: 'album', column: 'release_id' }],
  },
];

/** What a walk leaves behind, and what the scan takes away when it is gone. */
export const SWEPT_BY_SCAN: readonly string[] = ['file', 'folder', 'scan_state'];

/** What classification derives from the folders the walk left standing. */
export const SWEPT_BY_CLASSIFY: readonly string[] = ['album', 'release'];

/** `root_id = ? AND <the stamp is not this run's>`, bound in that order. */
function vanished(derived: Derived): string {
  return derived.lateStamp
    ? 'root_id = ? AND (last_seen_run_id IS NULL OR last_seen_run_id <> ?)'
    : 'root_id = ? AND last_seen_run_id <> ?';
}

/**
 * A statement releasing one reference, scoped by the rows that are going.
 *
 * The table and the column are this module's own literals — never a caller's
 * string and never a name off disk — which is what makes interpolating them
 * here the same kind of statement the sweep was written as before.
 */
function releaseSql(detach: Detach, derived: Derived): string {
  const doomed = `(SELECT id FROM ${derived.table} WHERE ${vanished(derived)})`;
  return detach.action === 'delete'
    ? `DELETE FROM ${detach.from} WHERE ${detach.column} IN ${doomed}`
    : `UPDATE ${detach.from} SET ${detach.column} = NULL WHERE ${detach.column} IN ${doomed}`;
}

/**
 * The sweep of one stage, prepared once.
 *
 * Prepared rather than run per call because a scan asks this of every root it
 * walked, and one root's sweep is a handful of statements executed once against
 * a database that was just walked across.
 */
export interface Sweep {
  /**
   * Drop every row of the stage's tables under `rootId` that this run did not
   * stamp — except what lies under `kept`, and except what lies under `held`.
   *
   * `kept` is the amnesty, and it belongs in the same call rather than beside
   * it, because it is the same rule read the other way: a directory the walk met
   * and could not enter is not a directory that vanished, so nothing beneath it
   * was observed and nothing beneath it can be judged. The paths are subtrees
   * *below* the root — a walk that could not read the root itself reports that
   * as '', saw nothing at all, and leaves the caller with nothing to keep, which
   * is why this cannot express that case and the caller must not call it.
   *
   * Whole segments only: `Album` must not protect `Album 2`. Measured with
   * `substr` rather than `LIKE`, where `_` is a wildcard and perfectly legal in
   * a file name.
   *
   * **`held` is the third state, and the two stamps it needs are opposites.** A
   * file the walk met but did not record — one the half-write gate held back —
   * has not vanished, so its rows must survive this sweep; and this run did not
   * look at it, so it must not come out of here saying it did. One column cannot
   * hold both, so the row is stamped for the length of the delete and then given
   * its own stamp back. What the caller must not do is pass such a path as
   * `kept`: the amnesty is *read* as "the run stands behind this path" by every
   * stage that selects its work, which is right for a directory nobody could
   * enter and wrong for a file that is still being written.
   */
  run(rootId: number, runId: number, kept?: readonly string[], held?: readonly string[]): void;
}

export function prepareSweep(db: DatabaseSync, tables: readonly string[]): Sweep {
  const owned = DERIVED.filter((derived) => tables.includes(derived.table));

  const steps = owned.map((derived) => ({
    markSeen: db.prepare(
      `UPDATE ${derived.table} SET last_seen_run_id = ?
        WHERE root_id = ? AND (rel_path = ? OR substr(rel_path, 1, ?) = ?)`,
    ),
    // What a row of this table says before a held path is stamped, so the stamp
    // can be handed back afterwards. Read and written with the same matcher as
    // `markSeen`, so the two cannot come to disagree about which rows are which.
    // Keyed by the natural key rather than by `id`, which `folder` and
    // `scan_state` do not have: what every table here shares is `root_id` and
    // `rel_path`, which is why the matcher is spelled that way in the first place.
    remember: db.prepare(
      `SELECT rel_path, last_seen_run_id AS stamp FROM ${derived.table}
        WHERE root_id = ? AND (rel_path = ? OR substr(rel_path, 1, ?) = ?)`,
    ),
    restore: db.prepare(
      `UPDATE ${derived.table} SET last_seen_run_id = ? WHERE root_id = ? AND rel_path = ?`,
    ),
    detach: derived.detach.map((detach) => db.prepare(releaseSql(detach, derived))),
    drop: db.prepare(`DELETE FROM ${derived.table} WHERE ${vanished(derived)}`),
  }));

  return {
    run(rootId, runId, kept = [], held = []) {
      for (const step of steps) {
        // Before this table's rows are judged, not after: a row under a path the
        // walk could not enter has to say it was seen, or the delete below
        // reads it as gone. Each table is stamped before its own delete, which
        // is all the ordering the amnesty needs — nothing else reads the stamp
        // of another table mid-sweep.
        for (const path of kept) {
          const below = `${path}/`;
          step.markSeen.run(runId, rootId, path, below.length, below);
        }

        // A held path is stamped for the same reason and unstamped for the
        // opposite one: it has not vanished, and this run did not look at it.
        // What survives the delete is the row; what must not survive is the
        // claim, because that claim is the scope every stage selects its work
        // by. Restored after the delete rather than instead of it — a row whose
        // stamp says some older run is a row this delete would take.
        const wasSaid: { rel_path: string; stamp: number | null }[] = [];
        for (const path of held) {
          const below = `${path}/`;
          for (const row of step.remember.all(rootId, path, below.length, below)) {
            wasSaid.push(row as { rel_path: string; stamp: number | null });
          }
          step.markSeen.run(runId, rootId, path, below.length, below);
        }

        for (const statement of step.detach) statement.run(rootId, runId);
        step.drop.run(rootId, runId);

        for (const row of wasSaid) step.restore.run(row.stamp, rootId, row.rel_path);
      }
    },
  };
}
