/**
 * One answer to "what is this file called".
 *
 * Paths reaching these helpers are in the meta layer's own form: forward
 * slashes, as `walkRoot` produces them. Nothing here second-guesses that with
 * Windows separators.
 */

/** `a/b/track.flac` -> `track.flac`. */
export function basenameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * `C:\Users\demo\Downloads\Кино` -> `Кино`; `/home/demo/music/Кино/` -> `Кино`.
 *
 * The root path is the one path in the meta layer that the walk did not produce:
 * it arrives from `realpathSync.native`, and on Windows that answers with
 * backslashes. `basenameOf` above splits on `/` alone — deliberately, because
 * everything else it is handed is forward-slashed by the walk — so it would
 * return the whole path here, and a caller asking "what is this root called"
 * would silently get no answer on Windows and the right one on Linux. Both
 * separators are accepted, for roots only.
 */
export function rootBasenameOf(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/** `track.flac` -> `track`. A leading dot is a hidden file, not an extension. */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

/** `a/b/c.flac` -> `a/b`; `c.flac` -> `''` (the root). */
export function folderOf(relPath: string): string {
  const cut = relPath.lastIndexOf('/');
  return cut === -1 ? '' : relPath.slice(0, cut);
}

/**
 * Fold for ordering: case and combining marks, and nothing else.
 *
 * The rule this replaces asked `localeCompare` for `sensitivity: 'base'`, which
 * ignores case and accents. Both are ignored here too, but decided rather than
 * delegated — see `compareNatural`.
 */
function orderFold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** Runs of digits and runs of everything else, in the order they appear. */
function chunks(text: string): string[] {
  return text.match(/\d+|\D+/g) ?? [];
}

/**
 * Digit-aware string order: `2 - x` before `10 - y`.
 *
 * Plain lexicographic order puts `10` first, which silently pairs cue tracks
 * with the wrong audio files in any album whose names are not zero-padded. So
 * runs of digits compare as numbers and everything else compares as text.
 *
 * No `localeCompare`, and for the reason `artist/apply.ts` gives for its own
 * display keys: its ordering depends on the host's ICU data and its default
 * locale, so the same unchanged collection would number an album's tracks
 * differently on two machines. Code units are the same everywhere, and the
 * folding `localeCompare` was doing — case, and accents through `NFD` — is done
 * here, visibly, instead of being asked for and hoped for.
 *
 * Deterministic, not "correct" in any linguistic sense: it is emulating one
 * option of one API, and it says exactly which.
 */
export function compareNatural(a: string, b: string): number {
  const left = chunks(orderFold(a));
  const right = chunks(orderFold(b));

  const shared = Math.min(left.length, right.length);

  for (let index = 0; index < shared; index += 1) {
    const one = left[index] as string;
    const other = right[index] as string;
    if (one === other) continue;

    // Both numeric, or both not: a digit run beside a text run is compared as
    // text, which is what code units do and what a reader expects of a name
    // that happens to start with a number.
    const bothNumeric = /^\d/.test(one) && /^\d/.test(other);
    if (bothNumeric) {
      const difference = Number(one) - Number(other);
      // Equal values with different spellings — `01` against `1` — fall to the
      // remaining chunks rather than stopping here.
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }

    return one < other ? -1 : 1;
  }

  return left.length - right.length;
}
