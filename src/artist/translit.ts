/**
 * The Latin spellings a Cyrillic artist key may be written as.
 *
 * This table never merges anything. It exists so that two rows which are one
 * name in two alphabets can be *named* to a reader (task:2675); the decision
 * that they are the same artist is left to a human or to v1.5's MBID, because
 * nothing on disk states it.
 *
 * The reason it cannot be a merge rule is the reason it is a list of schemes
 * rather than one table. A `name_key` folds spellings that differ only in
 * decoration — case, articles, punctuation — and folding is idempotent and
 * reversible enough to trust. Cyrillic-to-Latin is not a fold: it is a mapping
 * between scripts, it is many-to-many in both directions (`Кино` → `Kino`,
 * `Kino` → `Кино` or `Кіно`), and the schemes disagree with one another
 * (ГОСТ / BGN / ISO render `х` as `kh` or `h`, `я` as `ya` or `a`). A rule that
 * asserted the identity would be choosing a scheme, and a wrong choice is
 * silent: two bands that merely sound alike become one row, and no consumer
 * downstream can see that it happened. Reporting a wrong pair costs a line.
 */

/** One scheme: each Cyrillic letter, and the Latin spelling it becomes. */
type Scheme = Record<string, string>;

/**
 * What rippers, Discogs and MusicBrainz actually write — the BGN/PCGN side of
 * each disagreement. `х` is `kh`, `я` is `ya`.
 */
const PRACTICAL: Scheme = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'i', є: 'e', ґ: 'g',
};

/**
 * The simplified side: one letter per letter, as an ASCII keyboard or a
 * country-agnostic database tends to write it. It differs from `PRACTICAL` on
 * `й` (`i`), `х` (`h`), `ц` (`c`), `щ` (`sh`), `ю` (`u`) and `я` (`a`).
 */
const SIMPLIFIED: Scheme = {
  ...PRACTICAL,
  й: 'i', х: 'h', ц: 'c', щ: 'sh', ю: 'u', я: 'a',
};

const SCHEMES: readonly Scheme[] = [PRACTICAL, SIMPLIFIED];

/**
 * The property escape rather than a hand-written range: `Ѐ-ӿ` is the main
 * block only, and would read the Cyrillic Supplement (U+0500–U+052F) as a name
 * that is already Latin. `name.ts` asks the same question the same way.
 */
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** Whether a key holds a Cyrillic letter at all. */
export function hasCyrillic(key: string): boolean {
  return CYRILLIC.test(key);
}

/**
 * Every Latin key the schemes would write this one as, deduplicated. Empty when
 * the key holds no Cyrillic letter — a Latin key is not a candidate for being
 * the Latin side of a pair.
 *
 * The key is lowercased on entry: the schemes are written for lowercase
 * Cyrillic, and a caller holding a display name rather than a key would
 * otherwise get an answer that is still half Cyrillic (`Ха` → `Хa`).
 *
 * Characters no scheme maps — spaces, digits, the `#2` a split homonym carries
 * — pass through unchanged, so `кино` and `кино#2` stay distinguishable. What a
 * caller does with a qualified key is its own decision: the index is the row's
 * position within *its own* key group, so `кино#2` and `kino#2` are second
 * folders of two independently sorted groups and nothing makes them the same
 * folder. Pairing them would assert a correspondence that does not exist.
 */
export function latinSpellingsOf(key: string): string[] {
  const lowered = key.toLowerCase();
  if (!hasCyrillic(lowered)) return [];

  const spellings = new Set<string>();
  for (const scheme of SCHEMES) {
    let latin = '';
    for (const letter of lowered) latin += scheme[letter] ?? letter;
    spellings.add(latin);
  }

  return [...spellings];
}
