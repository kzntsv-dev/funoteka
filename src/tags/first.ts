import type { DatabaseSync } from '../db/index.ts';

/**
 * The tags a song listing asks for, as one row of their own per file.
 *
 * A listing builds a `Child` per song, and eight of that payload's fields come
 * out of `file_tag`: the genre, the track artist, the two advisories that decide
 * `explicitStatus`, and the four ReplayGain numbers.
 *
 * **A page of five hundred songs costs 10.04 ms reading them the obvious way —
 * one correlated subquery per name — and 6.37 ms reading them off this row**,
 * measured 2026-09-16 on a copy of the live collection, the two statements
 * interleaved in one run (task:2925). The saving is 36% of the heaviest listing
 * route there is.
 *
 * **The shape was not the defect, and the measurement is why this is a table and
 * not a query rewrite.** Every alternative is worse: all eight as one
 * `json_group_object` is no faster and answers differently; a `LEFT JOIN` to a
 * derived pivot — the shape `ALBUM_GENRES` uses — cannot be restricted to the
 * page, so it materialises over the whole tag table and multiplies the page's
 * cost by an order of magnitude; a covering index `(file_id, name, position,
 * value)` is **thirteen times** worse when forced, and the planner will not
 * choose it because it gives up the free ordering; `WITHOUT ROWID` five times
 * worse. What is left is that eight seeks a song are eight seeks a song.
 *
 * So the values move out of the tag table and a file's row is joined the way
 * `audio_probe` already is: one primary-key lookup, one row a file. The join
 * itself is not quite free — the page without any tag columns at all is 6.56 ms
 * in a run that put the eight subqueries at 11.29 — but it is an order of
 * magnitude cheaper than asking the tag table, and it is what the 36% above is
 * made of.
 *
 * **The rule is the API's own and is written once**, in `SELECT` below: the
 * *first value by position* of each name, trimmed of the whitespace a tag can
 * hide in, an empty result counted as no value at all so that a second line
 * falls through to a first. `migrations/036_file_tag_first.sql` carries the
 * frozen copy of it for the backfill; this is the one that runs from here on.
 *
 * What is deliberately *not* here is a cheaper-looking `MIN(position)` beside a
 * bare `value`, which reads the value out of whichever row the aggregate
 * happened to keep — SQLite guarantees that only while the subquery holds
 * exactly one aggregate, so a later `COUNT(*)` added beside it would silently
 * turn the genre into an arbitrary row's genre. `albumGenres` in `meta.ts`
 * declines that form at length, and this declines it for the same reason.
 */

/** What a `Child` shows, and the tag each column is read from. */
const FIRST_TAGS: readonly (readonly [string, string])[] = [
  ['genre', 'genre'],
  ['artist', 'track_artist'],
  ['itunesadvisory', 'advisory_itunes'],
  ['rtng', 'advisory_mp4'],
  ['replaygain_track_gain', 'rg_track_gain'],
  ['replaygain_album_gain', 'rg_album_gain'],
  ['replaygain_track_peak', 'rg_track_peak'],
  ['replaygain_album_peak', 'rg_album_peak'],
];

const COLUMNS = FIRST_TAGS.map(([, column]) => column);

/**
 * The whitespace a tag value is measured through, spelled out.
 *
 * Not SQLite's one-argument `TRIM`, which removes spaces and leaves a tab — so a
 * tag holding `"\t"` would pass the emptiness guard and arrive at a client as a
 * genre nobody can see. `meta.ts` spells the same set beside `trimmed`, and
 * `migrations/036_file_tag_first.sql` spells it a third time for the backfill.
 *
 * **Three spellings, and only two of them are held together by a test.**
 * `test/tags-first.test.ts` compares this module against its own oracle, written
 * in the old subquery form; the migration's copy is compared to neither, and no
 * test can reach it — on a fresh database `file_tag` is empty, so its `INSERT`
 * selects nothing. The three were checked against each other by hand on a copy
 * of the live collection (3280 rows, no drift) and against the eight subqueries
 * on nineteen awkward synthetic shapes (no drift); what is missing is a way to
 * keep them honest without a person.
 */
const TRIMMED = `TRIM(ft.value, ' ' || CHAR(9) || CHAR(10) || CHAR(13) || CHAR(160) || CHAR(12288))`;

const NAMES = FIRST_TAGS.map(([name]) => `'${name}'`).join(', ');

/**
 * One file's row, from the tags it has now.
 *
 * `rn = 1` leaves one row per (file, name), so the `MAX` below has nothing to
 * choose between and is exact rather than arbitrary — the whole reason for the
 * window function.
 */
const SELECT = `
  SELECT ft.file_id,
         ${FIRST_TAGS.map(([name, column]) => `MAX(CASE WHEN ft.name = '${name}' THEN ft.value END) AS ${column}`).join(',\n         ')}
    FROM (SELECT ft.file_id, ft.name, ${TRIMMED} AS value,
                 ROW_NUMBER() OVER (PARTITION BY ft.file_id, ft.name ORDER BY ft.position) AS rn
            FROM file_tag ft
           WHERE ft.file_id = ? AND ft.name IN (${NAMES}) AND ${TRIMMED} <> '') ft
   WHERE ft.rn = 1
   GROUP BY ft.file_id`;

/**
 * The two statements the tags stage runs for each file it has just read.
 *
 * Prepared once and handed back rather than prepared per file, which is how
 * every other statement in that stage is treated: it is inside one
 * `BEGIN IMMEDIATE`, and the compiler is not what this should be spending the
 * write lock on.
 *
 * **Cleared before it is written, and not upserted.** A file whose genre tag was
 * taken out of it has to lose the genre — and a write that only inserts when
 * there is something to insert would leave the old row standing, because a file
 * with no tags of these eight names produces no row at all. Clearing first makes
 * "no row" and "no tags" the same thing, which is what a file nobody has read
 * has always been.
 */
export function firstTagStatements(db: DatabaseSync): {
  clear: ReturnType<DatabaseSync['prepare']>;
  write: ReturnType<DatabaseSync['prepare']>;
} {
  return {
    clear: db.prepare('DELETE FROM file_tag_first WHERE file_id = ?'),
    write: db.prepare(`INSERT INTO file_tag_first (file_id, ${COLUMNS.join(', ')}) ${SELECT}`),
  };
}

/**
 * The same pair, prepared and run, for one file.
 *
 * For a caller that has one file in hand and no reason to keep a statement
 * around — a test writing `file_tag` by hand and standing in for the scanner,
 * which is the only other thing that writes it. Both roads go through `SELECT`
 * above, so the rule has one spelling either way, and a test that wrote the tags
 * without writing this row would be describing a collection the scanner cannot
 * produce.
 *
 * It prepares both statements on every call, which is a cost a caller in a loop
 * should not pay: a fixture rebuilding many files wants `firstTagStatements`
 * once and its two statements inside the loop. The stage does exactly that.
 */
export function refreshFirstTags(db: DatabaseSync, fileId: number): void {
  const { clear, write } = firstTagStatements(db);
  clear.run(fileId);
  write.run(fileId);
}
