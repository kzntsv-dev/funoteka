import { artistName, artistOwning } from '../artist/name.ts';
import type { DatabaseSync } from '../db/index.ts';
import { basenameOf } from '../util/names.ts';
import {
  artists,
  childFolders,
  discPaths,
  recordsUnder,
  recordsUnderCount,
  recordsUnderCounts,
  roots,
  type AlbumRow,
  type CountScope,
  type FolderRow,
} from './meta.ts';
import type { Visibility } from './visibility.ts';

/**
 * The library's own shape: what a client is shown at the top.
 *
 * The filesystem is raw material ([[wiki:3498]] §0), and the top of a
 * collector's tree is the one place it shows undigested. `Slipknot`,
 * `Slipknot AAC 320` and `Slipknot ALAC` are three folders for one artist;
 * `The Cure` beside `The Cure - Assemblage - 1991 (12CD FLAC)` is one artist
 * and one record of theirs that never got filed; and a thousand folders of
 * installers sit among them, because the root of this collection is also the
 * operator's Downloads.
 *
 * This answers what that level *is* and decides nothing deeper. Below the top
 * the folders are the collector's own navigation — `Compilations/`, `Deluxe
 * Editions/`, `Live Albums/` — and they stay exactly as they are. The operator's
 * word on the whole arrangement is that they know what they put where, and the
 * machine's part is to help a little.
 *
 * The rule is the one `shelf-name.ts` already spells out, read the other way
 * round: a shelf's name is the artist's name *plus* something, so a folder whose
 * name opens with an artist's name belongs to that artist. Where `shelf-name`
 * subtracts the artist to name the record, this subtracts the folder to gather
 * the artist.
 *
 * What it deliberately does not do is merge by script. `Кино` and `Kino` stay
 * two nodes, and so do `Аквариум` and `Aquarium`: Cyrillic-to-Latin is a mapping
 * between alphabets rather than a fold, and `translit.ts` is where that argument
 * is made. Accents are a different matter and `artistName` has already folded
 * them, which is why `Röyksopp` is one node here and not two.
 */

/** What the virtual top calls itself. The client shows this as the library. */
export const LIBRARY = 'Музыка';

export interface VirtualNode {
  /** The artist this node was gathered for, or null when it is a plain folder. */
  artistKey: string | null;
  /** The artist row, when this node is an artist's. */
  artistId: number | null;
  /** What a client is shown. */
  name: string;
  /** The folder a client opens when it is a plain folder; otherwise any of them. */
  folderId: number;
  /** Every physical folder gathered into this node, for the records it holds. */
  folders: { rootId: number; relPath: string }[];
  /** Where it files, so the list is the same on every machine. */
  sort: string;
  /**
   * How many records the node holds, counted once when it was built.
   *
   * Carried rather than asked for again, and it is what makes a node with
   * nothing in it drop out. A node is built from a *folder*, and a folder may
   * hold no record at all: the one that holds junk and nothing else would
   * otherwise be listed with a count of nought and open onto an empty
   * directory — which is the shape the operator would still see in his client
   * after the junk was "hidden". Since the count has to be taken to know that,
   * it is kept: `getIndexes` shows this number on every client sync, and asking
   * for it twice would be paying twice for one answer.
   */
  records: number;
}

/**
 * The nodes of the virtual top, in the order a client should show them.
 *
 * Gathered across every root rather than one at a time: the same artist may be
 * filed under two of them, and two nodes called `Кино` would be the defect this
 * exists to remove.
 */
export function virtualNodes(
  db: DatabaseSync,
  rootId?: number,
  visibility: Visibility = 'records',
): VirtualNode[] {
  const known = new Map<string, { name: string; sort: string; id: number }>();
  for (const artist of artists(db, undefined, visibility)) {
    known.set(artist.name_key, {
      name: artist.name,
      sort: artist.sort_key ?? artist.name,
      id: artist.id,
    });
  }

  const nodes: VirtualNode[] = [];
  const gathered = new Map<string, VirtualNode>();

  for (const root of roots(db)) {
    if (rootId !== undefined && root.id !== rootId) continue;
    for (const folder of childFolders(db, root.id, '', visibility)) {
      // A folder holding nothing playable anywhere beneath it is not part of
      // the library: on this collection that is 1029 of the 1558 folders, and
      // every one of them an installer, a driver or a backup.
      if (folder.role === 'empty') continue;

      const where = { rootId: root.id, relPath: folder.rel_path };
      const owner = artistOwning(basenameOf(folder.rel_path), known.keys());

      if (owner === null) {
        // Not an artist's: a series, a compilation shelf, or something that is
        // not music at all. It keeps its own name, because that is what the
        // collector called it.
        nodes.push({
          artistKey: null,
          artistId: null,
          name: basenameOf(folder.rel_path),
          folderId: folder.id,
          folders: [where],
          sort: basenameOf(folder.rel_path),
          // Filled in below, once every node's folders are known.
          records: 0,
        });
        continue;
      }

      const already = gathered.get(owner);
      if (already !== undefined) {
        already.folders.push(where);
        continue;
      }

      const artist = known.get(owner);
      const node: VirtualNode = {
        artistKey: owner,
        artistId: artist?.id ?? null,
        name: artist?.name ?? owner,
        folderId: folder.id,
        folders: [where],
        sort: artist?.sort ?? owner,
        records: 0,
      };
      gathered.set(owner, node);
      nodes.push(node);
    }
  }

  // Counted before the nodes are handed out, because a node with nothing under
  // it is not a place a client should be sent. See `VirtualNode.records`.
  const counts = virtualRecordCounts(db, nodes, visibility);
  const held = nodes
    .map((node, at) => ({ ...node, records: counts[at] ?? 0 }))
    .filter((node) => node.records > 0);

  // Code units rather than `localeCompare`, whose ordering depends on the host's
  // ICU data: the same unchanged collection must not list artists differently
  // on two machines. Same rule as the artist stage's display name.
  return held.sort(
    (a, b) => cmp(a.sort, b.sort) || cmp(a.name, b.name) || a.folderId - b.folderId,
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The records a node holds, gathered from every folder that folded into it.
 *
 * A node may stand for folders in more than one root, so the question is asked
 * per root and the answers joined in the order the folders were gathered — the
 * roots' own order, which is the order the operator configured them in.
 */
export function virtualRecords(
  db: DatabaseSync,
  node: VirtualNode,
  visibility: Visibility = 'records',
): AlbumRow[] {
  const records: AlbumRow[] = [];
  for (const [rootId, paths] of pathsByRoot(node)) {
    records.push(...recordsUnder(db, rootId, paths, visibility));
  }
  return records;
}

/**
 * How many records a node holds, without reading one of them.
 *
 * The plural of `virtualRecords` for the callers that want the size alone — see
 * `recordsUnderCount` for why that is a different query rather than a smaller
 * one. `getIndexes` is the caller that made it worth writing: it asks per node
 * and shows only the number.
 *
 * It is the same answer `virtualRecords(...).length` gives, and the two are
 * pinned together by a test rather than by this comment.
 */
export function virtualRecordCount(
  db: DatabaseSync,
  node: VirtualNode,
  visibility: Visibility = 'records',
): number {
  let total = 0;
  for (const [rootId, paths] of pathsByRoot(node)) {
    total += recordsUnderCount(db, rootId, paths, visibility);
  }
  return total;
}

/**
 * What each of these nodes holds, in the order they were given.
 *
 * The plural of `virtualRecordCount`, for `getIndexes`: it asks every node for
 * its number and nothing else, and asking one at a time ran the grouping the
 * count needs once per node. A node whose folders span two roots contributes
 * two scopes and one number, which is why this gathers them here rather than
 * handing the nodes to the query.
 */
export function virtualRecordCounts(
  db: DatabaseSync,
  nodes: readonly VirtualNode[],
  visibility: Visibility = 'records',
): number[] {
  const scope: CountScope[] = [];
  const at = nodes.map((node) => {
    const mine: number[] = [];
    for (const [rootId, paths] of pathsByRoot(node)) {
      mine.push(scope.length);
      scope.push({ rootId, paths });
    }
    return mine;
  });

  const counted = recordsUnderCounts(db, scope, visibility);
  return at.map((mine) => mine.reduce((total, one) => total + (counted[one] ?? 0), 0));
}

/**
 * Every record the library holds — what the nodes gather, gathered once.
 *
 * This is the `vn:` node's answer, and it is the whole collection. Asking node
 * by node ran `ALBUM_SELECT` twenty-five times over, genres and totals and all,
 * to put the same records in one list: measured at 851 ms on the live
 * collection, with the single-threaded server stopped behind it for 483 of
 * them. The paths are gathered per root instead, which is two queries.
 *
 * The order is not the query's, though, and cannot be left to it. The library
 * is shown as the tree is — one node after another, and each node's records by
 * year — so what one query returns interleaved by year is put back into nodes
 * here. `recordsUnder` has already ordered each node's rows; this only decides
 * which node each row belongs to, and the two agree because a record lies under
 * exactly one node's folders — the property the counts rely on too, and one a
 * test measures rather than assumes.
 *
 * A record under no node is dropped, which is what asking node by node did with
 * it as well: the library holds what the tree reaches.
 */
export function libraryRecords(
  db: DatabaseSync,
  rootId?: number,
  visibility: Visibility = 'records',
): AlbumRow[] {
  const nodes = virtualNodes(db, rootId, visibility);
  const gathered = nodes.map((): AlbumRow[] => []);

  const byRoot = new Map<number, string[]>();
  for (const node of nodes) {
    for (const [root, paths] of pathsByRoot(node)) {
      const at = byRoot.get(root) ?? [];
      at.push(...paths);
      byRoot.set(root, at);
    }
  }

  const loose: AlbumRow[] = [];
  for (const [root, paths] of byRoot) loose.push(...recordsUnder(db, root, paths, visibility));

  for (const record of loose) {
    const at = nodes.findIndex((node) =>
      node.folders.some(
        (where) => where.rootId === record.root_id && underPath(where.relPath, record.rel_path),
      ),
    );
    if (at !== -1) gathered[at]?.push(record);
  }

  return gathered.flat();
}

/** Whether a path lies at or beneath a folder's. */
function underPath(folder: string, path: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * A node's folders, gathered by the root each one is in.
 *
 * Asked per root because that is the shape the queries above take: one call per
 * root with all of that root's paths, rather than one call per folder.
 */
function pathsByRoot(node: VirtualNode): Map<number, string[]> {
  const byRoot = new Map<number, string[]>();
  for (const where of node.folders) {
    const paths = byRoot.get(where.rootId) ?? [];
    paths.push(where.relPath);
    byRoot.set(where.rootId, paths);
  }
  return byRoot;
}

/**
 * A record or a folder, as one entry of a node's listing.
 *
 * The two are what a node holds and they are not alike: a folder is where the
 * collector put something, and a record is what they put there.
 */
export interface VirtualEntry {
  /** The record this entry stands for, or null when it is a folder or a credit. */
  record: AlbumRow | null;
  /** The folder this entry stands for, or null when it is a record or a credit. */
  folder: FolderRow | null;
  /** The credited artist this entry gathers, or null when it is one of the two above. */
  credit: VirtualCredit | null;
}

/**
 * One credited artist's records inside a node that credits more than one.
 *
 * `Кино/` holds thirty records of Кино and five of Виктор Цой — the soloist the
 * collector filed with the band — and a client drawing titles shows them as one
 * flat run in which nothing says whose is whose. `Cock E.S.P/` is that shape
 * eleven times over, one act on each split. The operator asked for the grouping,
 * and it is the only thing that makes the credit visible in a client that draws
 * a name and not the `artist` field beside it.
 */
export interface VirtualCredit {
  /** The folded artist name, which is what the node's id carries. */
  artistKey: string;
  /** What a client is shown. */
  name: string;
  /**
   * The artist row this credit is, which is what a picture of it is asked by.
   *
   * `Виктор Цой` has no folder of his own — the collector filed him inside
   * `Кино/` — so he is not an artist in the list and has no `ar:` id anywhere a
   * client browses. But he *is* an artist row, and every place the server names
   * him gives that row's picture: `getArtistInfo2` offers him as a related
   * artist with `coverArt = ar:52`, and asking for it answers. The drawer was the
   * one place that offered nothing, so the same person had a picture in one list
   * and none in the other (task:2847).
   */
  artistId: number;
  records: AlbumRow[];
}

/**
 * What a node lists: the collector's own shelves, with a loose record beside
 * them.
 *
 * An artist's folder is not a flat bag of records. `The Cure/` is filed into
 * `Compilations/`, `Deluxe Editions/`, `Live Albums/`, `Side Projects/`,
 * `Singles and EPs/` and `Studio Albums/`, and the operator asked for that to
 * stay: the structure inside is theirs, and the fold above is the only thing
 * this decides. So a child that is a folder is listed as the folder it is, and
 * opening it shows what it always showed.
 *
 * What the fold adds is the record left at the *top* of the root beside the
 * artist's folder — `The Cure - Assemblage - 1991 (12CD FLAC)`, which has no
 * shelf to be under. It belongs to the artist and lands directly under them.
 *
 * A child that *is* a record is listed as the record, not as the folder it is
 * filed in. The difference is what a client draws: `1983 - Japanese Whispers`
 * rather than a folder named `1983 - Japanese Whispers [1990 reissue EU
 * Polydor 817 470-2]`, and opening it plays the record rather than listing a
 * directory holding one thing.
 *
 * Discs of a release are not listed. A box's discs sit inside the record they
 * are discs of, and listing them here would offer that record twice.
 *
 * Folders come first, then records by year — the order every file manager uses,
 * and this is a folder view. A record with no year goes last among records,
 * which is where a missing number belongs.
 */
export function virtualEntries(
  db: DatabaseSync,
  node: VirtualNode,
  visibility: Visibility = 'records',
): VirtualEntry[] {
  const byPath = new Map<string, AlbumRow>();
  for (const row of virtualRecords(db, node, visibility)) {
    byPath.set(keyOf(row.root_id, row.rel_path), row);
  }

  const discs = new Set<string>();
  for (const where of node.folders) {
    for (const path of discPaths(db, where.rootId, [where.relPath])) {
      discs.add(keyOf(where.rootId, path));
    }
  }

  const entries: VirtualEntry[] = [];
  const seen = new Set<string>();

  for (const where of node.folders) {
    const at = keyOf(where.rootId, where.relPath);
    const own = byPath.get(at);
    if (own !== undefined && !seen.has(at)) {
      seen.add(at);
      entries.push({ record: own, folder: null, credit: null });
    }

    for (const child of childFolders(db, where.rootId, where.relPath, visibility)) {
      // A folder with nothing playable anywhere beneath it is not part of the
      // library: `scans/`, `Artwork/`, a stray `@eaDir`. The same rule that
      // keeps 1029 installers out of the top keeps them out of here.
      if (child.role === 'empty') continue;

      const childAt = keyOf(where.rootId, child.rel_path);
      if (seen.has(childAt) || discs.has(childAt)) continue;
      seen.add(childAt);

      const record = byPath.get(childAt);
      entries.push(
        record === undefined
          ? { record: null, folder: child, credit: null }
          : { record, folder: null, credit: null },
      );
    }
  }

  // Grouped only when the node shows records and nothing else. A node holding
  // shelves — `The Cure/` with `Compilations/` and the rest — keeps them, and
  // grouping its records as well would list the same record twice: once under
  // the shelf, once under the artist.
  if (entries.some((entry) => entry.folder !== null)) return entries.sort(byListing);

  const credits = byCredit(entries);
  if (credits.length <= 1) return entries.sort(byListing);

  return credits.map((credit) => ({ record: null, folder: null, credit }));
}

/**
 * A node's records, gathered by whoever they are credited to.
 *
 * An empty list when a record states no artist at all: a node whose records are
 * not all attributable is not one to sort into drawers, and the flat listing is
 * the honest answer.
 */
function byCredit(entries: readonly VirtualEntry[]): VirtualCredit[] {
  const byKey = new Map<string, VirtualCredit>();

  for (const entry of entries) {
    const row = entry.record;
    if (row === null) continue;
    if (row.artist_id === null) return [];

    const name = row.artist_name ?? '';
    const key = artistName(name).key;
    if (key === '') return [];

    const at = byKey.get(key) ?? { artistKey: key, name, artistId: row.artist_id, records: [] };
    at.records.push(row);
    // The briefest spelling names the drawer, as it names an artist everywhere
    // else: decoration is what tends to be added.
    if (name.length < at.name.length) at.name = name;
    byKey.set(key, at);
  }

  for (const credit of byKey.values()) credit.records.sort(byListingRecord);
  return [...byKey.values()].sort((a, b) => cmp(a.name, b.name));
}

/** A record's place in a run: by year, then title — a missing year last. */
function byListingRecord(a: AlbumRow, b: AlbumRow): number {
  if ((a.year === null) !== (b.year === null)) return a.year === null ? 1 : -1;
  if (a.year !== null && b.year !== null && a.year !== b.year) return a.year - b.year;
  return cmp(a.title ?? '', b.title ?? '') || cmp(a.rel_path, b.rel_path) || a.id - b.id;
}

/** A path is only a path within its root — the same spelling may be in two. */
function keyOf(rootId: number, relPath: string): string {
  return `${rootId} ${relPath}`;
}

function byListing(a: VirtualEntry, b: VirtualEntry): number {
  if ((a.folder === null) !== (b.folder === null)) return a.folder === null ? 1 : -1;

  if (a.folder !== null && b.folder !== null) {
    return cmp(basenameOf(a.folder.rel_path), basenameOf(b.folder.rel_path));
  }

  // The number is read through the same `COALESCE` the query orders by, so a
  // release that states the year and a disc that does not are one record.
  const ay = a.record?.year ?? null;
  const by = b.record?.year ?? null;
  if ((ay === null) !== (by === null)) return ay === null ? 1 : -1;
  if (ay !== null && by !== null && ay !== by) return ay - by;

  return (
    cmp(a.record?.title ?? '', b.record?.title ?? '') ||
    cmp(a.record?.rel_path ?? '', b.record?.rel_path ?? '') ||
    (a.record?.id ?? 0) - (b.record?.id ?? 0)
  );
}

