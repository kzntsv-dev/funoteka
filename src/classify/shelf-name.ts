import { withTransaction, type DatabaseSync } from '../db/index.ts';
import { basenameOf, folderOf } from '../util/names.ts';

/** What the stage did, for the run report. */
export interface ShelfNameCounters {
  /** Shelves that turned out to say something beyond their artist. */
  shelves: number;
  /** Records whose name gained it. */
  named: number;
}

/**
 * Say which shelf a record came from — in the record's name, and last.
 *
 * A collector who keeps two rips of one album (`Slipknot AAC 320`,
 * `Slipknot ALAC`) has two records that agree about everything a client is
 * shown: the same title, the same artist, the same year. The only thing
 * separating them is the folder they sit in, and a folder is not a name. So
 * `We Are Not Your Kind` appeared three times in the operator's library with
 * nothing to choose between them.
 *
 * **Why this runs last, and not in `classify`.** Two reasons, and the second is
 * the one that decided it:
 *
 *   - The qualifier is the shelf's name *minus the artist's*, and the artist is
 *     something only the artist stage knows. `classify` writes no artists at
 *     all, deliberately, so a rule there had to guess the name from a sibling
 *     folder — a heuristic that named another artist's folder as this one's
 *     (`Nirvana (UK)` beside `Nirvana` gave `(UK)`) and could not see the
 *     ordinary `Artist/Shelf/CD1` layout at all. Here the artist is a fact.
 *   - It must not replace the name, only extend it. The name a record is shown
 *     by is the best one three stages could agree on — the folder's, improved
 *     by a tag, overruled by a cue — and a qualifier written earlier would
 *     either be thrown away by a later stage or force the *folder's* spelling
 *     on every shelf album. Measured: the shelves' albums carry tag names the
 *     folders do not (`Vol. 3: (The Subliminal Verses)` against `Vol. 3 (The
 *     Subliminal Verses)`), and forcing the folder's would have cost the
 *     collection every colon it has.
 *
 * Running after every stage that names anything means nothing can overrule it,
 * and it is re-derived every run like every other name here: the stages above
 * rewrite titles from the folder each time, so what arrives here is a fresh
 * name and not one this stage wrote a minute ago.
 *
 * **It appends to the record, not to the disc.** An album that belongs to a
 * release is a disc of it, and the record is what a client is shown — the
 * release's title carries the qualifier, and the disc keeps the name its own
 * folder states.
 */
export function nameShelfRecords(db: DatabaseSync): ShelfNameCounters {
  const counters: ShelfNameCounters = { shelves: 0, named: 0 };

  // Which folders are shelves. Read once: the albums below are looked up by
  // their parent's path, and a path is only a shelf in the root it belongs to.
  const roles = new Map<string, string | null>();
  const folderRows = db
    .prepare('SELECT root_id, rel_path, role FROM folder')
    .all() as { root_id: number; rel_path: string; role: string | null }[];
  for (const row of folderRows) roles.set(shelfKey(row.root_id, row.rel_path), row.role);

  const seen = new Set<string>();
  const renameAlbum = db.prepare('UPDATE album SET title = ?, title_source = ? WHERE id = ?');
  const renameRelease = db.prepare('UPDATE release SET title = ?, title_source = ? WHERE id = ?');

  const name = (rootId: number, shelfPath: string, artist: string | null): string | null => {
    if (roles.get(shelfKey(rootId, shelfPath)) !== 'category') return null;
    const qualifier = qualifierOf(basenameOf(shelfPath), artist);
    if (qualifier === null) return null;
    seen.add(shelfKey(rootId, shelfPath));
    return qualifier;
  };

  // The records that are albums: a shelf's own albums, and not its discs.
  const albums = db
    .prepare(
      `SELECT a.id, a.root_id, a.rel_path, a.title, ar.name AS artist
         FROM album a
         LEFT JOIN artist ar ON ar.id = a.artist_id
        WHERE a.release_id IS NULL`,
    )
    .all() as { id: number; root_id: number; rel_path: string; title: string | null; artist: string | null }[];

  // One transaction for both passes. Without it every rename below is its own
  // commit, and a commit is a disk flush: measured on the live collection, this
  // stage cost **902 ms** committing each and **13 ms** with the transaction
  // (task:2883). `db/index.ts` has the rule.
  withTransaction(db, () => {
    for (const row of albums) {
      const qualifier = name(row.root_id, folderOf(row.rel_path), row.artist);
      if (qualifier === null) continue;
      const title = qualified(row.title ?? '', qualifier);
      if (title === row.title) continue;
      renameAlbum.run(title, 'shelf', row.id);
      counters.named += 1;
    }

    // And the records that are releases: a shelf's disc set is one of these, and
    // its title is what a client is shown for the whole group.
    const releases = db
      .prepare(
        `SELECT r.id, r.root_id, r.rel_path, r.title, ar.name AS artist
           FROM release r
           LEFT JOIN artist ar ON ar.id = r.artist_id`,
      )
      .all() as {
      id: number;
      root_id: number;
      rel_path: string;
      title: string | null;
      artist: string | null;
    }[];

    for (const row of releases) {
      // A release's own artist is set by the artist stage from the credit its
      // discs agree on; when it has none — a compilation whose files name nobody
      // — any artist among its discs answers, because the shelf's name is what
      // is being subtracted and that is the same for all of them.
      const artist =
        row.artist ??
        ((
          db
            .prepare(
              `SELECT ar.name AS name FROM album a
                 JOIN artist ar ON ar.id = a.artist_id
                WHERE a.release_id = ? LIMIT 1`,
            )
            .get(row.id) as { name: string } | undefined
        )?.name ??
          null);

      // The shelf *is* the release's folder — that is what the classifier keys
      // it by — where an album's shelf is the folder above it.
      const qualifier = name(row.root_id, row.rel_path, artist);
      if (qualifier === null) continue;
      const title = qualified(row.title ?? '', qualifier);
      if (title === row.title) continue;
      renameRelease.run(title, 'shelf', row.id);
      counters.named += 1;
    }
  });

  counters.shelves = seen.size;
  return counters;
}

/** A folder is only the one meant when its root is, so the root is in the key. */
function shelfKey(rootId: number, relPath: string): string {
  return `${rootId}\u0000${relPath}`;
}

/**
 * What stands between an artist's name and the shelf's own word.
 *
 * The bullet is here for the same reason the dash is: this collection writes
 * `Кино ● Каталог Maschina Records`, and the bullet is a separator in exactly
 * the place a space would be. Left out of the class it became part of the note,
 * and every record under that shelf was named `… (● Каталог Maschina Records)` —
 * the separator carried into the name it was separating.
 */
const SEPARATOR = /^[\s\-_.●•]/;
const SEPARATOR_ALL = /^[\s\-_.●•]+/;

/**
 * What a shelf's name says beyond the artist it holds, or null.
 *
 * `Slipknot AAC 320` and `Slipknot ALAC` hold different rips of the same
 * records, and what tells them apart is `AAC 320` and `ALAC` — the artist's own
 * name is not part of the difference, and repeating it in every name is noise.
 *
 * A separator has to follow the artist's name, or `S` claims `Slipknot` and
 * `node-extract` claims `node-extract2` — both measured on the live root, as
 * `lipknot AAC 320` and `2`. Null when nothing is left over, which is the
 * answer for an artist's own folder: it has nothing to add to itself.
 */
function qualifierOf(shelfName: string, artistName: string | null): string | null {
  const shelf = shelfName.trim();
  const artist = (artistName ?? '').trim();
  if (artist === '' || !shelf.startsWith(artist)) return null;

  const rest = shelf.slice(artist.length);
  if (!SEPARATOR.test(rest)) return null;

  const spare = rest.replace(SEPARATOR_ALL, '').trim();
  return spare === '' ? null : spare;
}

/**
 * The name with the qualifier on the end, and never on twice.
 *
 * The stages above rewrite every title from the folder each run, so what
 * arrives here normally carries no qualifier — but a root the walk did not see
 * keeps the rows it had, this stage's among them, and a name that collected a
 * second `(AAC 320)` on every run would be a name nobody could read.
 *
 * The empty case is the last line's, and it is a guard rather than a path:
 * `base` is empty exactly when the title *is* the suffix — a leading space, the
 * qualifier, and its brackets, and nothing else. No stage writes a name like
 * that, and none of the 426 records of the live collection carries one: the only
 * title that is nothing but a bracket is `( )`, which has no leading space and
 * is no qualifier (measured 2026-09-13, task:2843). It is kept because the title
 * here can be a *tag's* — the one name this stage does not derive itself — and
 * a guard costs a line where a missing one costs a name.
 */
function qualified(title: string, qualifier: string): string {
  const suffix = ` (${qualifier})`;
  const base = title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
  return base === '' ? `(${qualifier})` : `${base}${suffix}`;
}
