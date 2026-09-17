/**
 * Measure this project's mp3 reader against ffprobe on a real collection.
 *
 * The unit tests cannot do this job, and it is worth being plain about why: the
 * fixture builder and the reader were written by the same hand from the same
 * understanding of the format, so a shared mistake makes them agree. That has
 * already happened here twice — two bitrate/samples tables entered with the key
 * for the wrong layer, both self-consistent, both wrong. Only an outside reader
 * catches that class of error.
 *
 * **Which outside reader, though, turns out to matter.** `format.duration` is
 * not a measurement for an mp3 with no Xing header: with nothing to state the
 * frame count, ffmpeg divides the file size by the nominal bitrate. On a 320
 * kbps constant-bitrate rip the real frame size is 1044.9 bytes, so roughly
 * nine frames in ten carry a padding byte, and that estimate lands about 0.08%
 * short — half a second on a ten-minute track, and every one of those files
 * reads as this reader being wrong. It is not. `-count_packets` counts the
 * frames, and frames are what the length is made of, so that is the oracle here;
 * the estimate is reported beside it, as the thing being corrected.
 *
 * Not a test, and deliberately not run by `npm test`: it needs ffprobe on PATH
 * and a real collection to point at.
 *
 *   node test/tools/mp3-vs-ffprobe.ts "C:\path\to\album-or-collection"
 *
 * Exit code is 0 when every file it could measure matched. Refusals are not
 * failures — the fallback is meant to fire — they are counted and reported
 * separately, because their rate is what says whether the fallback is worth its
 * keep or should be replaced by ffprobe outright.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { probeFile } from '../../src/probe/ffprobe.ts';
import { readTags } from '../../src/tags/read.ts';

/** How far apart two answers may be before they are called different. */
const TOLERANCE_MS = 120;

/** Samples per frame at Layer III, by the rate family the stream reports. */
function samplesPerFrame(sampleRate: number): number {
  return sampleRate >= 32000 ? 1152 : 576;
}

/**
 * The length from the frame count, which is the measurement the estimate above
 * is standing in for. Null when ffprobe cannot count them at all.
 */
function countedDurationMs(absPath: string): number | null {
  let out: string;
  try {
    out = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-count_packets',
        '-show_entries',
        'stream=nb_read_packets,sample_rate',
        '-of',
        'json',
        absPath,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    );
  } catch {
    return null;
  }

  // JSON, not CSV: ffprobe emits CSV fields in alphabetical order, so a
  // positional read of "packets, rate" silently reads "rate, packets" and
  // produces a duration wrong by four orders of magnitude — which is exactly
  // what it did the first time this was written.
  let parsed: { streams?: { nb_read_packets?: string; sample_rate?: string }[] };
  try {
    parsed = JSON.parse(out) as typeof parsed;
  } catch {
    return null;
  }

  const frames = Number.parseInt(parsed.streams?.[0]?.nb_read_packets ?? '', 10);
  const sampleRate = Number.parseInt(parsed.streams?.[0]?.sample_rate ?? '', 10);
  if (Number.isNaN(frames) || Number.isNaN(sampleRate) || sampleRate === 0) return null;

  return Math.round((frames * samplesPerFrame(sampleRate) * 1000) / sampleRate);
}

const root = process.argv[2];
if (root === undefined) {
  console.error('usage: node test/tools/mp3-vs-ffprobe.ts <collection-root>');
  process.exit(2);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.name.toLowerCase().endsWith('.mp3')) out.push(abs);
  }
  return out;
}

const files = walk(root);
const mismatches: { rel: string; mine: number; theirs: number }[] = [];
let agreed = 0;
let refused = 0;
let unreadable = 0;
let uncounted = 0;
let estimateDrift = 0;

for (const abs of files) {
  const read = readTags(readFileSync(abs));
  const exact = countedDurationMs(abs);
  const estimate = probeFile(abs);

  if (exact === null) {
    uncounted += 1;
    continue;
  }
  if (read.durationRefused) {
    refused += 1;
    continue;
  }
  if (read.durationMs === null) {
    unreadable += 1;
    continue;
  }

  // How far the number everything else reports sits from the counted truth —
  // a property of ffprobe, not of this reader, and the reason the two were
  // being compared unfairly.
  if (estimate.ok && estimate.durationMs !== null) {
    estimateDrift = Math.max(estimateDrift, Math.abs(estimate.durationMs - exact));
  }

  if (Math.abs(read.durationMs - exact) <= TOLERANCE_MS) agreed += 1;
  else mismatches.push({ rel: abs.slice(root.length + 1), mine: read.durationMs, theirs: exact });
}

mismatches.sort((a, b) => Math.abs(b.mine - b.theirs) - Math.abs(a.mine - a.theirs));

console.log(`files              ${files.length}`);
console.log(`agreed             ${agreed}`);
console.log(`refused            ${refused}   (handed to ffprobe by design)`);
console.log(`no frames at all   ${unreadable}`);
console.log(`ffprobe uncounted  ${uncounted}`);
console.log(`mismatched         ${mismatches.length}`);
console.log(`worst ffprobe duration-vs-counted drift: ${estimateDrift} ms`);

for (const row of mismatches.slice(0, 20)) {
  const delta = row.mine - row.theirs;
  console.log(
    `  ${delta > 0 ? '+' : ''}${delta} ms  ${(row.mine / 1000).toFixed(2)} vs ${(row.theirs / 1000).toFixed(2)}  ${row.rel}`,
  );
}

process.exit(mismatches.length === 0 ? 0 : 1);
