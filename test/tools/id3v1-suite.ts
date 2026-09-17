/**
 * Measure this project's ID3v1 reader against the official conformance suite.
 *
 * `C:\Users\demo\Downloads\id3v1_test_suite\id3v1\` — 274 files written by
 * Martin Nilsson in 2003, by the author of the ID3 specifications, with a
 * `generation.log` that states what every one of them contains. It is the rare
 * case where the test data is *given* rather than invented, and for ID3v1 it is
 * the only authority there is: the format was never formally standardized, so
 * there is no text to cite and the suite's generator is what stands in for one.
 *
 * The contract is in the file names. `id3v1_N_C[_P].mp3`, where `P` is `W` for
 * "might generate a decoding warning" or `F` for "should generate a decoding
 * failure", and the README says so in as many words. Three kinds of check:
 *
 *   - **every file's fields**, compared value for value against the tag
 *     structure the log prints — which it prints for all 274, warnings and
 *     failures included, so 348 fields are checked;
 *   - **every genre the table names**: 80 of them appear in the plain files and
 *     the remaining 68 in the warning cases, whose genre the prose states;
 *   - **the failures**: the field at fault must not survive, and something must
 *     say so.
 *
 * Three divergences are *expected* and reported rather than counted as failures,
 * because all three are deliberate and argued in `src/tags/id3v1.ts`: a magic in the
 * wrong case reads as "no tag" rather than as a failure, a year field of NULs
 * reads as nothing stated rather than as a bad value, and genre 255 reads as
 * "no genre" rather than as one the list is missing.
 *
 *   node test/tools/id3v1-suite.ts "C:\Users\demo\Downloads\id3v1_test_suite\id3v1"
 *
 * Exit code is 0 when every case this reader claims to satisfy does.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readTags } from '../../src/tags/read.ts';
import { ID3V1_GENRES } from '../../src/tags/genres.ts';

/** What the log says one file should yield. */
interface Expected {
  file: string;
  suffix: '' | 'W' | 'F';
  version: string | null;
  fields: Record<string, string>;
  /** The genre name the prose names, for the `W` cases the log does not tabulate. */
  genreName: string | null;
  /** The block's own sentence, which is where the failure cases say what is wrong. */
  prose: string;
}

/**
 * The log, read as the oracle it is.
 *
 * Blocks are `Test case N`. Every one of them prints the tag structure it
 * generated — the failures and warnings included, which is what makes the
 * comparison below worth anything: an earlier version of this comment claimed
 * only the well-formed tags were tabulated, and that was a rationalisation of a
 * bug in the split rather than a fact about the log. The prose is where the
 * failure cases say what is wrong, and where the genre cases past the first 80
 * name their genre ("An ID3 tag with genre set to Folk.").
 */
function expectations(log: string): Map<string, Expected> {
  const found = new Map<string, Expected>();

  // Split on a numbered case, not on the words `Test case `. The generator also
  // writes "Test case might generate a decoding warning." and "Test case should
  // generate a decoding failure." *inside* a case, and splitting on those turned
  // 274 blocks into 456 — every warning and failure case cut in half before its
  // tag structure, so 182 files had no fields parsed at all. The two things that
  // hid behind it were the reason it went unnoticed: only the 92 plain cases
  // were ever compared field by field, and the year check on the failure cases
  // could never fire, because the field it reads was always empty.
  for (const block of log.split(/^Test case \d+/m).slice(1)) {
    const file = /Generated test file "([^"]+)"/.exec(block)?.[1];
    if (file === undefined || found.has(file)) continue;

    const fields: Record<string, string> = {};
    for (const line of block.matchAll(/^(head|title|artist|album|year|comment|track|genre)\s*:\s*(.*)$/gm)) {
      // Values are printed as Pike literals (`"Title"`), and the genre carries
      // its index with the name in brackets: `7 (Hip-Hop)`.
      fields[line[1] as string] = (line[2] as string).trim().replace(/^"|"$/g, '');
    }

    const genre = /genre set to ([^.]+)\./.exec(block)?.[1]?.trim() ?? null;

    found.set(file, {
      file,
      suffix: (/_([WF])\.mp3$/.exec(file)?.[1] as '' | 'W' | 'F') ?? '',
      version: /^version:\s*(\S+)/m.exec(block)?.[1] ?? null,
      fields,
      genreName: genre,
      prose: block,
    });
  }

  return found;
}

/**
 * The two genres the log and the ID3v2 appendix spell differently, as the log
 * writes them and as `genres.ts` keeps them.
 *
 * Keyed by the log's spelling rather than by the genre's index, because the
 * `W` cases — which are most of the ones past the first 80 — state their genre
 * in prose and carry no index at all. Matching on the pair is also the narrower
 * check: it accepts one spelling for one genre and nothing else.
 */
const SPELLINGS: ReadonlyMap<string, string> = new Map([
  ['Psychadelic', 'Psychedelic'], // entry 67: v2.3 repeats ID3v1's misspelling
  ['A capella', 'A cappella'], // entry 123: the appendix doubles the p
]);

/** Pike's spelling of a NUL, in two characters: the log is text, not bytes. */
const PIKE_NUL = String.fromCharCode(92) + '0';

const root = process.argv[2];
if (root === undefined) {
  process.stderr.write('usage: node test/tools/id3v1-suite.ts <suite-directory>\n');
  process.exit(2);
}

const oracle = expectations(readFileSync(join(root, 'generation.log'), 'latin1'));
const files = readdirSync(root).filter((name) => name.endsWith('.mp3')).sort();

const mismatches: string[] = [];
const divergences: string[] = [];
let plainChecked = 0;
let plainFields = 0;
let genreNames = 0;
let refused = 0;
let warned = 0;
let genreSpellings = 0;

for (const file of files) {
  const expected = oracle.get(file);
  if (expected === undefined) {
    mismatches.push(`${file}: not described by the log`);
    continue;
  }

  const read = readTags(readFileSync(join(root, file)));
  const value = (name: string): string | undefined => read.tags.find((tag) => tag.name === name)?.value;

  if (expected.suffix === 'F') {
    // The suite's failure cases: a year that is not a year, a genre the list
    // does not name, and a magic in the wrong case. The first two are refused
    // *fields* — the rest of the tag is good and is still read — so what is
    // checked is that the field did not survive and that something says so.
    const refusedSomething = (read.refusals?.length ?? 0) > 0;

    // The three cases this reader deliberately answers differently. The prose is
    // where they are told apart, because what makes each of them a divergence is
    // *why* the suite calls it a failure and not what the bytes hold. All three
    // are argued in `src/tags/id3v1.ts`.
    if (/header in the wrong case/.test(expected.prose)) {
      if (value('title') !== undefined) mismatches.push(`${file}: a lowercase magic was read as a tag`);
      else divergences.push(`${file}: lowercase magic reads as "no tag"`);
      continue;
    }

    if (/year set to NULL/.test(expected.prose)) {
      if (value('date') !== undefined) mismatches.push(`${file}: a NULL year was read as a date`);
      else divergences.push(`${file}: a NULL year reads as nothing stated`);
      continue;
    }

    if (/genre set to 255\./.test(expected.prose)) {
      if (value('genre') !== undefined) mismatches.push(`${file}: genre 255 was read as a name`);
      else divergences.push(`${file}: genre 255 reads as nothing stated`);
      continue;
    }

    const yearBad = expected.fields.year !== undefined && !/^\d{4}$/.test(expected.fields.year);

    if (!refusedSomething) {
      mismatches.push(`${file}: the suite calls this a failure and nothing was refused`);
      continue;
    }
    // And for the cases that *are* about a genre, the genre must be the thing
    // that did not survive — refusing some other field while naming an unknown
    // genre would satisfy the check above and be exactly the defect these cases
    // exist to catch. Scoped by the prose rather than applied to every failure:
    // the year cases carry a perfectly good genre 0 (Blues), and demanding its
    // absence would be this tool inventing a defect out of a correct read.
    const aboutAGenre = /^An ID3 tag with genre set to /m.test(expected.prose);
    if (aboutAGenre && value('genre') !== undefined) {
      mismatches.push(`${file}: a genre the suite refuses was read as ${JSON.stringify(value('genre'))}`);
      continue;
    }
    if (yearBad && value('date') !== undefined) {
      mismatches.push(`${file}: a year the suite refuses was read as ${JSON.stringify(value('date'))}`);
      continue;
    }
    refused += 1;
    continue;
  }

  // The plain and warning cases are both files a reader must read.
  if (expected.suffix === 'W') warned += 1;
  else plainChecked += 1;

  // The genre first, because it is the check the suite exists for: every one of
  // the table's entries is exercised by exactly one file.
  //
  // The oracle is **the log's own word** — the name in brackets in the tabulated
  // cases, the prose in the others — and deliberately not `ID3V1_GENRES`. That
  // distinction is the whole value of this check and it was missing at first:
  // comparing the reader against the table the reader reads is comparing it
  // against itself, and it passed a table entry the suite disagrees with (67,
  // "Psychadelic" there and "Psychedelic" here) without a word. With the log as
  // the oracle the table is what is under test, which is what it should have
  // been all along.
  const logged = expected.fields.genre?.match(/\(([^)]*)\)\s*$/)?.[1] ?? expected.genreName;
  const index = expected.fields.genre === undefined ? null : Number(expected.fields.genre.split(' ')[0]);

  if (logged !== undefined && logged !== null && logged !== '' && !/^unknown$/i.test(logged)) {
    const got = value('genre');

    if (got === logged) {
      genreNames += 1;
    } else if (got !== undefined && SPELLINGS.get(logged) === got) {
      // The two entries where the log and the ID3v2 appendix spell one genre
      // differently, both already documented in `genres.ts`: 67, where v2.3
      // repeats ID3v1's original misspelling and v2.4 corrects it, and 123,
      // "A cappella" against "A capella". The table follows the appendix — this
      // suite's own README says it "should not be considered normative" — and
      // these are counted rather than called mismatches.
      genreSpellings += 1;
    } else {
      mismatches.push(`${file}: genre ${JSON.stringify(got)}, the suite says ${JSON.stringify(logged)}`);
    }
  }

  // Then every field the log tabulated, value for value.
  for (const [field, logged] of Object.entries(expected.fields)) {
    const name =
      field === 'year' ? 'date' : field === 'track' ? 'tracknumber' : field === 'genre' ? null : field;
    if (name === null || field === 'head') continue;
    if (logged === '') continue;

    // Up to the terminator, because the log dumps the bytes the generator
    // *wrote* and one warning case writes junk after a NUL on purpose. The
    // suite states the expectation for it in words — "only the string 12345
    // should show up" — so the prefix is the oracle: a reader that honours the
    // terminator passes and one that keeps the junk fails. The log spells that
    // NUL as Pike does, in two characters, which is why the cut is on those
    // rather than on the byte — a byte here would be an invisible control
    // character in this file, and this repository has already been bitten by
    // one of those making a source file unsearchable.
    const wanted = logged.split(PIKE_NUL)[0] as string;

    plainFields += 1;
    const got = value(name);
    // Two readings, because the log holds *bytes* and the suite's `extra`
    // category exists precisely to put the same word in two encodings. Read as
    // ISO-8859-1 — which is what the log is written in, and what a tag of that
    // age usually holds — or read as UTF-8, which is the other thing a tagger
    // wrote. The reader must produce the same text either way, and does: the
    // bytes are what the file states, and which of the two readings they admit
    // is a question the reader answers rather than the file.
    const asWritten = wanted;
    const asUtf8 = Buffer.from(wanted, 'latin1').toString('utf8');
    const same = got !== undefined && (got === asWritten || got === asUtf8);
    // A track number is the one field this project formats rather than copies:
    // the byte is a number 1..255 and the tag holds it as text.
    const numberSame = name === 'tracknumber' && Number(got) === Number(wanted);

    if (!same && !numberSame) {
      mismatches.push(`${file}: ${name} = ${JSON.stringify(got)}, the suite says ${JSON.stringify(wanted)}`);
    }
  }
}
console.log(`files              ${files.length}`);
console.log(`read and compared  ${plainChecked} plain, ${warned} warning`);
console.log(`fields compared    ${plainFields}`);
console.log(`genre names matched ${genreNames}`);
console.log(`refusals as asked  ${refused}`);
console.log(`mismatches         ${mismatches.length}`);
console.log(`genre spellings    ${genreSpellings}  (67 and 123: the appendix\u2019s, not the log\u2019s)`);
console.log(`divergences        ${divergences.length}  (deliberate, argued in id3v1.ts)`);

for (const line of mismatches.slice(0, 20)) console.log(`  MISMATCH ${line}`);
for (const line of divergences.slice(0, 4)) console.log(`  known    ${line}`);

process.exit(mismatches.length === 0 ? 0 : 1);
