import { withTransaction, type DatabaseSync } from '../db/index.ts';
import { junkReason, type Verdict } from './rule.ts';

/**
 * The allow/block edit, and the one place a hand mark becomes a decision.
 *
 * `junk/rule.ts` decides what a folder is; this decides who is asked. The two
 * halves of the contract's filter are the scan's reading and the operator's
 * word, and the operator's wins — which is the same rule the project keeps for
 * every derived field (Q15, brainstorm:190): the *owner* decides, never whoever
 * wrote last.
 *
 * **A mark is re-applied on the spot rather than at the next scan.** The verdict
 * is stored on the album row, so that every listing can read it for nothing, and
 * a hand edit that only wrote the mark would take effect whenever the scanner
 * next ran — an operator who marked a folder and then looked at his client would
 * be looking at the old answer and would have no way to tell. So the mark is
 * written and the row is re-derived from the same function the scan uses, in one
 * transaction, and the two cannot disagree because there is one rule and one
 * caller of it.
 */

/** Where a mark goes, and what it says. `note` is for the person reading it back. */
export interface Mark {
  rootId: number;
  relPath: string;
  verdict: Verdict;
  note: string | null;
  markedAt: string;
}

/** What a folder is, as one line of a listing: the path, the verdict, and why. */
export interface Marked {
  rootId: number;
  rootPath: string;
  relPath: string;
  title: string | null;
  junkReason: string;
  source: 'scan' | 'hand';
}

/**
 * A filesystem path, as the root and relative path the meta layer keys on.
 *
 * The operator names a folder the way the disk does — `D:\music\Telegram
 * Desktop` — and identity here is `(root, rel_path)`. Resolution is by the
 * deepest root that contains the path, so a root inside another root still
 * answers about itself, and the comparison is on separators normalised to `/`
 * because that is what `scan/walk.ts` writes.
 *
 * Nothing is resolved by guessing: a path under no root is not an error about
 * the collection, it is a path this server has never heard of, and the caller is
 * told so by `undefined` rather than by a mark on something else.
 */
export function resolvePath(db: DatabaseSync, path: string): { rootId: number; relPath: string } | undefined {
  const normal = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const roots = db.prepare('SELECT id, path FROM root ORDER BY LENGTH(path) DESC').all() as {
    id: number;
    path: string;
  }[];

  for (const root of roots) {
    const prefix = root.path.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normal === prefix) return { rootId: root.id, relPath: '' };
    if (normal.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) {
      return { rootId: root.id, relPath: normal.slice(prefix.length + 1) };
    }
  }
  return undefined;
}

/**
 * The album a mark is about, and what the rule makes of the files under it.
 *
 * Both verbs below open with exactly this and differ only in the verdict they
 * hand the rule: a person's word for `mark`, nothing for `unmark`, which is how
 * the rule gets to speak again. It is written once because the refusal in it is
 * the part that must not drift — a path that names no album is a statement about
 * nothing, and both verbs owe the operator that sentence rather than a mark
 * quietly landing on something else.
 */
function albumAndReason(
  db: DatabaseSync,
  rootId: number,
  relPath: string,
  mark?: Verdict,
): { albumId: number; reason: string | null } {
  const row = db
    .prepare('SELECT id FROM album WHERE root_id = ? AND rel_path = ?')
    .get(rootId, relPath) as { id: number } | undefined;
  if (row === undefined) {
    throw new Error(`no album at that path: ${relPath === '' ? '(the root itself)' : relPath}`);
  }

  const files = db
    .prepare('SELECT kind FROM file WHERE root_id = ? AND folder_rel_path = ?')
    .all(rootId, relPath) as { kind: string }[];

  return { albumId: row.id, reason: junkReason(files, mark) };
}

/**
 * Record what a person said about a folder, and make it so at once.
 *
 * Returns the reason the album now carries, or null when there is none — so a
 * caller reads the outcome off one value instead of two: `trust` on a folder the
 * rule would hide gives null, and `junk` on anything at all gives the sentence
 * the listings are keeping it out by. What differs between the two verdicts is
 * *which* answer comes back, not whether one does.
 *
 * A folder that is not an album at all is refused by name: the mark is keyed on
 * a path, and a path with no album row under it is a statement about nothing —
 * a typo the operator would otherwise never hear about.
 */
export function mark(db: DatabaseSync, rootId: number, relPath: string, verdict: Verdict, note: string | null): string | null {
  const { albumId, reason } = albumAndReason(db, rootId, relPath, verdict);

  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO junk_mark (root_id, rel_path, verdict, note, marked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (root_id, rel_path) DO UPDATE SET
         verdict   = excluded.verdict,
         note      = excluded.note,
         marked_at = excluded.marked_at`,
    ).run(rootId, relPath, verdict, note, new Date().toISOString());

    db.prepare('UPDATE album SET junk_reason = ? WHERE id = ?').run(reason, albumId);
  });

  return reason;
}

/**
 * Take a hand mark back, and let the rule speak again.
 *
 * The third verb, and the one that makes the other two reversible: `block` and
 * `allow` write a person's word over the rule's, and without this there is no
 * way to withdraw it — the album would carry "marked junk by hand" for ever, in
 * a database nobody remembers to edit.
 *
 * The row is re-derived here exactly as `mark` re-derives it, from the same
 * function and in the same transaction, so the two cannot disagree about what a
 * folder is: one rule, one caller of it, whichever way the mark moved.
 */
export function unmark(db: DatabaseSync, rootId: number, relPath: string): string | null {
  const { albumId, reason } = albumAndReason(db, rootId, relPath);

  withTransaction(db, () => {
    db.prepare('DELETE FROM junk_mark WHERE root_id = ? AND rel_path = ?').run(rootId, relPath);
    db.prepare('UPDATE album SET junk_reason = ? WHERE id = ?').run(reason, albumId);
  });

  return reason;
}

/**
 * The hand edits themselves, whether or not they hid anything.
 *
 * `hidden` answers "what is being kept out", which is not the same list: an
 * `allow` on a folder the rule would have hidden keeps nothing out, and it is
 * exactly the mark an operator wants to find again to take back. Listing the
 * marks is also how a deployment's own judgement becomes readable — the rule's
 * answers are derivable from the files, and these are not.
 */
export function marks(db: DatabaseSync): (Mark & { rootPath: string })[] {
  return (
    db
      .prepare(
        `SELECT m.root_id AS rootId, r.path AS rootPath, m.rel_path AS relPath,
                m.verdict AS verdict, m.note AS note, m.marked_at AS markedAt
           FROM junk_mark m JOIN root r ON r.id = m.root_id
          ORDER BY r.path, m.rel_path`,
      )
      .all() as { rootId: number; rootPath: string; relPath: string; verdict: Verdict; note: string | null; markedAt: string }[]
  );
}

/**
 * Every album the filter is keeping out, and why it is out.
 *
 * The reason and the source both, because "hidden" alone is not checkable: a
 * rule that overreached and a person who marked something look identical from a
 * count, and the difference is the whole of what an operator checking the
 * filter's work needs. `source` is the album's own reason matching the hand
 * mark's text — the two readings are distinguishable because `rule.ts` writes
 * one sentence and the mark writes another, and neither is ever a substring of
 * the other.
 */
export function hidden(db: DatabaseSync): Marked[] {
  return (
    db
      .prepare(
        `SELECT al.root_id AS rootId, r.path AS rootPath, al.rel_path AS relPath,
                al.title AS title, al.junk_reason AS junkReason,
                EXISTS (SELECT 1 FROM junk_mark m
                         WHERE m.root_id = al.root_id AND m.rel_path = al.rel_path
                           AND m.verdict = 'junk') AS marked
           FROM album al JOIN root r ON r.id = al.root_id
          WHERE al.junk_reason IS NOT NULL
          ORDER BY r.path, al.rel_path`,
      )
      .all() as { rootId: number; rootPath: string; relPath: string; title: string | null; junkReason: string; marked: number }[]
  ).map((row) => ({
    rootId: row.rootId,
    rootPath: row.rootPath,
    relPath: row.relPath,
    title: row.title,
    junkReason: row.junkReason,
    source: row.marked === 1 ? ('hand' as const) : ('scan' as const),
  }));
}
