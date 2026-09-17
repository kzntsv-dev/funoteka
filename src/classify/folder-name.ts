/**
 * What a folder name carries.
 *
 * A collector's folder is a record sleeve written in one line:
 *
 *     1994 - Cock E.S.P. + Thirdorgan - Split (Cass, C60)
 *
 * Year, artist credit, title, format. Three separate tasks want pieces of it —
 * the credit ([[task:2684]]), the title ([[task:2682]]), artist-folder
 * detection ([[task:2674]]) — and three half-parsers each reading the same
 * string their own way is the Shotgun Surgery the plan already has a task for.
 * So it is parsed once, here, and each task takes the part it needs.
 *
 * The name is parsed, never the path: an album's identity is its path
 * (requirements:39 §2), and rewriting a path to tidy a name would split one
 * album into two.
 *
 * Conservatism is the whole difficulty. Two rules carry it, and both were
 * narrowed by measurement against the real samples rather than by taste:
 *
 *   - **A credit is claimed only behind a year slot, or behind a joiner.**
 *     Reading any `A - B` as `credit - title` produced a credit for all four of
 *     `Pink Floyd - The Wall (JPN Remastered)`, `The Gerogerigegege - 2016 - …`,
 *     `CD 2 - Disk Union Bonus` and `This Is a Title - With a Dash`. Every one
 *     is wrong.
 *   - **A trailing bracket is a format only if it looks like one.** `(Cass,
 *     C60)` and `(JPN Remastered)` do; `(Moenai Hai)` and `(UK)` do not, and
 *     stripping them would damage titles that are already correct.
 *
 * The format vocabulary is deliberately a list of media and edition words
 * rather than "anything in brackets": the failure mode of a missing word is a
 * format left in the title, which is visible and harmless, while the failure
 * mode of a false positive is a truncated name, which is neither.
 */

/** Disc and edition words. A bracket naming one of these is a format note. */
const MEDIUM =
  /\b(cd|cdr|cass|cassette|vinyl|lp|ep|dvd|sacd|blu-?ray|minidisc|md|box|digipak|album|comp|single|promo|reissue|remaster|remastered|edition|anniversary|deluxe|expanded|ltd|limited|jpn|jp|disc|enh|c60|c20|c30|c5|bc)\b/i;

/**
 * `12CD FLAC`, `2CD` — a disc count, which names the medium as plainly as `CD`
 * does and which `MEDIUM` above cannot see.
 *
 * Its `\b` needs a boundary in front of the `c`, and a digit is a word
 * character, so `12CD` has none. The count is how this collection writes a box
 * most often — `The Cure - Assemblage - 1991 (12CD FLAC)`, `2001 - Greatest
 * Hits (2CD ltd …)` — so the note went unread on every one of them and the
 * bracket stayed in the title along with the count.
 */
const DISC_COUNT = /\d+\s*(?:cd|dvd|sacd|lp)\b/i;

/** `1994` is a year; `xxxx` is a year slot with no year in it. */
const YEAR_SLOT = /^(\d{4}|x{4})$/i;

/**
 * A whole segment that names a release rather than a record.
 *
 * Deliberately narrow. The words that are *missing* here are the ones that
 * matter: `Split`, `Live`, `Remixes`, `Album`, `Compilation` and `Soundtrack`
 * are all real titles in these collections, and a false positive costs the
 * credit on a collaboration while a false negative costs nothing but a word
 * left in a title.
 */
const RELEASE_TYPE = /^(ep|lp|single|cdm|cds|maxi|promo|sampler)$/i;

/**
 * `CD 1`, `Disc 2` — a disc of a multi-disc release, optionally followed by a
 * catalog bracket. Same slot in the name as a release type, and the same
 * misreading: `2014 - .5 The Gray Chapter - CD 1 [JP - WPCR-16130]` taken as
 * `YEAR - CREDIT - TITLE` names an artist after the album itself.
 *
 * The disc number is not read out here — which disc this is belongs to
 * [[task:2680]], which assigns it. This only stops the marker from becoming a
 * title and a credit.
 */
const DISC_SUFFIX = /^(cd|disc|disk)\s*\d+\b/i;

/**
 * `Артист_-_Заголовок-ГГГГ-Сайт` — the scene layout, as Kroogi hands a record out.
 *
 *     Aquarium_-_Archangelsk-2011-Kroogi.com
 *
 * The separator is the whole of the evidence, and it is a *written* one: `_-_`
 * is typed deliberately, where a bare dash merely falls between two words, so
 * it cannot be a hyphen inside a title. That is what lets this shape claim a
 * credit with neither of the two proofs every other branch needs — a year slot
 * or a joiner — and it is why nothing was read here at all before: with no
 * branch for the shape the whole string stayed one title, and the artist and
 * the album were both lost without a word.
 *
 * The tail is the scene's own: `-ГГГГ` the release year, `-Сайт` where it was
 * published. Both optional and both fenced by dashes, so a title carrying
 * dashes of its own keeps them — the year is what ends the title. The release
 * group is dropped the way `[ARDI4701]` is: it describes the download, not the
 * record.
 *
 * Underscores elsewhere are left alone. In a file name the scene writes a space
 * as `_`, but a folder name is not a file name, the one real sample spells its
 * words out, and folding `_` to a space would eat a title that legitimately
 * carries one.
 */
const SCENE = /^(.+?)_-_(.+?)(?:-(\d{4})(?:-(.+))?)?$/;

/** A joiner inside a segment, by the same classes `credit.ts` splits on. */
const JOINER = /[&+/;×]|\s(?:featuring|feat\.|ft\.|vs\.?|and|with|meets|x)\s/i;

export interface FolderName {
  /** The year prefix, or null when there is none (or the slot reads `xxxx`). */
  year: number | null;
  /** The artist credit, or null when the name states none. */
  credit: string | null;
  /** What is left once the credit and the slot are removed. */
  title: string | null;
  /** The disc/edition note, without its brackets. */
  format: string | null;
}

/**
 * Is this bracketed run a format note, or part of the name?
 *
 * A comma is the giveaway — Discogs writes `(CD, Comp)`, `(Vinyl, 7, Ltd)` —
 * and failing that, a word that names a medium or an edition.
 */
function looksLikeFormat(inner: string): boolean {
  const text = inner.trim();
  if (text === '') return false;
  return text.includes(',') || MEDIUM.test(text) || DISC_COUNT.test(text);
}

/**
 * The bracketed run a name ends with, as the folder wrote it.
 *
 * `body` is the note without its brackets, which is what `format` has always
 * been, and `text` is the run itself, brackets and all. Both answers are wanted
 * and they come from one read: a record is named in two places, and each states
 * the note its own way — round brackets outside the tree, the folder's own
 * inside it.
 */
function trailingNote(text: string): { body: string; text: string; at: number } | null {
  const paren = /\(([^()]*)\)\s*$/.exec(text);
  const square = /\[([^[\]]*)\]\s*$/.exec(text);
  const matched =
    paren !== null && paren[1] !== undefined && looksLikeFormat(paren[1]) ? paren : square;

  if (matched === null || matched[1] === undefined || matched[1].trim() === '') return null;
  return { body: matched[1].trim(), text: (matched[0] ?? '').trim(), at: matched.index };
}

/**
 * The note a folder states, in the brackets the folder wrote it in.
 *
 * `recordVersion` answers what the note *says* with the pressing's own year
 * taken off, and that is what a record's name outside the tree wants: `(2019,
 * Maschina Records, MKK881CD, 3CD)` dates the pressing, not the record. This
 * answers how the folder wrote it, which is the other thing a name wants — the
 * tree is the folder view, and what a leaf there shows is what the folder says,
 * `[UK promo Fiction FIXCD 17]` and `(Cass, C60)` both. See `named` in
 * `api/browse.ts` for the reader, and task:2783 for why the two are not one.
 */
export function folderNote(name: string): string | null {
  return trailingNote(name.trim())?.text ?? null;
}

/**
 * The note a record's name still has to say, or null when it says it already.
 *
 * Every reader that names a record has to ask this the same way, or one of them
 * says what the other has already said. And it has to be asked of the note's
 * **words**, not of the brackets the folder wrote them in.
 *
 * The reason is `recordTitle`, which is what puts the note into a title in the
 * first place. It writes round brackets and takes the pressing's own year off —
 * so a folder stating `[EU Polydor 981 463-0]` leaves a title saying
 * `(EU Polydor 981 463-0)`, and every test for the folder's spelling misses it.
 * `parseFolderName` cannot be asked either: it reads a round bracket only when
 * it looks like a format, and a catalogue number does not, so the note it just
 * wrote is one it will not read back.
 *
 * Measured over the live library: comparing the folder's brackets, 34 records
 * say their pressing twice in the tree and 18 in the album list; comparing the
 * note's words, none do either way (task:2845).
 *
 * What comes back is `recordVersion`'s answer — what the note says, without the
 * pressing's year. The caller wraps it: the tree in the brackets the folder
 * wrote, the album in round ones.
 */
export function unsaidNote(title: string, folderName: string): string | null {
  const note = recordVersion(folderName);
  if (note === null) return null;
  return title.includes(note) ? null : note;
}

/**
 * Split a folder name on ` - `, but never inside brackets.
 *
 * The separator is only a separator at depth zero. A catalog number is written
 * with dashes of its own — `1999 - Slipknot [JP - RRCY-1104]` — and splitting
 * inside the bracket produced an artist called `Slipknot [JP` and a title of
 * `RRCY-1104]`, from a bracket that is neither.
 *
 * Both bracket kinds count, and nesting is tracked rather than assumed away: a
 * name may hold `(Live - Remastered)` as easily as `[JP - RRCY-1104]`.
 */
export function splitFields(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      ch === '-' &&
      /\s/.test(text[i - 1] ?? '') &&
      /\s/.test(text[i + 1] ?? '')
    ) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));

  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

export function parseFolderName(name: string): FolderName {
  let rest = name.trim();
  let format: string | null = null;

  // A trailing bracket is a note, and the two kinds are read by different rules.
  //
  // `(...)` only when it reads like a format — `(Cass, C60)` does, `(Moenai Hai)`
  // does not — because this collection writes both a medium and a plain word in
  // round brackets, and stripping the second truncates a title that was right.
  //
  // `[...]` **always**. The square kind is where the collection writes a pressing
  // — `[UK promo Fiction FIXCD 17]`, `[JP - RRCY-1104]`, `[DE Polydor 873 909-2]`
  // — and deciding that by a word list made `JP` a note and `DE` not: the list's
  // edge rather than the collection's. The risk a word list was guarding against
  // is gone, because the note reaches the name now — a bracket that turns out to
  // be part of a title still reads as one.
  //
  // This was tried before and reverted, and the argument then was sound: the note
  // was sent as `version`, the client this library is read in does not render
  // that field, so `Slipknot [JP - RRCY-1104]` became `Slipknot` with the
  // pressing nowhere a person would see it. What changed is the serving side.
  const note = trailingNote(rest);
  if (note !== null) {
    format = note.body;
    rest = rest.slice(0, note.at).trim();
  }

  // The scene layout, read before the Discogs grammar because it answers a
  // different question: where that one splits on a dash between spaces, this one
  // trusts the written separator and then the dashes after it. A name with no
  // `_-_` cannot match, so nothing below changes for the collections already
  // parsing.
  const scene = SCENE.exec(rest);
  if (scene !== null) {
    const credit = (scene[1] ?? '').trim();
    const title = (scene[2] ?? '').trim();
    if (credit !== '' && title !== '') {
      return {
        year: scene[3] === undefined ? null : Number(scene[3]),
        credit,
        title,
        format,
      };
    }
  }

  // A year in front of a title, joined by a dot or by the bullet this collection
  // uses as its separator.
  //
  // `1992. Opiate [61422-31027-2]` says the same thing as `1992 - Opiate [...]`
  // in a different punctuation: the collector writes the year as a prefix rather
  // than as a field. It has to be read before the dash grammar, because a name
  // with no dash in it reaches that grammar as a single segment and finds no
  // year slot at all — which is what Tool's entire catalogue did, and why none
  // of its records could say when it came out.
  //
  // The bullet is the same idea in the punctuation this collection actually
  // writes: `1988 ● Группа крови (2019, Maschina Records, MKK881CD, 3CD)`. It
  // went unread for as long as the dot form did, and the cost is the one the
  // question above describes — the year stayed in the *title* and never reached
  // the field, so every box in the collection was shown as `1988 ● Группа крови`
  // with no year at all.
  let dotYear: number | null = null;
  const dotted = /^(\d{4})(?:\.\s+|\s*●\s*)/.exec(rest);
  if (dotted !== null) {
    dotYear = Number(dotted[1]);
    rest = rest.slice(dotted[0].length);
  }

  const parts = splitFields(rest);

  // The artist-first grammar: `The Gerogerigegege - 2016 - 燃えない灰 (Moenai
  // Hai)`. Same three parts as the Discogs form with the first two swapped, and
  // the swap is provable — a year is written *before* a title, never second in
  // a name that already opened with one. So a year slot in the middle is the
  // whole of the evidence needed, and nothing outside the string is consulted.
  //
  // No credit is claimed here. This branch's artist already arrives from a tag
  // on every sample that has one, and filling `credit` would move a result
  // [[task:2684]] verified byte for byte. [[task:2674]] is where an artist read
  // off a folder becomes a thing this project consumes.
  if (parts.length >= 3 && YEAR_SLOT.test(parts[1] ?? '')) {
    const middle = parts[1] ?? '';
    return {
      year: /^\d{4}$/.test(middle) ? Number(middle) : null,
      credit: null,
      title: parts.slice(2).join(' - '),
      format,
    };
  }

  // The same three fields as the Discogs form, written in the opposite order:
  // `The Cure - Assemblage - 1991 (12CD FLAC)`. The proof is positional, as it
  // is above and for the same reason — a year written *after* two other
  // segments is not where a year goes in `год - кредит - заголовок`, so what
  // stands in front of it is the credit and then the title.
  //
  // Three segments is the floor, and it is what keeps `Prince - 1999` out: two
  // segments say nothing about which of them is a credit, and a title ending in
  // a number is a real title. The name this was written for states its count in
  // the same breath — `(12CD FLAC)` — which is the `DISC_COUNT` note above.
  const tailSlot = parts[parts.length - 1];
  if (parts.length >= 3 && tailSlot !== undefined && YEAR_SLOT.test(tailSlot)) {
    return {
      year: /^\d{4}$/.test(tailSlot) ? Number(tailSlot) : null,
      credit: parts[0] ?? null,
      title: parts.slice(1, -1).join(' - '),
      format,
    };
  }

  // A year at the very end of a name is deliberately **not** read.
  //
  // `Led Zeppelin - II USA 8-track 1969` states one, and it is the only name in
  // the collection that does — measured over all 395 of them, with nothing else
  // moved. It looks like free money and it is not: this parser is also what
  // `recordTitle` runs over, and `recordTitle` is handed the TITLE of a cue and
  // of a tag as readily as a folder name. `A State Of Trance: Ibiza 2026` is
  // one of those, and the trailing `2026` is the record's name rather than its
  // year — the rule took a word out of it and `multidisc.test.ts` caught it.
  //
  // Nothing distinguishes the two strings. One record keeping an unknown year
  // is the cheaper mistake by a distance, so the year stays unread.
  const yearSlot = parts.length > 1 && YEAR_SLOT.test(parts[0] ?? '');
  let year: number | null = dotYear;
  let carriedSuffix: string | null = null;
  if (yearSlot) {
    year = /^\d{4}$/.test(parts[0] ?? '') ? Number(parts[0]) : null;
    parts.shift();

    // `2009 - This Must Be It - EP` has the same number of segments as
    // `1994 - Cock E.S.P. + Thirdorgan - Split`, and only the last one tells
    // them apart. A bare release-type word in that slot is a suffix: the
    // segment before it is the title, and there is no credit at all. Read as a
    // credit it named the album `EP` and invented an artist.
    //
    // The list is short on purpose. `Split`, `Live`, `Remixes`, `Compilation`
    // and `Album` are all real record titles in these collections, and taking
    // any of them as a suffix would cost the credit on the records that carry
    // it — sixteen of them on the Cock E.S.P sample alone.
    const last = parts[parts.length - 1];
    if (
      parts.length >= 2 &&
      last !== undefined &&
      (RELEASE_TYPE.test(last) || DISC_SUFFIX.test(last))
    ) {
      carriedSuffix = last;
      parts.pop();
    }
  }

  const title = parts.length === 0 ? null : parts.join(' - ');

  // Behind a year slot, the first remaining segment is the credit when there is
  // anything left for a title to be.
  if (yearSlot && parts.length >= 2) {
    return { year, credit: parts[0] ?? null, title: parts.slice(1).join(' - '), format };
  }

  // The suffix was the only thing after the title, so the title is the segment
  // before it and nothing was a credit.
  if (carriedSuffix !== null && parts.length === 1) {
    return { year, credit: null, title: parts[0] ?? null, format };
  }

  // Without a year slot a credit is claimed only when a joiner proves one, and
  // then only for the segment that carries it.
  //
  // Where a title survives, that is the whole of the evidence, and it is good
  // evidence: `2009 - Twodeadsluts Onegoodfuck + Cock E.S.P. (Cass, Ltd, C5)` is
  // the Discogs form with its title slot missing, and `+` between two names is
  // what this collection writes a split with. Where *nothing* survives, the
  // joiner stands alone — and alone it does not prove a credit, because `&`
  // sits inside titles as readily as between two names. Measured over the live
  // collection: the branch fires on six names, and the five that carry a digit
  // are a year range in a title, a volume number, a disc marker and a catalogue
  // number. The one garbage artist the meta layer holds is one of those five.
  //
  // What tells them apart is that a credit is a list of *names*, and a name
  // carries no number. So the guard is asked only when no title is left, and it
  // asks only that.
  const first = parts[0];
  if (first !== undefined && JOINER.test(first)) {
    const remainder = parts.slice(1).join(' - ');
    if (remainder !== '' || !/\d/.test(first)) {
      return { year, credit: first, title: remainder === '' ? null : remainder, format };
    }
  }

  return { year, credit: null, title, format };
}

/**
 * The name a *record* is shown by: the title, the edition note kept, no year.
 *
 * `parseFolderName` answers what a folder's name is made of; this answers what a
 * client should be shown, and the live collection settled both differences.
 *
 * **The note stays in the name.** It was moved out to `version` on the argument
 * that the protocol has a field for it — and it does, but a client that does not
 * render `version` (Feishin, the one the library is actually read in) then shows
 * `Группа крови` five times with nothing to choose between them. The operator
 * asked where `Maschina Records` had gone. A record's edition is information
 * about which record it is, and it belongs where every client will show it.
 * `recordVersion` still offers it, and the API suppresses that copy when the
 * name already carries it — so a client that reads the field is not told twice.
 *
 * **The year goes.** A year written in front of a title, in any of the
 * punctuations this collection uses (`1988 ● …`, `1992. …`, `1989 …`), is the
 * record's year and belongs in the field that holds it — not in the name. The
 * live collection showed every box as `1988 ● Группа крови` with an empty `year`
 * because the bullet went unread.
 *
 * Both a folder and an `ALBUM` tag name a record, and they must agree: this
 * collection showed a name from a tag beside a name from a folder, under one
 * artist, and only one of them looked like the rest.
 */
export function recordTitle(name: string): string {
  const parsed = parseFolderName(name);
  const note = (parsed.format ?? '').replace(/^\d{4}\s*,\s*/, '').trim();

  // Nothing was separated out, so the name is the whole of what there is: it
  // already carries its bracket, and appending the note would write it twice.
  // `Кинохроники 2021/1982 (Maschina Records, MASHCD-099)` is the case — the
  // slash in the title reads as a joiner, so the parser finds a credit and no
  // title, and the verbatim name is the only honest answer.
  if (parsed.title === null) return name;

  // A separator has to follow, so a record genuinely called `1999` keeps it.
  const title = parsed.title.replace(/^(?:19|20)\d{2}(?:[\s.●•]+|-[-\s]+)/, '').trim();
  return note === '' ? title : `${title} (${note})`;
}

/**
 * Which edition of a record this is, or null when the name says nothing.
 *
 * `AlbumID3.version` is the field the protocol keeps for exactly this —
 * "Remastered, Anniversary Box Set". It is **not** where the note belongs by
 * right: `recordTitle` above argues the other way and won, because the client
 * this library is read in does not render the field, and a note nobody is shown
 * is not worth taking out of a name. What is left for this is the record whose
 * *name* does not carry the note — one a tag or a cue named, which wrote its own
 * title and dropped the bracket on the way. The API suppresses this copy when
 * the name already says it, so a client that does render the field is never told
 * twice; see `albumId3`.
 *
 * The note's own year goes the way the folder's did: `(2019, Maschina Records,
 * MKK881CD, 3CD)` says 2019 about the *pressing*, and the record is 1988.
 */
export function recordVersion(name: string): string | null {
  const note = (parseFolderName(name).format ?? '').replace(/^\d{4}\s*,\s*/, '').trim();
  return note === '' ? null : note;
}

/**
 * The name a disc carries beyond its number, or null when it carries none.
 *
 * `CD2 ● Ранний вариант` names a disc that is more than its number: a bonus
 * disc, an early version, a live set. The protocol has a place for it
 * (`discTitles`), and the number in front is not part of it.
 *
 * A disc is numbered in one of two ways and both put the number first. It may
 * be *marked* as a disc — `CD2 ● …`, `Disc 1 [JP]` — or merely numbered, which
 * is how a box whose discs are named after the albums on them is laid out:
 * `01 - Three Imaginary Boys (1979)`, `12 - Disintegration (1989)`. The second
 * shape went unread until the box it belongs to was recognised at all, and the
 * cost was that all twelve discs of it were labelled with the record's name and
 * nothing else — the album each one holds appeared nowhere.
 *
 * So the only thing this refuses is a name that is *nothing but* its number:
 * `CD1` is its number and has no name to offer. A name with no marker at all is
 * not refused — `Show` is the name it is, and whether it says anything the
 * record does not is not a question about this string. The caller compares it
 * with the record's title and drops it when they agree, which is where the
 * record is known.
 */
export function discSubtitle(title: string): string | null {
  const withoutMarker = title.replace(/^(?:cd|disc|disk|d)\s*[._-]?\s*\d{1,2}\b/i, '');
  // An ordinal needs its separator: `1999` is a title, and a number with
  // nothing after it is not an ordinal.
  const withoutOrdinal = withoutMarker.replace(/^\d{1,3}\s*[.\-–]\s+/, '');

  const rest = withoutOrdinal.replace(/^[\s._●•\-–]+/, '').trim();
  return rest === '' ? null : rest;
}
