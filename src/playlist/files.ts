import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * The `.m3u` files lying in the collection.
 *
 * A playlist file is two very different things depending on what is in it, and
 * the difference is not in its name or its size — it is in where its entries
 * point. A `.m3u` written beside an album, listing that album's tracks, says
 * nothing the folder tree does not already say: it is *redundant*, and offering
 * it as a playlist would put every record in the library into a client's
 * playlist list twice. One whose entries come from several folders is a list
 * somebody made on purpose, and that is the kind worth importing.
 *
 * This module decides that and nothing else — it reads text, not the meta
 * layer, and knows nothing about tracks. Matching entries to songs is the
 * stage's business (`playlist/import.ts`, run by `run.ts` after `cues`),
 * because it is the stage that has a database.
 *
 * Nothing here reads a file: the bytes are decoded by `text/encoding.ts` and
 * handed over as a string, so a playlist in CP1251 is the same problem as an
 * `.nfo` in CP1251 and is solved in the same place.
 */

/**
 * The entries of a playlist file, in the order it states them.
 *
 * Three dialects arrive in the same collection and all three are handled:
 * a bare list of paths, the extended form where every path is preceded by
 * `#EXTINF:` lines, and the same with the paths quoted. Comments and directives
 * start with `#` and are dropped — an `#EXTINF` line carries a duration and a
 * title, and neither is used: the file says *which* songs and in what order,
 * and what each song is called is a fact about the song.
 *
 * A byte-order mark leading the file is dropped with them. It is three bytes of
 * `EF BB BF` that a Windows editor wrote, and left in place it becomes the
 * first character of the first path — a file that cannot be found, in a list
 * where every other entry resolves.
 */
export function parseEntries(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => unquote(line))
    .filter((line) => line !== '');
}

/** A path a playlist wrote the way a person would — sometimes in quotes. */
function unquote(line: string): string {
  const quoted = /^"(.*)"$/.exec(line) ?? /^'(.*)'$/.exec(line);
  return (quoted?.[1] ?? line).trim();
}

/**
 * What an entry points at, as a path — or nothing, when it points out of the
 * filesystem altogether.
 *
 * A playlist may name a stream (`http://…`), and no folder will ever hold one.
 * Those entries are dropped here rather than resolved into a nonsense path: the
 * question this module answers is about *folders*, and a URL has none.
 */
export function resolveEntry(entry: string, folder: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) return null;

  // A Windows path may be written with either separator, and both arrive: an
  // absolute `C:\Music\…` from a ripping tool and a relative `01 - x.flac` from
  // a person. `resolve` handles the second and understands both separators of
  // the first on Windows; on other platforms an absolute Windows path is not a
  // path, and the entry resolves relative to the folder like any other string.
  return resolve(isAbsolute(entry) ? entry : folder, entry);
}

/**
 * How the folders of a playlist compare.
 *
 * Case-folded on Windows and not elsewhere, because that is what the two
 * filesystems do: `C:\Music\A` and `c:\music\a` are one folder there and two
 * paths anywhere else. Getting this wrong in the other direction would call a
 * curated list redundant — the mistake this classification exists to avoid —
 * so it follows the platform rather than a preference.
 */
function folderKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** What a playlist file turned out to be. */
export type Verdict = 'redundant' | 'curated';

/** What a playlist file says, and what that makes of it. */
export interface Reading {
  verdict: Verdict;
  /** How many entries the file states, after comments are dropped. */
  entries: number;
  /**
   * How many distinct folders those entries come from.
   *
   * Streams are not counted: a URL has no folder, and counting one would call
   * every album playlist that names a radio station curated. `entries` still
   * includes them, because it is the number of lines a person wrote.
   */
  folders: number;
  /**
   * The entries that point at the filesystem, resolved.
   *
   * Carried out rather than thrown away: the caller matches these against its
   * own root, and resolving a path twice — once to count the folders, once to
   * look the file up — is the same work done twice over. Streams are absent,
   * having no path to resolve.
   */
  paths: string[];
}

/**
 * What a playlist file is: the album it sits beside, or a list of its own.
 *
 * One folder — or none — is redundant. That covers the ordinary case (a `.m3u`
 * beside an album, listing that album) and the degenerate ones (an empty file,
 * a file listing only one song): none of them is a list a client should be
 * offered, and importing them would fill the playlist list with the library
 * itself.
 *
 * More than one folder is curated. This is deliberately a question about
 * *folders* and not about albums or artists: a playlist of one artist's records
 * is exactly the case worth importing, and so is a mix, while a playlist of one
 * album from two folders is a record this collection filed in two places and
 * still says nothing new.
 *
 * Named `readingOf` and not `classify`, which in this project is a stage: the
 * folder classifier that decides what an *album* is. Two questions a word apart
 * and nothing else in common.
 */
export function readingOf(entries: readonly string[], folder: string): Reading {
  const folders = new Set<string>();
  const paths: string[] = [];
  for (const entry of entries) {
    const path = resolveEntry(entry, folder);
    if (path === null) continue;
    paths.push(path);
    folders.add(folderKey(dirname(path)));
  }

  return {
    verdict: folders.size > 1 ? 'curated' : 'redundant',
    entries: entries.length,
    folders: folders.size,
    paths,
  };
}
