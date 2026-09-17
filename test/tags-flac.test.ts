import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readTags } from '../src/tags/read.ts';
import { cp1251, flac, pictureBlock } from './helpers/bytes.ts';

test('a FLAC stream yields its Vorbis comments, names folded', () => {
  const bytes = flac({ tags: { TITLE: 'Green Desert', ARTIST: 'Tangerine Dream' } });

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'title', value: 'Green Desert' },
    { name: 'artist', value: 'Tangerine Dream' },
  ]);
});

test('a comment repeated keeps every value, in order', () => {
  // Vorbis says a field may appear more than once; taking only the first would
  // silently drop a collaborator.
  const bytes = flac({ tags: { ARTIST: ['Cock E.S.P.', 'Thirdorgan'] } });

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'artist', value: 'Cock E.S.P.' },
    { name: 'artist', value: 'Thirdorgan' },
  ]);
});

test('the encoding a comment was read as is reported, not only its text', () => {
  // Vorbis comments are UTF-8 by specification and this one is not: CP1251
  // bytes from a ripper that ignored the spec. Either reading yields something
  // that looks like a title, which is exactly why the *call* has to be
  // reported rather than left implicit in the text.
  const bytes = flac({
    rawComments: [Buffer.concat([Buffer.from('ARTIST=', 'latin1'), cp1251('Аквариум')])],
  });
  const result = readTags(bytes);

  assert.equal(result.encoding?.encoding, 'windows-1251');
  assert.ok((result.encoding?.confidence ?? 1) < 1, 'a guess must not be reported as certain');
});

test('a comment that really is utf-8 is reported as certain', () => {
  const result = readTags(flac({ tags: { TITLE: 'Green Desert' } }));

  assert.equal(result.encoding?.encoding, 'utf-8');
  assert.equal(result.encoding?.confidence, 1);
});

test('one guessed value makes the whole file a guess', () => {
  // A file is only as certain as its shakiest string. Reporting the clean
  // value would hide the mangled one sitting right beside it.
  const bytes = flac({
    tags: { TITLE: 'Green Desert' },
    rawComments: [Buffer.concat([Buffer.from('ARTIST=', 'latin1'), cp1251('Аквариум')])],
  });

  assert.equal(readTags(bytes).encoding?.encoding, 'windows-1251');
});

test('a file with no text at all reports no encoding', () => {
  // Nothing was decoded, so there is no call to report — which is a different
  // answer from a call that happened to be certain.
  assert.equal(readTags(flac()).encoding, null);
});

test('a comment that is not text is not stored as a value', () => {
  // The same rule as the ID3 side, and in one place: bytes that decode to
  // mostly control characters are not a title, whatever declared them.
  const garbage = Buffer.from('00002501ff00fe470072006500610074', 'hex');
  const bytes = flac({
    rawComments: [Buffer.concat([Buffer.from('TITLE=', 'latin1'), garbage])],
  });

  assert.deepEqual(readTags(bytes).tags, []);
});

test('duration comes from STREAMINFO, without a decoder or a process', () => {
  // 44100 frames a second; 2_100_000 samples is 47.62 seconds.
  const bytes = flac({ sampleRate: 44100, totalSamples: 2_100_000 });

  assert.equal(readTags(bytes).durationMs, 47_619);
});

test('channels and bits per sample are stored minus one, and read back whole', () => {
  // The format's own off-by-one: a header saying 1 and 15 means two channels at
  // sixteen bits. A reader that forgot to add one would report mono 15-bit
  // audio for every stereo file in the collection, and nothing would complain.
  const bytes = flac({ channels: 2, bitsPerSample: 16 });
  const result = readTags(bytes);

  assert.equal(result.channels, 2);
  assert.equal(result.bitsPerSample, 16);
  assert.equal(result.sampleRate, 44100);
});

test('mono is reported as one channel, not as none', () => {
  const result = readTags(flac({ channels: 1 }));
  assert.equal(result.channels, 1);
});

test('a field name the file wrote in another encoding does not take its value with it', () => {
  // RFC 9639 §8.6 restricts a field name to U+0020..U+007E, and this file breaks
  // that rule: the name is CP1251, as plenty of Russian rippers wrote them. The
  // value behind it is ordinary text and belongs to the file either way — a
  // reader that refused the name and threw the entry away would be reporting
  // that this track says nothing about itself, which is untrue.
  const bytes = flac({
    rawComments: [Buffer.concat([cp1251('НАЗВАНИЕ'), Buffer.from('='), Buffer.from('Аквариум')])],
  });

  assert.deepEqual(readTags(bytes).tags, [{ name: 'название', value: 'Аквариум' }]);
});

test('a name that had to be decoded is an inference, and is reported as one', () => {
  // The name's bytes are CP1251 and the value's are UTF-8, so the file really
  // does contain a CP1251 string. Filing no verdict at all would say "nothing
  // here needed reading", which is the one answer that is certainly wrong.
  const bytes = flac({
    rawComments: [Buffer.concat([cp1251('НАЗВАНИЕ'), Buffer.from('='), Buffer.from('Аквариум')])],
  });

  assert.equal(readTags(bytes).encoding?.encoding, 'windows-1251');
});

test('a name carrying a control character is kept as the file wrote it', () => {
  // Deliberate, and worth pinning: the RFC forbids this name, and enforcing the
  // RFC here would mean either dropping the field or renaming it — both losing
  // what the file said. A name nothing downstream matches is inert; a value
  // thrown away is not. What is *not* done is pretending it is a name: it is
  // stored exactly as it arrived.
  const bytes = flac({
    rawComments: [Buffer.from('\x01TITLE=Green Desert', 'latin1')],
  });

  assert.deepEqual(readTags(bytes).tags, [{ name: '\x01title', value: 'Green Desert' }]);
});

test('an entry with no equals sign states no name and no value, and yields neither', () => {
  // The one shape that is dropped outright, and the reason is that there is
  // nothing to keep: RFC 9639 §8.6 defines a field as a name, an `=`, and the
  // contents, so an entry with no separator never had a value to lose.
  const bytes = flac({ rawComments: [Buffer.from('JUSTAWORD', 'latin1')] });

  assert.deepEqual(readTags(bytes).tags, []);
});

test('a Vorbis comment that is not UTF-8 is decoded, not dropped', () => {
  const bytes = flac({
    rawComments: [Buffer.concat([Buffer.from('ARTIST='), cp1251('Аквариум')])],
  });

  assert.deepEqual(readTags(bytes).tags, [{ name: 'artist', value: 'Аквариум' }]);
});

test('a truncated stream yields what it holds and never throws', () => {
  // A half-copied file is a fact of a collection, not an exception.
  const whole = flac({ tags: { TITLE: 'Green Desert' } });
  const cut = whole.subarray(0, 12);

  assert.deepEqual(readTags(cut).tags, []);
});

test('bytes that are not a FLAC stream are not a FLAC stream', () => {
  assert.deepEqual(readTags(Buffer.from('not audio at all, just words', 'utf8')).tags, []);
  assert.deepEqual(readTags(Buffer.alloc(0)).tags, []);
});

test('a picture carried as a comment is a picture, not a tag', () => {
  // The same comment name an Ogg file uses, in the other container that can
  // carry it. A FLAC normally puts its art in a PICTURE block, so this is the
  // rarer form — but the comment list is read by one piece of code for both
  // containers now, and a rule that applied in one of them would be a file that
  // reads correctly in an Ogg and wrongly in a FLAC.
  const bytes = flac({
    tags: { TITLE: 'Green Desert' },
    rawComments: [Buffer.from(`METADATA_BLOCK_PICTURE=${pictureBlock({ mime: 'image/png' }).toString('base64')}`, 'latin1')],
  });
  const read = readTags(bytes);

  assert.deepEqual(read.tags, [{ name: 'title', value: 'Green Desert' }]);
  assert.equal(read.picture?.mime, 'image/png');
  // The comment block is contiguous in a FLAC, but the image inside it is base64
  // rather than bytes, so it is still not a range a client could be sent.
  assert.equal(read.picture?.indirect, true);
});
