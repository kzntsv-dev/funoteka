/**
 * Measure this project's m4a reader against ffprobe on a real collection.
 *
 * Same argument as `mp3-vs-ffprobe.ts`, and the same reason it is not a test:
 * the fixture builder and the reader were written by the same hand, so a box
 * nesting they both misread agrees perfectly. ffprobe is the outside reader.
 *
 * Two checks, because an MP4 carries two things:
 *
 *   - the length, against `format.duration` — and here that is the *opposite*
 *     choice from `mp3-vs-ffprobe.ts`, where the same field is an estimate and
 *     the packet count is the truth. MP4 states its length in `mvhd`, so
 *     ffmpeg reports the file's own number rather than working one out. The
 *     packet count would have to know the samples per frame, and that differs
 *     per codec — 1024 for AAC, 4096 for ALAC — which produced a uniform 1024
 *     or 4096 over 1152 error the first time this was written;
 *   - the names, against `format_tags`, under the mapping between this
 *     project's vocabulary and ffprobe's (`albumartist` / `album_artist`,
 *     `tracknumber` / `track`). ffprobe is the right oracle for *which* names
 *     are in a file; it is not the right production path for them, because its
 *     tag output is a dictionary and two `©ART` entries collapse into one.
 *
 *   node test/tools/m4a-vs-ffprobe.ts "C:\path\to\album-or-collection"
 *
 * Exit code is 0 when every mapped name agreed and every countable length
 * matched.
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
  durationMs: number | null;
  tags: Record<string, string>;
}

function askFfprobe(absPath: string): Oracle {
  const empty: Oracle = { durationMs: null, tags: {} };

  let out: string;
  try {
    out = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:format_tags',
        '-of',
        'json',
        absPath,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    );
  } catch {
    return empty;
  }

  // JSON, not CSV: ffprobe emits CSV fields in alphabetical order, so a
  // positional read of "duration, tags" is not the read that was asked for.
  let parsed: { format?: { duration?: string; tags?: Record<string, string> } };
  try {
    parsed = JSON.parse(out) as typeof parsed;
  } catch {
    return empty;
  }

  const seconds = Number.parseFloat(parsed.format?.duration ?? '');
  return {
    durationMs: Number.isNaN(seconds) ? null : Math.round(seconds * 1000),
    tags: parsed.format?.tags ?? {},
  };
}

const root = process.argv[2];
if (root === undefined) {
  console.error('usage: node test/tools/m4a-vs-ffprobe.ts <collection-root>');
  process.exit(2);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.name.toLowerCase().endsWith('.m4a')) out.push(abs);
  }
  return out;
}

const files = walk(root);
const badDuration: { rel: string; mine: number; theirs: number }[] = [];
const badTag: string[] = [];
let agreed = 0;
let refused = 0;
let uncounted = 0;
let namesChecked = 0;
let namesMatched = 0;

for (const abs of files) {
  const rel = abs.slice(root.length + 1);
  const read = readTags(readFileSync(abs));
  const oracle = askFfprobe(abs);

  if (read.durationRefused) {
    refused += 1;
  } else if (read.durationMs === null || oracle.durationMs === null) {
    uncounted += 1;
  } else if (Math.abs(read.durationMs - oracle.durationMs) <= TOLERANCE_MS) {
    agreed += 1;
  } else {
    badDuration.push({ rel, mine: read.durationMs, theirs: oracle.durationMs });
  }

  // Only the names this reader claims to map: ffprobe carries plenty more
  // (MusicBrainz, replay gain) that this project deliberately does not read,
  // and counting those as misses would report a decision as a defect.
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
console.log(`length agreed      ${agreed}`);
console.log(`length refused     ${refused}   (handed to ffprobe by design)`);
console.log(`length uncounted   ${uncounted}`);
console.log(`length mismatched  ${badDuration.length}`);
console.log(`names matched      ${namesMatched} / ${namesChecked}`);
console.log(`names mismatched   ${badTag.length}`);

for (const row of badDuration.slice(0, 10)) {
  console.log(`  ${row.mine - row.theirs} ms  ${(row.mine / 1000).toFixed(2)} vs ${(row.theirs / 1000).toFixed(2)}  ${row.rel}`);
}
for (const row of badTag.slice(0, 10)) console.log(`  ${row}`);

process.exit(badDuration.length === 0 && badTag.length === 0 ? 0 : 1);
