import { splitCredit, type CreditEntry } from './credit.ts';
import type { DatabaseSync } from '../db/index.ts';
import { clearIssues, type Stage } from '../db/issue.ts';
import { parseFolderName } from '../classify/folder-name.ts';
import { basenameOf, rootBasenameOf } from '../util/names.ts';
import { artistFolderOf, qualifiedKey, type ArtistFolder } from './folder.ts';
import { hasCyrillic, latinSpellingsOf } from './translit.ts';
import { artistName } from './name.ts';

/** This stage's name in `issue.stage`. Bound to the insert and to the clear. */
const STAGE: Stage = 'artists';

/**
 * What a `PERFORMER` string can say that is not a performer.
 *
 * A ripper writing PERFORMER on a live recording is saying who was *audible* in
 * the track, not who is credited for it: `Публика` is the audience, `Ведущий`
 * the compere, and `-` is a ripper's way of writing "nobody". None of them is an
 * artist, and left alone they would become rows in the artist tree and hits in
 * the artist search — which is worse than losing them, because a search that
 * answers `Публика` is answering something nobody asked (task:2729).
 *
 * Matched whole and case-folded, never as a substring: an artist called
 * `Ведущий` is not the case this is for, and `Публика` inside a real name would
 * be a different word.
 */
const NOT_A_PERFORMER = new Set(['публика', 'ведущий', 'ведущий ~ публика', '-']);

export interface ArtistCounters {
  artists: number;
  /** Rows whose identity is a guess, whether merged by spelling or split by folder. */
  ambiguous: number;
  /** Names two artist folders both claimed, and which therefore had to be split. */
  homonyms: number;
  linked: number;
  issues: number;
}

interface AlbumRef {
  id: number;
  rootId: number;
  relPath: string;
  releaseId: number | null;
}

interface Candidate {
  /** The artist folder the albums behind this candidate were filed under. */
  folder: ArtistFolder | null;
  /** Every spelling seen, and how often — the display name is the common one. */
  spellings: Map<string, number>;
  /** Case/punctuation/article-folded spellings. More than one means a real merge. */
  folded: Set<string>;
  /** What the key discarded beyond case and punctuation — the disambiguators. */
  stripped: Set<string>;
  albums: Set<number>;
}

/** One artist row about to be written, and how sure the stage is of it. */
interface ArtistRow {
  /** The key it is stored under — the bare one, or `#2` and up when split. */
  key: string;
  /** The name every row of this key came from, before any suffix. */
  baseKey: string;
  candidate: Candidate;
  /** Its identity is a guess: spellings were merged, or folders were split. */
  ambiguous: boolean;
}

/** A name two artist folders both claimed, which had to become two rows. */
interface Homonym {
  spellings: string[];
  /** Each folder that claimed the name, with the key it was given. */
  owners: { folder: ArtistFolder; key: string }[];
  /** Albums that named the artist but sat in no artist folder — a coin flip. */
  guessed: number;
  rootId: number | null;
  relPath: string | null;
}

/** A source's reading of one album's credit, before the artists exist as rows. */
interface Credit {
  album: AlbumRef;
  raw: string;
  source: 'cue' | 'folder' | 'tag';
  entries: CreditEntry[];
}

/**
 * The album a cue's performer belongs to.
 *
 * Three guesses, most specific first. A disc of a release ripped flat is an
 * album keyed on its own image, so the audio file's path fits. An ordinary
 * album is the folder the image sits in. And a cue may sit one level *above*
 * the album it describes (`whole.cue` beside `Album/01.flac`), which is why the
 * cue's own folder is tried last rather than relied on.
 *
 * Missing the middle case is not a near-miss: the artist row is still created,
 * the album simply never points at it, and nothing anywhere says so.
 */
function albumRelPaths(row: {
  audio_rel_path: string;
  audio_folder: string;
  cue_folder: string;
}): string[] {
  return [row.audio_rel_path, row.audio_folder, row.cue_folder];
}

/**
 * The artist an album's own files agree on.
 *
 * ALBUMARTIST is an album-level claim and wins outright. ARTIST is the *track's*
 * artist, so it speaks for the album only when every file in it says the same
 * thing: a compilation whose tracks disagree has no single album artist, and
 * naming it after whichever file sorted first would be confidently wrong about
 * all the others. Null is the honest answer there, and the column already means
 * "not determined".
 *
 * Note what this deliberately does *not* do, on a split: taking the majority
 * would name `2011 - Demonologists + Cock E.S.P.` (10 tracks to 1) after
 * `Cock E.S.P.`, which is exactly the confidently-wrong answer the rule above
 * exists to avoid. A per-track ARTIST names who plays that track, not whose
 * record it is, and no majority fixes that. The album credit comes from the
 * album-level sources instead — the cue, or the folder name.
 *
 * **What it does do is look for a name every track's credit already contains.**
 * A guest is written *inside* the credit — `Sigur Rós & Blanck Mass` on one
 * track of `Kveikur Expanded LP`, `Sigur Rós` on the other two — so the two
 * answers are not two artists disagreeing; one of them is the other plus
 * somebody. Splitting each credit on its joiners and keeping what all of them
 * have in common finds that: `{Sigur Rós}` meets `{Sigur Rós, Blanck Mass}` at
 * `Sigur Rós`, and the album is by Sigur Rós with a guest on one track, which is
 * what `track_artist` is for.
 *
 * It is not the majority rule, and the split above is the proof: `{Demonologists}`
 * and `{Cock E.S.P.}` have nothing in common, so a split still gets no album
 * artist. The rule only ever answers with a name **every** file states, which is
 * a claim about agreement and not about counting — and it is silent unless that
 * name is exactly one, so a collaboration everywhere is still nobody's record.
 */
function albumArtistOf(entry: { albumArtists: string[]; artists: string[] }): string | null {
  const albumArtist = entry.albumArtists[0];
  if (albumArtist !== undefined) return albumArtist;

  if (entry.artists.length === 1) return entry.artists[0] ?? null;

  const credits = entry.artists.map(
    (name) =>
      new Set(
        splitCredit(name)
          .map((part) => part.name.trim())
          .filter((part) => part !== ''),
      ),
  );

  const first = credits[0];
  if (first === undefined) return null;

  const common = [...first].filter((name) => credits.every((credit) => credit.has(name)));
  return common.length === 1 ? (common[0] ?? null) : null;
}

/**
 * What a folder is called: the same question `classify` answers for the title.
 *
 * The root is the one path here that did not come from the walk, and on Windows
 * it arrives backslashed — `rootBasenameOf` rather than `basenameOf`, or an
 * album that *is* its root would be named after the whole path, and the credit
 * its folder states would go unclaimed on Windows while working on Linux.
 */
function folderNameOf(album: AlbumRef, rootPaths: Map<number, string>): string {
  if (album.relPath !== '') return basenameOf(album.relPath);
  return rootBasenameOf(rootPaths.get(album.rootId) ?? '');
}

/**
 * Turn cue performers, folder names and tags into artist rows.
 *
 * Runs after `applyCues`, because that is where a cue's performer first exists
 * and where the tracks a tag's artist is reached through are written.
 *
 * Three sources, in this order, and the order is the whole design:
 *
 *   1. The cue's PERFORMER — a document about *this* record.
 *   2. The folder name — `1994 - Cock E.S.P. + Thirdorgan - Split (Cass, C60)`
 *      states the credit outright, and it is the only source that does for a
 *      collaboration. This is why the feature exists at all.
 *   3. Tags — ALBUMARTIST, or an ARTIST every file agrees on.
 *
 * Whichever wins is read as a *list* (`splitCredit`), because a credit is not
 * one name: on the sample, 20 of 24 Cock E.S.P folders are collaborations. The
 * list is stored with the phrase that joined each entry, so it rebuilds into
 * the original exactly, and the original is kept beside it.
 *
 * Two things this deliberately does not do:
 *
 *   - **It does not touch `track.artist_id`.** Per-track PERFORMER is how a
 *     compilation names its artists — a different question (which artist is on
 *     *this* track), needing the VA overrides the spec keeps separate. Leaving
 *     the column null says "not determined"; filling it with the album artist
 *     would say something false about every track of a mix.
 *   - **It does not guess from a majority.** See `albumArtistOf`.
 *
 * What it writes, it re-derives every time. Albums, releases and credits are
 * unset before being set again, and artist rows left holding nothing are
 * deleted, so a performer removed from a cue on disk actually leaves. The one
 * thing that is *not* re-derived is history: `cue_track` and the files
 * themselves are other stages' business.
 *
 * Three things it does are guesses, and all three say so. A key that merges
 * names folding *differently* was merged by discarding something a human wrote.
 * A key two artist folders both claim is *split*, because the spec reads
 * different folders as different artists ("разные арт-папки = разные артисты",
 * wiki:3498 §3) — though the collection may equally be one artist filed twice,
 * and only a human or an external identifier can settle that. Each writes its
 * own issue, `artist-ambiguous` and `artist-homonym`, and both mark the rows
 * concerned. The third guesses nothing and marks nothing: two keys that are one
 * name in two alphabets are reported as `artist-transliteration` and left as
 * two rows (`translit.ts` has the argument for why they are not merged).
 */
export function applyArtists(db: DatabaseSync): ArtistCounters {
  const counters: ArtistCounters = { artists: 0, ambiguous: 0, homonyms: 0, linked: 0, issues: 0 };

  // The inner join is the point: a cue with no `audio_file_id` describes
  // nothing, and a performer on it names a record that is not in this folder.
  // `applyCues` clears the binding but leaves the row and its performer, so
  // trusting the performer alone keeps an album named after a vanished rip.
  const cueRows = db
    .prepare(
      `SELECT c.performer       AS performer,
              cf.root_id        AS root_id,
              cf.folder_rel_path AS cue_folder,
              af.rel_path       AS audio_rel_path,
              af.folder_rel_path AS audio_folder
       FROM cue c
       JOIN file cf ON cf.id = c.file_id
       JOIN file af ON af.id = c.audio_file_id
       WHERE c.performer IS NOT NULL AND TRIM(c.performer) <> ''
       ORDER BY c.performer`,
    )
    .all() as {
    performer: string;
    root_id: number;
    cue_folder: string;
    audio_rel_path: string;
    audio_folder: string;
  }[];

  const albumIds = new Map<string, number>();
  const albumById = new Map<number, AlbumRef>();
  const orderedAlbums: AlbumRef[] = [];
  for (const row of db
    .prepare('SELECT id, root_id, rel_path, release_id FROM album ORDER BY id')
    .all() as { id: number; root_id: number; rel_path: string; release_id: number | null }[]) {
    const album: AlbumRef = {
      id: row.id,
      rootId: row.root_id,
      relPath: row.rel_path,
      releaseId: row.release_id,
    };
    albumIds.set(`${row.root_id}:${row.rel_path}`, row.id);
    albumById.set(row.id, album);
    orderedAlbums.push(album);
  }

  const rootPaths = new Map<number, string>(
    (db.prepare('SELECT id, path FROM root').all() as { id: number; path: string }[]).map((row) => [
      row.id,
      row.path,
    ]),
  );

  const credits = new Map<number, Credit>();
  const claim = (albumId: number, raw: string, source: Credit['source']): void => {
    // First claim wins, and the order of the three passes below *is* the
    // priority: a cue is claimed before folders are read, so a folder can never
    // displace one.
    if (credits.has(albumId)) return;
    const album = albumById.get(albumId);
    if (album === undefined) return;

    const entries = splitCredit(raw);
    if (entries.length === 0) return;
    credits.set(albumId, { album, raw, source, entries });
  };

  // 1. The cue.
  for (const row of cueRows) {
    for (const relPath of albumRelPaths(row)) {
      const albumId = albumIds.get(`${row.root_id}:${relPath}`);
      if (albumId === undefined) continue;
      claim(albumId, row.performer, 'cue');
      break;
    }
  }

  // 2. The folder name, for every album no cue named.
  for (const album of orderedAlbums) {
    const parsed = parseFolderName(folderNameOf(album, rootPaths));
    if (parsed.credit === null) continue;
    claim(album.id, parsed.credit, 'folder');
  }

  // 3. Tags, reached through `track` — the relation the pipeline already built.
  const tagRows = db
    .prepare(
      `SELECT t.album_id AS album_id, ft.name AS name, ft.value AS value
         FROM track t
         JOIN file_tag ft ON ft.file_id = t.file_id
        WHERE ft.name IN ('albumartist', 'artist')
        ORDER BY t.album_id, ft.name, ft.position`,
    )
    .all() as { album_id: number; name: string; value: string }[];

  const byAlbum = new Map<number, { albumArtists: string[]; artists: string[] }>();
  for (const row of tagRows) {
    let entry = byAlbum.get(row.album_id);
    if (entry === undefined) {
      entry = { albumArtists: [], artists: [] };
      byAlbum.set(row.album_id, entry);
    }
    // A file shared by every track of an image-cue album arrives once per
    // track; the value is the same value, and counting it twice would let one
    // file outvote the others.
    const bucket = row.name === 'albumartist' ? entry.albumArtists : entry.artists;
    if (!bucket.includes(row.value)) bucket.push(row.value);
  }

  for (const [albumId, entry] of [...byAlbum].sort((a, b) => a[0] - b[0])) {
    const name = albumArtistOf(entry);
    if (name === null) continue;
    claim(albumId, name, 'tag');
  }

  // Every chosen credit, read into the rows that will become artists.
  //
  // Grouped by (key, artist folder) rather than by key alone. The key is what
  // merges `The Cure` with `Cure, The`, and it is also what would merge two
  // different bands both called Nirvana — the folder is the only thing that can
  // tell those apart, and the spec hands the deterministic core exactly that
  // half of the signal ("разные арт-папки = разные артисты", wiki:3498 §3).
  const byKey = new Map<string, Map<string | null, Candidate>>();

  function remember(key: string, folder: ArtistFolder | null): Candidate {
    let groups = byKey.get(key);
    if (groups === undefined) {
      groups = new Map();
      byKey.set(key, groups);
    }

    // Keyed on the folder's path-derived id. Null is its own group: an album
    // that names an artist but sits in no artist folder is not evidence that it
    // belongs to a *different* artist, so it must not manufacture a split.
    const id = folder?.id ?? null;
    let candidate = groups.get(id);
    if (candidate === undefined) {
      candidate = {
        folder,
        spellings: new Map(),
        folded: new Set(),
        stripped: new Set(),
        albums: new Set(),
      };
      groups.set(id, candidate);
    }
    return candidate;
  }

  for (const credit of credits.values()) {
    const rootPath = rootPaths.get(credit.album.rootId) ?? '';

    for (const entry of credit.entries) {
      const parsed = artistName(entry.name);
      if (parsed.key === '') continue;

      // Asked per entry, not per album: a collaboration names two artists at
      // once, and each of them may be filed under a folder of its own.
      const folder = artistFolderOf({
        albumRelPath: credit.album.relPath,
        rootPath,
        key: parsed.key,
      });

      const candidate = remember(parsed.key, folder);
      candidate.spellings.set(parsed.name, (candidate.spellings.get(parsed.name) ?? 0) + 1);
      candidate.folded.add(parsed.folded);
      if (parsed.stripped !== null) candidate.stripped.add(parsed.stripped);
      candidate.albums.add(credit.album.id);
    }
  }

  /**
   * Root path, then relative path.
   *
   * Never the root id: ids are rowids, reassigned when a root is dropped from
   * the scan and added back, and `upsertRoot` deletes collapsed twins — so
   * ordering by one would hand `#2` to a different folder with no change to the
   * collection on disk.
   */
  function byFolder(a: ArtistFolder, b: ArtistFolder): number {
    if (a.rootPath !== b.rootPath) return a.rootPath < b.rootPath ? -1 : 1;
    return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
  }

  /** The first album a candidate holds, for attributing an issue to a place. */
  function firstAlbumOf(candidate: Candidate): AlbumRef | undefined {
    return [...candidate.albums]
      .sort((a, b) => a - b)
      .map((id) => albumById.get(id))
      .find((album) => album !== undefined);
  }

  const rows: ArtistRow[] = [];
  const homonyms: Homonym[] = [];
  /** `${albumId}:${baseKey}` -> the row that album's credit for that name lands on. */
  const finalKeyOf = new Map<string, string>();

  for (const [key, groups] of byKey) {
    const loose = groups.get(null);
    const foldered = [...groups.values()]
      .filter(
        (candidate): candidate is Candidate & { folder: ArtistFolder } => candidate.folder !== null,
      )
      .sort((a, b) => byFolder(a.folder, b.folder));

    // A split takes two folders to disagree. One folder — or none at all — is
    // the ordinary case and behaves exactly as it did before folders were read,
    // which is what keeps a band filed under a single artist folder whole.
    const targets = foldered.length === 0 ? (loose === undefined ? [] : [loose]) : foldered;
    const split = targets.length > 1;

    // Read before the folder-less albums are merged in below. The issue is about
    // the folders that disagree, so pinning it to an album that belongs to no
    // folder would give a location its own text contradicts.
    const anchor = foldered[0];
    const where = split && anchor !== undefined ? firstAlbumOf(anchor) : undefined;

    let guessed = 0;

    targets.forEach((candidate, index) => {
      const finalKey = qualifiedKey(key, index);

      // Albums no folder claimed go to the first folder. That is a coin flip, so
      // it is counted here and reported below rather than folded in quietly.
      if (index === 0 && foldered.length > 0 && loose !== undefined) {
        for (const [spelling, seen] of loose.spellings) {
          candidate.spellings.set(spelling, (candidate.spellings.get(spelling) ?? 0) + seen);
        }
        for (const folded of loose.folded) candidate.folded.add(folded);
        for (const stripped of loose.stripped) candidate.stripped.add(stripped);
        for (const albumId of loose.albums) candidate.albums.add(albumId);
        guessed = loose.albums.size;
      }

      for (const albumId of candidate.albums) finalKeyOf.set(`${albumId}:${key}`, finalKey);

      rows.push({
        key: finalKey,
        baseKey: key,
        candidate,
        ambiguous: candidate.folded.size > 1 || split,
      });
    });

    if (split) {
      homonyms.push({
        spellings: [...new Set(targets.flatMap((target) => [...target.spellings.keys()]))].sort(),
        // When a split happens `targets` *is* `foldered`, so the two walks below
        // cannot fall out of step — which is why the folder and the key it was
        // given are carried as one pair rather than as two aligned arrays.
        owners: foldered.map((candidate, index) => ({
          folder: candidate.folder,
          key: qualifiedKey(key, index),
        })),
        guessed,
        rootId: where?.rootId ?? null,
        relPath: where?.relPath ?? null,
      });
    }
  }

  const upsertArtist = db.prepare(
    `INSERT INTO artist (name, name_key, sort_key, ambiguous) VALUES (?, ?, ?, ?)
     ON CONFLICT (name_key) DO UPDATE SET
       name      = excluded.name,
       sort_key  = excluded.sort_key,
       ambiguous = excluded.ambiguous`,
  );
  const selectArtist = db.prepare('SELECT id FROM artist WHERE name_key = ?');
  const linkRelease = db.prepare('UPDATE release SET artist_id = ? WHERE id = ?');

  // A credit is re-derived, so it is cleared rather than merged into: an album
  // whose folder stopped naming a collaborator has to lose them.
  const clearCredits = db.prepare('DELETE FROM artist_credit');
  const resetCredit = db.prepare('UPDATE album SET credit_raw = NULL, credit_source = NULL');
  const setAlbumCredit = db.prepare(
    'UPDATE album SET artist_id = ?, credit_raw = ?, credit_source = ? WHERE id = ?',
  );
  const insertCredit = db.prepare(
    'INSERT INTO artist_credit (album_id, position, artist_id, join_phrase) VALUES (?, ?, ?, ?)',
  );

  // A track's credit is re-derived for the same reason an album's is, and it is
  // the same shape: a list, in the order the source stated, with the word that
  // joined them (task:2729).
  const clearTrackCredits = db.prepare('DELETE FROM track_credit');
  const insertTrackCredit = db.prepare(
    'INSERT INTO track_credit (track_id, position, artist_id, join_phrase) VALUES (?, ?, ?, ?)',
  );

  // Every track a cue states a performer for, with the record it sits in — the
  // same join the dump makes, and for the same reason: a track and its cue_track
  // are one thing seen from two sides, keyed by the audio file and the ordinal.
  const trackPerformerRows = db
    .prepare(
      `SELECT * FROM (
         SELECT t.id AS track_id, t.album_id AS album_id,
                f.root_id AS root_id, f.rel_path AS rel_path,
                (SELECT ct.performer
                   FROM cue c JOIN cue_track ct ON ct.cue_id = c.id
                  WHERE c.audio_file_id = t.file_id AND ct.ordinal = t.ordinal
                  ORDER BY c.id LIMIT 1) AS performer
           FROM track t JOIN file f ON f.id = t.file_id
       ) WHERE performer IS NOT NULL AND trim(performer) <> ''`,
    )
    .all() as unknown as {
    track_id: number;
    album_id: number | null;
    root_id: number;
    rel_path: string;
    performer: string;
  }[];

  /** Files holding tracks whose performer nothing here can resolve — per file. */
  const unplaced = new Map<string, { root_id: number; rel_path: string; tracks: number }>();

  /**
   * The artists each record's own credit landed on, in order.
   *
   * Kept so a track can be compared with its record by *identity* rather than by
   * the string the cue wrote. The two are not the same test: `[LINKIN PARK]` and
   * `Linkin Park` are one artist in two spellings — 137 of this collection's
   * stated performers are exactly that — and a string comparison would write a
   * track credit for every one of them, saying nothing the record did not already
   * say (task:2729).
   */
  const albumCreditIds = new Map<number, number[]>();

  // An artist named only by a credit is still an artist. Without the last
  // UNION, `pruneArtists` deletes such a row and the cascade takes the credit
  // with it — silently, and only for collaborations, which is exactly the case
  // this whole stage was built for.
  const pruneArtists = db.prepare(
    `DELETE FROM artist WHERE id NOT IN (
       SELECT artist_id FROM album WHERE artist_id IS NOT NULL
       UNION SELECT artist_id FROM release WHERE artist_id IS NOT NULL
       UNION SELECT artist_id FROM artist_credit
       UNION SELECT artist_id FROM track_credit
     )`,
  );
  const insertIssue = db.prepare(
    `INSERT INTO issue (scan_run_id, stage, root_id, rel_path, kind, severity, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const latestRun = (db.prepare('SELECT MAX(id) AS id FROM scan_run').get() as { id: number | null })
    .id;

  /**
   * How many accents a spelling carries.
   *
   * Decomposed first, so the two writings of one letter count the same: `ö` as
   * one code point and as `o` plus U+0308 are one accent, and a spelling must
   * not win on the accident of how its tag happened to be stored.
   */
  function marksIn(name: string): number {
    return (name.normalize('NFD').match(/\p{M}/gu) ?? []).length;
  }

  /**
   * How the merged artist is displayed: the spelling that carries the most
   * accents, then the one the collection uses most, and on a tie the briefest —
   * decoration is what tends to be added (`Cure, The` over `The Cure`,
   * `Nirvana (UK)` over `Nirvana`), so the shortest is usually the plainest.
   *
   * The accents come first because they are the one decoration that is not
   * added: they are what a tag *loses*. `Röyksopp` written `Royksopp` is a
   * ripper's umlaut gone missing, and the count would have picked the lossy
   * spelling whenever it happened to be the more common one — which, on the
   * live collection, it is. Code units last rather than `localeCompare`, whose
   * ordering depends on the host's ICU data — the same unchanged collection
   * must not name an artist differently on two machines.
   */
  function displayName(spellings: Map<string, number>): string {
    const ranked = [...spellings.entries()].sort(
      (a, b) =>
        marksIn(b[0]) - marksIn(a[0]) ||
        b[1] - a[1] ||
        a[0].length - b[0].length ||
        (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    const best = ranked[0];
    return best === undefined ? '' : best[0];
  }

  try {
    // `IMMEDIATE`, so that what this transaction happens to do first cannot
    // decide whether it waits — the first statement below is a write, which
    // would consult the busy handler under a deferred `BEGIN`, but that is a
    // property of the order of the statements rather than of this line, and the
    // order is what the next edit changes. `db/index.ts` has the rule and
    // `search/index.ts` the case where it already matters (task:2871).
    db.exec('BEGIN IMMEDIATE');

    // This stage derives everything from the current meta layer, so its issues
    // describe the present and an earlier run's rows are dead weight. The scope
    // used to be `AND scan_run_id IS ?`, which reads as "the present" and is
    // not: it matched only rows *this* run had already written, so it guarded
    // against running the stage twice in one run and let every run add another
    // set. See `db/issue.ts`.
    clearIssues(db, 'artists');

    // Unset before setting: an album whose cue no longer names anyone has to
    // lose the artist it had, not keep it forever.
    db.prepare('UPDATE album SET artist_id = NULL').run();
    db.prepare('UPDATE release SET artist_id = NULL').run();
    clearCredits.run();
    resetCredit.run();
    clearTrackCredits.run();

    for (const row of rows) {
      const name = displayName(row.candidate.spellings);
      upsertArtist.run(name, row.key, artistName(name).sortKey, row.ambiguous ? 1 : 0);

      if (row.ambiguous) counters.ambiguous += 1;

      // A merge of spellings is a guess in its own right and keeps its own
      // issue. A split is reported once per name below, since it spans rows.
      if (row.candidate.folded.size <= 1) continue;

      counters.issues += 1;

      // Attributed to the first album that pulled this key in, so the row can
      // be traced back and scoped to a root. `root_id` of null would have made
      // it unfindable in the dump.
      const where = firstAlbumOf(row.candidate);

      const dropped =
        row.candidate.stripped.size === 0
          ? ''
          : ` by dropping ${[...row.candidate.stripped].sort().join(', ')}`;

      insertIssue.run(
        latestRun,
        STAGE,
        where?.rootId ?? null,
        where?.relPath ?? null,
        'artist-ambiguous',
        'warn',
        `${[...row.candidate.spellings.keys()].sort().join(' / ')} all reduce to "${row.baseKey}"${dropped}`,
      );
    }

    // Said out loud, once per name, because it is a claim the rules cannot prove:
    // two folders named after the artist are two artists — or one artist filed
    // twice, and nothing on disk says which. Only a human or an external
    // identifier can settle that, so it is a warning rather than a decision.
    for (const homonym of homonyms) {
      counters.homonyms += 1;
      counters.issues += 1;

      const described = homonym.owners.map(({ folder }) =>
        folder.relPath === '' ? `the root itself (${folder.rootPath})` : folder.relPath,
      );
      const guessed =
        homonym.guessed === 0
          ? ''
          : `; ${homonym.guessed} album${homonym.guessed === 1 ? '' : 's'} named the artist but sat in no artist folder, and went to the first`;

      insertIssue.run(
        latestRun,
        STAGE,
        homonym.rootId,
        homonym.relPath,
        'artist-homonym',
        'warn',
        `${homonym.spellings.join(' / ')} came from ${described.length} artist folders (${described.join(', ')}) -> ${homonym.owners.map((owner) => owner.key).join(' / ')}${guessed}`,
      );
    }

    // The credits, written in the order the source stated them. The first name
    // becomes the album's artist — a single displayed artist is what the rest
    // of the meta layer and the API need — while the list keeps the whole
    // truth beside it.
    for (const credit of credits.values()) {
      // Resolved through the group this album's credit actually landed in, not
      // through the bare key. The moment two folders split a name, the bare key
      // is the wrong answer: a collaborator credited inside the second folder
      // would be written onto the first artist's row — right name, wrong band,
      // and the credit list on the album is the only thing that would show it.
      const written = credit.entries
        .map((entry) => ({
          entry,
          key: finalKeyOf.get(`${credit.album.id}:${artistName(entry.name).key}`),
        }))
        .map((pair) => ({
          ...pair,
          id:
            pair.key === undefined
              ? undefined
              : (selectArtist.get(pair.key) as { id: number } | undefined)?.id,
        }))
        .filter(
          (pair): pair is { entry: CreditEntry; key: string; id: number } => pair.id !== undefined,
        );

      if (written.length === 0) continue;

      written.forEach((pair, position) => {
        insertCredit.run(credit.album.id, position, pair.id, pair.entry.joinPhrase);
      });
      albumCreditIds.set(
        credit.album.id,
        written.map((pair) => pair.id),
      );

      const first = written[0];
      if (first === undefined) continue;

      setAlbumCredit.run(first.id, credit.raw, credit.source, credit.album.id);
      counters.linked += 1;

      const releaseId = credit.album.releaseId;
      if (releaseId !== null) linkRelease.run(first.id, releaseId);

      // The reading, said out loud. `Smell & Quim` is one artist and this
      // splits it; so is `Florence + the Machine`. The rules cannot tell, so
      // the only honest thing left is to make the guess reviewable.
      //
      // It fires whenever a credit carries a separator, which is the event
      // itself rather than noise — but the names are quoted in the message
      // because the obvious rendering is a tautology: `Cock E.S.P. + Thirdorgan`
      // printed back as `Cock E.S.P. + Thirdorgan` says nothing, since the word
      // that joined them and the word this joined them with are the same one.
      // Quoted, the message shows *where* the split was made, which is the only
      // thing a reader can disagree with (task:2756).
      if (written.length > 1) {
        insertIssue.run(
          latestRun,
          STAGE,
          credit.album.rootId,
          credit.album.relPath,
          'artist-credit-split',
          'info',
          `${credit.raw} -> ${written.map((pair) => `"${pair.entry.name}"`).join(' + ')}`,
        );
        counters.issues += 1;
      }
    }

    // The tracks whose performer is not the record's credit — the second half of
    // what a credit is, and the half `track.artist_id` cannot hold: it holds one
    // artist, and `Кино & Джоанна Стингрей` is two (task:2729).
    //
    // Written were the two disagree. Where they agree the row would only repeat
    // the album's own credit — 1862 of the collection's 2626 stated performers
    // agree — and a row that says nothing new is a row that has to be kept in
    // step for no reason.
    //
    // `NOT_A_PERFORMER` is the rule this starts from: a ripper writing PERFORMER
    // on a live recording is saying who was *audible*, and `Публика` is the
    // audience. Those parts are dropped, and the drop is said out loud — a
    // refusal that keeps quiet is the same loss in a smaller place.
    for (const row of trackPerformerRows) {
      const parts = splitCredit(row.performer);
      const spoken = parts.filter((part) => !NOT_A_PERFORMER.has(part.name.trim().toLowerCase()));
      const dropped = parts.length - spoken.length;

      if (spoken.length === 0) {
        // Nothing but a note about the room. Reported once per track rather than
        // once per run: the thing to go and look at is a track, and 12 of them
        // is not a number worth aggregating away.
        insertIssue.run(
          latestRun,
          STAGE,
          row.root_id,
          row.rel_path,
          'track-performer-declined',
          'info',
          `PERFORMER is ${row.performer}, which names the room rather than a performer`,
        );
        counters.issues += 1;
        continue;
      }

      if (row.album_id === null) {
        // No record to defer to, and no folder for this stage to stand an
        // identity on: the names here are not in any artist folder, so resolving
        // them would be inventing the identity rather than reading it. Counted
        // per file, because that is where the missing thing is (task:2729).
        unplaced.set(`${row.root_id}:${row.rel_path}`, {
          root_id: row.root_id,
          rel_path: row.rel_path,
          tracks: (unplaced.get(`${row.root_id}:${row.rel_path}`)?.tracks ?? 0) + 1,
        });
        continue;
      }

      const written = spoken
        .map((entry) => {
          const key = finalKeyOf.get(`${row.album_id}:${artistName(entry.name).key}`);
          // Through the record's group first — the same rule the album's own
          // credit follows, and for the same reason: two artist folders can hold
          // one spelling, and the bare key would then be the other band's row.
          //
          // A name *only* a track states has no group: it is in no artist folder
          // and on no record's credit, so `finalKeyOf` has never seen it. Those
          // resolve through the name itself, and only to a row that already
          // exists — a guest on this track who appears on another record's credit
          // is a person this stage knows. Creating the row here instead would be
          // inventing an identity with no folder to stand it on, which is the
          // guess this stage refuses to make everywhere else.
          const bare = artistName(entry.name).key;
          const id =
            key === undefined
              ? (selectArtist.get(bare) as { id: number } | undefined)?.id
              : (selectArtist.get(key) as { id: number } | undefined)?.id;
          return id === undefined ? undefined : { entry, id };
        })
        .filter((pair): pair is { entry: CreditEntry; id: number } => pair !== undefined);

      // The same artists, in the same order, as the record's own credit: this
      // track says nothing the record does not, and a row repeating it would
      // have to be kept in step for no reason. Compared by identity, not by the
      // string the cue wrote — see `albumCreditIds`.
      // A part that resolved to nobody is the one way this can lose a name
      // silently, so it is the one thing said out loud here — and it is asked
      // *before* the comparison below, because a partial credit can look exactly
      // like the record's own: `Кино & Гость` on a record credited `Кино`
      // resolves to just the band, matches, and would have been dropped without
      // ever saying that the guest was lost. Nothing is written in that case
      // either: naming some of a track's people as all of them is worse than
      // naming none (task:2729, and 120 of them in the live collection).
      if (written.length < spoken.length) {
        const unresolved = spoken.filter((entry) => !written.some((pair) => pair.entry === entry));
        insertIssue.run(
          latestRun,
          STAGE,
          row.root_id,
          row.rel_path,
          'track-performer-unresolved',
          'info',
          `${unresolved.map((e) => e.name).join(' + ')} is named only by this track and by no artist folder, so there is no row to attach it to`,
        );
        counters.issues += 1;
        continue;
      }

      // The same artists, in the same order, as the record's own credit: this
      // track says nothing the record does not, and a row repeating it would
      // have to be kept in step for no reason. Compared by identity, not by the
      // string the cue wrote — see `albumCreditIds`.
      const record = albumCreditIds.get(row.album_id) ?? [];
      const sameCredit =
        written.length === record.length && written.every((pair, at) => pair.id === record[at]);
      if (sameCredit) continue;

      written.forEach((pair, position) => {
        insertTrackCredit.run(row.track_id, position, pair.id, pair.entry.joinPhrase);
      });

      if (dropped > 0) {
        insertIssue.run(
          latestRun,
          STAGE,
          row.root_id,
          row.rel_path,
          'track-performer-declined',
          'info',
          `${row.performer} -> ${spoken.map((e) => e.name).join(' + ')} (${dropped} part(s) named the room)`,
        );
        counters.issues += 1;
      }
    }

    for (const unplacedRow of unplaced.values()) {
      insertIssue.run(
        latestRun,
        STAGE,
        unplacedRow.root_id,
        unplacedRow.rel_path,
        'track-performer-unplaced',
        'info',
        `${unplacedRow.tracks} track(s) state a performer and sit in no record, so there is no credit to compare it with and no artist folder to resolve it through`,
      );
      counters.issues += 1;
    }

    // An album no source could name. Declining to guess is this stage's rule and
    // it is right (`albumArtistOf`) — but the refusal was silent, and an empty
    // artist reads the same whether the record is a compilation whose ripper
    // wrote no ALBUMARTIST or an artist that got lost. Those want opposite
    // responses from whoever reads the dump, and telling them apart is the whole
    // of what is reported below: the number of distinct ARTIST tags is the
    // signal, and it stays a report rather than becoming a `Various Artists` the
    // stage would be inventing (task:2701).
    const unclaimed = db
      .prepare(
        `SELECT a.id AS id, a.root_id AS root_id, a.rel_path AS rel_path,
                (SELECT COUNT(*) FROM track t WHERE t.album_id = a.id) AS tracks
           FROM album a WHERE a.artist_id IS NULL
          ORDER BY a.root_id, a.rel_path`,
      )
      .all() as { id: number; root_id: number; rel_path: string; tracks: number }[];

    for (const album of unclaimed) {
      // The distinct values the tags stage read, counted once per value above:
      // one file shared by every track of an image-cue album is one voice.
      const stated = byAlbum.get(album.id)?.artists.length ?? 0;
      const carried =
        stated === 0
          ? 'no ARTIST tag'
          : stated === 1
            ? 'one ARTIST tag'
            : `${stated} different ARTIST tags`;

      insertIssue.run(
        latestRun,
        STAGE,
        album.root_id,
        album.rel_path,
        'album-without-artist',
        'info',
        `no source named this record; its ${album.tracks} track${album.tracks === 1 ? '' : 's'} carry ${carried}`,
      );
      counters.issues += 1;
    }

    // An artist holding nothing is one whose performer went away. The stage
    // derives from the present; it does not keep ghosts of the past.
    pruneArtists.run();

    // Two surviving rows whose keys are one name in two alphabets: the Kino
    // catalogue writes `Кино` in 48 cues and `Kino` in the French edition of
    // one, and a reader sees one band where the database holds two. The pairing
    // is *said* and not acted on — see `translit.ts` for why a merge here would
    // be asserting an identity nothing on disk states. Reported after the prune
    // so a pair is only ever named when both rows are actually in the layer.
    const artistRows = db
      .prepare('SELECT id, name, name_key FROM artist')
      .all() as { id: number; name: string; name_key: string }[];
    const unqualified = artistRows.filter((row) => !row.name_key.includes('#'));
    const nonCyrillicByKey = new Map(
      unqualified.filter((row) => !hasCyrillic(row.name_key)).map((row) => [row.name_key, row]),
    );

    // The path is for tracing and scoping — the finding is about a pair of
    // rows, not about one album — but a report with no location at all is
    // unfindable in the dump, which is why the sibling stage refuses a null
    // root too. A collaborator named only by a credit has no album of its own
    // (`Aube + Кино`), so the fallback reaches it through the credit.
    const albumOfArtist = db.prepare(
      `SELECT a.root_id, a.rel_path FROM album a WHERE a.artist_id = ?
        UNION ALL
       SELECT a.root_id, a.rel_path FROM artist_credit c JOIN album a ON a.id = c.album_id
        WHERE c.artist_id = ?
        ORDER BY root_id, rel_path LIMIT 1`,
    );

    // Every pair, not the first one found: a single key can be written several
    // ways (`Ксения` as `Kseniya` and as `Ksenia`), and each is a different row
    // a reader would want named. Stopping at the first would drop the rest
    // without saying so — the failure this report exists to prevent.
    //
    // Qualified keys (`кино#2`) are left out of the pairing. The index is a
    // position within that key's own group, so pairing `кино#2` with `kino#2`
    // would claim the second folder of one group is the second folder of the
    // other, and nothing supports that. The base rows already make the
    // band-level finding, so declining costs nothing.
    for (const row of unqualified.filter((candidate) => hasCyrillic(candidate.name_key))) {
      const where = albumOfArtist.get(row.id, row.id) as
        | { root_id: number; rel_path: string }
        | undefined;

      for (const latin of latinSpellingsOf(row.name_key)) {
        const other = nonCyrillicByKey.get(latin);
        if (other === undefined) continue;

        insertIssue.run(
          latestRun,
          STAGE,
          where?.root_id ?? null,
          where?.rel_path ?? null,
          'artist-transliteration',
          'warn',
          `${[row.name, other.name].sort().join(' / ')} — may be one name in two alphabets`,
        );
        counters.issues += 1;
      }
    }

    counters.artists = (db.prepare('SELECT COUNT(*) AS n FROM artist').get() as { n: number }).n;

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already unwound; the original error is what matters.
    }
    throw err;
  }

  return counters;
}
