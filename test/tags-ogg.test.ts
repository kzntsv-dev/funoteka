import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readTags } from '../src/tags/read.ts';
import { oggPicture } from '../src/tags/ogg.ts';
import { cp1251, ogg, oggCrc } from './helpers/bytes.ts';

test('an Ogg file yields its Vorbis comments, names folded', () => {
  const bytes = ogg({ tags: { TITLE: 'Не покидай меня', ARTIST: 'ПолнаЛюбви' } });

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'title', value: 'Не покидай меня' },
    { name: 'artist', value: 'ПолнаЛюбви' },
  ]);
});

test('the reader says which container and which codec it found', () => {
  // Two different questions, and the difference is the whole point of the two
  // fields: an `.ogg` is one container whether it holds Vorbis or Opus, and only
  // the codec decides whether a browser plays it as it stands.
  const vorbis = readTags(ogg({ tags: { TITLE: 'x' } }));
  assert.equal(vorbis.container, 'ogg');
  assert.equal(vorbis.codec, 'vorbis');

  const opus = readTags(ogg({ codec: 'opus', tags: { TITLE: 'x' } }));
  assert.equal(opus.container, 'ogg');
  assert.equal(opus.codec, 'opus');
});

test('the length is the last page granule, not the first one', () => {
  // The trap this reader exists to avoid. A Vorbis granule is the running count
  // of PCM samples up to the last packet a page finishes (Vorbis I §A.2), so
  // the *first* audio page states a third of a three-page song. A reader that
  // took the first granule it found would report a length three times too short
  // and nothing downstream would have anything to compare it against.
  const read = readTags(ogg({ sampleRate: 44100, granule: 44100 * 3, audioPages: 3 }));

  assert.equal(read.durationMs, 3000);
  assert.equal(read.durationRefused, false);
});

test('the sample rate and channel count come out of the identification header', () => {
  const read = readTags(ogg({ sampleRate: 48000, channels: 1, tags: { TITLE: 'x' } }));

  assert.equal(read.sampleRate, 48000);
  assert.equal(read.channels, 1);
  // Vorbis is lossy: there is no bit depth anywhere in the stream to report.
  assert.equal(read.bitsPerSample, null);
});

test('an Opus file is measured in its own units, with the pre-skip taken off', () => {
  // RFC 7845 §4: an Opus granule counts 48 kHz samples whatever the encoder was
  // fed, and §4.3 gives one formula for the length — the granule *minus the
  // pre-skip*, which is decoder padding rather than audio. Ignoring either half
  // gives a number that is wrong by a plausible-looking amount: 312 samples of
  // padding is 6.5 ms, and reading the granule as if it were the input rate is
  // wrong by whatever the resampler was handed.
  const read = readTags(
    ogg({
      codec: 'opus',
      sampleRate: 44100,
      inputSampleRate: 44100,
      preSkip: 312,
      granule: 48000 * 3 + 312,
    }),
  );

  assert.equal(read.codec, 'opus');
  assert.equal(read.durationMs, 3000);
  // §5.1 is explicit that the input rate is *not* the rate the file plays at,
  // so the rate reported is the one the granule is counted in.
  assert.equal(read.sampleRate, 48000);
});

test('a comment header that spans pages is reassembled, not truncated', () => {
  // Vorbis I §5.2.1 makes the comment packet a list that may cross page
  // boundaries, and §5 of RFC 3533 makes that happen through the segment table:
  // a segment of 255 says "more of this packet follows", on this page or the
  // next. A reader that took a page's body as a packet would read half a tag
  // and call the rest garbage.
  const bytes = ogg({
    segmentsPerPage: 4,
    tags: { TITLE: 'a name long enough to cross a page', ARTIST: 'someone' },
  });

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'title', value: 'a name long enough to cross a page' },
    { name: 'artist', value: 'someone' },
  ]);
});

test('a page no packet finishes on states no granule, and does not shorten the song', () => {
  // RFC 3533 §6 sets the granule to -1 exactly when no packet completes on the
  // page — which is the normal state of a page a long packet is still crossing.
  // Read as a number it is 18446744073709551615, and a length computed from it
  // is not a length. The spanning fixture above produces such pages; this checks
  // that they are stepped over rather than counted.
  const bytes = ogg({ segmentsPerPage: 4, sampleRate: 44100, granule: 44100 * 2, audioPages: 2 });
  const read = readTags(bytes);

  assert.equal(read.durationMs, 2000);
});

test('a file cut off before any audio page refuses a length rather than inventing one', () => {
  // Headers and nothing behind them: the stream was understood and its length is
  // nowhere in it. That is the answer worth handing to ffprobe, and it is not
  // the same as a file whose format nothing recognised.
  const read = readTags(ogg({ tags: { TITLE: 'x' }, withoutAudio: true }));

  assert.equal(read.tags.length, 1);
  assert.equal(read.durationMs, null);
  assert.equal(read.durationRefused, true);
});

test('a granule of -1 on the last page is not read as a length', () => {
  // The final page can carry -1 too — a stream cut inside a packet, or one whose
  // last page holds nothing that finishes. The length then stands at the last
  // page that *did* state one, and a reader that took the -1 would file
  // 18446744073709551615 samples.
  const bytes = ogg({ sampleRate: 44100, granule: 44100 * 2, audioPages: 2 });
  const damaged = withLastGranuleMinusOne(bytes);

  const read = readTags(damaged);

  assert.equal(read.durationMs, 1000, 'the page before the damaged one states the length');
});

test('another logical stream spliced between the pages is stepped over', () => {
  // RFC 3533 §6 numbers pages per logical bitstream, so an Ogg file may carry
  // several interleaved — a video track beside the audio. The packets of one are
  // not the packets of another, and a reader that ignored the serial number
  // would take the other stream's first packet as this one's comment header.
  const bytes = ogg({ tags: { TITLE: 'Green Desert', ARTIST: 'Tangerine Dream' }, interleave: true });

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'title', value: 'Green Desert' },
    { name: 'artist', value: 'Tangerine Dream' },
  ]);
});

test('a comment that is not UTF-8 is decoded, not dropped', () => {
  // Vorbis comments are UTF-8 by specification (Vorbis I §5.2.2) and this one is
  // not: CP1251 bytes from a ripper that ignored the spec. Both readings produce
  // something that looks like an artist, which is why the *call* is reported.
  const bytes = ogg({
    rawComments: [Buffer.concat([Buffer.from('ARTIST=', 'latin1'), cp1251('Аквариум')])],
  });
  const read = readTags(bytes);

  assert.equal(read.tags[0]?.value, 'Аквариум');
  assert.equal(read.encoding?.encoding, 'windows-1251');
  assert.ok((read.encoding?.confidence ?? 1) < 1, 'a guess must not be reported as certain');
});

test('a cover carried as a comment is a picture, not a name and a value', () => {
  // The trap this reader fell into first: a `METADATA_BLOCK_PICTURE` comment
  // arrives as one more `NAME=value`, so it left as one more tag — and the
  // eighty files of the collection put nineteen and a half megabytes of base64
  // into `file_tag`, one of them in a single value of 562 KB. Read as a tag it
  // is a name nothing looks up; read as what it is, it is the record's cover.
  const read = readTags(ogg({ tags: { TITLE: 'x' }, picture: { mime: 'image/jpeg' } }));

  assert.deepEqual(read.tags, [{ name: 'title', value: 'x' }]);
  assert.equal(read.picture?.mime, 'image/jpeg');
  assert.equal(read.picture?.kind, 3, 'a front cover, as the block states');
});

test('the picture is named by a region, because its bytes are not a range', () => {
  // Base64 inside a packet the lacing rule spreads across pages: there is no run
  // of the file whose bytes are the image, so what is recorded is a region worth
  // reading. Saying `indirect` is what stops the delivery layer sending a client
  // three hundred kilobytes of base64 and calling it a JPEG.
  const read = readTags(ogg({ picture: {} }));

  assert.equal(read.picture?.indirect, true);
  assert.equal(read.picture?.offset, 0);
  assert.ok(read.picture !== undefined && read.picture.length > 0);
});

test('the picture can be derived again from the region the reader named', () => {
  // The whole bargain of an indirect picture: the scan writes down where to look
  // and nothing else, and the bytes are derived on demand. That only works if
  // the derivation agrees with the reading — which is why the region has to be
  // enough on its own, and why `oggPicture` walks the same pages the reader did.
  const data = Buffer.from('a cover, of a sort', 'utf8');
  const bytes = ogg({ tags: { TITLE: 'x' }, picture: { mime: 'image/png', data } });

  const read = readTags(bytes);
  const region = bytes.subarray(
    read.picture?.offset ?? 0,
    (read.picture?.offset ?? 0) + (read.picture?.length ?? 0),
  );

  const derived = oggPicture(region);
  assert.equal(derived?.mime, 'image/png');
  assert.deepEqual(Buffer.from(derived?.data ?? []), data);
});

test('a packet past the size any header can be is dropped, and the length is not', () => {
  // The bound on how much this reader will assemble, and what it costs. A file
  // can be built whose second packet never finishes — page after page of
  // 255-value lacing — and a walk that collects until a packet ends holds every
  // segment and then copies the lot; measured on a 60 MB file of that shape,
  // 246,725 pieces and a second 60 MB allocation for a file with no tags in it.
  //
  // So a packet that grows past anything a header could be is abandoned, and
  // this is what that costs: a file whose comment really is that large loses its
  // tags. What it does not lose is its length, and that half is the point —
  // abandoning a packet must not end the walk, because the granule comes from
  // pages that have nothing to do with it.
  const read = readTags(
    ogg({
      tags: { TITLE: 'x', COMMENT: 'y'.repeat(17 * 1024 * 1024) },
      sampleRate: 44100,
      granule: 44100 * 2,
      audioPages: 2,
    }),
  );

  assert.deepEqual(read.tags, [], 'the packet was abandoned rather than assembled');
  assert.equal(read.durationMs, 2000, 'and the pages were still walked for the granule');
});

test('a file with no comments is understood and empty, not unrecognised', () => {
  // A Vorbis stream with an empty comment list is an ordinary untagged rip. Its
  // container is known and its length is known; only its names are missing, and
  // reporting it as a format this project cannot read would be a lie about it.
  const read = readTags(ogg({}));

  assert.deepEqual(read.tags, []);
  assert.equal(read.container, 'ogg');
  assert.equal(read.durationMs, 3000);
});

test('a comment entry with no separator is passed over', () => {
  // §5.2.2 defines a field as a name, an `=`, and the contents. An entry with no
  // `=` never named anything, so there is no value being lost by skipping it —
  // and taking the whole entry as a name would file a sentence where a tag goes.
  const bytes = ogg({ rawComments: [Buffer.from('not a field at all', 'utf8')] });

  assert.deepEqual(readTags(bytes).tags, []);
});

test('bytes that are not Ogg at all are not claimed as Ogg', () => {
  const read = readTags(Buffer.from('this is not a music file, it is a note', 'utf8'));

  assert.equal(read.container, null);
  assert.equal(read.codec, null);
});

/**
 * Set the last page's granule to -1, and repair its checksum.
 *
 * Written here rather than as a fixture option, and it walks the page chain the
 * way any reader does: the point of the test is the *reader's* handling of a
 * page that finishes nothing, so the page has to be a real one that a real
 * decoder would accept. A fixture that could emit -1 on demand would be a second
 * implementation of the lacing rule, free to disagree with the first.
 */
function withLastGranuleMinusOne(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes);
  let at = 0;
  let last = 0;
  while (at + 27 <= copy.length && copy.subarray(at, at + 4).toString('latin1') === 'OggS') {
    last = at;
    const segments = copy[at + 26] as number;
    let body = 0;
    for (let i = 0; i < segments; i += 1) body += copy[at + 27 + i] as number;
    at += 27 + segments + body;
  }

  copy.writeBigInt64LE(-1n, last + 6);
  copy.writeUInt32LE(0, last + 22);
  copy.writeUInt32LE(oggCrc(copy.subarray(last, at)), last + 22);
  return copy;
}
