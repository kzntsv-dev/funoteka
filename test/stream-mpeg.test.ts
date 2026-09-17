import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mpegSegment } from '../src/stream/mpeg.ts';
import { mpeg } from './helpers/bytes.ts';
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
/** One image, written for the duration of one test and removed after it. */
async function withImage(bytes: Buffer, work: (path: string) => Promise<void>): Promise<void> {
  const dir = tempRoot('funoteka-mpeg-');
  try {
    const path = join(dir, 'image.mp3');
    writeFileSync(path, bytes);
    await work(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An ID3v1 block, which is what a great many mp3s end with. */
function id3v1(): Buffer {
  const tag = Buffer.alloc(128);
  tag.write('TAG', 0, 'latin1');
  return tag;
}

/** The length in milliseconds a run of frames plays for, to the millisecond. */
function ms(frames: number, sampleRate: number, samplesPerFrame = 1152): number {
  return Math.ceil((frames * samplesPerFrame * 1000) / sampleRate);
}

test('a request that asks for the millisecond a duration was rounded to is served', async () => {
  // The frames of a file end where the audio ends; the *request* comes from a
  // duration the scan rounded to the millisecond, so it asks for a fraction of
  // a frame more than the file holds — eight and eighteen samples of a
  // 1152-sample frame, over three tracks of the live collection that were
  // refused whole for it (task:2846).
  //
  // Here 100 frames of 1152 samples at 44100 play for 2612.244 ms; a duration
  // rounded up to 2613 asks for 33 samples past the end, and the file ends with
  // an ID3v1 block, so the bytes after the last frame are a tag and not a frame.
  const frames = 100;
  const image = Buffer.concat([mpeg({ frames, sampleRate: 44100, bitrateKbps: 128 }), id3v1()]);

  await withImage(image, async (path) => {
    const segment = await mpegSegment(path, 0, 2613, TAGS);
    assert.ok(segment !== null, 'the whole track is served, not refused');
    assert.equal(segment.from, 0);
    assert.equal(segment.to, frames * 417, 'and the tag is not part of it');
  });
});

test('a stream that stops a frame or more short of the request is still refused', async () => {
  // The other half of the same rule, and the reason the rule is drawn at a
  // frame rather than at any shortfall: a file that really is missing audio
  // must not be served under the name of the track that asked for it. Ten
  // frames short is audio that is not there.
  const frames = 100;
  const image = mpeg({ frames, sampleRate: 44100, bitrateKbps: 128 });

  await withImage(image, async (path) => {
    assert.equal(await mpegSegment(path, 0, ms(frames + 10, 44100), TAGS), null);
  });
});

test('a file cut off inside its last frame is served to its end, not past it', async () => {
  // A frame's length is stated by its *header*, so a file truncated in the
  // middle of its last frame still walks to the end of that frame — a byte
  // offset past the end of the file. The segment then promised more than the
  // file holds: `segmentSize` and `content-length` said one number and the
  // stream delivered a shorter body, which a client reads as a download that
  // stopped rather than as a refusal.
  //
  // The window always allowed this for a tail of forty-four bytes or more; the
  // walk asking for a four-byte header widened it to four (task:2848).
  const frames = 100;
  const full = mpeg({ frames, sampleRate: 44100, bitrateKbps: 128 });
  const cut = full.subarray(0, full.length - 400);

  await withImage(cut, async (path) => {
    const segment = await mpegSegment(path, 0, ms(frames, 44100), TAGS);
    assert.ok(segment !== null, 'the audio that is there is served');
    assert.equal(segment.to, cut.length, 'and the segment ends at the end of the file');
  });
});

test('a frame in the last bytes of the file is read, not passed over', async () => {
  // The walk asks the window for a frame *header*, which is four bytes, so the
  // fourty-four the window used to insist on hid a frame that was there. Short
  // frames are what a low bitrate makes: MPEG-2 at 8 kbps is 26 bytes a frame,
  // and the last of them starts 26 bytes from the end of the file.
  const frames = 100;
  const image = mpeg({ version: 2, frames, sampleRate: 22050, bitrateKbps: 8 });

  await withImage(image, async (path) => {
    const segment = await mpegSegment(path, 0, ms(frames, 22050, 576), TAGS);
    assert.ok(segment !== null, 'the last frame is found');
    assert.equal(segment.to, frames * 26, 'and it is the whole of what is served');
  });
});
