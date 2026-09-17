import { withTransaction, type DatabaseSync } from '../db/index.ts';

import { basenameOf } from '../util/names.ts';
import { unsaidNote } from './folder-name.ts';

/** What the stage did, for the run report. */
export interface CollisionNameCounters {
  /** Sets of records by one artist that would otherwise read identically. */
  groups: number;
  /** Records whose name gained a number. */
  numbered: number;
}

/**
 * Two records that read the same get a number, so a client shows two.
 *
 * The last resort, and it is deliberately the *last*: every other rule here tries
 * to say what distinguishes a record, and this one gives up on saying it and
 * merely makes the difference visible. Two folders of one Sigur Rós record —
 * eleven tracks against twelve, the Japanese bonus missing from one — carry the
 * same album tag, so every name the stages above could build for them is the same
 * name, and a client lists the record twice with nothing to choose between.
 *
 * `(1)` and `(2)` are not a claim about which is which. They are the honest
 * minimum: these are two, and which one a person keeps is a question about their
 * collection that the server has no business answering. The operator's rule for
 * the whole of this: show what the folder says, and if a person dislikes the
 * result they will go and tidy the folder.
 *
 * **Numbered by record, never by row.** `ALBUM_GROUPS` folds a box's discs into
 * one record, and this stage reads the same two sets that stage does — albums
 * that belong to no release, and releases — because numbering rows would put
 * `(1)` through `(10)` on the discs of one box.
 *
 * Only records an artist owns are numbered. A record with no artist appears on no
 * artist's page, so two of them reading alike is not something a client can be
 * shown; numbering them would invent a difference nobody sees.
 *
 * The order is the collection's own — path, then id — so the same unchanged
 * library numbers the same record `(1)` on every machine.
 */
export function numberCollidingRecords(db: DatabaseSync): CollisionNameCounters {
  const counters: CollisionNameCounters = { groups: 0, numbered: 0 };

  const albums = db
    .prepare(
      `SELECT id, title, artist_id, rel_path FROM album
        WHERE release_id IS NULL AND artist_id IS NOT NULL AND title IS NOT NULL`,
    )
    .all() as { id: number; title: string; artist_id: number; rel_path: string }[];
  const releases = db
    .prepare(
      `SELECT id, title, artist_id, rel_path FROM release
        WHERE artist_id IS NOT NULL AND title IS NOT NULL`,
    )
    .all() as { id: number; title: string; artist_id: number; rel_path: string }[];

  const byKey = new Map<string, { kind: 'album' | 'release'; id: number; base: string; relPath: string }[]>();
  const add = (kind: 'album' | 'release', id: number, title: string, artistId: number, relPath: string): void => {
    const base = title.replace(NUMBERED, '').trim();
    if (base === '') return;
    // Grouped by what a client is *shown*, not by the title a tag states.
    //
    // The two are not the same field, and this stage read the wrong one. A folder
    // writes the pressing beside the record — `1990 - Entreat [1991 issue AU
    // Warner 903174106-2]`, `1994 - … - Split (Cass, C60)` — and that note is
    // part of every name the record is shown by. A tag says `Entreat` three times
    // for three pressings, so this stage saw one name three times and numbered
    // them, and the note arrived afterwards and told them apart anyway. Sixteen
    // of the eighteen numbers it wrote were that: the collection had already
    // answered the question the number was asked to answer (task:2783).
    //
    // The note goes in as `unsaidNote` answers it — the same answer every name of
    // the record is built from — and not as the folder spells it. The folder's
    // spelling is finer: it keeps the pressing's own year, which each name drops,
    // so two pressings of one catalogue number would be told apart here and read
    // identically in the album list, with no number to separate them (task:2845).
    const key = `${artistId}\u0000${base}\u0000${unsaidNote(base, basenameOf(relPath)) ?? ''}`;
    const at = byKey.get(key) ?? [];
    at.push({ kind, id, base, relPath });
    byKey.set(key, at);
  };

  for (const row of albums) add('album', row.id, row.title, row.artist_id, row.rel_path);
  for (const row of releases) add('release', row.id, row.title, row.artist_id, row.rel_path);

  const renameAlbum = db.prepare('UPDATE album SET title = ?, title_source = ? WHERE id = ?');
  const renameRelease = db.prepare('UPDATE release SET title = ?, title_source = ? WHERE id = ?');

  // One transaction, and it is not a micro-optimisation. Without it every
  // rename below is its own commit, and a commit is a disk flush: measured on
  // the live collection, this stage cost **43 ms** committing each and **5 ms**
  // with the transaction. It renames a handful of records, so the writes were
  // never the cost — the commits were the whole of it (task:2883). `db/index.ts`
  // has the rule and `scan.ts` the same fix at a larger scale.
  withTransaction(db, () => {
    for (const set of byKey.values()) {
      if (set.length < 2) continue;
      counters.groups += 1;

      set.sort((a, b) => cmp(a.relPath, b.relPath) || a.id - b.id);
      for (const [at, record] of set.entries()) {
        const title = `${record.base} (${at + 1})`;
        if (record.kind === 'album') renameAlbum.run(title, 'collision', record.id);
        else renameRelease.run(title, 'collision', record.id);
        counters.numbered += 1;
      }
    }
  });

  return counters;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A number this stage put there on an earlier run.
 *
 * Stripped before numbering, for the reason `qualified` in `shelf-name.ts` gives:
 * a root the walk did not see keeps the rows it had, this stage's among them, and
 * a name that collected a second `(1)` on every run would be a name nobody could
 * read.
 */
const NUMBERED = / \((\d+)\)$/;
