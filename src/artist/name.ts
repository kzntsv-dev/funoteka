/**
 * One artist, however many ways the collection spells them.
 *
 * `The Cure`, `Cure, The` and `cure` are one artist, and a library that lists
 * them three times has failed at the only thing it promised. So names are
 * reduced to a key, and the key is what merges.
 *
 * But merging is a claim, and some claims are guesses. The module therefore
 * answers at *two* levels, and the gap between them is the point:
 *
 *   - `folded` normalises only what is obviously the same record — case,
 *     punctuation, whitespace, the definite article, and the accents a tag
 *     loses on its way through a ripper.
 *   - `key` goes further and also drops a disambiguator, because `Nirvana (UK)`
 *     and `Nirvana` would otherwise never merge.
 *
 * Two names that fold to the same thing are the same artist, plainly. Two that
 * fold *differently* and still share a key were merged by discarding something
 * a human wrote on purpose — and that is exactly the merge worth flagging
 * rather than performing in silence (requirements:39 §6).
 */

export interface ArtistName {
  /** As written, tidied. What a human sees, disambiguator and all. */
  name: string;
  /** Case, punctuation, whitespace and article normalised. The flag reads this. */
  folded: string;
  /** Merge key — `folded`, plus any disambiguator dropped. Empty means "not an artist". */
  key: string;
  /** Display sort key: the article moved to the end, case preserved. */
  sortKey: string;
  /** What the key dropped that the fold kept — the disambiguator. Null if it dropped nothing. */
  stripped: string | null;
}

/**
 * `’` for `'` and the typographic dashes for `-`.
 *
 * Rippers write all of these, and a key that treats `N’Ko` and `N'Ko` as two
 * artists is not doing its job. Whitespace is collapsed here rather than at
 * each use, since every path below assumes single spaces.
 */
function tidy(raw: string): string {
  return raw
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEADING_ARTICLE = /^the\s+/i;
const TRAILING_ARTICLE = /,\s*the$/i;
/** A name that is nothing but the article — not an artist, and not a key. */
const ONLY_ARTICLE = /^the$/i;

/**
 * Remove the definite article, from whichever end a ripper put it.
 *
 * Only `the`: it is the one article that gets inverted in practice, and
 * stripping `a`/`an` would merge `A Perfect Circle` with a hypothetical
 * `Perfect Circle` on no evidence at all.
 */
function dropArticle(name: string): string {
  if (ONLY_ARTICLE.test(name)) return '';
  if (LEADING_ARTICLE.test(name)) return name.replace(LEADING_ARTICLE, '');
  if (TRAILING_ARTICLE.test(name)) return name.replace(TRAILING_ARTICLE, '');
  return name;
}

/**
 * Letters, digits and combining marks survive; everything else becomes a
 * separator.
 *
 * Unicode-aware on purpose — `Кино` has to come out the other side intact, and
 * `\w` would not manage it. `\p{M}` survives *here* so that a mark stays part
 * of its letter instead of becoming a separator: `foldName` below is where it
 * is dropped, deliberately, and a mark turned into a space first would leave
 * `bj rk` behind and merge nothing.
 */
function stripPunctuation(name: string): string {
  return name.replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

/**
 * A dot inside a word belongs to the word, not between two of them.
 *
 * `Cock E.S.P.` and `Cock Esp` are one act, and this collection holds both
 * spellings — twelve albums under the first, two under the second, and no flag
 * between them, because the fold turned the acronym's dots into spaces and left
 * `cock e s p` standing beside `cock esp`. An initialism is written with its
 * dots in some places and without them in others; dropping them is the same
 * class of normalisation as case, and it is what makes the two one key.
 *
 * Only a dot with something other than a space after it. `Dr. Dre` and
 * `St. Vincent` keep the space their dot was standing in, and a dot at the end
 * of a name is turned into a separator by the fold below either way.
 */
function closeAcronymDots(name: string): string {
  return name.replace(/\.(?=\S)/g, '');
}

/**
 * The key a name folds to, with its accents gone.
 *
 * `Röyksopp` and `Royksopp` are one artist, and so are `Sigur Rós` and `Sigur
 * Ros` — measured over the live collection, where those two pairs are the only
 * names this merges and nothing else in it moves.
 *
 * The claim is about the collection rather than about Unicode: an unaccented
 * spelling is nearly always a tag that lost its accent, not a name written
 * differently on purpose. Nobody types `Royksopp` deliberately, and the
 * opposite case — a collector who meant the plain spelling and got the accented
 * one — costs a letter rather than a record.
 *
 * Decomposing before the marks come off is what keeps the two writings of one
 * letter together: `ö` is a single code point in a tag and `o` plus U+0308 in a
 * tree ripped on macOS, and both have to fold the same way. It is also what
 * lets `Bjork`, carrying no mark at all, join them.
 *
 * What it costs: a mark that carries meaning goes with the rest. Cyrillic loses
 * `й` to `и` and `ё` to `е`, so two names differing only there — and they are
 * two names — would fold together. Nothing in this collection does, and the
 * alternative is a library that lists `Röyksopp` twice.
 */
function foldName(name: string): string {
  const folded = stripPunctuation(closeAcronymDots(dropArticle(name).toLowerCase()));
  return folded.normalize('NFD').replace(/\p{M}/gu, '');
}

/** `(UK)`, `[US]` — a human marking which of several same-named artists this is. */
const BRACKETED = /[([][^)\]]*[)\]]/g;

function stripDisambiguators(name: string): { name: string; stripped: string | null } {
  const found: string[] = [];

  // Whitespace is collapsed, not merely left behind. Removing `(UK)` from
  // `Cure, The (UK)` otherwise leaves a trailing space, and the article
  // pattern — anchored at the end — stops matching, so the name keys as
  // `cure the` while `Cure, The` keys as `cure`. One artist, two rows, which is
  // the whole failure this module exists to prevent.
  const cleaned = name
    .replace(BRACKETED, (match) => {
      const inner = match.slice(1, -1).trim();
      if (inner !== '') found.push(inner);
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  // A name written *entirely* in brackets is the name, and the bracket has
  // nothing left to qualify. `[LINKIN PARK]` is how a file states the artist —
  // not a qualifier of one — and stripping it anyway left an empty name, which
  // the key reads as "not a name". So one act the collection writes two ways
  // became two identities, one of them nameless: thirteen records of
  // `Linkin Park Japan CD` state `[LINKIN PARK]` on some tracks and
  // `Linkin Park` on the rest, the stage found no name every track states, and
  // they carried no album artist at all (task:2837).
  if (cleaned === '' && found.length > 0) return { name: found[0] as string, stripped: null };

  return { name: cleaned, stripped: found.length === 0 ? null : found.join('; ') };
}

/**
 * Sort key: `The Cure` files under C.
 *
 * A name already written inverted (`Cure, The`) is left as it is — inverting
 * it again would produce `The, Cure, The`.
 */
function sortKeyOf(name: string): string {
  if (!LEADING_ARTICLE.test(name)) return name;
  return `${name.replace(LEADING_ARTICLE, '')}, The`;
}

/** Anything that could be a word. `The` has it; `!!!` does not. */
function hasWordChar(name: string): boolean {
  return /[\p{L}\p{N}]/u.test(name);
}

export function artistName(raw: string): ArtistName {
  const name = tidy(raw);
  const disambiguated = stripDisambiguators(name);

  // An empty key means "not a name", and folding alone cannot tell the two
  // cases apart: `The` folds to nothing because it is not a name, while `!!!`
  // and `∆` fold to nothing because they are names written in symbols. Both
  // are real artists, and giving them one shared empty key would merge every
  // symbol-only act into a single nonexistent row.
  const foldedDisambiguated = foldName(disambiguated.name);
  const key = foldedDisambiguated !== '' || hasWordChar(name) ? foldedDisambiguated : name.toLowerCase();

  return {
    name,
    folded: foldName(name),
    key,
    sortKey: sortKeyOf(name),
    stripped: disambiguated.stripped,
  };
}

/**
 * The artist a folder's name belongs to, or null.
 *
 * The rule `shelf-name.ts` spells out, read the other way round. There a shelf's
 * name is the artist's name *plus* something and the something is subtracted to
 * name the record; here the same fact gathers the artist — a folder whose name
 * opens with an artist's key is that artist's.
 *
 * The longest key wins, not the first: `Röyksopp Discography` opens with
 * `Röyksopp`, and a shorter artist called `Röy` would otherwise take it.
 *
 * A separator has to follow, or `S` claims `Slipknot`. The same guard
 * `shelf-name.ts` puts on the subtraction, for the same reason and from the
 * same measurement.
 */
export function artistOwning(folderName: string, keys: Iterable<string>): string | null {
  const folderKey = artistName(folderName).key;
  if (folderKey === '') return null;

  let best: string | null = null;
  for (const key of keys) {
    if (key === '') continue;
    const fits = folderKey === key || folderKey.startsWith(`${key} `);
    if (fits && (best === null || key.length > best.length)) best = key;
  }
  return best;
}
