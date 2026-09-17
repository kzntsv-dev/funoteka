/**
 * Measure this project's MPEG reader against ffmpeg, one layer at a time.
 *
 * `tags-mpeg.test.ts` pins the reader's behaviour against a fixture, and the
 * fixture carries the same bitrate tables and the same frame-length formula the
 * reader does — written separately, which buys less than it sounds like: a
 * builder and a reader transcribed from one wrong understanding agree with each
 * other and are both wrong. The collection cannot settle it either. Every mp3
 * in it is Layer III, so Layer I and Layer II were code no test and no file had
 * ever executed (task:2756, finding 11).
 *
 * So the tables are handed to something that did not write them. Two answers
 * come back, and they are independent in different ways:
 *
 *   - **counted frames.** ffmpeg demuxes the stream and says how many frames it
 *     found and at what rate; the duration is that count times the samples a
 *     frame carries. The frame *count* is ffmpeg's own walk over its own frame
 *     sizes, so it settles the bitrate table and the frame-length formula —
 *     including the four-byte slot Layer I is built out of. The samples-per-
 *     frame figure is the one thing here that is still ours, and it is why the
 *     second answer matters.
 *   - **generated audio.** Real Layer II files written by ffmpeg's own encoder,
 *     not by the fixture: a stream laid out by a real encoder is the one thing
 *     no transcription error survives.
 *
 * **What this does not cover, and it should be said rather than implied.** No
 * open encoder writes Layer I — ffmpeg decodes it and does not produce it — so
 * the Layer I rows rest on ffmpeg's *demuxer* reading frames this repository
 * built. That is a real second opinion on the tables and the formula, and it is
 * not a real file.
 *
 * Not a test, and deliberately not run by `npm test`: it needs ffmpeg and
 * ffprobe on PATH.
 *
 *   node test/tools/mpeg-layers-vs-ffprobe.ts
 *
 * Exit code is 0 when every stream agreed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readTags } from '../../src/tags/read.ts';
import { mpeg } from '../helpers/bytes.ts';
import { tempRoot } from '../helpers/tmp.ts';

/** How far apart two answers may be before they are called different. */
const TOLERANCE_MS = 120;

type Version = 1 | 2 | 25;
type Layer = 'I' | 'II' | 'III';

/**
 * Samples a frame carries — Layer III alone differs by version, and this is the
 * one figure the counted answer borrows from the reader rather than measuring.
 */
function samplesPerFrame(version: Version, layer: Layer): number {
  if (layer === 'I') return 384;
  if (layer === 'II') return 1152;
  return version === 1 ? 1152 : 576;
}

const EXTENSION: Record<Layer, string> = { I: 'mp1', II: 'mp2', III: 'mp3' };

interface Case {
  version: Version;
  layer: Layer;
  sampleRate: number;
  bitrateKbps: number;
  padding?: boolean;
}

/**
 * The matrix, chosen for what each row can catch rather than for breadth.
 *
 * Layer I reaches 448 kbps where Layer III stops at 320, so a reader that read
 * one table at the other's index lands on a real bitrate at a real index and
 * lays the frames out wrongly — silently. Layer II's MPEG-2 column starts at 8
 * where MPEG-1's starts at 32, which is the same trap the other way. Padding is
 * its own unit at Layer I (four bytes) and its own number everywhere else.
 */
const CASES: Case[] = [
  // Layer I — the layer nothing here could write before the fixture could.
  { version: 1, layer: 'I', sampleRate: 44100, bitrateKbps: 32 },
  { version: 1, layer: 'I', sampleRate: 44100, bitrateKbps: 96 },
  { version: 1, layer: 'I', sampleRate: 44100, bitrateKbps: 224 },
  { version: 1, layer: 'I', sampleRate: 44100, bitrateKbps: 448 },
  { version: 1, layer: 'I', sampleRate: 48000, bitrateKbps: 128, padding: true },
  { version: 2, layer: 'I', sampleRate: 22050, bitrateKbps: 64 },
  { version: 25, layer: 'I', sampleRate: 8000, bitrateKbps: 256 },

  // Layer II — real files for this exist below; these are the table's own edges.
  { version: 1, layer: 'II', sampleRate: 44100, bitrateKbps: 32 },
  { version: 1, layer: 'II', sampleRate: 44100, bitrateKbps: 128 },
  { version: 1, layer: 'II', sampleRate: 44100, bitrateKbps: 384, padding: true },
  { version: 1, layer: 'II', sampleRate: 48000, bitrateKbps: 192 },
  { version: 2, layer: 'II', sampleRate: 22050, bitrateKbps: 8 },
  { version: 2, layer: 'II', sampleRate: 24000, bitrateKbps: 160 },
  { version: 25, layer: 'II', sampleRate: 11025, bitrateKbps: 64 },

  // Layer III — what the collection actually is, over the same edges.
  { version: 1, layer: 'III', sampleRate: 44100, bitrateKbps: 32 },
  { version: 1, layer: 'III', sampleRate: 44100, bitrateKbps: 320, padding: true },
  { version: 2, layer: 'III', sampleRate: 22050, bitrateKbps: 64 },
];

/** A real Layer II file, written by ffmpeg's encoder rather than by the fixture. */
const GENERATED: { sampleRate: number; bitrateKbps: number; durationS: number }[] = [
  { sampleRate: 44100, bitrateKbps: 192, durationS: 3 },
  { sampleRate: 44100, bitrateKbps: 384, durationS: 3 },
  { sampleRate: 48000, bitrateKbps: 128, durationS: 2 },
];

/**
 * What ffprobe counted: how many frames, at what rate, right or wrong.
 *
 * JSON rather than CSV, and for the reason `mp3-vs-ffprobe.ts` records: ffprobe
 * emits CSV fields in alphabetical order, so a positional read of "packets,
 * rate" silently reads "rate, packets".
 */
function counted(absPath: string): { frames: number; sampleRate: number } | null {
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

  let parsed: { streams?: { nb_read_packets?: string; sample_rate?: string }[] };
  try {
    parsed = JSON.parse(out) as typeof parsed;
  } catch {
    return null;
  }

  const frames = Number.parseInt(parsed.streams?.[0]?.nb_read_packets ?? '', 10);
  const sampleRate = Number.parseInt(parsed.streams?.[0]?.sample_rate ?? '', 10);
  if (Number.isNaN(frames) || Number.isNaN(sampleRate) || sampleRate === 0) return null;

  return { frames, sampleRate };
}

const dir = tempRoot('funoteka-mpeg-layers-');
const mismatches: string[] = [];
let agreed = 0;
let uncounted = 0;

for (const [index, one] of CASES.entries()) {
  const path = join(dir, `case${index}.${EXTENSION[one.layer]}`);
  writeFileSync(path, mpeg({ ...one, frames: 200 }));

  const seen = counted(path);
  const mine = readTags(readFileSync(path));

  if (seen === null) {
    uncounted += 1;
    mismatches.push(
      `MPEG-${one.version} Layer ${one.layer} @${one.sampleRate} ${one.bitrateKbps}k — ffprobe counted no frames`,
    );
    continue;
  }

  const theirs = Math.round(
    (seen.frames * samplesPerFrame(one.version, one.layer) * 1000) / seen.sampleRate,
  );
  const delta = (mine.durationMs ?? Number.NaN) - theirs;
  const label = `MPEG-${one.version} Layer ${one.layer} @${one.sampleRate} ${one.bitrateKbps}k${one.padding === true ? ' padded' : ''}`;

  if (Math.abs(delta) <= TOLERANCE_MS) agreed += 1;
  else {
    mismatches.push(
      `${label} — mine ${mine.durationMs ?? 'null'} ms (codec ${mine.codec ?? 'null'}), ffprobe counted ${seen.frames} frames = ${theirs} ms`,
    );
  }
}

for (const [index, one] of GENERATED.entries()) {
  const path = join(dir, `generated${index}.mp2`);
  try {
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=${one.sampleRate}:duration=${one.durationS}`,
        '-c:a',
        'mp2',
        '-b:a',
        `${one.bitrateKbps}k`,
        '-y',
        path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    );
  } catch {
    mismatches.push(`ffmpeg could not write a Layer II file at ${one.bitrateKbps}k`);
    continue;
  }

  const seen = counted(path);
  const mine = readTags(readFileSync(path));
  if (seen === null) {
    uncounted += 1;
    mismatches.push(`Layer II @${one.sampleRate} ${one.bitrateKbps}k — ffprobe counted no frames`);
    continue;
  }

  const theirs = Math.round((seen.frames * 1152 * 1000) / seen.sampleRate);
  const delta = (mine.durationMs ?? Number.NaN) - theirs;
  const label = `real Layer II @${one.sampleRate} ${one.bitrateKbps}k`;

  if (Math.abs(delta) <= TOLERANCE_MS) agreed += 1;
  else {
    mismatches.push(
      `${label} — mine ${mine.durationMs ?? 'null'} ms (codec ${mine.codec ?? 'null'}), ffprobe counted ${seen.frames} frames = ${theirs} ms`,
    );
  }
}

console.log(`streams            ${CASES.length + GENERATED.length}`);
console.log(`agreed             ${agreed}`);
console.log(`ffprobe uncounted  ${uncounted}`);
console.log(`mismatched         ${mismatches.length}`);
for (const line of mismatches) console.log(`  ${line}`);

rmSync(dir, { recursive: true, force: true });
process.exit(mismatches.length === 0 ? 0 : 1);
