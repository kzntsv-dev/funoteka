import { decodeText } from '../text/encoding.ts';
import { ID3V1_GENRES } from './genres.ts';
import { type Tag, type TagEncoding } from './types.ts';

/**
 * Read the ID3v1 block: 128 bytes at the very end of an MPEG file.
 *
 * **There is no ID3v1 specification to cite, and this reader says so rather than
 * inventing one.** The format is not formally standardized — the words are the
 * conformance suite's own README — so the authority used here is the layout as
 * *the author of the ID3 specifications* writes it in the suite's `generate.pike`
 * (the `ID3_1` and `ID3_11` classes, which are the format stated as data), and
 * the suite itself as the oracle for what a reader must do with each field. That
 * is a weaker footing than `flac.ts` has with RFC 9639 or `ogg.ts` with
 * RFC 3533, and pretending otherwise would be the one thing this directory is
 * not allowed to do.
 *
 * The layout, from those two classes:
 *
 *     head   3   "TAG", and the case matters — a lowercase `tag` is not a tag
 *     title 30   artist 30   album 30   year 4
 *     comment 30 (v1.0) | 28, a zero byte, and the track number (v1.1)
 *     genre  1   an index into the list in `genres.ts`
 *
 * The suite splits its cases by what a reader owes them, and the name of each
 * file states which: nothing (`_W` aside) is ordinary, `W` "might generate a
 * decoding warning", and `F` "should generate a decoding failure". What is
 * refused here is what the suite calls a failure — a year that is not four
 * digits, and a genre byte the list does not name — and each refusal is reported
 * rather than swallowed. The warnings are not reported, and that is a decision:
 * the one warning class is junk after a string terminator, which changes nothing
 * about what is read, and a finding on every tag some tagger left junk in is
 * noise rather than information.
 *
 * Three cases part company with the suite, each for the same reason and each
 * reported by `test/tools/id3v1-suite.ts` rather than hidden:
 *
 *   - a magic in the wrong case reads as *no tag* rather than as a failure — a
 *     scan cannot tell a lowercase `tag` from an audio frame that landed there,
 *     and the alternative is a finding against every mp3 without a tag;
 *   - a year field of NULs reads as nothing stated — there is no value in it to
 *     refuse, and untagged years are ordinary;
 *   - genre 255 reads as nothing stated — see `NO_GENRE`, measured on this very
 *     collection.
 *
 * All three are the same judgement, and it is the one the suite cannot make: it
 * reports on a single file, while this reader runs over a library and a finding
 * that fires on a hundred ordinary files is not information.
 */

/** RFC-less and fixed: the block is 128 bytes and always the last 128. */
const TAG_BYTES = 128;

/** The last field's index within the block, and the genre byte's. */
const GENRE_AT = 127;

/**
 * The genre byte that says there is no genre.
 *
 * Not a genre the list is missing — 255 is how ID3v1 states *none*, and it is
 * the only value past the end of the table that this collection's **music**
 * uses. Measured over the scanned root, which since 2026-09-13 also holds the
 * conformance suite: 489 of the collection's 700 mp3 carry a v1 block, 184 of
 * those state 255, and not one states anything between 148 and 254. The 107
 * files that do are the suite's own failure cases, which exist in order to state
 * exactly that — so the corpus is where the refusals belong, and it is where
 * all 109 of them land.
 *
 * So it is read as nothing stated rather than as a value that could not be read.
 * Reporting it would put 184 findings in the dump about the absence of a fact,
 * which is the aggregate mistake `tag-format-unknown` exists to avoid.
 */
const NO_GENRE = 255;

/** How much room each text field has. */
const FIELD_BYTES = 30;

function magicAt(bytes: Uint8Array, at: number, magic: string): boolean {
  if (at + magic.length > bytes.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[at + i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * One text field, decoded, or null when it holds nothing.
 *
 * Two rules, and they do different jobs. A field ends at its **first NUL** —
 * everything after the terminator is junk and "should not show up for the user"
 * in the suite's own words, which is what the two warning cases exist to test.
 * And a field padded with **spaces** rather than NULs has that padding taken
 * off, which is what taggers other than this suite's generator write.
 *
 * Neither rule is what refuses a bad year; the shape check is. `"   3"` is
 * leading-padded, so the trailing strip does nothing to it, and `"112\0"` reads
 * as `"112"` whichever order the two rules are applied in — both are refused by
 * `/^\d{4}$/` and by nothing else. Saying otherwise would credit the padding
 * rules with a job they do not do, and the next person to touch this would keep
 * them for the wrong reason.
 *
 * The encoding is not declared anywhere, so it is detected: `decodeText` is the
 * entry point for exactly that, and it settles a byte-order mark, then strict
 * UTF-8, then the single-byte verdict. ID3v1 predates any convention here, which
 * is why the suite has a whole category of cases for it — some taggers wrote
 * Latin-1 as the format implies, others wrote whatever the local code page was.
 */
function fieldText(bytes: Uint8Array, at: number, length: number): { text: string; verdict: TagEncoding } | null {
  let end = at + length;
  for (let i = at; i < end; i += 1) {
    if (bytes[i] === 0) {
      end = i;
      break;
    }
  }
  while (end > at && bytes[end - 1] === 0x20) end -= 1;
  if (end <= at) return null;

  const decoded = decodeText(bytes.subarray(at, end));
  return {
    text: decoded.text,
    verdict: { encoding: decoded.encoding, confidence: decoded.confidence, basis: decoded.basis },
  };
}

/** The weaker of two verdicts, by the rule `weakestEncoding` uses. */
function weaker(current: TagEncoding | null, candidate: TagEncoding): TagEncoding {
  return current === null || candidate.confidence < current.confidence ? candidate : current;
}

/** What an ID3v1 block says, and what of it was refused. */
export interface Id3v1Read {
  tags: Tag[];
  /** One sentence per field the block stated and this reader would not use. */
  refusals: string[];
  /** The shakiest decode verdict among the fields read, or null when none was. */
  encoding: TagEncoding | null;
  /**
   * The verdict a *name* was decoded under, so a caller that keeps only some of
   * these fields can weigh only the ones it keeps.
   *
   * Reporting the block's weakest verdict for the whole file is wrong when most
   * of the block is not used, and wrong in a way that is easy to miss: an mp3
   * whose v2 block is clean UTF-8 and whose v1 block is Latin-1 puts every one
   * of its titles into the guess column even though not one v1 title is stored.
   * Measured on this collection: 328 findings about text nothing keeps.
   */
  verdicts: Map<string, TagEncoding>;
}

/**
 * The ID3v1 block a file carries, or null when it carries none.
 *
 * Null means the last 128 bytes do not begin `TAG`, and nothing else — a file
 * too short to hold a block carries none, and so does one whose tagger wrote the
 * magic in the wrong case. The suite calls that last one a decoding failure, and
 * for a decoder reporting on a single file it is; here it is the difference
 * between "this file has no ID3v1 tag" and "this file has a broken one", and a
 * scan over a collection has no way to tell a lowercase `tag` from the bytes of
 * an audio frame that happened to land there. Reporting every mp3 without a tag
 * as a failure is the alternative, and it is absurd.
 */
export function readId3v1(bytes: Uint8Array): Id3v1Read | null {
  if (bytes.length < TAG_BYTES) return null;
  const base = bytes.length - TAG_BYTES;
  if (!magicAt(bytes, base, 'TAG')) return null;

  const tags: Tag[] = [];
  const refusals: string[] = [];
  const verdicts = new Map<string, TagEncoding>();
  let encoding: TagEncoding | null = null;

  const push = (name: string, field: ReturnType<typeof fieldText>): void => {
    if (field === null) return;
    encoding = weaker(encoding, field.verdict);
    verdicts.set(name, field.verdict);
    tags.push({ name, value: field.text });
  };

  push('title', fieldText(bytes, base + 3, FIELD_BYTES));
  push('artist', fieldText(bytes, base + 3 + FIELD_BYTES, FIELD_BYTES));
  push('album', fieldText(bytes, base + 3 + 2 * FIELD_BYTES, FIELD_BYTES));

  // The suite's year cases, and the whole of the rule they express: a year is
  // four digits. `0000` and `9999` are years a reader must accept — the bounds
  // are tested precisely because a parser that used a range check instead of a
  // shape check would reject them — while `"   3"`, `"112\0"` and a field of
  // NULs are the three shapes that must be refused. `date` is the name the
  // ID3v2 reader stores TYER under (see the frame table in `id3v2.ts`), so a
  // file carrying both versions states one fact under one name.
  const year = fieldText(bytes, base + 3 + 3 * FIELD_BYTES, 4);
  if (year === null) {
    // An empty year states nothing, which is not a refusal — nothing was
    // claimed. The suite's NULL case is listed as a failure, and it is the one
    // case where this reader deliberately differs, for the same reason as the
    // lowercase magic above: there is no field to refuse.
  } else if (/^\d{4}$/.test(year.text)) {
    push('date', year);
  } else {
    encoding = weaker(encoding, year.verdict);
    refusals.push(`id3v1 year ${JSON.stringify(year.text)} is not four digits`);
  }

  // ID3v1.1 is told from v1.0 by the comment's tail: 28 bytes of comment, then a
  // zero byte, then the track number. The generator's own log prints the version
  // as `track ? 1.1 : 1.0`, which is the same ambiguity from the other side — a
  // track of zero is not distinguishable from an untracked v1.0 tag, and no
  // reader can do better.
  const tracked = bytes[base + 125] === 0 && bytes[base + 126] !== 0;
  push('comment', fieldText(bytes, base + 97, tracked ? 28 : FIELD_BYTES));

  if (tracked) {
    const track = bytes[base + 126] as number;
    // The track number is a byte, so it is 1..255 — and the suite tests 255 as
    // an ordinary value rather than a failure, which is why there is no upper
    // bound to check here. It is formatted the way `tracknumber` is elsewhere
    // in this project: two digits, which is what every other reader's tag
    // values look like and what the ordering downstream expects.
    tags.push({ name: 'tracknumber', value: String(track).padStart(2, '0') });
  }

  // The genre is an index, and the list is the one already in this directory —
  // taken from three sources that agree, and stopping at 147 because no source
  // names anything beyond. A byte the list cannot answer is refused rather than
  // invented, which is the suite's own boundary: 0..79 are safe, 80..147 are a
  // warning, and 148 and up are a failure — except for the one value that means
  // the absence of a genre rather than an unknown one.
  const genre = bytes[base + GENRE_AT] ?? 0;
  const name = ID3V1_GENRES[genre];
  if (name !== undefined && name !== '') {
    tags.push({ name: 'genre', value: name });
  } else if (genre !== NO_GENRE) {
    refusals.push(`id3v1 genre ${genre} is not in the list, which names 0..${ID3V1_GENRES.length - 1}`);
  }

  return { tags, refusals, encoding, verdicts };
}
