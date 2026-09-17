/**
 * Measure this project's Ogg reader against ffprobe on a real collection.
 *
 * Same argument as `mp3-vs-ffprobe.ts` and `m4a-vs-ffprobe.ts`, and the same
 * reason it is not a test: `ogg()` in `test/helpers/bytes.ts` and
 * `src/tags/ogg.ts` were written by the same hand, so a lacing rule they both
 * misread agrees perfectly. ffprobe is the outside reader. (The fixture's own
 * checksum was checked against a real encoder's once, by hand, for the same
 * reason — see the note on `oggCrc`.)
 *
 * Two checks, and here they are not equally strong:
 *
 *   - **the codec**, against `codec_name`. This one carries the weight. Nothing
 *     in this project's reader and nothing in ffmpeg's share a line, and the
 *     answer is a word rather than a number: `vorbis` or `opus`, decided from
 *     the identification packet. A reader that walked the pages wrong would
 *     read the wrong packet and name the wrong codec, or none.
 *   - **the names**, against `format_tags`. Vorbis comments are a flat list of
 *     `NAME=value`, so the mapping to ffprobe's dictionary is the identity —
 *     there is no per-format renaming to get wrong, which is what makes this a
 *     check on the *parser* rather than on a translation table.
 *   - **the length**, against `format.duration` — deliberately last, and the
 *     weakest of the three. ffmpeg reads the same granule position this reader
 *     reads, so agreement here is evidence that the *page walk* reached the
 *     last page, not that the arithmetic is right. Agreement would survive a
 *     shared misreading of what a granule counts; the Opus pre-skip is checked
 *     better by the fixture, where the number is stated independently.
 *
 *   node test/tools/ogg-vs-ffprobe.ts "C:\path\to\album-or-collection"
 *
 * Exit code is 0 when every codec agreed, every mapped name agreed, and every
 * countable length matched.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readTags } from '../../src/tags/read.ts';

/** How far apart two answers may be before they are called different. */
const TOLERANCE_MS = 120;

/** This project's tag name -> the key ffprobe reports the same fact under. */
const ORACLE_NAMES: Record<string, string> = {
  title: 'title',
  artist: 'artist',
  albumartist: 'album_artist',
  album: 'album',
  genre: 'genre',
  date: 'date',
  tracknumber: 'track',
  discnumber: 'disc',
};

interface Oracle {
  codec: string | null;
  durationMs: number | null;
  tags: Record<string, string>;
}

/** ffprobe's reading of one file. Nothing here is shared with the reader. */
function askFfprobe(abs: string): Oracle {
  const out = JSON.parse(
    execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', abs], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    }),
  ) as {
    streams?: { codec_type?: string; codec_name?: string; tags?: Record<string, string> }[];
    format?: { duration?: string; tags?: Record<string, string> };
  };

  const stream = (out.streams ?? []).find((one) => one.codec_type === 'audio');
  const duration = out.format?.duration;

  // Both places, because ffprobe puts a Vorbis file's comments on the *stream*
  // and an MP4's on the *format* — the container decides. Reading only
  // `format.tags` finds nothing at all in every Ogg file, and a checker that
  // compared against that would report a perfect score by never comparing
  // anything.
  //
  // The keys are lower-cased because ffprobe's own spelling is inconsistent by
  // design: a name it maps to one of its own arrives lower-cased (`album_artist`
  // for this project's `albumartist`), and the rest keep whatever the file
  // wrote (`ALBUM`, `ARTIST`, `TITLE`).
  const tags: Record<string, string> = {};
  for (const source of [stream?.tags, out.format?.tags]) {
    for (const [name, value] of Object.entries(source ?? {})) tags[name.toLowerCase()] = value;
  }

  return {
    codec: stream?.codec_name ?? null,
    durationMs: duration === undefined ? null : Math.round(Number(duration) * 1000),
    tags,
  };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(ogg|oga|opus)$/i.test(entry.name)) out.push(abs);
  }
  return out;
}

const root = process.argv[2];
if (root === undefined) {
  process.stderr.write('usage: node test/tools/ogg-vs-ffprobe.ts <directory>\n');
  process.exit(2);
}

const files = walk(root);
const badCodec: string[] = [];
const badDuration: { rel: string; mine: number; theirs: number }[] = [];
const badTag: string[] = [];
const codecs: Record<string, number> = {};
let agreed = 0;
let refused = 0;
let uncounted = 0;
let namesChecked = 0;
let namesMatched = 0;

for (const abs of files) {
  const rel = abs.slice(root.length + 1);
  const read = readTags(readFileSync(abs));
  const oracle = askFfprobe(abs);

  codecs[String(read.codec)] = (codecs[String(read.codec)] ?? 0) + 1;
  if (read.codec !== oracle.codec) badCodec.push(`${rel}: ${read.codec} vs ffprobe ${oracle.codec}`);

  if (read.durationRefused) {
    refused += 1;
  } else if (read.durationMs === null || oracle.durationMs === null) {
    uncounted += 1;
  } else if (Math.abs(read.durationMs - oracle.durationMs) <= TOLERANCE_MS) {
    agreed += 1;
  } else {
    badDuration.push({ rel, mine: read.durationMs, theirs: oracle.durationMs });
  }

  // Only the names this reader claims to map: a Vorbis comment may carry plenty
  // else — lyrics, ISRC, a barcode — that this project deliberately does not
  // read, and counting those as misses would report a decision as a defect.
  const seen = new Map<string, string>();
  for (const tag of read.tags) {
    if (!seen.has(tag.name)) seen.set(tag.name, tag.value);
  }
  for (const [mine, theirs] of Object.entries(ORACLE_NAMES)) {
    const value = seen.get(mine);
    if (value === undefined) continue;
    namesChecked += 1;
    if (oracle.tags[theirs] === value) namesMatched += 1;
    else badTag.push(`${rel}: ${mine} = ${JSON.stringify(value)}, ffprobe ${theirs} = ${JSON.stringify(oracle.tags[theirs])}`);
  }
}

console.log(`files              ${files.length}`);
console.log(`codecs read        ${JSON.stringify(codecs)}`);
console.log(`codec disagreed    ${badCodec.length}`);
console.log(`length agreed      ${agreed}`);
console.log(`length refused     ${refused}   (handed to ffprobe by design)`);
console.log(`length uncounted   ${uncounted}`);
console.log(`names matched      ${namesMatched}/${namesChecked}`);

for (const line of badCodec.slice(0, 10)) console.log(`  codec  ${line}`);
for (const one of badDuration.slice(0, 10)) {
  console.log(`  length ${one.rel}: ${one.mine} vs ffprobe ${one.theirs}`);
}
for (const line of badTag.slice(0, 10)) console.log(`  name   ${line}`);

process.exit(badCodec.length + badDuration.length + badTag.length === 0 ? 0 : 1);
