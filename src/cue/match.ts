import type { WalkedFile } from '../scan/walk.ts';
import { basenameOf, folderOf, stemOf } from '../util/names.ts';
import type { CueDocument } from './parse.ts';

/**
 * A cue's `FILE` reference, resolved to a root-relative path.
 *
 * References are written relative to the cue's own folder, and rips do use
 * `..` — a cue sitting above the audio it describes is a real layout. Without
 * resolving, a `FILE "../x.flac"` could only ever match a same-named file
 * beside the cue, which is the one place the file is not.
 */
export function resolveRef(cueFolder: string, ref: string): string {
  const parts = cueFolder === '' ? [] : cueFolder.split('/');

  for (const segment of ref.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  return parts.join('/');
}

export interface CueCandidate {
  relPath: string;
  doc: CueDocument;
}

/** How a cue's own `FILE` reference landed on a file the folder holds. */
export type RefMatchHow = 'exact-name' | 'stem';

/**
 * Generic in the candidate so a caller may carry extra facts about a cue it
 * has already read — the engine keeps the decoded text there — and get them
 * back on the winning match. Matching itself only ever looks at `relPath` and
 * `doc`.
 */
export interface CueMatch<TCue extends CueCandidate = CueCandidate> {
  cue: TCue;
  audio: WalkedFile;
  how: RefMatchHow;
}

/** Higher wins. A name is better evidence than a stem. */
const SCORE: Record<RefMatchHow, number> = { 'exact-name': 3, stem: 2 };

/**
 * Every landing a cue's own `FILE` tags make on the files the folder actually
 * holds, in reference order.
 *
 * The one loop both questions below are put through. Written once because
 * "which file does this reference name" must not answer differently depending
 * on who is asking: the matcher wants the single best landing, and the plan
 * wants to know whether the cue named the folder whole or only a part of it.
 */
function refMatches<TCue extends CueCandidate>(
  cue: TCue,
  audioFiles: readonly WalkedFile[],
): { audio: WalkedFile; how: RefMatchHow }[] {
  const cueFolder = folderOf(cue.relPath);
  const found: { audio: WalkedFile; how: RefMatchHow }[] = [];

  for (const ref of cue.doc.files) {
    const resolved = resolveRef(cueFolder, ref.name).toLowerCase();
    const resolvedFolder = folderOf(resolved);
    const resolvedStem = stemOf(basenameOf(resolved));

    for (const audio of audioFiles) {
      const path = audio.relPath.toLowerCase();

      let how: RefMatchHow | null = null;
      if (path === resolved) {
        how = 'exact-name';
      } else if (folderOf(path) === resolvedFolder && stemOf(basenameOf(path)) === resolvedStem) {
        // Same folder, same stem, different extension. A cue declaring `.wav`
        // for a rip that is really `.flac` lands here — and only here, since
        // the folder has to agree, so it cannot reach across albums.
        how = 'stem';
      }
      if (how === null) continue;

      found.push({ audio, how });
    }
  }

  return found;
}

/**
 * The audio file a cue's own `FILE` tags name, resolved against the files the
 * folder actually holds — or null when they name nothing that is there.
 *
 * This is `chooseCue`'s per-cue half, split out because a caller has a second
 * question to put to it: a cue the matcher did *not* pick still has to be told
 * apart from a cue that describes nothing at all, and only that cue's own
 * references can answer which one it is. Asking the album's match instead
 * answers about the wrong cue.
 */
export function audioNamedBy<TCue extends CueCandidate>(
  cue: TCue,
  audioFiles: readonly WalkedFile[],
): { audio: WalkedFile; how: RefMatchHow } | null {
  let best: { audio: WalkedFile; how: RefMatchHow } | null = null;

  for (const match of refMatches(cue, audioFiles)) {
    if (best === null || SCORE[match.how] > SCORE[best.how]) best = match;
  }

  return best;
}

/**
 * The audio files a cue's own `FILE` tags name — the plural of the question
 * `audioNamedBy` answers.
 *
 * The plan has to put this one, because "does this cue describe these files" is
 * a question about the whole folder and not about the one file a match settles
 * on. Counting a cue's TRACK tags against a folder's audio files looks like the
 * same test and is not: a cue naming one file under two TRACK tags has the same
 * count as a folder holding two files, so the second file was handed a title
 * the cue never wrote for it (task:2723). Only the references can answer it.
 *
 * Answers in the folder's own order, and names each file once however many
 * references reach it — a cue that repeats `FILE` per track is ordinary.
 */
export function audioNamedByCue<TCue extends CueCandidate>(
  cue: TCue,
  audioFiles: readonly WalkedFile[],
): WalkedFile[] {
  const named = new Set<WalkedFile>();
  for (const match of refMatches(cue, audioFiles)) named.add(match.audio);

  return audioFiles.filter((audio) => named.has(audio));
}

/**
 * Decide which cue in a folder describes which audio file.
 *
 * The cue's `FILE` tag is treated as a hint, never as truth — real rips declare
 * `WAVE` for an `.m4a` and `.wav` for a `.flac`. Resolution runs against the
 * audio files that are actually present, in descending order of evidence:
 *
 *   1. the basename matches exactly (ignoring case)
 *   2. the basename matches once extensions are dropped — this is what catches
 *      the `.wav`-declared `.flac`
 *
 * Those two are the whole of it: a cue whose `FILE` tags land on none of the
 * folder's audio is answered `null`, because it does not describe these files.
 *
 * A third rule used to stand below them — nothing matched, but the folder held
 * exactly one audio file and at least one cue, so take the two as belonging
 * together — and it was a guess wearing the clothes of a reading. Its cost was
 * total: a stale cue for a rip that is not here ([[task:2712]]) sat above a
 * one-file, fully tagged album, cut that file into the stranger's three
 * segments, gave them the stranger's three titles and wrote them under
 * `title_source = 'cue'` — the value `011_track_title_source.sql` reserves for
 * a cue that *describes* these files. The album's real track was gone and
 * nothing was reported. Which cue describes which audio is the question this
 * module exists to answer; "neither does, so probably this one" is not an
 * answer it can give, and being wrong costs an album its tracks. A cue that
 * names audio the folder no longer holds is reported instead — see the loser
 * loop in `cue/engine.ts`.
 *
 * A folder with several cues is normal (rippers leave a stale one behind); the
 * best-scoring cue wins, and ties fall to the first path so repeated scans
 * agree.
 */
export function chooseCue<TCue extends CueCandidate>(
  cues: readonly TCue[],
  audioFiles: readonly WalkedFile[],
): CueMatch<TCue> | null {
  const ordered = [...cues].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  let best: CueMatch<TCue> | null = null;

  for (const cue of ordered) {
    const named = audioNamedBy(cue, audioFiles);
    if (named === null) continue;

    if (best === null || SCORE[named.how] > SCORE[best.how]) {
      best = { cue, audio: named.audio, how: named.how };
    }
  }

  return best;
}
