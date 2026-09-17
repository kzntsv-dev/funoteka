import { splitCredit } from '../artist/credit.ts';
import { artistName, artistOwning } from '../artist/name.ts';
import type { DatabaseSync } from '../db/index.ts';
import { basenameOf } from '../util/names.ts';
import type { Visibility } from './visibility.ts';

/**
 * The meta layer, as the API reads it.
 *
 * Routes answer in the protocol's shapes; the SQL that reaches the classified
 * collection lives here. That split is what lets a route's file be about the
 * protocol and this one about the library, and it is why the API's reads can be
 * read in one place when the question is "what does the server know".
 *
 * Read-only, and it stays that way. The classified model has one author — the
 * scanner — and a second writer of *that* would make the database describe two
 * collections. The listener's own rows are not the model and are not written
 * here: playlists are `src/playlist/store.ts` and the marks are
 * `src/annotation/store.ts` — the two writers this server has.
 *
 * Identity is the path, so nothing here merges: two rows are two rows, and two
 * albums that read the same are still two albums, exactly as the contract's
 * first rule requires.
 */

/**
 * Rows in the shape this module declares them.
 *
 * The driver hands back an untyped record per row, and the two casts below are
 * the whole of the seam: every declared shape is a claim about the SQL right
 * beside it, checkable by reading the two together, and nothing else in the API
 * has to know the driver's type.
 */
function rows<T>(db: DatabaseSync, sql: string, ...args: (string | number)[]): T[] {
  return db.prepare(sql).all(...args) as unknown as T[];
}

function row<T>(db: DatabaseSync, sql: string, ...args: (string | number)[]): T | undefined {
  return db.prepare(sql).get(...args) as unknown as T | undefined;
}

/**
 * One query for a page of ids, answered in the order the ids were asked for.
 *
 * A page of ids is ranked already — a search's by relevance, a listing's by its
 * own sort — and asking for them one at a time is not that request repeated: it
 * is a separate execution of the whole select per id. `ALBUM_SELECT` carries the
 * genre window table, so on a search page that difference is measured in
 * seconds. See `albumsById`.
 *
 * SQLite answers a set, so the order comes back from the caller's list, which is
 * the only place it is known. An id that names nothing drops out rather than
 * becoming a hole — but *what* names nothing is the caller's query and not this
 * function's. `albumsById` matches a row's own `id`, while `album` resolves the
 * group, so a box's second disc opens the record through one and drops out of
 * the other. Both are answering the question they were asked; a caller that
 * wants a disc's id to open its record asks the way `album` does.
 */
function byIds<T extends { id: number }>(ids: number[], query: (placeholders: string) => T[]): T[] {
  if (ids.length === 0) return [];

  const found = query(ids.map(() => '?').join(', '));
  const byId = new Map(found.map((found) => [found.id, found]));
  return ids.flatMap((id) => {
    const found = byId.get(id);
    return found === undefined ? [] : [found];
  });
}

// Scan bookkeeping -----------------------------------------------------------

export interface ScanStatus {
  scanning: boolean;
  count: number;
}

/**
 * Whether a scan is running, and how big the library is.
 *
 * `count` is the audio files the meta layer holds rather than every file the
 * walk met: the covers, cue sheets and logs beside a record are the scanner's
 * business and never become a song a client could ask for, so a count that
 * included them would describe a library larger than the one the client sees.
 *
 * `scanning` reads the last run's status rather than answering `false`: a scan
 * that died without settling its row would otherwise be reported as finished,
 * and a client that polled this to decide when to refresh would wait forever.
 */
export function scanStatus(db: DatabaseSync): ScanStatus {
  const run = row<{ status: string }>(db, 'SELECT status FROM scan_run ORDER BY id DESC LIMIT 1');

  return {
    scanning: run?.status === 'running',
    count: count(db, "SELECT COUNT(*) AS n FROM file WHERE kind = 'audio'"),
  };
}

export function count(db: DatabaseSync, sql: string, ...args: (string | number)[]): number {
  return row<{ n: number }>(db, sql, ...args)?.n ?? 0;
}

// Artists --------------------------------------------------------------------

export interface ArtistRow {
  id: number;
  name: string;
  /** The fold key: what the virtual tree matches a folder's name against. */
  name_key: string;
  sort_key: string | null;
  album_count: number;
  /** The listener's marks on this artist. See `SongRow.starred_at`. */
  starred_at: string | null;
  rating: number | null;
  /**
   * What this artist is in the library — see `rolesOf`.
   *
   * Filled by every selector below rather than left to the caller, because a
   * client buckets its views by it and an artist described without its roles in
   * one listing and with them in another is two answers to one question.
   */
  roles: string[];
}

/**
 * The roles an artist has in this library, as OpenSubsonic lists them.
 *
 * `ArtistID3.roles` is "the list of all roles this artist has in the library",
 * and a client groups its views by it: the operator's Symfonium has an "album
 * artists" view and a "composers" one, and the second came up empty — because
 * this server sent no roles at all, so no artist was a composer or anything
 * else (task:2896).
 *
 * **Two roles are claimed, and only two are derivable honestly.** `albumartist`
 * for an artist a record is credited to — owning it, or credited on it beside
 * somebody else, which is what `artist_credit` is for — and `artist` for one
 * credited on a track. In this model a record's artist *is* its tracks' artist,
 * so the second follows from the first and there is no second lookup behind it.
 *
 * **`composer` is deliberately not among them.** This collection states a
 * composer on 80 files of 3350, in sixteen distinct names, and **one** of those
 * names is an artist this library knows: the rest are people who would have to
 * exist as artists before a role could put them in a list. Matching a composer
 * tag's *value* — a credit string, `Виктор Цой & Кино` — against artist names is
 * the kind of guessing `artist/credit.ts` exists to avoid, and one wrong match
 * here does not lose a picture, it moves an artist into a view it is not in.
 *
 * Asked once for a whole page rather than once per artist: a listing is a page,
 * and a query per row is the shape `search3` was already fixed for.
 */
export function rolesOf(db: DatabaseSync, ids: number[]): Map<number, string[]> {
  const roles = new Map<number, string[]>();
  if (ids.length === 0) return roles;

  const placeholders = ids.map(() => '?').join(', ');
  const stated = rows<{ artist_id: number; role: string }>(
    db,
    `SELECT stated.artist_id, stated.role FROM (
       SELECT artist_id, 'albumartist' AS role FROM album WHERE artist_id IS NOT NULL
       UNION SELECT artist_id, 'albumartist' FROM artist_credit
       UNION SELECT artist_id, 'artist' FROM track_credit
       UNION SELECT artist_id, 'artist' FROM album WHERE artist_id IS NOT NULL
     ) stated WHERE stated.artist_id IN (${placeholders})`,
    ...ids,
  );

  for (const { artist_id, role } of stated) {
    const held = roles.get(artist_id);
    if (held === undefined) roles.set(artist_id, [role]);
    else if (!held.includes(role)) held.push(role);
  }
  // One order for one set of roles, so that two listings of the same artist
  // cannot differ in a field a client compares.
  for (const held of roles.values()) held.sort();
  return roles;
}

/** The same rows with their roles attached, in one query for the page. */
function attachRoles(db: DatabaseSync, all: ArtistRow[]): ArtistRow[] {
  const roles = rolesOf(
    db,
    all.map((one) => one.id),
  );
  return all.map((one) => ({ ...one, roles: roles.get(one.id) ?? [] }));
}

/**
 * The artists a client can browse to, which is those owning at least one record.
 *
 * An artist known only from a credit — a guest on a compilation, the audience on
 * a live disc — is a real credit and a dead end: a client that opened them would
 * find nothing to play. `artist_credit` keeps them; the index does not offer
 * them.
 *
 * The count is of *records*, through the group's representative, so it is the
 * number of entries `albumsOfArtist` will actually list — a box counts once, not
 * once per disc.
 */
export function artists(
  db: DatabaseSync,
  rootId?: number,
  visibility: Visibility = 'records',
): ArtistRow[] {
  const all = attachRoles(
    db,
    rows<ArtistRow>(
      db,
      `SELECT ar.id, ar.name, ar.name_key, ar.sort_key, aa.starred_at, aa.rating,
            COUNT(*) AS album_count
       FROM artist ar
       LEFT JOIN artist_annotation aa ON aa.artist_id = ar.id
       JOIN (
         SELECT COALESCE(rel.artist_id, rep.artist_id) AS artist_id
           FROM ${ALBUM_GROUPS} grp
           JOIN album rep ON rep.id = grp.id
           LEFT JOIN release rel ON rel.id = rep.release_id
          WHERE grp.rn = 1${recorded(visibility)}
       ) record ON record.artist_id = ar.id
      GROUP BY ar.id
      ORDER BY COALESCE(ar.sort_key, ar.name), ar.id`,
    ),
  );

  const owned = ownedArtistKeys(db, all, rootId);
  for (const key of albumArtistKeys(db, rootId)) owned.add(key);
  return all.filter((row) => owned.has(row.name_key));
}

/**
 * The artists the collection's own `albumartist` tags name.
 *
 * This is a second way onto the list, and it was the operator's call after the
 * first one left out somebody real. `Виктор Цой` leads Кино, his records are
 * filed in Кино's folder, and no rule reading folders will ever offer him — but
 * the files themselves say `albumartist = Виктор Цой`, and that tag is the
 * statement "this record is his".
 *
 * What buys it its place is what it *refuses*. The rule it replaces would have
 * admitted every artist who is the only credit on a record, and that admits
 * `All Out Life` — a single whose folder name parsed as an artist while its
 * files say `albumartist = Slipknot`. It would have admitted `Merzbow`, whose
 * split carries no `albumartist` at all, only `artist = Merzbow & Cock E.S.P.`:
 * a track credit saying who plays, not whose record it is. Neither has the tag.
 *
 * The operator weighed the cost and took it: the list grows by the tags' own
 * words, which is how `Various Artists` and the series' names arrive beside the
 * performers. That is the trade this makes — the folder still decides, and now
 * a tag may also nominate. See `wiki:3590` for the boundary argument this
 * replaces, and [[task:2822]] for the decision to cross it.
 */
function albumArtistKeys(db: DatabaseSync, rootId?: number): Set<string> {
  const values =
    rootId === undefined
      ? rows<{ value: string }>(
          db,
          `SELECT DISTINCT ft.value AS value
             FROM file_tag ft JOIN file f ON f.id = ft.file_id
            WHERE ft.name = 'albumartist'`,
        )
      : rows<{ value: string }>(
          db,
          `SELECT DISTINCT ft.value AS value
             FROM file_tag ft JOIN file f ON f.id = ft.file_id
            WHERE ft.name = 'albumartist' AND f.root_id = ?`,
          rootId,
        );

  const keys = new Set<string>();
  for (const { value } of values) {
    for (const name of namesInTag(value)) {
      const key = artistName(name).key;
      if (key !== '') keys.add(key);
    }
  }
  return keys;
}

/**
 * The names one tag value holds.
 *
 * `splitCredit` reads the joiners a track credit uses — the symbols, and the
 * whole words — and a comma is not among them. What a comma would break is
 * `Cure, The`, where the article has moved to the tail and the name is still
 * one name; that rule lives in `name.ts`, not in `credit.ts`, and an earlier
 * version of this comment credited `splitCredit` with a decision it never made.
 *
 * A tag that lists two artists writes them with a comma, and the operator
 * confirmed both count: `Аквариум, Kyiv Virtuosi` is two artists, not one
 * called that. So this reader splits them, after `splitCredit` has taken the
 * joiners — having a tag that is a list rather than a name.
 *
 * The split is unguarded, and `Earth, Wind & Fire` would come out as two
 * artists. Nothing in this collection is spelled that way — the one comma among
 * the fourteen values is a list — but the rule is not safe beyond the collection
 * that produced it, and a test pinning a `Cure, The`-shaped tag would say so.
 */
function namesInTag(value: string): string[] {
  return splitCredit(value)
    .flatMap((entry) => entry.name.split(','))
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/**
 * The artists that own a folder of their own.
 *
 * One of the two ways onto the list — `albumArtistKeys` is the other, and
 * `artists` unions them. This one is the older and the stricter: a folder named
 * for the artist is the artist's, and so is a folder with a shelf's tail on it,
 * `Slipknot AAC 320`.
 *
 * On its own it left out somebody real, and the arguments above it are where
 * that used to be justified. This collection credits eleven different acts
 * across the splits filed in `Cock E.S.P/`, one Slipknot single to `All Out
 * Life`, and four Кино records to `Виктор Цой` — and every one of those is
 * reachable through the folder their record sits in, which is why the rule read
 * as sufficient. `Виктор Цой` is the case that showed it was not: he leads
 * Кино, his records are filed in Кино's folder, and the files say
 * `albumartist = Виктор Цой`. A tag offers him; this function never would.
 *
 * What it still decides is everything it always did — which folders fold into
 * which artist's node, and so which folder names can offer an artist at all.
 */
function ownedArtistKeys(
  db: DatabaseSync,
  all: readonly ArtistRow[],
  rootId?: number,
): Set<string> {
  const keys = all.map((row) => row.name_key);
  const tops =
    rootId === undefined
      ? rows<{ rel_path: string }>(
          db,
          `SELECT rel_path FROM folder WHERE parent_rel_path = '' AND role <> 'empty'`,
        )
      : rows<{ rel_path: string }>(
          db,
          `SELECT rel_path FROM folder WHERE root_id = ? AND parent_rel_path = '' AND role <> 'empty'`,
          rootId,
        );

  const owned = new Set<string>();
  for (const top of tops) {
    const owner = artistOwning(basenameOf(top.rel_path), keys);
    if (owner !== null) owned.add(owner);
  }
  return owned;
}

/** One folder worth looking in, and the order the caller built the list in. */
export interface FolderRef {
  rootId: number;
  relPath: string;
}

/**
 * The folders that are an artist's own — the ones named for them.
 *
 * Whose a folder is follows the rule `ownedArtistKeys` above and `virtualNodes`
 * keep: a folder whose name opens with the artist's name belongs to that artist.
 * Here it comes with an order. `Slipknot`, `Slipknot AAC 320` and `Slipknot
 * ALAC` all belong to Slipknot, and the one spelled exactly like the artist
 * comes first — it is the one a picture of the artist, or a note about them,
 * would have been put in; the shelves behind it are asked only when it holds
 * nothing.
 *
 * Two readers want this and neither owns it: `cover.ts` asks it where an
 * artist's picture is, and `artistinfo.ts` where their `artist.nfo` is. It is
 * the same folder both times, and the same rule `ownedArtistKeys` already
 * states — so it is stated once, here, rather than once per reader.
 */
export function artistOwnFolders(db: DatabaseSync, artistId: number): FolderRef[] {
  const row = artist(db, artistId);
  if (row === undefined) return [];

  const exact: FolderRef[] = [];
  const shelved: FolderRef[] = [];
  for (const root of roots(db)) {
    for (const folder of childFolders(db, root.id, '')) {
      if (folder.role === 'empty') continue;

      const name = basenameOf(folder.rel_path);
      if (artistOwning(name, [row.name_key]) !== row.name_key) continue;

      const where: FolderRef = { rootId: root.id, relPath: folder.rel_path };
      if (artistName(name).key === row.name_key) exact.push(where);
      else shelved.push(where);
    }
  }

  return [...exact, ...shelved];
}

/** A file on disk: the root it sits under, and its path within that root. */
export interface FileRef {
  rootPath: string;
  relPath: string;
}

/**
 * The `artist.nfo` sitting in a folder, when the collection has one there.
 *
 * The scan records the file and never parses it, which is what makes this a
 * path rather than a column: what the document says is read where it is asked
 * for, and the meta layer's part is only to say which file that is.
 */
export function artistNfoIn(db: DatabaseSync, where: FolderRef): FileRef | null {
  const found = row<{ rel_path: string; root_path: string }>(
    db,
    `SELECT f.rel_path, r.path AS root_path
       FROM file f JOIN root r ON r.id = f.root_id
      WHERE f.root_id = ? AND f.folder_rel_path = ? AND f.name = 'artist.nfo'`,
    where.rootId,
    where.relPath,
  );
  return found === undefined ? null : { rootPath: found.root_path, relPath: found.rel_path };
}

/** One artist row, by whatever names them — an id, or the fold of their name. */
function artistWhere(
  db: DatabaseSync,
  column: 'ar.id' | 'ar.name_key',
  value: string | number,
  visibility: Visibility = 'records',
): ArtistRow | undefined {
  const found = row<ArtistRow>(
    db,
    `SELECT ar.id, ar.name, ar.name_key, ar.sort_key, aa.starred_at, aa.rating,
            COUNT(grp.id) AS album_count
       FROM artist ar
       LEFT JOIN artist_annotation aa ON aa.artist_id = ar.id
       LEFT JOIN album al ON al.artist_id = ar.id
       LEFT JOIN ${ALBUM_GROUPS} grp ON grp.id = al.id AND grp.rn = 1${recorded(visibility)}
      WHERE ${column} = ?
      GROUP BY ar.id`,
    value,
  );
  if (found === undefined) return undefined;

  return { ...found, roles: rolesOf(db, [found.id]).get(found.id) ?? [] };
}

export function artist(db: DatabaseSync, id: number): ArtistRow | undefined {
  return artistWhere(db, 'ar.id', id);
}

/**
 * The artist a folded name belongs to, when the collection has one.
 *
 * Offering and answering are different questions, and this is the second one.
 * `artists` above is who a client can browse to; this answers about a name some
 * other row already holds — a credit on a record, or the drawer an artist's
 * folder gathers — whether or not that name is offered.
 *
 * `Виктор Цой` needed both, and needed only the second before the albumartist
 * tag earned him a place in the list. That is the difference worth keeping
 * straight: being answerable never depended on being offered.
 */
export function artistByKey(db: DatabaseSync, nameKey: string): ArtistRow | undefined {
  return artistWhere(db, 'ar.name_key', nameKey);
}

/**
 * The same answer for a page of ids, in one query.
 *
 * The plural of `artist`, for the reason `byIds` gives: a search's artist
 * section is twenty ranked ids, and twenty executions of the join above is
 * twenty of the same answer.
 *
 * **The count goes through the group, and leaving it out is not a smaller
 * version of the same answer.** Counting `album.id` counted every disc of every
 * box: a search page said `albumCount: 2` beside an artist whose page listed one
 * record, and a client that reconciled the two had no way to tell which was
 * lying. Both numbers being the same ordinal in the same payload is the whole
 * contract between the search and the artist page, so this reads exactly what
 * `artist` above reads.
 */
export function artistsById(db: DatabaseSync, ids: number[]): ArtistRow[] {
  return attachRoles(
    db,
    byIds(ids, (placeholders) =>
      rows<ArtistRow>(
        db,
        `SELECT ar.id, ar.name, ar.name_key, ar.sort_key, aa.starred_at, aa.rating,
              COUNT(grp.id) AS album_count
         FROM artist ar
         LEFT JOIN artist_annotation aa ON aa.artist_id = ar.id
         LEFT JOIN album al ON al.artist_id = ar.id
         LEFT JOIN ${ALBUM_GROUPS} grp ON grp.id = al.id AND grp.rn = 1
        WHERE ar.id IN (${placeholders})
        GROUP BY ar.id`,
        ...ids,
      ),
    ),
  );
}

// Albums ---------------------------------------------------------------------

export interface AlbumRow {
  id: number;
  root_id: number;
  rel_path: string;
  title: string | null;
  /** The listener's marks on this record. See `SongRow.starred_at`. */
  starred_at: string | null;
  rating: number | null;
  artist_id: number | null;
  artist_name: string | null;
  artist_sort: string | null;
  release_title: string | null;
  disc_number: number | null;
  /** The year the folder's name states, or the one a file's DATE did. */
  year: number | null;
  /**
   * The genre the record's files state, or null when none of them states one.
   *
   * A separate question from the *year* beside it, which the scanner stores on
   * the album row and this only reads. There is no genre column and this is not
   * an oversight: a genre is what a file says, so it is asked of the files every
   * time rather than copied up — and a copied one would go stale the moment a
   * file's tags were edited, with nothing to say it had.
   */
  genre: string | null;
  song_count: number;
  duration_ms: number | null;
}

/**
 * The characters taken off the edge of a genre value, for a named alias.
 *
 * **`TRIM(X)` is not enough and this was wrong at first.** SQLite's one-argument
 * `TRIM` removes space and nothing else — not a tab, not a newline, not a
 * non-breaking space — so a file stating `"Rock\t"` would still list as a second
 * genre beside `"Rock"`, and a value that was *only* a tab would pass the
 * emptiness guard and be listed as a genre whose name is invisible. The set is
 * spelled out here so that the claim the comments make is the claim the code
 * keeps.
 *
 * A function of the alias rather than one string, because the same expression
 * has to hold in more than one place at once — the list's group key, both
 * lookups, and the album predicate — and the agreement between those is the
 * whole contract the two methods have: a client hands back a value it was given,
 * and a genre that lists but cannot be opened is the failure that prevents.
 */
const trimmed = (alias: string): string =>
  `TRIM(${alias}.value, ' ' || CHAR(9) || CHAR(10) || CHAR(13) || CHAR(160) || CHAR(12288))`;

/**
 * Which record an album row belongs to, as one value two rows compare equal by.
 *
 * A function of the alias because three queries group by it and they have to
 * agree; a fourth spelling of the same rule is how a listing and a count come to
 * disagree.
 *
 * **The prefix is not decoration.** `album.id` and `release.id` are two
 * independent `INTEGER PRIMARY KEY` sequences, so a bare
 * `COALESCE(release_id, id)` puts the standalone album `al:9` in the group of
 * release 9 — different tables, same integer, and nothing in the value says
 * which one it came from. It happened: measured on this collection, a Cock
 * E.S.P record (album 9) was listed as the record of a Kino box (release 9) and
 * the box itself disappeared from its artist, because the row standing for the
 * group was the one with an artist of its own. Both id spaces are in use, so the
 * key carries which one it is.
 */
const grouped = (alias: string): string =>
  `CASE WHEN ${alias}.release_id IS NULL THEN 'a' || ${alias}.id ELSE 'r' || ${alias}.release_id END`;

/**
 * Every record's genre, as a table to be joined rather than asked per record.
 *
 * **This was a correlated subquery and it took the server down.** Written the
 * obvious way — a `SELECT … LIMIT 1` inside `ALBUM_SELECT` — it was evaluated
 * once per album *before* the listing's `ORDER BY` and `LIMIT` could discard
 * anything, so every album listing in the whole API paid it 268 times: measured
 * at 1321 ms for the collection, against 24 ms for this. The operator's client
 * stopped answering, which is what a browse call that takes seconds and a genre
 * call that takes thirty looks like from a sofa.
 *
 * The cost was not the work but its shape. A correlated subquery here cannot use
 * the index that would make it cheap: its two conditions came from the *album*
 * row. Computed once, the same question is a single pass over the genre rows.
 *
 * `ROW_NUMBER() OVER (PARTITION BY …)` is what keeps the rule: the first file
 * that states a genre answers for the record, in path order — and within one
 * file, the first genre tag by position. Files of one record do disagree — this
 * collection has compilations whose tracks each carry their own — and some
 * answer has to be first.
 *
 * **Keyed by record, not by folder, and reached through the track.** A record is
 * a box with its discs (see `ALBUM_GROUPS`), so its genre is the first file by
 * path across *all* its discs — which a per-folder key cannot express. The file
 * reaches its record through the track it became rather than through the folder
 * it sits in, because a disc of a flat rip is keyed on the image *file* and no
 * folder names it: binding by folder loses those. Measured on this collection,
 * that is 6 genre-tagged files, and the binding gains nothing — every
 * genre-tagged file here has a track, and no file's tracks belong to more than
 * one record (both measured).
 *
 * What is left costs about 15 ms on this collection, measured 2026-09-13 warm
 * with the baseline interleaved: the joins are about 8 of it and the window
 * function the rest. A cheaper form was measured rather than assumed — grouping
 * with `MIN()` over a concatenated `rel_path` and `position` is about 12 ms — and
 * it was declined, **but not on price**. The figures this paragraph used to quote
 * (150 ms against 25) were true when they were written and are not any more; it
 * is the same rows several times faster. What still holds is the reason: that
 * form reads the bare `value` column out of whichever row the `MIN()` chose,
 * which SQLite guarantees only while the subquery holds *exactly one* aggregate —
 * so a later `COUNT(*)` added beside it would turn the genre into an arbitrary
 * row's genre, silently, with a test that catches it only half the time. Six
 * milliseconds is not worth that, and the `MIN()` figure above is the grouping
 * alone: fetching the winning row's value safely needs a join back, which nobody
 * has measured.
 */
const albumGenres = (scope: string): string => `
  (SELECT group_id, value FROM (
     SELECT ${grouped('a')} AS group_id,
            ${trimmed('ft')} AS value,
            ROW_NUMBER() OVER (PARTITION BY ${grouped('a')}
                               ORDER BY f.rel_path, ft.position) AS rn
       FROM file f
       JOIN track t ON t.file_id = f.id
       JOIN album a ON a.id = t.album_id
       JOIN file_tag ft ON ft.file_id = f.id
      WHERE ft.name = 'genre' AND ${trimmed('ft')} <> '' ${scope}
   ) WHERE rn = 1)`;

/**
 * The same, for every record at once — see `albumTotals` on why it is a function.
 *
 * The window function is what the join cannot plan around, and it is kept for the
 * reason stated at length above: the cheaper form reads the value out of whichever
 * row it happened to choose.
 */
const ALBUM_GENRES = albumGenres('');

/**
 * Which record each album row belongs to, and which row stands for it.
 *
 * A box is a `release` with one `album` row per disc, so the unit a client
 * opens — an album — is the *group*, not the row. This is the one place that
 * grouping is decided; everything below reads it rather than repeating the rule.
 *
 * The row that stands for a group is its **first disc**: lowest stated disc
 * number, then path, then id. Deliberately not `release.id`, because an `al:` id
 * carries an `album.id` and the two tables number themselves independently — an
 * `al:5` that sometimes meant a release would be a client handing back an id it
 * was given and being shown a different record. A representative keeps the id
 * in the namespace it has always been in, and keeps it stable: disc 1 is disc 1
 * as long as the box is on disk, whatever the scan does to the other rows.
 *
 * `rep_id` rides on every row of the group rather than only on the
 * representative, so a song can name the record it is on without a second join.
 */
/**
 * Which row of a group stands for it: the lowest disc, then path, then id.
 *
 * **A row with no disc number goes last, not first.** `COALESCE(disc_number, 0)`
 * reads as "no number is zero", and a zero sorts in front of disc 1 — so a row
 * that is not a disc at all could represent the record, and everything a client
 * is shown for it comes off that row: the `al:` id, the name, the year. Measured
 * on the live collection there is no such row — 0 albums carry a release without
 * a disc number, and no album's path lies inside a disc folder — so this orders
 * nothing differently today; it is there so that the ordering is not the thing
 * that decides it when the shape appears (task:2843).
 *
 * What a group with *only* unnumbered rows does is unchanged: the lowest of them
 * by path is still the representative. There is nothing else it could be.
 */
const REPRESENTATIVE_ORDER = `(a.disc_number IS NULL), a.disc_number, a.rel_path, a.id`;

const ALBUM_GROUPS = `
  (SELECT a.id, ${grouped('a')} AS group_id,
          FIRST_VALUE(a.id) OVER (PARTITION BY ${grouped('a')}
                                  ORDER BY ${REPRESENTATIVE_ORDER}) AS rep_id,
          ROW_NUMBER() OVER (PARTITION BY ${grouped('a')}
                             ORDER BY ${REPRESENTATIVE_ORDER}) AS rn,
          a.junk_reason AS junk_reason
     FROM album a)`;

/**
 * The clause that keeps what is not a record out of a listing.
 *
 * Every listing in this file already joins the record group by `grp`, so the
 * answer is carried there once (`ALBUM_GROUPS` above) and read here — rather than
 * a subquery per row, which is the shape that took the server down once already
 * (`ALBUM_GENRES`). A caller told to show everything gets the empty string, and
 * an empty string in a `WHERE` changes nothing.
 *
 * **The line this draws, stated once so no listing has to guess it.** Hiding is
 * about what the server *offers*: the listings a client browses, the tree, what
 * a search turns up, what a shuffle draws. It is not about what the listener
 * already holds — a playlist or a star that names a hidden album keeps naming it,
 * because a client whose own list silently lost an entry is worse off than one
 * shown something it marked. And it is not about a record reached by an id
 * already in hand: `album`, `song` and their plurals answer what they are asked,
 * so a client with a stale entry gets a cover rather than an error. What is
 * hidden is that nobody is *offered* it.
 */
function recorded(visibility: Visibility, alias = 'grp'): string {
  return visibility === 'all' ? '' : ` AND ${alias}.junk_reason IS NULL`;
}

/**
 * What a record holds, summed over its discs.
 *
 * Its own pass rather than a subquery per row, for the reason above, and
 * aggregated *before* it is joined so a record with no songs still comes back as
 * itself — which an inner join to `track` would not do.
 */
const albumTotals = (scope: string): string => `
  (SELECT ${grouped('a')} AS group_id,
          COUNT(*) AS song_count,
          SUM(t.duration_ms) AS duration_ms
     FROM track t JOIN album a ON a.id = t.album_id
    ${scope}
    GROUP BY ${grouped('a')})`;

/**
 * The same, for every record at once.
 *
 * A function of the scope rather than one string, because a reader that already
 * knows which record it wants can say so — and then this pass touches that
 * record's tracks instead of the collection's. The body is written once; only the
 * `WHERE` differs, which is how `grouped` and `trimmed` above are built too.
 */
const ALBUM_TOTALS = albumTotals('');

/** One genre, as much of the collection as states it. */
export interface GenreRow {
  value: string;
  song_count: number;
  album_count: number;
}

/**
 * Every genre the collection states, and how much of it states each.
 *
 * Counted over `track` rather than over files, because a song is what a client
 * is being offered: a genre list whose numbers were files would overcount every
 * cue image, which is one file holding an album's worth of tracks.
 *
 * There is no list of known genres here and there should not be — the files
 * name their own, and this project has one table of genre names only because
 * ID3 lets a tag be a *number* that points into one (`tags/genres.ts`). What a
 * file states in words is what this returns, trimmed and nothing else.
 */
export function genres(db: DatabaseSync, visibility: Visibility = 'records'): GenreRow[] {
  // A song on a record nobody is offered is not part of what the collection
  // states: a genre whose every file lives in a folder of screenshots would
  // otherwise be listed with nothing behind it. `al` is joined `LEFT` because a
  // song's album may be missing, and such a song is kept — it is not something
  // that was hidden, it is something that was never classified.
  const dropJunk = visibility === 'all' ? '' : 'AND (al.id IS NULL OR al.junk_reason IS NULL)';
  return rows<GenreRow>(
    db,
    `SELECT ${trimmed('ft')} AS value,
            COUNT(DISTINCT t.id) AS song_count,
            COUNT(DISTINCT ${grouped('al')}) AS album_count
       FROM file_tag ft
       JOIN track t ON t.file_id = ft.file_id
       LEFT JOIN album al ON al.id = t.album_id
      WHERE ft.name = 'genre' AND ${trimmed('ft')} <> '' ${dropJunk}
      GROUP BY ${trimmed('ft')}
      ORDER BY ${trimmed('ft')} COLLATE NOCASE`,
  );
}

/**
 * The genre predicate, written once.
 *
 * `EXISTS` rather than a join to `file_tag` so a genre cannot multiply a song
 * into several rows — a file is free to state a genre twice, and a listing that
 * showed it twice would be a listing that invented a duplicate. Two queries ask
 * it now (one genre's songs, and a random draw filtered by genre), and the two
 * have to agree about what "this song is that genre" means.
 */
function inGenre(fileAlias: string): string {
  return `EXISTS (SELECT 1 FROM file_tag ft
                   WHERE ft.file_id = ${fileAlias}.id AND ft.name = 'genre' AND ${trimmed('ft')} = ?)`;
}

/**
 * A random draw of songs, from what the filters name.
 *
 * **`ORDER BY RANDOM()` reads every matching row and sorts it**, which is why
 * this shape is usually the wrong one — and it is written here with the number
 * in hand rather than by habit. The alternative, picking a random rowid, cannot
 * honour a filter: `genre` is a tag on the file, `year` belongs to the record,
 * and a folder is a root — none of them is a column of `track`. So the choice is
 * between reading the rows and refusing the parameters, and the protocol has the
 * parameters.
 *
 * **Measured on the live collection** (11 541 files, 4 969 songs), warmed,
 * against the running daemon: a default draw of ten is **15–33 ms**, five
 * hundred songs **45 ms**, a genre filter **20 ms** and a year filter **23 ms**.
 * The scan and the sort are the whole of it.
 *
 * **Two of those numbers have since been taken again, and one of them was read
 * wrong here.** The year filter is genuinely about free — 17.2 ms against an
 * unfiltered 16.3 ms — but the *genre* filter is **twice** the unfiltered draw:
 * 34.0 ms against 16.3, medians of thirty warm samples each, on a machine whose
 * `ping` floor was 20 ms in the same window (task:2869). The plan says why, and
 * it is the opposite of what this comment used to claim: `genre` is a tag on the
 * *file*, so the filter is an `EXISTS` evaluated for every one of the 4 972
 * tracks — a covering-index search each, but a search *per row*, before
 * `ORDER BY RANDOM()` sorts what is left. Fewer rows reach the sort; more work
 * happens getting them there. The old sentence — "a filter is *cheaper* than no
 * filter because there are fewer rows left to sort" — was true of the year and
 * false of the genre, and it was written as though it were true of both.
 *
 * **Warmed is the word that matters.** The first version of this comment gave
 * 76–100 ms, taken moments after a restart: a cold page cache is not what the
 * method costs, it is what the disk costs, and the two were reported as the
 * same number until a reviewer measured it again (task:2864).
 *
 * What it costs the *other* clients is the loop, not the call: on one thread
 * eight draws back to back take `ping` from a half-millisecond to 25 ms, because
 * every draw holds the thread for its whole scan.
 *
 * `size` is chosen by the caller, which caps it at the protocol's five hundred;
 * the `LIMIT` itself is this function's.
 */
export function randomSongs(
  db: DatabaseSync,
  wanted: {
    size: number;
    genre?: string;
    fromYear?: number;
    toYear?: number;
    rootId?: number;
    visibility?: Visibility;
  },
): SongRow[] {
  const filters: string[] = [];
  const args: (string | number)[] = [];
  const junk = recorded(wanted.visibility ?? 'records');

  if (wanted.genre !== undefined) {
    filters.push(inGenre('f'));
    args.push(wanted.genre);
  }
  // The record's year, spelled the way the select above reads it — a release's
  // when there is one, the album's otherwise — so a filter and the field it
  // filters cannot disagree about which year a song has.
  if (wanted.fromYear !== undefined) {
    filters.push('COALESCE(rel.year, rep.year) >= ?');
    args.push(wanted.fromYear);
  }
  if (wanted.toYear !== undefined) {
    filters.push('COALESCE(rel.year, rep.year) <= ?');
    args.push(wanted.toYear);
  }
  if (wanted.rootId !== undefined) {
    filters.push('r.id = ?');
    args.push(wanted.rootId);
  }

  return rows<SongRow>(
    db,
    `${SONG_SELECT}
      WHERE 1 = 1${filters.length === 0 ? '' : ` AND ${filters.join(' AND ')}`}${junk}
      ORDER BY RANDOM()
      LIMIT ?`,
    ...args,
    wanted.size,
  );
}

/**
 * The songs one genre names, in a stable order.
 *
 * A song is listed under *every* genre its file states, while the `genre` in its
 * own payload is the first one by position. Those two answers would disagree for
 * a file stating two different genres, and no file in this collection does
 * (measured: not one has even two genre rows). Left unreconciled rather than
 * guessed at, because reconciling means choosing — a song under one genre only,
 * or a payload that cannot say which of several it is — and that choice should
 * be made on a file that has the shape.
 */
export function songsByGenre(
  db: DatabaseSync,
  genre: string,
  count: number,
  offset: number,
  visibility: Visibility = 'records',
): SongRow[] {
  return rows<SongRow>(
    db,
    `${SONG_SELECT}
      WHERE ${inGenre('f')}${recorded(visibility)}
      ORDER BY al.rel_path, t.ordinal, t.id
      LIMIT ? OFFSET ?`,
    genre,
    count,
    offset,
  );
}

/**
 * The records at least one of whose files states this genre.
 *
 * Matched through `track`, which is the same relation `genres()` counts its
 * records by, so the number and the listing are one answer rather than two that
 * happen to agree. The hit is a derived table joined on the *group*, so a box is
 * listed once however many of its discs carry the genre, and no record is
 * multiplied by the genre rows that found it — a file is free to state a genre
 * twice.
 */
export function albumListByGenre(
  db: DatabaseSync,
  genre: string,
  size: number,
  offset: number,
  rootId?: number,
  visibility: Visibility = 'records',
): AlbumRow[] {
  const confined = rootId === undefined ? '' : 'WHERE COALESCE(rel.root_id, al.root_id) = ?';
  const junk = rootId === undefined ? `WHERE 1 = 1${recorded(visibility)}` : recorded(visibility);
  return rows<AlbumRow>(
    db,
    `${ALBUM_SELECT}
      JOIN (SELECT DISTINCT ${grouped('a')} AS group_id
              FROM track t
              JOIN album a ON a.id = t.album_id
              JOIN file_tag ft ON ft.file_id = t.file_id
             WHERE ft.name = 'genre' AND ${trimmed('ft')} = ?) hit ON hit.group_id = grp.group_id
      ${confined}${junk}
      ORDER BY COALESCE(rel.rel_path, al.rel_path), al.id
      LIMIT ? OFFSET ?`,
    ...(rootId === undefined ? [genre, size, offset] : [genre, rootId, size, offset]),
  );
}

/**
 * The records whose year falls between two the client named, inclusive.
 *
 * The second of the protocol's two filters, shaped like the genre one beside it:
 * a client names the axis and the bounds, and the bounds are required arguments
 * rather than a page — defaulting them would answer "everything" to a client that
 * asked for a decade and forgot to say which.
 *
 * The year is the record's own, the release's where it has one and its folder's
 * otherwise, which is the value `albumId3` shows. So a record lists under the
 * year it displays, and a range that finds it is the range that shows it.
 */
export function albumListByYear(
  db: DatabaseSync,
  fromYear: number,
  toYear: number,
  size: number,
  offset: number,
  rootId?: number,
  visibility: Visibility = 'records',
): AlbumRow[] {
  const confine = rootId === undefined ? '' : 'AND COALESCE(rel.root_id, al.root_id) = ?';
  return rows<AlbumRow>(
    db,
    `${ALBUM_SELECT}
      WHERE COALESCE(rel.year, al.year) BETWEEN ? AND ? ${confine}${recorded(visibility)}
      ORDER BY COALESCE(rel.year, al.year), COALESCE(rel.rel_path, al.rel_path), al.id
      LIMIT ? OFFSET ?`,
    ...(rootId === undefined
      ? [fromYear, toYear, size, offset]
      : [fromYear, toYear, rootId, size, offset]),
  );
}

/**
 * What a record is, however it was reached — by artist, by id, by listing.
 *
 * **One row per record, not per album row.** A box is several `album` rows and
 * one record, so the select reads the representative of each group
 * (`ALBUM_GROUPS`) and answers for the whole of it: the title is the release's,
 * the counts are summed over its discs, and `disc_number` is null because a
 * record is not a disc. Without this a client is shown `CD1 ● Альбом`,
 * `CD2 ● …`, `CD3 ● …` as three albums and the record's own name — the one its
 * folder states — nowhere at all. Measured on this collection: 61 disc rows
 * standing in for 19 records.
 *
 * `rel_path` and `root_id` are the *record's* folder, which for a box is the
 * release's — where its cover is, and where its genre and year come from. The
 * representative's own path is still reachable as `al.rel_path`, which is what
 * the orderings use: a deterministic order does not care which of the two
 * prefixes it sorts by, and the queries that do care say which they mean.
 *
 * The counts are a left join to a table aggregated before the join, rather than
 * a subquery per row: a record with no songs still comes back as itself, and
 * nothing multiplies — while a correlated subquery here is what took the server
 * down once already (see `ALBUM_GENRES`).
 */
/**
 * The rows a record is read from, before the columns are chosen.
 *
 * Split out because other queries want these rows and none of the columns:
 * `recordsUnderCount` counts what `ALBUM_SELECT` reads, and
 * `albumPlacesOfArtist` wants only where a record is. The one invariant all
 * three depend on — no join here multiplies a record — is not something any of
 * them can check. Writing the `FROM` clause once is the nearest thing to a
 * guard: a join added for a column stays below, and a join that changed *which*
 * rows there are cannot be.
 */
const ALBUM_ROWS = `
    FROM album al
    JOIN ${ALBUM_GROUPS} grp ON grp.id = al.id AND grp.rn = 1
    LEFT JOIN release rel ON rel.id = al.release_id`;

const albumSelect = (totals: string, genres: string): string => `
  SELECT al.id,
         aa.starred_at, aa.rating,
         COALESCE(rel.root_id, al.root_id) AS root_id,
         COALESCE(rel.rel_path, al.rel_path) AS rel_path,
         COALESCE(rel.title, al.title) AS title,
         COALESCE(rel.artist_id, al.artist_id) AS artist_id,
         ar.name AS artist_name, ar.sort_key AS artist_sort,
         rel.title AS release_title,
         CASE WHEN al.release_id IS NULL THEN al.disc_number END AS disc_number,
         COALESCE(rel.year, al.year) AS year,
         g.value AS genre,
         COALESCE(tot.song_count, 0) AS song_count,
         tot.duration_ms AS duration_ms
${ALBUM_ROWS}
    LEFT JOIN artist ar ON ar.id = COALESCE(rel.artist_id, al.artist_id)
    LEFT JOIN album_annotation aa ON aa.album_id = al.id
    LEFT JOIN ${totals} tot ON tot.group_id = grp.group_id
    LEFT JOIN ${genres} g ON g.group_id = grp.group_id
`;

/**
 * The columns are written once and the two aggregate clauses are handed in.
 *
 * Which keeps the property `ALBUM_ROWS` above is written once to keep: a reader
 * that knows which record it wants and one that lists them all answer with the
 * same columns from the same rows, and only the scope of the aggregates differs.
 */
const ALBUM_SELECT = albumSelect(ALBUM_TOTALS, ALBUM_GENRES);

/**
 * The same columns for a reader that already knows which record it wants.
 *
 * Both aggregates walk the whole collection — every track for the counts, every
 * genre-tagged file for the genre — and neither is narrowed by whatever `WHERE` or
 * `LIMIT` a caller puts after them: the plan materialises them, and only then does
 * the outer query choose rows. Measured on this collection the floor is about
 * 25 ms and it is flat: `getAlbumList2` cost 24.3 ms at `size=10` and 31.7 ms at
 * `size=500`. A listing pays that once for hundreds of records; opening one album
 * paid it for one.
 *
 * So the aggregates are told which record to build, through a `target` named once
 * and read by both. The rules do not fork — `albumTotals` and `albumGenres` above
 * write the bodies, and this hands each a `WHERE`.
 */
const ONE_GROUP = `${grouped('a')} = (SELECT group_id FROM target)`;

const ALBUM_SELECT_ONE = `WITH target(group_id) AS (
    SELECT ${grouped('b')} FROM album b WHERE b.id = ?
  )
${albumSelect(albumTotals(`WHERE ${ONE_GROUP}`), albumGenres(`AND ${ONE_GROUP}`))}
  WHERE grp.group_id = (SELECT group_id FROM target)`;

/**
 * The records an artist is credited on, or only those in one root.
 *
 * `rootId` is what a client asking for one music folder means. Without it this
 * answers about the whole collection, which is right for an artist page and
 * wrong for a confined one: `getArtists` narrows its list to the folder asked
 * about, so a page that ignored the same parameter would list records from a
 * folder the client is not looking at.
 */
export function albumsOfArtist(
  db: DatabaseSync,
  artistId: number,
  rootId?: number,
  visibility: Visibility = 'records',
): AlbumRow[] {
  const confined = rootId === undefined ? '' : 'AND al.root_id = ?';
  return rows<AlbumRow>(
    db,
    `${ALBUM_SELECT} WHERE COALESCE(rel.artist_id, al.artist_id) = ? ${confined}${recorded(visibility)}
      ORDER BY COALESCE(al.disc_number, 0), al.rel_path, al.id`,
    ...(rootId === undefined ? [artistId] : [artistId, rootId]),
  );
}

/**
 * Where a record is, and which record it is — nothing about what it holds.
 *
 * The two aggregates `ALBUM_SELECT` carries are built for *every* album before
 * the join narrows anything (see `recordsUnderCount`, which refuses them for the
 * same reason), so a caller that wants only the places pays tens of milliseconds
 * for them. The cover route is that caller: an artist's records are read to
 * learn which folders their files are in, and the genre and the running time are
 * thrown away. Measured on the live collection, `albumsOfArtist` against this
 * for the same artist: 45–69 ms against 4–6.
 *
 * The grouping stays, because it is what decides *which* records there are — a
 * box counts once, not once per disc — and the order stays, because the record
 * that is asked first decides which picture answers when no name does.
 */
export interface AlbumPlace {
  id: number;
  root_id: number;
  rel_path: string;
}

export function albumPlacesOfArtist(
  db: DatabaseSync,
  artistId: number,
  visibility: Visibility = 'records',
): AlbumPlace[] {
  return rows<AlbumPlace>(
    db,
    `SELECT al.id,
            COALESCE(rel.root_id, al.root_id) AS root_id,
            COALESCE(rel.rel_path, al.rel_path) AS rel_path
${ALBUM_ROWS}
      WHERE COALESCE(rel.artist_id, al.artist_id) = ?${recorded(visibility)}
      ORDER BY COALESCE(al.disc_number, 0), al.rel_path, al.id`,
    artistId,
  );
}

/**
 * The folders that are a *disc* of a release rather than a record of their own.
 *
 * The tree lists what is directly inside a folder, and a box's discs are not
 * that: `Slipknot AAC 320/2014 - .5 The Gray Chapter - CD 1 [JP - WPCR-16130]`
 * is the first disc of the record keyed on `Slipknot AAC 320` itself, and a
 * listing that showed it as a folder would offer the same record twice — once
 * as itself and once as its own first CD.
 */
export function discPaths(
  db: DatabaseSync,
  rootId: number,
  paths: readonly string[],
): string[] {
  if (paths.length === 0) return [];

  const under = paths
    .map(() => `(al.rel_path = ? OR al.rel_path LIKE ? || '/%')`)
    .join(' OR ');
  const args: string[] = [];
  for (const path of paths) args.push(path, path);

  return rows<{ rel_path: string }>(
    db,
    `SELECT al.rel_path FROM album al
      WHERE al.root_id = ? AND al.release_id IS NOT NULL AND (${under})`,
    rootId,
    ...args,
  ).map((row) => row.rel_path);
}

/**
 * The records lying under a set of physical folders.
 *
 * This is the question the virtual tree asks and `albumsOfArtist` cannot: a
 * record belongs to the folder it was filed in, not to whoever its tags credit.
 * `Cock E.S.P` holds eleven splits its files credit to Merzbow, Aube and nine
 * others, and the operator's word on that is that the folder decides — the
 * person knows what they put where, and everything else is navigation or
 * search.
 *
 * A folder's records are the ones whose own path *is* it (a record folder at
 * the top of a root) or lies beneath it.
 *
 * Ordered by year, and deliberately not by path. Path order is the collector's
 * *shelves* — `Compilations/`, `Deluxe Editions/`, `Live Albums/` — so an
 * artist listed every compilation from 1983 to 2004 and then every deluxe
 * edition from 2004 on, with the year jumping at each boundary. What a person
 * reads a shelf of records for is when they came out. A record with no year
 * goes last rather than first, which is where a missing number belongs.
 */
export function recordsUnder(
  db: DatabaseSync,
  rootId: number,
  paths: readonly string[],
  visibility: Visibility = 'records',
): AlbumRow[] {
  if (paths.length === 0) return [];

  const under = underPaths(paths);

  return rows<AlbumRow>(
    db,
    `${ALBUM_SELECT} WHERE COALESCE(rel.root_id, al.root_id) = ? AND (${under.sql})${recorded(visibility)}
      ORDER BY COALESCE(rel.year, al.year) IS NULL, COALESCE(rel.year, al.year),
               COALESCE(rel.title, al.title), COALESCE(rel.rel_path, al.rel_path), al.id`,
    rootId,
    ...under.args,
  );
}

/**
 * The predicate that says a record lies under one of these paths.
 *
 * Written once because two queries now read it — the one that fetches the
 * records and the one that only counts them — and a path predicate that drifted
 * between the two would make a list and its own length disagree, which is the
 * defect this project keeps finding.
 */
function underPaths(paths: readonly string[]): { sql: string; args: string[] } {
  const sql = paths
    .map(
      () =>
        `(COALESCE(rel.rel_path, al.rel_path) = ? OR COALESCE(rel.rel_path, al.rel_path) LIKE ? || '/%')`,
    )
    .join(' OR ');

  const args: string[] = [];
  for (const path of paths) args.push(path, path);
  return { sql, args };
}

/**
 * How many records lie under a set of folders, without reading one of them.
 *
 * The same question `recordsUnder` answers, asked for its size alone — and the
 * difference is not a smaller version of the same query. `ALBUM_SELECT` carries
 * `ALBUM_GENRES` and `ALBUM_TOTALS`, aggregates over `file`, `track` and
 * `file_tag` built for *every* album before the join narrows anything; a caller
 * that wants only the length pays for all of it and reads one number.
 *
 * `getIndexes` is that caller, and it asks once per node: thirty-one nodes at
 * roughly twenty milliseconds each was most of a second, on a single-threaded
 * server, spent producing a list of counts. What a record *is* is not needed to
 * count it, so the genres and the totals are not joined here — only
 * `ALBUM_GROUPS`, which decides how many records there are rather than what
 * they hold.
 */
export function recordsUnderCount(
  db: DatabaseSync,
  rootId: number,
  paths: readonly string[],
  visibility: Visibility = 'records',
): number {
  if (paths.length === 0) return 0;

  const under = underPaths(paths);
  const found = row<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n
${ALBUM_ROWS}
      WHERE COALESCE(rel.root_id, al.root_id) = ? AND (${under.sql})${recorded(visibility)}`,
    rootId,
    ...under.args,
  );
  return found?.n ?? 0;
}

/** One group of paths to count. The answer comes back in the order given. */
export interface CountScope {
  rootId: number;
  paths: string[];
}

/**
 * The same counts, all at once.
 *
 * Asking `recordsUnderCount` per group is what `getIndexes` did, and each call
 * built `ALBUM_GROUPS` — a window function over every album — for its own
 * handful of paths. Twenty-five of those was most of the 104 ms that route
 * still cost after the records stopped being read. One pass over the album rows
 * with the groups as a `VALUES` list gives the same numbers; measured on a copy
 * of the collection, 63–144 ms became 4–8.
 *
 * The scope is a `VALUES` list in a CTE rather than a temporary table: SQLite
 * has to be told about temp tables, and `WITH s(...) AS (VALUES ...)` is a
 * literal the planner sees. It is written this way and not as a
 * `(VALUES ...)` join because SQLite refuses a bare `VALUES` as a table
 * expression — measured, `near "(": syntax error` — while a CTE over one is
 * accepted. The paths are bound, never interpolated: they are folder names, and
 * a folder name is a thing a person chose.
 *
 * Groups whose paths overlap count a record once for each, which is the answer
 * the per-group calls gave as well, so nothing here depends on overlap being
 * absent.
 */
export function recordsUnderCounts(
  db: DatabaseSync,
  scope: readonly CountScope[],
  visibility: Visibility = 'records',
): number[] {
  const counts = new Array<number>(scope.length).fill(0);
  if (scope.length === 0) return counts;

  const bound: (string | number)[] = [];
  const values: string[] = [];
  scope.forEach((group, at) => {
    for (const path of group.paths) {
      values.push('(?, ?, ?)');
      bound.push(at, group.rootId, path);
    }
  });
  if (values.length === 0) return counts;

  // The path predicate is spelled out here rather than taken from `underPaths`,
  // and the reason is that the two are not the same shape: `underPaths` builds a
  // disjunction over N *bound* paths, one comparison each, while this compares
  // one path *column* per joined row. A shared form would have to take the
  // expression as an argument, which is a parameter whose only two values are
  // `?` and `s.path` — more machinery than the rule it would protect, and a
  // reader of either is still looking at the same three conditions.
  const found = rows<{ at: number; n: number }>(
    db,
    `WITH s(at, root_id, path) AS (VALUES ${values.join(', ')})
     SELECT s.at AS at, COUNT(*) AS n
${ALBUM_ROWS}
       JOIN s ON COALESCE(rel.root_id, al.root_id) = s.root_id
             AND (COALESCE(rel.rel_path, al.rel_path) = s.path
                  OR COALESCE(rel.rel_path, al.rel_path) LIKE s.path || '/%')
      WHERE 1 = 1${recorded(visibility)}
      GROUP BY s.at`,
    ...bound,
  );

  for (const { at, n } of found) counts[at] = n;
  return counts;
}

/**
 * The record an id names, whichever of its rows the id belongs to.
 *
 * The id is resolved through the group rather than matched, so a client that
 * stored `al:` for the second disc of a box — which is what every client did
 * while the discs were the albums — opens the record rather than being told
 * there is no such album. An id naming nothing resolves to nothing: the inner
 * select is empty, the comparison is null, and no row matches.
 */
export function album(db: DatabaseSync, id: number): AlbumRow | undefined {
  return row<AlbumRow>(db, ALBUM_SELECT_ONE, id);
}

/**
 * The same answer for a page of ids, in one query.
 *
 * This is where asking one at a time stopped being affordable. `ALBUM_SELECT`
 * computes `ALBUM_GENRES` — a window function over every genre row — and the
 * plan is built per execution, so a search page of 250 albums ran it 250 times:
 * measured on the live collection at about **2 s**, against a few milliseconds
 * for the single `IN` below. The listing routes never had the problem, because
 * they ask once and let `LIMIT` decide; only the search resolved ids it already
 * held.
 */
export function albumsById(db: DatabaseSync, ids: number[]): AlbumRow[] {
  return byIds(ids, (placeholders) =>
    rows<AlbumRow>(db, `${ALBUM_SELECT} WHERE al.id IN (${placeholders})`, ...ids),
  );
}

/**
 * The orderings `getAlbumList2` can honestly answer, and no others.
 *
 * `recent`, `frequent`, `highest` and `starred` were refused until now, and the
 * refusal said why: "nothing in the meta layer records a star or a play count".
 * That was true when it was written and stopped being true with v1.2, which
 * added the listener's marks and the history of what they played — the data
 * arrived and the listing that needed it went on saying it could not say. The
 * classic client's five lists were three empty screens because of it
 * (task:2896).
 *
 * Each of these orders albums by something about *the listener*, and each one
 * that has nothing to order by is empty rather than arbitrary: a list of albums
 * nobody has played is not a "most played" list, and a client asking for the
 * albums it starred is not asking for all of them with the starred ones first.
 * So the three carry a condition as well as an order.
 */
export type AlbumOrder =
  | 'alphabeticalByName'
  | 'alphabeticalByArtist'
  | 'newest'
  | 'random'
  | 'starred'
  | 'highest'
  | 'recent'
  | 'frequent';

/** Where the listener's own marks and plays are read from — see the migrations. */
const MARKS = '(SELECT aa.starred_at FROM album_annotation aa WHERE aa.album_id = al.id)';
const RATING = '(SELECT aa.rating FROM album_annotation aa WHERE aa.album_id = al.id)';
const LAST_PLAY =
  '(SELECT MAX(tp.played_at) FROM track_play tp JOIN track t ON t.id = tp.track_id WHERE t.album_id = al.id)';
const PLAYS =
  '(SELECT SUM(tp.play_count) FROM track_play tp JOIN track t ON t.id = tp.track_id WHERE t.album_id = al.id)';

const ORDERS: Record<AlbumOrder, { by: string; where?: string }> = {
  // The *record's* name, which for a box is its release folder — the row's own
  // title is the disc's (`CD1 ● Альбом`), and sorting the collection by that
  // would file every box under `C`, beside the alphabet's other disc ones.
  alphabeticalByName: { by: 'COALESCE(rel.title, al.title, al.rel_path), al.id' },
  alphabeticalByArtist: {
    by: 'COALESCE(ar.sort_key, ar.name), COALESCE(rel.title, al.title, al.rel_path), al.id',
  },
  // The id rises with the order the scan met a folder in, which is the nearest
  // thing to "recently added" a derived layer can offer: nothing records when a
  // record was acquired, only when it was first seen.
  newest: { by: 'al.id DESC' },
  random: { by: 'RANDOM()' },
  // The albums the listener marked, most recently marked first.
  starred: { by: `${MARKS} DESC`, where: `AND ${MARKS} IS NOT NULL` },
  // A record is rated as a record — the rating of its songs is a different
  // question — and one nobody rated is not "highly rated".
  highest: { by: `${RATING} DESC, al.id`, where: `AND ${RATING} IS NOT NULL` },
  // And the two the history answers: when anything on the record was last
  // played, and what the plays on it add up to.
  recent: { by: `${LAST_PLAY} DESC`, where: `AND ${LAST_PLAY} IS NOT NULL` },
  frequent: { by: `${PLAYS} DESC, al.id`, where: `AND COALESCE(${PLAYS}, 0) > 0` },
};

export function albumList(
  db: DatabaseSync,
  order: AlbumOrder,
  size: number,
  offset: number,
  rootId?: number,
  visibility: Visibility = 'records',
): AlbumRow[] {
  const confined = rootId === undefined ? '' : 'COALESCE(rel.root_id, al.root_id) = ?';
  const ordered = ORDERS[order];
  const where =
    `WHERE 1 = 1 ${confined === '' ? '' : `AND ${confined}`}${recorded(visibility)} ` +
    `${ordered.where ?? ''}`;
  const args: number[] = rootId === undefined ? [size, offset] : [rootId, size, offset];
  return rows<AlbumRow>(db, `${ALBUM_SELECT} ${where} ORDER BY ${ordered.by} LIMIT ? OFFSET ?`, ...args);
}

// Songs ----------------------------------------------------------------------

export interface SongRow {
  id: number;
  ordinal: number;
  title: string | null;
  /**
   * When the listener starred this song, and what they rated it.
   *
   * The listener's own marks, read here with everything else about a song so
   * that every listing which shows one shows the same two fields — see
   * `annotation/store.ts` for why they are not columns of the model.
   */
  starred_at: string | null;
  rating: number | null;
  /**
   * What the listener's plays add up to: how many, and when the last one was.
   *
   * Read here with everything else about a song, like the two marks above and
   * for the same reason — `playCount` and `played` are fields on every `Child`,
   * and a field every listing has to fill cannot be a query of its own. The
   * rollup is written by the history's own layer (`history/store.ts`), which is
   * where a play is recorded; nothing here computes it.
   */
  play_count: number | null;
  played_at: string | null;
  album_id: number | null;
  album_title: string | null;
  artist_id: number | null;
  artist_name: string | null;
  disc_number: number | null;
  duration_ms: number | null;
  /** The year of the record this song is on — a song has none of its own. */
  album_year: number | null;
  /**
   * The genre *this file* states — the song's own, unlike the year beside it.
   *
   * A song is a file, or a stretch of one, so it can state its own genre even
   * when the record around it states another — which is exactly what a
   * compilation is, and why this is asked of the file rather than taken from
   * the album's answer. Null when the file states none.
   */
  genre: string | null;
  /**
   * The two tags that say how a song is rated, kept apart because they disagree.
   *
   * `itunesadvisory` is what a Vorbis comment or an ID3v2 `TXXX` frame carries
   * and `rtng` is the MP4 atom, and the protocol gives them **different
   * numberings** — "ITUNESADVISORY: 1 = explicit, 2 = clean, MP4 rtng: 1 or 4 =
   * explicit, 2 = clean". One column would have to throw away which tag a value
   * came from, and `4` means explicit in one of them and nothing in the other.
   * See `explicitStatusOf`, which is where they are read.
   */
  advisory_itunes: string | null;
  advisory_mp4: string | null;
  /**
   * What the file says its own loudness is, in the four tags ReplayGain uses.
   *
   * Carried as the strings the file wrote, like the advisory pair above and for
   * the same reason: `+0.23 dB` and `0.388123` are two different spellings of a
   * number and the parsing is the payload's business, not this query's. They
   * travel on every `Child`, so `replayGainOf` can build the object without a
   * second query per song (task:2921).
   */
  rg_track_gain: string | null;
  rg_album_gain: string | null;
  rg_track_peak: string | null;
  rg_album_peak: string | null;
  /**
   * The artist *this file* names, when it names one.
   *
   * Not the song's artist — the record's is, one column up, and that is the
   * project's model: a band's album shows the band, and a guest credit on it does
   * not displace them. This is the fallback for the case where the record has no
   * artist at all, which is a compilation: thirteen tracks by thirteen acts, no
   * `albumartist`, and `albumArtistOf` refusing to choose between them. Nothing
   * is lost by the refusal — every file names its own performer — and this is
   * where that name reaches a client.
   */
  track_artist: string | null;
  root_id: number;
  root_path: string;
  rel_path: string;
  /** The folder the file sits in, which is where a picture of it would live. */
  folder_rel_path: string;
  size: number;
  ext: string;
  /**
   * The slice of the file this song is, when it is one.
   *
   * Null means the whole file is the song. Set means the song is a cue track
   * cut out of an image, and the file is that image — which is why `size` above
   * is the image's and not the answer's.
   */
  segment_start_ms: number | null;
  segment_end_ms: number | null;
  /**
   * What the scan's ffprobe made of the file, when it could read it.
   *
   * The delivery layer asks this of a whole file it is about to send: a browser
   * plays a handful of codecs, and a `.m4a` says nothing by its name about
   * whether ALAC or AAC is inside it.
   */
  codec: string | null;
  /**
   * What the scan's ffprobe measured of the stream, beyond the codec.
   *
   * The protocol puts all three on every `Child` — `bitRate`, `samplingRate`,
   * `channelCount` — and this server sent none of them: the probe reads them and
   * nothing carried them out. A client deciding whether it can play a file at
   * all needs them, and so does `stream`'s own `maxBitRate`, which cannot obey a
   * ceiling without knowing what the file is already at.
   *
   * Null when the file was never probed, which is not the same as nought: a
   * bitrate nobody measured cannot be shown to be under a ceiling.
   */
  sample_rate: number | null;
  channels: number | null;
  bitrate: number | null;
}

/**
 * A song, with the album it is on and the artist who owns that album.
 *
 * The artist is the album's and not the song's, because the meta layer keeps no
 * per-song artist: `track.artist_id` is left empty on purpose (see
 * `artist/apply.ts`), and the cue's own PERFORMER is a credit — a string a cue
 * wrote — which the inventory dump shows beside the track rather than in place
 * of the record's artist.
 *
 * **The eight tag fields come off a joined row and are not asked of `file_tag`
 * here.** They used to be eight correlated subqueries, which was not wrong so
 * much as eight seeks a song: a page of five hundred costs 10.04 ms that way and
 * 6.37 ms off this row, measured, with every alternative shape worse
 * (`tags/first.ts` has the numbers and the alternatives). `tg` is one row a file,
 * written by the stage that writes the tags it is derived from, so it cannot
 * disagree with them — and a file nobody has read has no row, which is the null
 * the subqueries answered too.
 */
const SONG_SELECT = `
  SELECT t.id, t.ordinal, t.title, grp.rep_id AS album_id,
         ta.starred_at, ta.rating,
         tp.play_count, tp.played_at,
         COALESCE(rel.title, rep.title) AS album_title,
         COALESCE(rel.artist_id, rep.artist_id) AS artist_id,
         ar.name AS artist_name, al.disc_number,
         COALESCE(rel.year, rep.year) AS album_year,
         tg.genre AS genre, tg.track_artist AS track_artist,
         tg.advisory_itunes AS advisory_itunes, tg.advisory_mp4 AS advisory_mp4,
         tg.rg_track_gain AS rg_track_gain,
         tg.rg_album_gain AS rg_album_gain,
         tg.rg_track_peak AS rg_track_peak,
         tg.rg_album_peak AS rg_album_peak,
         t.duration_ms, t.segment_start_ms, t.segment_end_ms,
         r.id AS root_id, r.path AS root_path, f.rel_path, f.folder_rel_path, f.size, f.ext,
         p.codec AS codec, p.sample_rate AS sample_rate, p.channels AS channels,
         p.bitrate AS bitrate
    FROM track t
    JOIN file f ON f.id = t.file_id
    JOIN root r ON r.id = f.root_id
    LEFT JOIN album al ON al.id = t.album_id
    LEFT JOIN ${ALBUM_GROUPS} grp ON grp.id = al.id
    LEFT JOIN album rep ON rep.id = grp.rep_id
    LEFT JOIN release rel ON rel.id = rep.release_id
    LEFT JOIN artist ar ON ar.id = COALESCE(rep.artist_id, rel.artist_id)
    LEFT JOIN audio_probe p ON p.file_id = f.id
    LEFT JOIN file_tag_first tg ON tg.file_id = f.id
    LEFT JOIN track_annotation ta ON ta.track_id = t.id
    LEFT JOIN track_play tp ON tp.track_id = t.id
`;

/**
 * Every song of a record, in playing order — disc by disc, then within a disc.
 *
 * The id is resolved through the group, so opening *any* disc of a box opens the
 * record, and what comes back is all of it. Each song still says which disc it
 * is on: that is the field the protocol gives a client to draw its separators
 * with, and the reason the discs do not have to be albums of their own.
 */
export function songsOfAlbum(db: DatabaseSync, albumId: number): SongRow[] {
  return rows<SongRow>(
    db,
    `${SONG_SELECT}
      WHERE al.id IN (SELECT id FROM album a
                       WHERE ${grouped('a')} =
                             (SELECT ${grouped('b')} FROM album b WHERE b.id = ?))
      ORDER BY COALESCE(al.disc_number, 0), t.ordinal, t.id`,
    albumId,
  );
}

/**
 * Which of these artists have a record in this root.
 *
 * The one question a music-folder filter can ask about an artist: an artist is
 * not *in* a folder — their records are, and they may sit in several — so the
 * artists a folder holds are the ones it has a record of, credited either on
 * the record itself or on the release a box belongs to.
 *
 * Chunked for the reason `knownTrackIds` is: one placeholder per id, and SQLite
 * caps how many a statement may carry.
 */
export function artistIdsInRoot(
  db: DatabaseSync,
  ids: readonly number[],
  rootId: number,
): Set<number> {
  const found = new Set<number>();
  const CHUNK = 500;

  for (let at = 0; at < ids.length; at += CHUNK) {
    const chunk = ids.slice(at, at + CHUNK);
    const matched = rows<{ id: number | null }>(
      db,
      `SELECT DISTINCT COALESCE(rel.artist_id, al.artist_id) AS id
         FROM album al
         LEFT JOIN release rel ON rel.id = al.release_id
        WHERE al.root_id = ? AND COALESCE(rel.artist_id, al.artist_id) IN (${chunk.map(() => '?').join(', ')})`,
      rootId,
      ...chunk,
    );
    for (const row of matched) if (row.id !== null) found.add(row.id);
  }

  return found;
}

/**
 * The songs of a playlist, in the order the playlist holds them.
 *
 * The one listing in this API whose order was chosen by a person rather than by
 * the collection: `position` is the whole of what a playlist says beyond which
 * songs are in it, so the `ORDER BY` is the answer and not a convenience.
 *
 * Read here rather than in the playlist module so that a song in a playlist is
 * the same song as everywhere else — one select, one shape, and no second
 * opinion about what a song is.
 */
export function songsOfPlaylist(db: DatabaseSync, playlistId: number): SongRow[] {
  return rows<SongRow>(
    db,
    `${SONG_SELECT}
      JOIN playlist_track pt ON pt.track_id = t.id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position`,
    playlistId,
  );
}

/**
 * Which of these ids name a song the collection still has.
 *
 * The question `createPlaylist` and `updatePlaylist` ask before they write
 * anything, and asked of the collection rather than of the playlist module for
 * the reason the reading above lives here: whether a track exists is a fact
 * about the classified model, and the model has one reader.
 *
 * Asked in chunks, and the chunking is not tidiness. The ids are bound one
 * placeholder per song, and SQLite caps how many parameters a statement may
 * carry — 32766 in the build this runs on — so a client saving a very long
 * playlist would be answered with an internal error rather than with an answer
 * about songs. A chunk well under that ceiling keeps every statement ordinary,
 * and the protocol sets no limit on how many songs a playlist may hold.
 *
 * An id that names nothing is simply absent from the answer: which of them did
 * is the caller's to report, since only the caller knows what it asked for.
 */
export function knownTrackIds(db: DatabaseSync, ids: readonly number[]): Set<number> {
  const known = new Set<number>();
  const CHUNK = 500;

  for (let at = 0; at < ids.length; at += CHUNK) {
    const chunk = ids.slice(at, at + CHUNK);
    const found = rows<{ id: number }>(
      db,
      `SELECT id FROM track WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      ...chunk,
    );
    for (const { id } of found) known.add(id);
  }

  return known;
}

/**
 * Where the files of several records sit, for all of them at once.
 *
 * `songsOfAlbum` answers "what is on this record", and reads it through the
 * group so a box's other discs come with it. A caller that wants only *where*
 * the files are paid that whole select per record: the cover route asking about
 * an artist ran it once per record of the artist — measured on the live
 * collection at 30 executions for `getCoverArt?id=ar:15`, and 277 ms of a route
 * that serves no other request while it runs. The question needs no order of
 * tracks and no titles, only `track → file`, which is one statement either way.
 *
 * Keyed by the record each row belongs to, and within a record in the order
 * `songsOfAlbum` would have given it, so a caller that walks its own records in
 * order and appends what it finds gets the list it would have built one record
 * at a time. That order is not decoration: it decides which folder answers when
 * no picture's *name* says which side it is.
 */
export function fileFoldersOfAlbums(
  db: DatabaseSync,
  albumIds: readonly number[],
): Map<number, FolderRef[]> {
  const found = new Map<number, FolderRef[]>();
  if (albumIds.length === 0) return found;

  const asked = albumIds.map(() => '?').join(', ');
  const where = rows<{ album_id: number; root_id: number; rel_path: string }>(
    db,
    `SELECT grp.rep_id AS album_id, r.id AS root_id, f.folder_rel_path AS rel_path
       FROM track t
       JOIN file f ON f.id = t.file_id
       JOIN root r ON r.id = f.root_id
       LEFT JOIN album al ON al.id = t.album_id
       JOIN ${ALBUM_GROUPS} grp ON grp.id = al.id
      WHERE grp.rep_id IN (${asked})
      ORDER BY grp.rep_id, COALESCE(al.disc_number, 0), t.ordinal, t.id`,
    ...albumIds,
  );

  for (const { album_id: albumId, root_id: rootId, rel_path: relPath } of where) {
    const already = found.get(albumId);
    const folder = { rootId, relPath };
    if (already === undefined) found.set(albumId, [folder]);
    else already.push(folder);
  }
  return found;
}

/**
 * The discs of a record, in order, for `discTitles`.
 *
 * A disc folder called `CD2 ● Ранний вариант` says what that disc *is* — an
 * early version, a bonus disc, a live set — and the protocol has a field for
 * exactly that. The title comes back verbatim; stripping the number in front of
 * it is `discSubtitle`'s job, and a disc whose folder names nothing but its
 * number is reported as it is and dropped by the caller.
 */
export function discsOfAlbum(
  db: DatabaseSync,
  albumId: number,
): { disc: number; title: string | null }[] {
  return rows<{ disc: number; title: string | null }>(
    db,
    `SELECT al.disc_number AS disc, al.title AS title FROM album al
      WHERE al.disc_number IS NOT NULL
        AND ${grouped('al')} = (SELECT ${grouped('b')} FROM album b WHERE b.id = ?)
      ORDER BY al.disc_number, al.rel_path, al.id`,
    albumId,
  );
}

export function song(db: DatabaseSync, trackId: number): SongRow | undefined {
  return row<SongRow>(db, `${SONG_SELECT} WHERE t.id = ?`, trackId);
}

/**
 * The same answer for a page of ids, in one query.
 *
 * The plural of `song`, and the one the starred listing needs: what the listener
 * starred is a set of ids with no order the collection knows, and asking for
 * them one at a time is one execution of `SONG_SELECT` per song.
 */
export function songsByIds(db: DatabaseSync, ids: number[]): SongRow[] {
  return byIds(ids, (placeholders) => rows<SongRow>(db, `${SONG_SELECT} WHERE t.id IN (${placeholders})`, ...ids));
}

/** The songs held in one folder, which is one album's worth by construction. */
export function songsInFolder(db: DatabaseSync, rootId: number, relPath: string): SongRow[] {
  return rows<SongRow>(
    db,
    `${SONG_SELECT} WHERE al.root_id = ? AND al.rel_path = ? ORDER BY t.ordinal, t.id`,
    rootId,
    relPath,
  );
}

// Folders --------------------------------------------------------------------

export interface FolderRow {
  id: number;
  root_id: number;
  rel_path: string;
  parent_rel_path: string | null;
  role: string | null;
}

export interface RootRow {
  id: number;
  path: string;
  alias: string | null;
}

export function roots(db: DatabaseSync): RootRow[] {
  return rows<RootRow>(db, 'SELECT id, path, alias FROM root ORDER BY id');
}

export function root(db: DatabaseSync, id: number): RootRow | undefined {
  return row<RootRow>(db, 'SELECT id, path, alias FROM root WHERE id = ?', id);
}

export function folder(db: DatabaseSync, id: number): FolderRow | undefined {
  return row<FolderRow>(
    db,
    'SELECT id, root_id, rel_path, parent_rel_path, role FROM folder WHERE id = ?',
    id,
  );
}

/**
 * The pictures the walk met in one folder, in path order.
 *
 * `root_path` comes along so that the one caller which serves them — the cover
 * route — has the whole of what it needs from a single read: an image is the
 * one thing the API hands over that the meta layer never copied, so where it
 * sits on disk is part of the answer rather than a detail of it.
 *
 * Path order is the contract `pickCover` leans on, and it is stated here rather
 * than left to the plan: the same folder must answer the same way on two
 * machines, and only an ordering the query fixes can promise that.
 */
export interface PictureRow {
  rel_path: string;
  ext: string;
  root_path: string;
}

export function picturesInFolder(db: DatabaseSync, rootId: number, relPath: string): PictureRow[] {
  return rows<PictureRow>(
    db,
    `SELECT f.rel_path, f.ext, r.path AS root_path
       FROM file f
       JOIN root r ON r.id = f.root_id
      WHERE f.root_id = ? AND f.folder_rel_path = ? AND f.kind = 'image'
      ORDER BY f.rel_path`,
    rootId,
    relPath,
  );
}

// Search ---------------------------------------------------------------------

/**
 * A page of a search, and the two ways it is read.
 *
 * `match` is FTS5's own expression (`search/query.ts` builds it) or null for a
 * search with no words in it — and the second is not a degenerate first. FTS5
 * has no expression meaning "everything", and an empty search is exactly that
 * request: a client's first sync asks for the library with no query at all. So
 * the null case reads the tables in their own order instead of the index, which
 * is also the order a client paging through a whole collection expects.
 *
 * The three sections are paged independently, because that is how they are
 * asked for: `artistCount=0` is a client wanting albums and songs for a word it
 * already has.
 */
export interface SearchPage {
  match: string | null;
  size: number;
  offset: number;
  /** One root's worth of the collection, when the client asked for one. */
  rootId?: number;
  /**
   * What this search may find.
   *
   * Carried on the page rather than passed beside it because all three sections
   * read it, and a search whose artists hid junk while its albums offered it
   * would be three answers to one question.
   */
  visibility?: Visibility;
}

/**
 * The songs a search finds, best first.
 *
 * The rank comes from the index rather than from this query: how well a row
 * answers is the index's to say, and the id beside it is only there so that two
 * equally good answers come back in the same order twice.
 */
export function searchSongs(db: DatabaseSync, page: SearchPage): SongRow[] {
  // The root, when one was asked for, is a condition on every one of the three
  // sections — a search confined to a library that answered about another one
  // would be answering about the wrong music.
  const inRoot = page.rootId === undefined ? '' : ' AND r.id = ?';
  const root = page.rootId === undefined ? [] : [page.rootId];
  const junk = recorded(page.visibility ?? 'records');

  if (page.match === null) {
    return rows<SongRow>(
      db,
      `${SONG_SELECT} WHERE 1 = 1${inRoot}${junk} ORDER BY t.id LIMIT ? OFFSET ?`,
      ...root,
      page.size,
      page.offset,
    );
  }

  return rows<SongRow>(
    db,
    `${SONG_SELECT}
      JOIN track_fts ON track_fts.rowid = t.id
      WHERE track_fts MATCH ?${inRoot}${junk}
      ORDER BY track_fts.rank, t.id
      LIMIT ? OFFSET ?`,
    page.match,
    ...root,
    page.size,
    page.offset,
  );
}

/**
 * The records a query finds, as the ids `albumsById` expects: the
 * representative of each group, never a disc.
 *
 * A disc id here would be a second answer to a question `getAlbumList2` answers
 * with records — a search that offered `CD1 ● Альбом` while the browse tab
 * offered the box is the disagreement this file exists to avoid. The ranking is
 * kept: a match is ordered by its best rank, everything else by the record's
 * name.
 */
export function searchAlbumIds(db: DatabaseSync, page: SearchPage): number[] {
  const inRoot = page.rootId === undefined ? '' : ' AND al.root_id = ?';
  const root = page.rootId === undefined ? [] : [page.rootId];
  const junk = recorded(page.visibility ?? 'records');

  const ids =
    page.match === null
      ? rows<{ id: number }>(
          db,
          `SELECT grp.rep_id AS id FROM album al
             JOIN ${ALBUM_GROUPS} grp ON grp.id = al.id AND grp.rn = 1
             LEFT JOIN release rel ON rel.id = al.release_id
            WHERE 1 = 1${inRoot}${junk}
            ORDER BY COALESCE(rel.title, al.title, al.rel_path), grp.rep_id
            LIMIT ? OFFSET ?`,
          ...root,
          page.size,
          page.offset,
        )
      : rows<{ id: number }>(
          db,
          `SELECT MIN(grp.rep_id) AS id, MIN(track_fts.rank) AS best
             FROM track_fts
             JOIN track t ON t.id = track_fts.rowid
             JOIN album al ON al.id = t.album_id
             JOIN ${ALBUM_GROUPS} grp ON grp.id = al.id
            WHERE track_fts MATCH ? AND t.album_id IS NOT NULL${inRoot}${junk}
            GROUP BY grp.group_id
            ORDER BY best, MIN(grp.rep_id)
            LIMIT ? OFFSET ?`,
          page.match,
          ...root,
          page.size,
          page.offset,
        );

  return ids.map((row) => row.id);
}

export function searchArtistIds(db: DatabaseSync, page: SearchPage): number[] {
  const inRoot = page.rootId === undefined ? '' : ' AND al.root_id = ?';
  const root = page.rootId === undefined ? [] : [page.rootId];
  // Spelled out rather than `recorded()`, because that reads the clause off the
  // record group's alias `grp` and this query has no group to join — it is
  // answering "which artists have a song", which is a question about `album`
  // rows, and joining the group would multiply every row it counts.
  const junk = page.visibility === 'all' ? '' : ' AND al.junk_reason IS NULL';

  const ids =
    page.match === null
      ? rows<{ id: number }>(
          db,
          `SELECT ar.id FROM artist ar
             JOIN album al ON al.artist_id = ar.id
            WHERE 1 = 1${inRoot}${junk}
            GROUP BY ar.id
            ORDER BY COALESCE(ar.sort_key, ar.name), ar.id
            LIMIT ? OFFSET ?`,
          ...root,
          page.size,
          page.offset,
        )
      : rows<{ id: number }>(
          db,
          `SELECT al.artist_id AS id, MIN(track_fts.rank) AS best
             FROM track_fts
             JOIN track t ON t.id = track_fts.rowid
             JOIN album al ON al.id = t.album_id
            WHERE track_fts MATCH ? AND al.artist_id IS NOT NULL${inRoot}${junk}
            GROUP BY al.artist_id
            ORDER BY best, al.artist_id
            LIMIT ? OFFSET ?`,
          page.match,
          ...root,
          page.size,
          page.offset,
        );

  return ids.map((row) => row.id);
}

/**
 * The cover a file in this folder carries, when none of them sits beside it.
 *
 * A record whose folder holds no picture is the ordinary case for a download:
 * measured on the live collection, 54 of the 59 albums without one carry their
 * art inside their files. The first file that has one answers for the folder,
 * in path order — the same determinism the pictures beside a record are chosen
 * with, and for the same reason.
 */
export interface EmbeddedCoverRow {
  rel_path: string;
  root_path: string;
  mime: string;
  offset: number;
  length: number;
  /** `image` — the range is the picture. `indirect` — it holds it. See 017. */
  kind: string;
  /**
   * Which reader to derive an indirect picture with, carried along because the
   * scan already decided it and `file.tags_container` is where that verdict
   * lives.
   *
   * A direct row carries its file's container here too — the query does not
   * filter by kind — so a non-null value must not be read as "this one is
   * indirect". `kind` is what says that.
   */
  container: string | null;
}

export function embeddedCoverInFolder(
  db: DatabaseSync,
  rootId: number,
  relPath: string,
): EmbeddedCoverRow | undefined {
  return row<EmbeddedCoverRow>(
    db,
    `SELECT f.rel_path, r.path AS root_path, c.mime, c.offset, c.length,
            c.kind, f.tags_container AS container
       FROM file f
       JOIN root r ON r.id = f.root_id
       JOIN cover_art c ON c.file_id = f.id
      WHERE f.root_id = ? AND f.folder_rel_path = ?
      ORDER BY f.rel_path
      LIMIT 1`,
    rootId,
    relPath,
  );
}

/**
 * The folders directly inside one folder.
 *
 * The row that stands for a root has `''` for both its path and its parent, so
 * the third condition is what keeps the root from being listed among its own
 * children. It is written as a comparison rather than as a special case for `''`
 * because it says the general thing: a folder is never its own child.
 */
export function childFolders(
  db: DatabaseSync,
  rootId: number,
  parentRelPath: string,
  visibility: Visibility = 'records',
): FolderRow[] {
  // A folder the scanner called junk is not offered as a place to go.
  //
  // **This is what makes hiding complete, and it is not the album filter
  // repeated.** A record is hidden by the clause every listing carries, but the
  // *tree* is built from folders, not from records: the node for `Telegram
  // Desktop` would still be built, still be listed by `getIndexes`, and still
  // open onto an empty directory — a row reading nought, which is the shape the
  // operator would still see in his client. Dropping the folder drops the node
  // with it, everywhere, because every tree in this file is built from here.
  //
  // What it does not cover, stated because the rule is not general: a folder
  // that is *both* junk and a shelf over other records takes those records with
  // it. No folder in this collection is both — a dumping ground holds no
  // records, and the one that does is the root itself, which is never a child of
  // anything — and a rule that had to tell the two apart would have to walk the
  // subtree to answer.
  //
  // **The subquery is correlated, which this file otherwise refuses.** The shape
  // is the one that took the server down once (`ALBUM_GENRES`), and it is kept
  // here because its cost is bounded by something the other had not: this runs
  // once per *child folder* of one folder, not once per album in the collection,
  // and it reads `album (root_id, rel_path)`, which is that table's UNIQUE index
  // — a lookup, not a scan. `getIndexes` walks the whole tree and is measured;
  // it did not move.
  const hideJunk =
    visibility === 'all'
      ? ''
      : `AND NOT EXISTS (SELECT 1 FROM album al
                          WHERE al.root_id = f.root_id AND al.rel_path = f.rel_path
                            AND al.junk_reason IS NOT NULL)`;
  return rows<FolderRow>(
    db,
    `SELECT f.id, f.root_id, f.rel_path, f.parent_rel_path, f.role FROM folder f
      WHERE f.root_id = ? AND f.parent_rel_path = ? AND f.rel_path <> ? ${hideJunk}
      ORDER BY f.rel_path`,
    rootId,
    parentRelPath,
    parentRelPath,
  );
}
