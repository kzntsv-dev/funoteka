import { test } from 'node:test';
import assert from 'node:assert/strict';

import { id3v2, vorbisComment, type TrackTags } from '../src/tags/encode.ts';
import { readFlac } from '../src/tags/flac.ts';
import { readId3v2 } from '../src/tags/id3v2.ts';

/**
 * The tags a built file carries, read back by the readers that read the
 * collection.
 *
 * **The round trip is the whole point.** Asserting the bytes a writer produced
 * would pin this file to its own assumptions — a wrong field name and a wrong
 * reader cancel out and both tests pass. What is asserted instead is that this
 * project's own reader, which was written against the specifications and
 * measured against 274 files by the format's own author (`id3v1-suite.ts`),
 * understands what this writer wrote. A name it does not know would come back
 * under a different spelling and fail here.
 *
 * What the tags should *say* is `api-stream.test.ts`'s: this file is about the
 * two encodings, so its values are chosen to be awkward for them — Cyrillic,
 * which is what rules ID3v2.3 out; a length past one syncsafe byte; a field the
 * collection does not know, which must not be written at all.
 */

/** A song whose every field is something an encoding can get wrong. */
const SONG: TrackTags = {
  title: 'Группа крови',
  artist: 'Кино',
  albumArtist: 'Виктор Цой',
  album: 'Группа крови (2019, Maschina Records, MKK881CD, 3CD)',
  trackNumber: 1,
  discNumber: 1,
  date: '1988',
  genre: 'Post-punk',
};

/** A whole FLAC file, as far as the metadata walk is concerned: no audio. */
function flacFile(comment: Buffer): Buffer {
  const header = Buffer.from([0x04, 0x80 | 0x00, 0x00, 0x00]);
  header.writeUIntBE(comment.length, 1, 3);
  return Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    // Section 8.2: the stream information is first and must be there. Its body
    // is zeros — the walk reads it for a rate and a length, and neither is what
    // this file is asking about.
    Buffer.from([0x00, 0x00, 0x00, 34]),
    Buffer.alloc(34),
    header,
    comment,
  ]);
}

test('a Vorbis comment is read back by this project’s FLAC reader', () => {
  const read = readFlac(flacFile(vorbisComment(SONG)));
  const found = Object.fromEntries(read.tags.map((tag) => [tag.name, tag.value]));

  assert.deepEqual(found, {
    title: 'Группа крови',
    artist: 'Кино',
    albumartist: 'Виктор Цой',
    album: 'Группа крови (2019, Maschina Records, MKK881CD, 3CD)',
    tracknumber: '1',
    discnumber: '1',
    date: '1988',
    genre: 'Post-punk',
  });

  // The reader folds names on the way in (Vorbis I §5.2.2 says they are
  // case-insensitive), so the writer's uppercase is not what makes this pass —
  // and a name it had never seen would arrive under its own spelling.
  assert.ok(read.tags.every((tag) => tag.name === tag.name.toLowerCase()));
});

test('a field the collection does not know is left out, not written empty', () => {
  // A `TITLE=` of nothing is a claim that the song has no title; a missing one
  // is a file that never said. The two are different, and only one of them is
  // true here.
  const read = readFlac(
    flacFile(vorbisComment({ ...SONG, artist: null, genre: '', date: null })),
  );
  const names = read.tags.map((tag) => tag.name);

  assert.ok(names.includes('title'));
  assert.ok(!names.includes('artist'), 'a null is not written');
  assert.ok(!names.includes('genre'), 'and neither is an empty string');
  assert.ok(!names.includes('date'));
});

test('an ID3v2 tag is read back by this project’s ID3 reader', () => {
  const read = readId3v2(id3v2(SONG));
  const found = Object.fromEntries(read.tags.map((tag) => [tag.name, tag.value]));

  assert.deepEqual(found, {
    title: 'Группа крови',
    artist: 'Кино',
    albumartist: 'Виктор Цой',
    album: 'Группа крови (2019, Maschina Records, MKK881CD, 3CD)',
    tracknumber: '1',
    discnumber: '1',
    date: '1988',
    genre: 'Post-punk',
  });
  assert.equal(read.container, 'id3v2', 'and the bytes name their own container');
});

test('the tag is version 2.4, which is the one that can hold this collection', () => {
  // 2.3 has latin1 and UTF-16 and no UTF-8, so a Cyrillic title would need a
  // byte-order mark and a reader willing to guess the endianness — which is the
  // guess `id3v2.ts` spends a page explaining. The version byte is asserted
  // because it is the fact the rest of the encoding hangs on: 2.4's frame sizes
  // are syncsafe and 2.3's are not.
  const tag = id3v2(SONG);
  assert.equal(tag.subarray(0, 3).toString('latin1'), 'ID3');
  assert.equal(tag[3], 4);
  assert.equal(tag[4], 0);

  // Every frame's size is four bytes of seven bits — the top bit of each clear,
  // so no byte of a size can be read as a frame sync.
  const syncsafe = (at: number): number =>
    ((tag[at] ?? 0) << 21) | ((tag[at + 1] ?? 0) << 14) | ((tag[at + 2] ?? 0) << 7) | (tag[at + 3] ?? 0);
  let at = 10;
  let frames = 0;
  const end = 10 + syncsafe(6);
  while (at < end) {
    assert.ok((tag[at + 4] ?? 0) < 0x80, 'the size starts below the top bit');
    at += 10 + syncsafe(at + 4);
    frames += 1;
  }
  assert.equal(at, end, 'the frames fill the tag exactly');
  assert.equal(frames, 8);
  assert.equal(end, tag.length);
});
