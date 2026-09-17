import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readTags } from '../src/tags/read.ts';
import { id3v2, mp4 } from './helpers/bytes.ts';

/**
 * The cover a file carries, found without copying it.
 *
 * Every assertion here is the same claim in three formats: the offset the reader
 * reports points at the image's own bytes, and the length is the image's. That
 * is checked by finding the bytes in the file rather than by repeating the
 * parser's arithmetic — a test that recomputed the offset the same way the
 * reader does would agree with a reader that was wrong the same way.
 */

/** Not a real JPEG, and deliberately: what is under test is where it sits. */
const IMAGE = Buffer.from('COVER-BYTES-THAT-ARE-NOT-A-REAL-JPEG');

/** The picture of a FLAC block, laid out as RFC 9639 section 8.8 says. */
function flacPicture(type: number, mime: string, image: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(type, 0);

  const mimeBytes = Buffer.from(mime, 'latin1');
  const mimeLength = Buffer.alloc(4);
  mimeLength.writeUInt32BE(mimeBytes.length, 0);

  const descriptionLength = Buffer.alloc(4); // an empty description
  const dimensions = Buffer.alloc(16); // width, height, depth, colours
  const imageLength = Buffer.alloc(4);
  imageLength.writeUInt32BE(image.length, 0);

  return Buffer.concat([
    header,
    mimeLength,
    mimeBytes,
    descriptionLength,
    dimensions,
    imageLength,
    image,
  ]);
}

/** A FLAC holding nothing but a stream information block and a picture. */
function flacWithPicture(type: number, image: Buffer = IMAGE): Buffer {
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt32BE(44100 << 12, 10); // rate, channels, depth, samples

  const picture = flacPicture(type, 'image/jpeg', image);
  return Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x22]), // stream information, 34 bytes, not last
    streamInfo,
    Buffer.from([0x80 | 0x06]), // picture, last
    Buffer.from([(picture.length >> 16) & 0xff, (picture.length >> 8) & 0xff, picture.length & 0xff]),
    picture,
    Buffer.alloc(128), // audio the picture block's "last" flag says follows
  ]);
}

/** The body of an ID3v2.3 `APIC` frame: encoding, MIME, type, description, image. */
function apicBody(type: number, mime: string, image: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x00]), // ISO-8859-1
    Buffer.from(`${mime}\0`, 'latin1'),
    Buffer.from([type]),
    Buffer.from([0x00]), // an empty description
    image,
  ]);
}

test('a FLAC’s picture block is reported where its bytes are', () => {
  const bytes = flacWithPicture(3);
  const read = readTags(bytes);

  assert.ok(read.picture !== undefined, 'a picture was found');
  assert.equal(read.picture.mime, 'image/jpeg');
  assert.equal(read.picture.kind, 3);

  assert.equal(read.picture.offset, bytes.indexOf(IMAGE), 'the offset is the image’s own');
  assert.deepEqual(
    Buffer.from(bytes.subarray(read.picture.offset, read.picture.offset + read.picture.length)),
    IMAGE,
  );
});

test('an ID3v2 APIC frame is reported where its bytes are', () => {
  const image = Buffer.from('ID3-EMBEDDED-COVER');
  const body = apicBody(3, 'image/png', image);
  const bytes = Buffer.concat([
    id3v2([{ id: 'APIC', encoding: 0, text: Buffer.alloc(0), raw: body }]),
    Buffer.alloc(64),
  ]);

  const read = readTags(bytes);
  assert.ok(read.picture !== undefined, 'a picture was found');
  assert.equal(read.picture.mime, 'image/png');
  assert.equal(read.picture.kind, 3);
  assert.equal(read.picture.offset, bytes.indexOf(image));
  assert.deepEqual(
    Buffer.from(bytes.subarray(read.picture.offset, read.picture.offset + read.picture.length)),
    image,
  );
});

test('an MP4’s covr atom is reported where its bytes are', () => {
  // The helper writes the six bytes a JPEG opens with, and the length is the
  // atom's — which is the whole point: the reader learns the picture's size from
  // the box that holds it and never has to recognise an image.
  const bytes = mp4({ cover: true });
  const read = readTags(bytes);

  assert.ok(read.picture !== undefined, 'a picture was found');
  assert.equal(read.picture.mime, 'image/jpeg');
  assert.equal(read.picture.kind, 3, 'covr has one meaning, and it is the cover');

  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(read.picture.offset, bytes.indexOf(image));
  assert.equal(read.picture.length, image.length);
  assert.deepEqual(
    Buffer.from(bytes.subarray(read.picture.offset, read.picture.offset + read.picture.length)),
    image,
  );
});

test('a front cover wins over whatever else the file carries', () => {
  // Both are in the file, with "other" first. A reader that kept the first
  // picture would serve a photograph of the disc as the record's cover.
  const other = Buffer.from('NOT-THE-COVER');
  const bytes = flacWithPicture(0, other);

  // Two picture blocks: an "other" one first, then the front cover.
  const streamInfo = bytes.subarray(4, 42);
  const first = bytes.subarray(42, bytes.length - 128);
  const second = flacPicture(3, 'image/jpeg', IMAGE);
  const two = Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x22]),
    streamInfo,
    Buffer.from([0x06]),
    Buffer.from([(first.length >> 16) & 0xff, (first.length >> 8) & 0xff, first.length & 0xff]),
    first,
    Buffer.from([0x80 | 0x06]),
    Buffer.from([(second.length >> 16) & 0xff, (second.length >> 8) & 0xff, second.length & 0xff]),
    second,
  ]);

  const read = readTags(two);
  assert.ok(read.picture !== undefined);
  assert.equal(read.picture.kind, 3, 'the front cover, not the first picture seen');
  assert.deepEqual(
    Buffer.from(two.subarray(read.picture.offset, read.picture.offset + read.picture.length)),
    IMAGE,
  );
});

test('a picture block that cannot be walked yields no picture rather than a guess', () => {
  // A description of a length that runs past the block is the shape that matters:
  // everything after it is offset by an unknown number of bytes, so a reader
  // that trusted the lengths it read first would point into the middle of a
  // caption and serve that as art.
  const whole = flacPicture(3, 'image/jpeg', IMAGE);
  const lying = Buffer.concat([
    whole.subarray(0, 4), // picture type
    whole.subarray(4, 4 + 4 + 10), // MIME length and MIME
    Buffer.from([0xff, 0xff, 0xff, 0xf0]), // a description longer than the file
    whole.subarray(22),
  ]);

  const bytes = Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x22]),
    Buffer.alloc(34),
    Buffer.from([0x80 | 0x06]),
    Buffer.from([(lying.length >> 16) & 0xff, (lying.length >> 8) & 0xff, lying.length & 0xff]),
    lying,
  ]);

  assert.equal(readTags(bytes).picture, undefined);
});

test('a tag that says it is unsynchronised yields no picture where it cannot be undone', () => {
  // v2.2 and v2.3 escape the whole tag, and this reader deliberately does not
  // undo that (`deunsynchronise` says why: the samples carry no such tag, so the
  // rule is left unimplemented rather than guessed at). What it must not do is
  // report an offset into bytes it never decoded — that picture would be served
  // with the escaping still in it. An absent cover is the smaller lie.
  const image = Buffer.from([0xff, 0x00, 0xff, 0xe1, ...Buffer.from('COVER')]);
  const body = apicBody(3, 'image/jpeg', image);
  const tag = id3v2([{ id: 'APIC', encoding: 0, text: Buffer.alloc(0), raw: body }]);

  assert.equal(tag[3], 3, 'the fixture is a v2.3 tag, which is the case that matters');
  assert.ok(readTags(Buffer.concat([tag, Buffer.alloc(64)])).picture !== undefined);

  // The same tag, saying in its header that every frame in it was escaped.
  const escaped = Buffer.from(tag);
  escaped[5] = (escaped[5] ?? 0) | 0x80;

  assert.equal(readTags(Buffer.concat([escaped, Buffer.alloc(64)])).picture, undefined);
});
