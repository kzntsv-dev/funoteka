/**
 * An artist credit, read as a list.
 *
 * A collaboration is not one artist with punctuation in the name, and the
 * collection says so constantly: `Cock E.S.P. + Thirdorgan`, `Merzbow & Cock
 * E.S.P.`, `Aube / Cock E.S.P.` spread across 20 of the 24 Cock E.S.P folders.
 * Reading them as a single name loses the collaboration; reading them as a list
 * and throwing the string away loses the album when the reading is wrong.
 *
 * So neither is lost. Each entry carries the exact phrase that joined it to the
 * entry before, which means the list rebuilds into the original string
 * character for character. A split is a *reading* of a credit rather than a
 * replacement for it, and an operator who disagrees with one can see exactly
 * what was done and undo it.
 *
 * That is what makes "catch maximally" safe. And it needs to be, because two of
 * these rules are provably wrong and will stay wrong:
 *
 *   - `Smell & Quim` is one artist. The rules split it. Nothing available to a
 *     deterministic core can tell it apart from `Merzbow & Cock E.S.P.`, and
 *     §2 of the design spec puts machine inference outside the core — so the
 *     honest answer is to split it and be seen doing so.
 *   - A **word** token matched anywhere rather than as a whole word is not a
 *     near-miss, it is a disaster: `Extreme Noise Terror` becomes `E` +
 *     `treme Noise Terror` the moment `x` is a bare token, and `The Nihilist
 *     Spasm Band` becomes `The Nihilist Spasm B` + `and`. Both were measured on
 *     the real sample before this rule was written.
 */

export interface CreditEntry {
  /** The artist, trimmed. */
  name: string;
  /**
   * What joined this name to the one before it, verbatim — spaces and all, so
   * `a + b` rebuilds as `a + b` and not `a+b`. Empty on the first entry.
   */
  joinPhrase: string;
}

/**
 * Symbols join wherever they appear, with whatever whitespace surrounds them.
 *
 * Unambiguous as characters: nobody spells an artist with a `;`. `&` is the
 * risky one (`Smell & Quim`) and there is no way around that except to keep the
 * original string on the row.
 */
const SYMBOLS = '&+/;×';

/**
 * Words join only when they stand alone — whitespace on both sides.
 *
 * The rule the measurement bought. `x` and `and` are far too common *inside*
 * names to match as bare substrings, and `x` counts only in lower case:
 * `Malcolm X` is a name, `Malcolm X and Xzibit` is a collaboration.
 */
const WORDS = ['featuring', 'feat\\.', 'ft\\.', 'vs\\.?', 'and', 'with', 'meets', 'x'];

/**
 * One pattern, two alternatives: a symbol with the whitespace around it, or a
 * whole word with the whitespace that isolates it.
 *
 * The whitespace is captured *into* the match deliberately — it belongs to the
 * phrase that joined the two artists, and dropping it is how a credit stops
 * rebuilding into itself. Both branches therefore take the *run*, `\s+` and
 * `\s*`, and not a single character: `A  and  B` has two spaces either side of
 * the word, and a pattern that took one of each rebuilt it as `A and B` — which
 * is what the module's promise of a character-for-character round trip turned
 * out not to cover (task:2756).
 */
const JOINER = new RegExp(`\\s*([${SYMBOLS}])\\s*|\\s+(?:${WORDS.join('|')})\\s+`, 'g');

/**
 * Read a credit string as a list of artists and the phrases between them.
 *
 * Never throws and never loses its input: for every string with content on both
 * sides of a joiner, `splitCredit(raw).map((e) => e.joinPhrase + e.name)
 * .join('')` returns `raw`. Outer whitespace is the one exception, and
 * deliberately so — a name with a leading space sorts wrongly forever.
 */
export function splitCredit(raw: string): CreditEntry[] {
  const text = raw.trim();
  const entries: CreditEntry[] = [];

  let at = 0;
  // The phrase leading to the entry about to be pushed; empty before the first.
  let phrase = '';
  JOINER.lastIndex = 0;

  for (let match = JOINER.exec(text); match !== null; match = JOINER.exec(text)) {
    const start = match.index;
    const after = start + match[0].length;
    const name = text.slice(at, start).trim();

    // A joiner with nothing before it (`& x`) or nothing after it (`a +`) is
    // not joining two artists — it is part of one name. Splitting there would
    // produce an empty name and break the round-trip on precisely the
    // malformed input that most needs to survive intact.
    if (name === '' || text.slice(after).trim() === '') continue;

    entries.push({ name, joinPhrase: phrase });
    phrase = match[0];
    at = after;
  }

  if (entries.length === 0) {
    // Either the whole thing is one name, or it is empty.
    return text === '' ? [] : [{ name: text, joinPhrase: '' }];
  }

  const tail = text.slice(at).trim();
  if (tail !== '') entries.push({ name: tail, joinPhrase: phrase });

  return entries;
}
