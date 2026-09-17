import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { flacSegment } from '../src/stream/flac.ts';
import { flac } from './helpers/flac.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The tags a built file is stamped with. What they say is not this file's
 * question — `tags-encode.test.ts` is where that lives — but a stub is still a
 * song's worth of fields, so a reader can tell the tag being present from the
 * tag being empty.
 */
const TAGS = {
  title: 'Tramvai',
  artist: 'Кино',
  albumArtist: 'Кино',
  album: '45',
  trackNumber: 2,
  discNumber: 1,
  date: '1982',
  genre: 'Rock',
} as const;
/**
 * What a segment's rebuilt stream information declares as the stream's length.
 *
 * Section 8.2 packs it with the rate, the channel count and the bit depth into
 * one 64-bit word, and it is the number a decoder reports and a client believes
 * — so it is also the number that says how many of the file's frames the walk
 * found. A frame the walk passed over is a frame whose samples are in the bytes
 * and absent from this count.
 */
function declaredSamples(prefix: Buffer): number {
  return Number(prefix.readBigUInt64BE(18) & ((1n << 36n) - 1n));
}

/** One image, written for the duration of one test and removed after it. */
async function withImage(bytes: Buffer, work: (path: string) => Promise<void>): Promise<void> {
  const dir = tempRoot('funoteka-flac-');
  try {
    const path = join(dir, 'image.flac');
    writeFileSync(path, bytes);
    await work(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('frames inside the last bytes of the file are indexed, not passed over', async () => {
  // The walk holds the tail of each window back, so that a header straddling
  // the seam between two windows is read whole once the next window is in
  // behind it. At the end of the file there is no next window — the bytes in
  // hand are every byte there will ever be — and a frame that starts inside the
  // room that is held back is then never looked at.
  //
  // These frames are eight bytes each, so the last several of them fall in that
  // room. It is not a shape invented for the test: the closing frame of a real
  // image is short, and `Кино - Это не любовь (MKK851CD1).flac` ends with three
  // frames of sixteen, sixteen and eighteen bytes — all of them inside the last
  // sixty-four bytes of the file, and all of them lost to this (task:2783).
  const frames = 20;
  const blockSize = 256;

  await withImage(flac({ frames, blockSize, bodyBytes: 0 }), async (path) => {
    const segment = await flacSegment(path, 0, 1000, TAGS);
    assert.ok(segment !== null, 'the image is walkable');

    assert.equal(
      declaredSamples(segment.prefix),
      frames * blockSize,
      'a segment of the whole file declares the whole file',
    );
  });
});

test('a frame-shaped run of bytes inside a frame body is not a frame', async () => {
  // The walk accepts a candidate header when its CRC-8 agrees with its own bytes
  // **and** the number it states is the one that must come next, and the module
  // has argued that a coincidence in coded audio would have to satisfy both at
  // once. In this collection one does: `Игры - Крик в жизни (MASHCD-058-1).flac`
  // carries `FF F9 7C 5C 16 8C 3D 6C F6` inside the body of frame 21, and every
  // part of that is plausible — sync word, footer that agrees, and the number 22
  // the walk was waiting for. Taking it cost the walk 31806 samples of drift and
  // served fifteen tracks of that disc 743 ms early (task:2849).
  //
  // What gives it away is what it contradicts: a stream states its blocking
  // strategy once and keeps it (§9.1.1), and this one states the other.
  const frames = 20;
  const blockSize = 4096;
  const image = flac({ frames, blockSize, bodyBytes: 512, decoy: 'strategy' });

  await withImage(image, async (path) => {
    const segment = await flacSegment(path, 0, 100_000, TAGS);
    assert.ok(segment !== null, 'the image is walkable');
    assert.equal(
      declaredSamples(segment.prefix),
      frames * blockSize,
      'every frame of the image is found, and the decoy is not one of them',
    );
  });
});
