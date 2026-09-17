import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { classifyFile, type FileKind } from './kinds.ts';
import { observed } from './settle.ts';

export interface WalkedFile {
  /** Path relative to the root, always forward-slashed. */
  relPath: string;
  folderRelPath: string;
  name: string;
  kind: FileKind;
  ext: string;
  size: number;
  mtimeMs: number;
}

export interface Skipped {
  relPath: string;
  reason: string;
}

/**
 * A directory the walk was told to ignore by name, and what is under it.
 *
 * The two counts are the whole point of recording it. `@eaDir` is a thumbnail
 * per track and holds nothing this stage would have collected; `#recycle` and
 * `.Trash-1000` hold whatever was deleted, music included. Neither may be
 * walked *into the collection* — a Synology thumbnail tree would invent a
 * phantom album per track — but a reader has to be able to reconcile `files N`
 * with the filesystem, and to be told when the guess was wrong.
 */
export interface IgnoredDir {
  relPath: string;
  /** Audio files beneath it. Counted, never walked into the result. */
  audio: number;
  /** Everything else beneath it: the bookkeeping the name says it is. */
  other: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /** Directories below the root; the root itself is '' and is not listed. */
  folders: string[];
  /** Anything met but not walked. Reported as issues — never dropped silently. */
  skipped: Skipped[];
  /** Directories dropped by name, with what they hold. Reported, never silently. */
  ignored: IgnoredDir[];
}

/**
 * Directories that hold filesystem bookkeeping rather than music. Walking a
 * Synology `@eaDir` tree would invent a phantom album per track.
 */
const IGNORED_DIRS = new Set([
  '@eaDir',
  '#recycle',
  '.@__thumb',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.Trash-1000',
  '.Trashes',
]);

/**
 * What an ignored directory holds, read to the end and counted.
 *
 * The name is what says "bookkeeping, not music", and it is a guess. Undoing
 * the guess costs a traversal of the directory that was being avoided — which
 * is why nothing here is `stat`-ed: `readdir` already answers whether an entry
 * is a file, and the per-file stat is the expensive half of a walk. A directory
 * that cannot be read contributes nothing to either count; it is still reported
 * as ignored, which is the part a reader needs.
 */
function countIgnored(rootPath: string, relDir: string): { audio: number; other: number } {
  let audio = 0;
  let other = 0;
  const queue = [relDir];

  while (queue.length > 0) {
    const dir = queue.pop() as string;

    let entries;
    try {
      entries = readdirSync(join(rootPath, dir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(`${dir}/${entry.name}`);
        continue;
      }
      // Symlinks and special files are counted as neither: the walk records
      // none of them either, so counting them would overstate what was lost.
      if (!entry.isFile()) continue;

      if (classifyFile(entry.name) === 'audio') audio += 1;
      else other += 1;
    }
  }

  return { audio, other };
}

/**
 * Walk one configured root and describe everything under it.
 *
 * The result is held in memory. A 50k-file collection is a few tens of MB of
 * plain objects, which is fine for v1; if that stops being true, this is the
 * function to turn into a stream.
 *
 * Symlinked entries are reported as skipped rather than followed — a cycle in
 * the collection would otherwise not terminate.
 */
export function walkRoot(rootPath: string): WalkResult {
  const files: WalkedFile[] = [];
  const folders: string[] = [];
  const skipped: Skipped[] = [];
  const ignored: IgnoredDir[] = [];

  const walk = (relDir: string): void => {
    const absDir = relDir === '' ? rootPath : join(rootPath, relDir);

    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ relPath: relDir, reason: `unreadable directory: ${(err as Error).message}` });
      return;
    }

    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

      // A symlink reports false for both isDirectory() and isFile(), so it is
      // routed to `skipped` below rather than followed or recorded as a file.
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          ignored.push({ relPath, ...countIgnored(rootPath, relPath) });
          continue;
        }
        folders.push(relPath);
        walk(relPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        skipped.push({ relPath, reason: 'symlink (not followed)' });
        continue;
      }

      if (!entry.isFile()) {
        skipped.push({ relPath, reason: 'not a regular file' });
        continue;
      }

      let stat;
      try {
        stat = statSync(join(rootPath, relPath));
      } catch (err) {
        skipped.push({ relPath, reason: `stat failed: ${(err as Error).message}` });
        continue;
      }

      files.push({
        relPath,
        folderRelPath: relDir,
        name: entry.name,
        kind: classifyFile(entry.name),
        ext: extname(entry.name).toLowerCase().slice(1),
        // Through the gate's own spelling of an observation, because the gate
        // compares a fresh reading against this one: two `Math.trunc` calls in
        // two files is one rule written down twice, and the day they disagree
        // every file in a settled collection reads as moving. See `settle.ts`.
        ...observed(stat),
      });
    }
  };

  walk('');

  // Deterministic order keeps scans comparable run to run.
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  folders.sort();
  ignored.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  return { files, folders, skipped, ignored };
}
