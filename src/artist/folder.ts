import { artistName } from './name.ts';
import { rootBasenameOf } from '../util/names.ts';

/**
 * Which folder an artist's name came from — the signal that tells two
 * same-named artists apart.
 *
 * A key merges spellings, and for most of the collection that is the whole
 * truth: `The Cure` in one album and `Cure, The` in another are one band. But
 * two different bands both written `Nirvana` key identically too, and the key
 * has no way to know. The filesystem does: a collector files artists in folders,
 * and `Music/Nirvana` and `Other/Nirvana` are two folders.
 *
 * The spec states the rule as "разные арт-папки = разные артисты" (wiki:3498
 * §3), and is explicit that the deterministic core owns only the path half of it.
 * This module is that half. Naming the two Nirvanas correctly still needs
 * MBID/Discogs — task:2675 is where that lives.
 *
 * ## What counts as an artist folder
 *
 * The **outermost** folder above the album whose **whole name** reduces to
 * exactly the artist key. The root counts, the album's own folder does not.
 *
 * Outermost rather than nearest, and that is the load-bearing choice. A band's
 * self-titled record sits at `Artist/Artist/Disc 1`, where the record is named
 * after the band exactly as the artist folder is; stopping at the nearest match
 * reads the record as a second artist and splits one band in two. Taking the
 * outermost also survives `Artist/Artist` nested a level deeper for the same
 * reason, and it never costs anything the nearest-match rule would have got
 * right — two genuinely different bands live in sibling folders, not one inside
 * the other.
 *
 * Whole-name equality, never substring or prefix: `Странные игры` and `Игры` are
 * two different bands and one name literally contains the other (wiki:3519). Any
 * containment rule collapses them, which is a worse failure than missing the
 * homonym this module exists to catch.
 *
 * The comparison is at the `key` level, not `folded` — a folder called `The Cure`
 * is the artist folder for a credit written `Cure, The`. That is the same
 * reduction that merged them in the first place, so the folder lookup uses it too.
 *
 * ## The signs this does *not* use, and why
 *
 * The task that asked for this named three: a folder holding only albums, a name
 * matching the PERFORMERs of the cues inside it, and the expected artist/album
 * depth. Only the name test is used.
 *
 *   - **Depth** would reject the root, and in the collection this was built
 *     against the artist folder *is* the root — `Downloads\Кино` (wiki:3519).
 *     A nested `Music/Rock/Nirvana/…` is not wrong either, so a depth rule only
 *     buys false negatives, and a false negative here is the silent merge the
 *     contract forbids.
 *   - **Corroboration against the cue PERFORMERs** would lose the case the whole
 *     feature exists for: 20 of the 24 Cock E.S.P folders carry no cue at all,
 *     and their credit comes from the folder *name* (task:2684). The name is
 *     therefore compared against the album's winning credit, whichever of the
 *     three sources stated it.
 *   - **"Holds only albums"** is not asked of the `folder` table. It does not
 *     need to be: the album's own folder is never a candidate, and taking the
 *     outermost match steps over every record-level folder between the artist
 *     and the album.
 */

export interface ArtistFolder {
  /**
   * `${rootPath}:${relPath}` — built from the root *path*, not its id.
   *
   * Root ids are rowids: dropping a root from the scan and adding it back
   * assigns a higher id, and `upsertRoot` deletes collapsed twins, so an id is
   * not a property of the directory.
   */
  id: string;
  rootPath: string;
  relPath: string;
}

export interface ArtistFolderInput {
  /** The album's path relative to its root, forward-slashed. '' is the root. */
  albumRelPath: string;
  rootPath: string;
  /** The artist's merge key, as `artistName` produced it. */
  key: string;
}

/**
 * The artist folder above `albumRelPath`, or null when there is none.
 *
 * Null is the ordinary answer, not a failure: most albums in a loose collection
 * have no artist folder at all, and a null folder is simply not evidence. The
 * caller must not read it as "a different artist" — see `applyArtists`, where a
 * key splits only when two or more *real* folders disagree.
 */
export function artistFolderOf(input: ArtistFolderInput): ArtistFolder | null {
  const { albumRelPath, rootPath, key } = input;

  // An empty key means "not a name" (see `artistName`), and it would match the
  // first folder whose own name is also not a name — `The`, say — inventing an
  // artist folder out of nothing. The caller already refuses empty keys; this is
  // the guard that keeps the refusal from having to be repeated.
  if (key === '') return null;

  // An album that *is* the root has no folder above it. The root is its own
  // folder here, and a record's folder is never its artist's.
  if (albumRelPath === '') return null;

  // The root first: it is the outermost folder there is, and `Downloads\Кино`
  // is a real artist folder (wiki:3519). Its name has to be read
  // separator-agnostically — on Windows the stored path is backslashed.
  const rootName = rootBasenameOf(rootPath);
  if (artistName(rootName).key === key) {
    return { id: `${rootPath}:`, rootPath, relPath: '' };
  }

  const parts = albumRelPath.split('/');

  // Shallowest first. Bounding at `i < parts.length` is what keeps the album's
  // own folder — the last segment — out of the running: the deepest candidate
  // is its parent.
  for (let i = 1; i < parts.length; i += 1) {
    const name = parts[i - 1] ?? '';
    if (artistName(name).key === key) {
      const relPath = parts.slice(0, i).join('/');
      return { id: `${rootPath}:${relPath}`, rootPath, relPath };
    }
  }

  return null;
}

/**
 * The merge key for the `index`-th artist folder of one name.
 *
 * The first folder keeps the bare key — for the overwhelming majority of
 * artists there is only one folder anyway, and `nirvana` is a better key to read
 * in a dump than `nirvana#1`. The rest are numbered in the order the caller
 * sorted them, so a folder added ahead of an existing one takes the bare key and
 * the one behind it moves to the next number. Nothing corrupts when that
 * happens — albums and credits are re-resolved through the new keys every run —
 * but a reader who knew a row as `nirvana#2` last time may find it elsewhere.
 *
 * A suffixed key can never collide with a bare one, though not for the obvious
 * reason. `#` *does* survive into a key: `artistName` falls back to the raw
 * lowercased name for a name with no letter or digit in it, so an artist called
 * `#` keys to `#`. The invariant is narrower and holds regardless — a key
 * containing `#` has no letter or digit anywhere in it (that is the only route
 * to the fallback), while a suffixed key always ends in one. A name reading
 * `nirvana#2` folds to `nirvana 2`, and `##2` folds to `2`, so neither can
 * produce a suffixed key. The two sets are disjoint by construction.
 */
export function qualifiedKey(key: string, index: number): string {
  return index === 0 ? key : `${key}#${index + 1}`;
}
