import { test } from 'node:test';
import assert from 'node:assert/strict';

import { restatedSize, restating, type Reframe, type Rewrite } from '../src/stream/rewrite.ts';
import { crc16 } from './helpers/flac.ts';

/** A ten-byte stretch of a file, and the offset it sits at. */
const SOURCE = Buffer.from('abcdefghij');
const BASE = 100;

/** A span replaced by `with`, as a rewrite of `length` bytes starting at `at`. */
function span(at: number, length: number, with_: string): Rewrite {
  return { at: BASE + at, length, bytes: Buffer.from(with_, 'latin1') };
}

/** A frame covering `[from, to)`, whose header is replaced. */
function frame(from: number, to: number, length: number, with_: string): Reframe {
  return { header: span(from, length, with_), from: BASE + from, to: BASE + to };
}

/**
 * What the rewriter makes of the source, arriving in pieces of `size` bytes.
 *
 * The pieces are how a chunk boundary is put where a test wants one: the same
 * frames through a stream that arrives whole and one that dribbles in must
 * produce the same bytes, because a header or a footer can be split anywhere.
 */
async function served(frames: Reframe[], size = SOURCE.length): Promise<Buffer> {
  const through = restating(frames, BASE);
  const chunks: Buffer[] = [];
  through.on('data', (chunk: Buffer) => chunks.push(chunk));

  const ended = new Promise<void>((resolve, reject) => {
    through.on('end', resolve);
    through.on('error', reject);
  });

  for (let at = 0; at < SOURCE.length; at += size) through.write(SOURCE.subarray(at, at + size));
  through.end();
  await ended;
  return Buffer.concat(chunks);
}

test('a frame goes out as its new header, its body, and a footer over both', async () => {
  // The whole point: a header restated without its footer restated is a frame
  // no parser will take. The footer covers the frame *including its header*
  // (§9.3), so it has to be computed over what goes out. The frame here is
  // `cdefgh`: a two-byte header, four bytes of body, and the footer.
  const rewritten = await served([frame(2, 8, 2, 'XY')]);

  assert.equal(rewritten.subarray(0, 2).toString('latin1'), 'ab', 'bytes before the frame are the file’s');
  assert.equal(rewritten.subarray(2, 4).toString('latin1'), 'XY', 'the header is replaced');
  assert.equal(rewritten.subarray(4, 6).toString('latin1'), 'ef', 'the body is the file’s own');
  assert.equal(rewritten.readUInt16BE(6), crc16(rewritten.subarray(2, 6)), 'and the footer covers the frame');
  assert.equal(rewritten.subarray(8).toString('latin1'), 'ij', 'the rest is untouched');
  assert.equal(rewritten.length, SOURCE.length, 'two bytes for two');
});

test('a chunk boundary anywhere makes no difference to the bytes', async () => {
  const frames = [frame(2, 8, 2, 'XY'), frame(8, 10, 1, 'Z')];
  const whole = await served(frames);

  for (const size of [1, 2, 3, 4, 5, 7, 9]) {
    assert.equal((await served(frames, size)).toString('latin1') + '|', whole.toString('latin1') + '|', `in ${size}-byte pieces`);
  }
});

test('a header shorter or longer than the one it replaces moves the body', async () => {
  // `abcdef` is the frame: a three-byte header, one byte of body, the footer.
  const shorter = await served([frame(0, 6, 3, 'X')]);
  assert.equal(shorter.subarray(0, 1).toString('latin1'), 'X', 'a one-byte header');
  assert.equal(shorter.subarray(1, 2).toString('latin1'), 'd', 'the body follows the header it got');
  assert.equal(shorter.readUInt16BE(2), crc16(shorter.subarray(0, 2)), 'and the footer still ends the frame');
  assert.equal(shorter.subarray(4).toString('latin1'), 'ghij', 'the rest is untouched');
  assert.equal(shorter.length, SOURCE.length - 2);

  assert.equal(restatedSize([frame(0, 6, 3, 'X')]), -2);
  assert.equal(restatedSize([frame(0, 6, 1, 'XYZ')]), 2);
});

test('a frame that is not named goes out as the file holds it', async () => {
  // A track needing no restating keeps the footers it came with: nothing here
  // is computed over bytes that were not written.
  const rewritten = await served([frame(4, 6, 1, 'Q')]);
  assert.equal(rewritten.subarray(0, 4).toString('latin1'), 'abcd');
  assert.equal(rewritten.subarray(4, 5).toString('latin1'), 'Q');
  assert.equal(rewritten.readUInt16BE(5), crc16(rewritten.subarray(4, 5)));
  assert.equal(rewritten.subarray(7).toString('latin1'), 'hij', 'and the rest is untouched');
});

test('a frame the stream has already passed is an error, not silent bytes', async () => {
  const behind = restating([frame(-1, 4, 1, 'X')], BASE);
  const failed = new Promise<Error>((resolve) => behind.on('error', resolve));

  behind.write(SOURCE.subarray(0, 4));
  const error = await failed;
  assert.match(error.message, /a frame at 99 was passed at position 100/);
});
