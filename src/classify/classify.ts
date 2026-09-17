import { basename } from 'node:path';

import { withTransaction, type DatabaseSync } from '../db/index.ts';
import { prepareSweep, SWEPT_BY_CLASSIFY } from '../db/sweep.ts';
import { junkReason, type Verdict } from '../junk/rule.ts';
import type { FileKind } from '../scan/kinds.ts';
import type { WalkedFile } from '../scan/walk.ts';
import { compareNatural, stemOf } from '../util/names.ts';
import { parseFolderName, recordTitle, splitFields } from './folder-name.ts';
import {
  assignRoles,
  discMarker,
  discMarkerIndex,
  discNumber,
  flatDiscPairs,
  isDiscName,
  type DiscPair,
  type FolderRole,
} from './roles.ts';
import { buildTree, type FolderNode } from './tree.ts';

export interface ClassifyCounters {
  folders: number;
  albums: number;
  releases: number;
  byRole: Record<FolderRole, number>;
}

const ALL_ROLES: readonly FolderRole[] = ['album', 'disc', 'box', 'category', 'empty'];

interface FileRow {
  rel_path: string;
  folder_rel_path: string;
  name: string;
  kind: string;
  ext: string;
  size: number;
  mtime_ms: number;
}

function toWalkedFile(row: FileRow): WalkedFile {
  return {
    relPath: row.rel_path,
    folderRelPath: row.folder_rel_path,
    name: row.name,
    kind: row.kind as FileKind,
    ext: row.ext,
    size: row.size,
    mtimeMs: row.mtime_ms,
  };
}

/**
 * Provisional album name.
 *
 * The contract says metadata comes from the folder, the cue and the .nfo
 * (requirements:39 §4). Only the folder is available at this stage, so the name
 * stands in until the cue and tag readers can override it.
 *
 * A collector's folder carries more than the title, though — the year, the
 * artist, the Discogs format note — and a release called
 * `1996 - Greatest Dicks (CD, Comp)` is called `Greatest Dicks`. `parseFolderName`
 * reads the name once for all three tasks that want a piece of it, and the
 * title is this stage's piece. The verbatim name is the fallback: when there is
 * nothing to strip, or stripping leaves nothing (`2009 - Twodeadsluts
 * Onegoodfuck + Cock E.S.P. (Cass, Ltd, C5)` is a credit and a format with no
 * title between them), a noisy name still beats an empty one.
 */
function displayName(node: FolderNode, rootPath: string): string {
  const name = node.relPath === '' ? basename(rootPath) : node.name;
  return parseFolderName(name).title ?? name;
}

/**
 * The name a *record* is shown by — see `recordTitle`, which owns the rule.
 *
 * Only a release reads it, and it parts from `displayName` twice, both times
 * over what a person is shown. It takes the year out of the name — a record's
 * year is the one a box states on its own folder, and `folderYear` reads it for
 * an album either way — and it *keeps* the edition note that `displayName`
 * strips. `1988 ● Группа крови (2019, Maschina Records, MKK881CD, 3CD)` and
 * `Группа Крови (Gold Castle Rec.)` are one album by one band, and a client
 * shown `Группа крови` twice has nothing to choose between them.
 *
 * The note is not said again in `AlbumID3.version`: the API offers that field
 * only when the name does not already carry the note, which for a release named
 * here it always does. See `albumId3`.
 */
function releaseName(node: FolderNode, rootPath: string): string {
  return recordTitle(node.relPath === '' ? basename(rootPath) : node.name);
}

/**
 * The year the folder's name states, or nothing.
 *
 * The same read as the name above, and the same source: the year slot a
 * collector puts in front of a title. It was parsed and thrown away until a
 * client asked for a release date — 236 of the 241 albums in the live
 * collection state one, and all of them were being discarded on the line above.
 */
function folderYear(node: FolderNode, rootPath: string): number | null {
  const name = node.relPath === '' ? basename(rootPath) : node.name;
  return parseFolderName(name).year;
}

/** `01. x - Pulse` -> `1`; null when the name carries no disc number. */
function leadingNumber(name: string): number | null {
  const match = /^(\d{1,2})\s*[.\-_)\]]/.exec(name.trim());
  const digits = match?.[1];
  return digits === undefined ? null : Number.parseInt(digits, 10);
}

/** Whether a folder holds audio of its own — the only thing a disc can be. */
function hasAudioHere(node: FolderNode): boolean {
  return node.files.some((file) => file.kind === 'audio');
}

/**
 * The children of a folder that are discs by their *name*, whatever their role.
 *
 * `assignRoles` promotes a child to `disc` only where the folder around it came
 * out a box, and a shelf is not one. So the discs of a shelf carry the role of
 * an ordinary album, and the only thing left that says what they are is their
 * name — the same `isDiscName` the role rule reads.
 */
function namedDiscs(node: FolderNode): FolderNode[] {
  return node.children.filter((child) => isDiscName(child.name) && hasAudioHere(child));
}

/**
 * Those children gathered into the sets they name.
 *
 * A disc's set is everything in front of its marker: `2014 - .5 The Gray
 * Chapter - CD 1 [JP - WPCR-16130]` and `… CD 2 [JP - WPCR-16131]` are one set
 * although their catalogue numbers differ, because the difference comes *after*
 * the marker. Bare `CD 1` and `CD 2` are one set too — nothing in front of the
 * marker, both times.
 *
 * The distinction matters because a shelf may hold two sets, and they are two
 * records. Pooling them is not a naming problem: the second set stops existing,
 * its songs joining the first record's totals ([[task:2811]], finding 1).
 */
function discSets(node: FolderNode): FolderNode[][] {
  const byName = new Map<string, FolderNode[]>();
  for (const child of namedDiscs(node)) {
    const at = discMarkerIndex(child.name);
    const prefix = at === -1 ? child.name : child.name.slice(0, at);
    const key = prefix.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    byName.set(key, [...(byName.get(key) ?? []), child]);
  }
  return [...byName.values()];
}

/**
 * The name a shelf's release starts out as: what its discs are called.
 *
 * The discs are the record — the shelf's own name is a statement about the rip,
 * not about the music (`Slipknot AAC 320` names a format). Both discs of a pair
 * are named after the record, so either answers; the lowest disc number is
 * taken, which is the same choice `ALBUM_GROUPS` makes about which row stands
 * for a group, made here for the same reason.
 *
 * What tells one shelf from the next is *not* added here. That needs the
 * artist, and this stage writes no artists — `shelf-name.ts` runs last and
 * appends it, to this name or to whatever a tag or cue made of it.
 */
function shelfReleaseName(discs: readonly FolderNode[], rootPath: string): string {
  const ordered = [...discs].sort(
    (a, b) =>
      (discNumber(a.name) ?? 0) - (discNumber(b.name) ?? 0) ||
      compareNatural(a.relPath, b.relPath),
  );
  const first = ordered[0];
  return first === undefined ? '' : displayName(first, rootPath);
}

/**
 * Cut a shared prefix back to a boundary between two names.
 *
 * Two discs of one record share almost their whole name. `Pink Floyd - The Wall
 * [Disc 1]` and `Pink Floyd - The Wall [1994 Remaster](Disc 2)` agree as far as
 * `Pink Floyd - The Wall [`, and taking that prefix leaves `Disc 1]` and
 * `1994 Remaster](Disc 2)` — titles opening on a closing bracket, which is not a
 * name anybody wrote. A prefix ending inside a bracket is not a boundary between
 * two names, so it walks back to the last one that is.
 *
 * The boundary comes from `splitFields`, the bracket-aware splitter the folder
 * parser already uses, rather than from a second scanner counting depth here.
 * `folder-name.ts` opens by naming that duplication as the Shotgun Surgery this
 * project already has a task for.
 */
function snapPrefix(prefix: string): string {
  const opened = (prefix.match(/[([]/g) ?? []).length;
  const closed = (prefix.match(/[)\]]/g) ?? []).length;

  // Balanced, so the cut landed between two names and is a boundary already.
  if (opened <= closed) return prefix;

  // Inside a bracket. Keep everything before the last boundary; when there is no
  // boundary to walk back to, keep nothing and let the caller fall back to the
  // file's own name rather than serve a fragment.
  const parts = splitFields(prefix);
  return parts.length > 1 ? parts.slice(0, -1).join(' - ') : '';
}

/**
 * Name each disc by what survives once the folder's shared prefix is removed,
 * so `VA - A State Of Trance_Ibiza 2026 - Pulse/Frequency/Energy` becomes
 * `Pulse`, `Frequency`, `Energy`. Falls back to the file's own stem if
 * stripping leaves nothing — a name is better than an empty string.
 *
 * What survives has to be a **name**, and that is the whole of what a letter
 * tests. `CD1` and `CD2` agree as far as `CD`, so the strip leaves `1` and `2`:
 * honest, and telling a reader nothing — the album list showed the Kino box as
 * two records called `1` and `2`. A folder box has no such hole, because its
 * discs are *folders* and their names are kept whole (`CD1 ● Группа крови`), and
 * the flat pair's equivalent of that name is the file's own stem, which is what
 * the disc is called (task:2756, finding 7).
 */
function discTitles(pairs: readonly DiscPair[]): string[] {
  const stripped = pairs.map((pair) => stemOf(pair.audio.name).replace(/^\d+\s*[.\-_)\]]*\s*/, ''));

  let prefix = stripped[0] ?? '';
  for (const value of stripped) {
    while (prefix !== '' && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }

  prefix = snapPrefix(prefix);

  return stripped.map((value, index) => {
    const trimmed = value.slice(prefix.length).replace(/^[\s\-_.]+|[\s\-_.]+$/g, '');
    if (/\p{L}/u.test(trimmed)) return trimmed;
    return stemOf(pairs[index]?.audio.name ?? '');
  });
}

/**
 * Classify every folder and materialise the album tree.
 *
 * Album identity is the path — `(root_id, rel_path)` and nothing else. Two
 * pressings of the same record, or one album present under two roots, produce
 * two rows, because the filesystem says they are two things. Tags may enrich a
 * row later; they never merge two of them.
 *
 * Re-running is safe: rows are matched on the same identity and updated.
 *
 * Albums and releases are created, updated, and — where the folder beneath
 * them is gone — dropped. Letting go belongs here rather than in the scan
 * because the scan sweeps folders first: by the time this runs, a folder row
 * that is missing is missing because a walk did not see it. What keeps that
 * from being a mistake is the stamp — a row the latest classification
 * re-derived from a surviving folder carries the run, and a row it did not
 * carries an older one. So a root the latest run never walked keeps everything
 * it had.
 */
export function classify(db: DatabaseSync): ClassifyCounters {
  const byRole = Object.fromEntries(ALL_ROLES.map((role) => [role, 0])) as Record<FolderRole, number>;
  let folders = 0;
  let albums = 0;
  let releases = 0;

  const roots = db.prepare('SELECT id, path FROM root ORDER BY id').all() as {
    id: number;
    path: string;
  }[];

  // The run this classification belongs to. With no run there is nothing to
  // scope a sweep by — and nothing that rows could be older than.
  const runId = (db.prepare('SELECT MAX(id) AS id FROM scan_run').get() as { id: number | null }).id;

  const selectFolders = db.prepare('SELECT rel_path FROM folder WHERE root_id = ?');
  // The hand marks for one root, read once: `junk/rule.ts` owns what they mean.
  const selectMarks = db.prepare('SELECT rel_path, verdict FROM junk_mark WHERE root_id = ?');
  const selectFiles = db.prepare(
    `SELECT rel_path, folder_rel_path, name, kind, ext, size, mtime_ms
     FROM file WHERE root_id = ?`,
  );
  const updateRole = db.prepare('UPDATE folder SET role = ? WHERE root_id = ? AND rel_path = ?');

  // artist_id is deliberately absent: normalising artists is a later stage, and
  // leaving it out here means reclassifying never clobbers what it wrote.
  //
  // `title_source` is set, and set to the plain truth: this name came from the
  // folder. It is overwritten by whichever later stage has a better one, and it
  // is written unconditionally because the folder name is re-derived on every
  // pass — a stage that wants its own name to survive a rescan has to say so
  // again on that rescan anyway.
  // The year follows the same rule the title does and one more: a folder that
  // names no year must not erase the one a file's own DATE stated, which is the
  // only thing the `COALESCE` and the `CASE` below are for. Everything else is
  // re-derived on every pass, because the folder is.
  // `junk_reason` is written unconditionally, like `title` and unlike `year`:
  // what the folder holds is on disk and is re-derived on every pass, so a folder
  // that stops being a dumping ground stops being junk without anyone saying so.
  // The one thing that outranks it is a hand mark, and `junkReason` is where that
  // is decided — this stage only carries the answer.
  const upsertAlbum = db.prepare(
    `INSERT INTO album (root_id, rel_path, title, title_source, release_id, disc_number, year, year_source, junk_reason, last_seen_run_id)
     VALUES (?, ?, ?, 'folder', ?, ?, ?, ?, ?, ?)
     ON CONFLICT (root_id, rel_path) DO UPDATE SET
       title        = excluded.title,
       title_source = excluded.title_source,
       release_id   = excluded.release_id,
       disc_number  = excluded.disc_number,
       year         = COALESCE(excluded.year, album.year),
       year_source  = CASE WHEN excluded.year IS NULL THEN album.year_source ELSE excluded.year_source END,
       junk_reason  = excluded.junk_reason,
       last_seen_run_id = excluded.last_seen_run_id`,
  );
  // The release carries the year too, and for the opposite reason the album's
  // `COALESCE` above exists: a box states its year on the *box* folder and its
  // discs state none (`1988 ● Группа крови (…)` over `CD1 ● Альбом`), so the
  // year has nowhere else to live. `ALBUM_SELECT` asks the release first for
  // exactly that reason — a record *is* its release where it has one, and a
  // disc's year is the year of the album that disc holds, which for a box is
  // not the record's. What a tag or a cue writes is the *album's*, and it is
  // still what dates a record with no release above it.
  const upsertRelease = db.prepare(
    `INSERT INTO release (root_id, rel_path, title, title_source, year, last_seen_run_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (root_id, rel_path) DO UPDATE SET
       title        = excluded.title,
       title_source = excluded.title_source,
       year         = excluded.year,
       last_seen_run_id = excluded.last_seen_run_id`,
  );
  const selectRelease = db.prepare('SELECT id FROM release WHERE root_id = ? AND rel_path = ?');

  // Letting go of albums and releases whose folder is gone. This belongs here
  // because classify is what creates them, and it runs after the scan, so the
  // folder rows for whatever disappeared are already gone by now. How a row is
  // judged, and what has to be released before it goes, is `db/sweep.ts`.
  const sweep = prepareSweep(db, SWEPT_BY_CLASSIFY);

  for (const root of roots) {
    const folderPaths = (selectFolders.all(root.id) as { rel_path: string }[]).map((r) => r.rel_path);
    // node:sqlite types a row as Record<string, SQLOutputValue>; the columns are
    // ours, so the bridge through unknown is a naming step, not a conversion.
    const files = (selectFiles.all(root.id) as unknown as FileRow[]).map(toWalkedFile);
    const marks = new Map(
      (selectMarks.all(root.id) as { rel_path: string; verdict: string }[]).map((row) => [
        row.rel_path,
        row.verdict as Verdict,
      ]),
    );

    const tree = buildTree(folderPaths, files);
    assignRoles(tree);

    const persist = (
      node: FolderNode,
      releaseId: number | null,
      discOrdinal: number | null,
    ): void => {
      if (node.relPath !== '') {
        updateRole.run(node.role, root.id, node.relPath);
        folders += 1;
        if (node.role !== null) byRole[node.role] += 1;
      }

      let inheritedRelease = releaseId;
      // When *this* folder's release covers named children rather than all of
      // them: a shelf's covers its disc set and stops there, where a box's
      // covers every child it has, because every child it has is a disc. The
      // set is carried rather than a flag, so a disc-named child that is *not*
      // in the set does not slip in beside it.
      let shelfDiscs: ReadonlySet<string> | null = null;

      if (node.role === 'box') {
        upsertRelease.run(
          root.id,
          node.relPath,
          releaseName(node, root.path),
          'folder',
          folderYear(node, root.path),
          runId,
        );
        inheritedRelease = (
          selectRelease.get(root.id, node.relPath) as { id: number } | undefined
        )?.id ?? null;
        releases += 1;

        const pairs = flatDiscPairs(node.files);
        const paired = new Set(pairs.map((pair) => pair.audio.relPath));
        const loose = node.files.filter((file) => file.kind === 'audio' && !paired.has(file.relPath));

        if (pairs.length >= 2) {
          // Flat multi-disc: each pair IS a disc, so it takes its own album row
          // keyed on the image it lives in. Without this every disc past the
          // first loses its tracks entirely.
          const titles = discTitles(pairs);
          pairs.forEach((pair, index) => {
            upsertAlbum.run(
              root.id,
              pair.audio.relPath,
              titles[index] ?? pair.audio.name,
              inheritedRelease,
              // A stated disc marker outranks a leading number: `01 - The Wall
              // [Disc 2].ape` says which disc it is, and the `01` is the order it
              // was ripped in. Order is the last resort, for names that state
              // nothing.
              discMarker(pair.audio.name) ?? leadingNumber(pair.audio.name) ?? index + 1,
              folderYear(node, root.path),
              folderYear(node, root.path) === null ? null : 'folder',
              // The disc's own key is the image it lives in, so the mark is
              // looked up by that and not by the box's folder: a hand edit names
              // the path a client is shown, which is the album's row.
              junkReason(node.files, marks.get(pair.audio.relPath)),
              runId,
            );
            albums += 1;
          });
        }

        // The box's own audio: the files the discs did not claim.
        //
        // Two shapes reach here and both want the row. With fewer than two pairs
        // nothing was keyed on an image at all, so the folder is the album and
        // every file under it belongs to it. With two or more, the albums went
        // to the discs and `loose` is what they left behind — a bonus track, a
        // rip whose cue never matched. That second shape is the one a condition
        // reading `pairs.length < 2` alone missed, and its cost is total: the
        // file reaches no track at all, without an issue or a counter ever
        // moving.
        if (loose.length > 0 || (pairs.length < 2 && node.files.some((f) => f.kind === 'audio'))) {
          upsertAlbum.run(
            root.id,
            node.relPath,
            displayName(node, root.path),
            null,
            null,
            folderYear(node, root.path),
            folderYear(node, root.path) === null ? null : 'folder',
            junkReason(node.files, marks.get(node.relPath)),
            runId,
          );
          albums += 1;
        }
      } else if (node.role === 'category') {
        // A shelf that holds a disc set. The set is a release and the shelf is
        // not: `a9f06a5` settled that, and what it settled is *how far* the
        // release reaches rather than whether one exists. The albums beside the
        // pair stay records of their own — making the shelf a box is what
        // collapsed sixteen releases into two, and the difference between the
        // two shapes is exactly this list.
        //
        // Nothing here asks what tells one shelf from the next. That question
        // needs the artist, which this stage has not got and deliberately does
        // not write; it is answered after every stage that names anything, by
        // `shelf-name.ts`. Grouping a pair is right whether or not a qualifier
        // can be found — a pair inside one shelf collides with itself.
        //
        // One set, and only one: a release is keyed by its folder, so a second
        // set could only be poured into the first one's record. See `discSets`.
        const sets = discSets(node).filter((set) => set.length >= 2);
        const discs = sets.length === 1 ? (sets[0] ?? []) : [];

        if (discs.length >= 2) {
          upsertRelease.run(
            root.id,
            node.relPath,
            shelfReleaseName(discs, root.path),
            'folder',
            // No year: a shelf's name states none, and the discs' own years
            // reach the record through its representative row.
            null,
            runId,
          );
          inheritedRelease = (
            selectRelease.get(root.id, node.relPath) as { id: number } | undefined
          )?.id ?? null;
          shelfDiscs = new Set(discs.map((disc) => disc.relPath));
          releases += 1;
        }
      } else if (node.role === 'album' || node.role === 'disc') {
        // A disc named `CD2` states its own number; one named after its album
        // does not, and falls back to its position in the release.
        //
        // A shelf's discs arrive here with the role of an ordinary album — the
        // role rule only promotes children of a *box* — so the release it holds
        // is what says they are discs, and a name that states a number is read
        // for the same reason it is read anywhere else.
        const number =
          node.role === 'disc' || (releaseId !== null && isDiscName(node.name))
            ? (discNumber(node.name) ?? discOrdinal)
            : null;
        upsertAlbum.run(
          root.id,
          node.relPath,
          displayName(node, root.path),
          inheritedRelease,
          number,
          folderYear(node, root.path),
          folderYear(node, root.path) === null ? null : 'folder',
          junkReason(node.files, marks.get(node.relPath)),
          runId,
        );
        albums += 1;
      }

      const discs = node.children.filter((child) => child.role === 'disc');
      for (const child of node.children) {
        const position = discs.indexOf(child);
        // The release a shelf created belongs to its discs and to nothing else.
        // Everything the shelf holds beside them is a record in its own right,
        // which is the whole of what separates a shelf from a box.
        const carriesRelease = shelfDiscs === null ? true : shelfDiscs.has(child.relPath);
        persist(child, carriesRelease ? inheritedRelease : null, position === -1 ? null : position + 1);
      }
    };

    // One transaction per root. Without it every `updateRole` and `upsertAlbum`
    // below is its own commit, and a commit is a disk flush: measured on the
    // live collection, this stage cost **10 356 ms** committing each and **437
    // ms** with the transaction (task:2883). The tree it builds is the same
    // either way — all of the difference was the commits. The sweep goes in the
    // same transaction as the rows it judges, which is the rule `scan.ts` states
    // for the same reason.
    withTransaction(db, () => {
      persist(tree, null, null);

      if (runId !== null) sweep.run(root.id, runId);
    });
  }

  return { folders, albums, releases, byRole };
}
