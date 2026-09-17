import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readTags } from '../src/tags/read.ts';
import { cp1251, mp4 } from './helpers/bytes.ts';

test('a value the tagger wrote in CP1251 is read as text, with the call recorded', () => {
  // The `data` atom declares its payload UTF-8, and a declaration is a hint to
  // verify rather than an answer — the same lie an ID3 encoding byte tells,
  // written by the same rippers. Read with a bare `TextDecoder` the value came
  // out as mojibake and was stored as fact, and nothing anywhere recorded that
  // a call had been made at all.
  const bytes = mp4({ rawTags: { '©ART': [cp1251('Аквариум')] } });

  const result = readTags(bytes);
  assert.deepEqual(result.tags, [{ name: 'artist', value: 'Аквариум' }]);
  assert.equal(result.encoding?.encoding, 'windows-1251');
  assert.ok((result.encoding?.confidence ?? 1) < 1, 'a guess must not be reported as certain');
});

test('a value that really is UTF-8 is certain', () => {
  // The other half: the detector must not turn a clean read into a finding.
  const bytes = mp4({ tags: { '©nam': 'Green Desert' } });

  assert.equal(readTags(bytes).encoding?.confidence, 1);
});

test('bytes that are not text are not stored as a value', () => {
  // Same judgement the other two readers make, and for the same reason: a value
  // of control characters is not a value, and splitting it on the NULs it is
  // full of turns one broken atom into a dozen one-character tags that then
  // outrank a readable folder name.
  const bytes = mp4({ rawTags: { '©nam': [Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])] } });
  const result = readTags(bytes);

  assert.deepEqual(result.tags, []);
  assert.ok(result.encoding !== null, 'the call that was made is still a finding');
});

test('a rating written as a number is read as the number it is', () => {
  // `rtng` is one byte with a data type of its own, and neither numeric path
  // above reads it: `trkn` and `disk` are a number *and its total*, so a
  // one-byte atom fails that branch's length check and is dropped without a
  // word. Which is what every `rtng` in this collection got — nothing read it,
  // so `explicitStatus` had nothing to answer from (task:2866).
  assert.deepEqual(readTags(mp4({ integers: { rtng: 1 } })).tags, [{ name: 'rtng', value: '1' }]);
  assert.deepEqual(readTags(mp4({ integers: { rtng: 4 } })).tags, [{ name: 'rtng', value: '4' }]);
});

test('an m4a states its length in mvhd', () => {
  // Two numbers and a division, the way FLAC's STREAMINFO is — and the reason
  // a third of the collection can stop showing `--:--` without a process.
  const bytes = mp4({ timescale: 44100, duration: 441_000 });

  assert.equal(readTags(bytes).durationMs, 10_000);
});

test('the names an m4a carries arrive under the same words as everywhere else', () => {
  // `©nam` and `TIT2` are the same fact in two containers, and the stages after
  // this one ask for it by one name only.
  const bytes = mp4({
    tags: {
      '©nam': 'Green Desert',
      '©ART': 'Tangerine Dream',
      aART: 'Tangerine Dream',
      '©alb': 'Green Desert',
      '©gen': 'Ambient',
      '©day': '1986',
    },
  });

  const result = readTags(bytes);
  assert.equal(result.container, 'mp4');
  assert.deepEqual(result.tags, [
    { name: 'title', value: 'Green Desert' },
    { name: 'artist', value: 'Tangerine Dream' },
    { name: 'albumartist', value: 'Tangerine Dream' },
    { name: 'album', value: 'Green Desert' },
    { name: 'genre', value: 'Ambient' },
    { name: 'date', value: '1986' },
  ]);
});

test('trkn and disk are the binary pairs they are, not text', () => {
  // Written as two 16-bit numbers behind two leading zero bytes. Read as text
  // they are a NUL and a control character, and the number is lost.
  const bytes = mp4({ numbers: { trkn: [1, 8], disk: [2, 2] } });

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'tracknumber', value: '1/8' },
    { name: 'discnumber', value: '2/2' },
  ]);
});

test('two artists are two values, not the last one standing', () => {
  // The reason this is read here rather than asked of ffprobe, whose tag output
  // is a dictionary: a collaboration written as two `©ART` entries collapses to
  // one over there, and `file_tag` keeps a position precisely so it cannot.
  const bytes = mp4({ tags: { '©ART': ['Cock E.S.P.', 'Thirdorgan'] } });

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'artist', value: 'Cock E.S.P.' },
    { name: 'artist', value: 'Thirdorgan' },
  ]);
});

test('a cover is stepped over, not decoded', () => {
  // Artwork is most of a tag's bytes and none of its meaning. A reader that
  // walks boxes by size gets this for free; one that assumes text does not.
  const bytes = mp4({ tags: { '©nam': 'Green Desert' }, cover: true });

  assert.deepEqual(readTags(bytes).tags, [{ name: 'title', value: 'Green Desert' }]);
  assert.equal(readTags(bytes).durationMs, 10_000);
});

test('a fragmented m4a states no length, and says so rather than guessing', () => {
  // A fragmented file carries its timing in the fragments and writes zero in
  // `mvhd`. Zero is not a length, and storing it would be the quiet kind of
  // wrong — so this refuses, and ffprobe answers.
  const bytes = mp4({ fragmented: true, tags: { '©nam': 'Green Desert' } });

  const read = readTags(bytes);
  assert.equal(read.durationMs, null);
  assert.equal(read.durationRefused, true);
  assert.deepEqual(read.tags, [{ name: 'title', value: 'Green Desert' }]);
});

test('a file whose index never arrived is refused rather than guessed', () => {
  const read = readTags(mp4({ withoutMoov: true }));

  assert.equal(read.container, 'mp4');
  assert.equal(read.durationMs, null);
  assert.equal(read.durationRefused, true);
});

test('the index may sit after the audio', () => {
  // Where a fragmented file puts `moov`, and where a streamed one leaves it.
  // The walk goes by box length, so position is not a thing it can get wrong.
  const read = readTags(mp4({ fragmentsFirst: true, tags: { '©nam': 'Green Desert' } }));

  assert.equal(read.durationMs, 10_000);
  assert.deepEqual(read.tags, [{ name: 'title', value: 'Green Desert' }]);
});

test('a video is not music, whatever its extension says', () => {
  // A phone clip and an `.m4a` are the same container carrying the same `ftyp`;
  // only the track handlers tell them apart, and the extension is exactly what
  // this project refuses to believe. The kind list keeps `.mp4` out — but the
  // kind list is a name, and a video renamed `.m4a` walked straight in.
  const read = readTags(mp4({ tracks: ['vide'], tags: { '©nam': 'Not a song' } }));

  assert.equal(read.container, 'mp4', 'a format it reads, and holds no music for');
  assert.equal(read.durationMs, null);
  assert.equal(read.durationRefused, false, 'nothing here to hand to ffprobe');
  assert.deepEqual(read.tags, []);
  assert.equal(read.video, true, 'and it is the picture track that says so');
});

test('a live clip with sound in it is still a video', () => {
  // The one that actually got filed as a track: `La Route Du Rock 12 (2002
  // Live).mp4` carries a sound track, so "does it hold audio" is the wrong
  // question. "Does it hold a picture" is the right one.
  const read = readTags(mp4({ tracks: ['soun', 'vide'], tags: { '©nam': 'Live' } }));

  assert.equal(read.container, 'mp4');
  assert.deepEqual(read.tags, []);
  assert.equal(read.video, true, 'the sound track does not make it music');
});

test('bytes that only look like an mp4 are not claimed as one', () => {
  assert.equal(readTags(Buffer.from('not an mp4 at all, just words', 'utf8')).container, null);
});

test('a genre written as a number into the ID3v1 list is stored as the genre', () => {
  // iTunes writes `gnre` — and no `©gen` — for a genre it took from the ID3v1
  // list: one 16-bit value, **one-based** into that list, so 53 is Electronic
  // and 1 is Blues. 480 of the 1424 m4a files in the collection are written
  // this way, which is a third of them showing no genre at all while ffprobe
  // names one for every file.
  const read = readTags(mp4({ id3Genres: [53] }));

  assert.deepEqual(read.tags, [{ name: 'genre', value: 'Electronic' }]);
});

test('the genre numbering starts at one, so one is Blues and not Classic Rock', () => {
  // Off by one here is silent in the worst way: every genre in the collection
  // would be the next one along the list, and each would still be a real genre.
  // The rule was read off the data — all 480 files in the collection whose
  // number resolves to the name ffprobe reports do so at value - 1.
  assert.deepEqual(readTags(mp4({ id3Genres: [1] })).tags, [{ name: 'genre', value: 'Blues' }]);
  assert.deepEqual(readTags(mp4({ id3Genres: [18] })).tags, [{ name: 'genre', value: 'Rock' }]);
});

test('a genre number the list cannot answer yields no genre rather than a wrong one', () => {
  // The end of the table, asked for by number: 148 is the last name it holds
  // (Winamp's `Synthpop`) and 149 is the first it does not, so the two together
  // pin the length exactly. The test used to probe only at 200, which a table of
  // any length from 126 to 199 would have passed — an end nothing held
  // (task:2756).
  assert.deepEqual(readTags(mp4({ id3Genres: [148] })).tags, [
    { name: 'genre', value: 'Synthpop' },
  ]);
  assert.deepEqual(readTags(mp4({ id3Genres: [149] })).tags, []);
  assert.deepEqual(readTags(mp4({ id3Genres: [200] })).tags, []);
  assert.deepEqual(readTags(mp4({ id3Genres: [0] })).tags, []);
});

test('a text genre beside a numbered one is read as the text it is', () => {
  // Both forms in one file: `©gen` is a name already, and nothing about the
  // presence of `gnre` should make the reader treat it as a number too.
  const read = readTags(mp4({ tags: { '©gen': 'Trance' } }));

  assert.deepEqual(read.tags, [{ name: 'genre', value: 'Trance' }]);
});

test('an m4a states the codec its sample description names', () => {
  // The container's name says nothing about what is inside it: a `.m4a` is AAC
  // or Apple Lossless and the `stsd` entry is the only thing that says which.
  // Not reading it cost the decision path an ffprobe spawn for every one of the
  // collection's 1425 `.m4a`, on the path that answers a client (task:2910).
  //
  // `mp4a` alone is not the answer — it is the MPEG-4 audio sample entry, and
  // the object type inside `esds` is what makes it AAC.
  assert.equal(readTags(mp4({ codec: 'mp4a' })).codec, 'aac');
  assert.equal(readTags(mp4({ codec: 'alac' })).codec, 'alac');
});

test('a code the reader cannot name is left for ffprobe rather than guessed', () => {
  // Dolby on an `.m4a` is a real thing to meet, and this reader has no business
  // calling it anything. `null` is not a failure — it is the answer that sends
  // the question to something that can, which is what the decision path does
  // with a null codec.
  assert.equal(readTags(mp4({ codec: 'ac-3' })).codec, null);
});

test('an mp4 with no sample description claims no codec', () => {
  // Every other test in this file builds a file without one, and none of them
  // may start reporting a codec out of the tag atoms beside it.
  assert.equal(readTags(mp4({ tags: { '©nam': 'Green Desert' } })).codec, null);
});

test('an m4a states the rate and channels its sample entry carries', () => {
  // The same header that names the codec states both, and the decision path
  // needs them for the reason it needs the codec: `alreadyIs` cannot check a
  // client's `maxAudioChannels` against a number that is not there, so a file
  // with no channel count is transcoded whole — 2.4 seconds cold for one that
  // needed no work at all, on 1425 files (task:2910).
  const stereo = readTags(mp4({ codec: 'mp4a', sampleRate: 44_100, channels: 2 }));
  assert.equal(stereo.sampleRate, 44_100);
  assert.equal(stereo.channels, 2);

  const mono = readTags(mp4({ codec: 'alac', sampleRate: 48_000, channels: 1 }));
  assert.equal(mono.sampleRate, 48_000);
  assert.equal(mono.channels, 1);
});

test('a sample entry that states no rate states no channel count either', () => {
  // Zero is the format's way of writing "not here", and storing it would be a
  // sample rate of nothing rather than the absence of one — the same
  // distinction the rest of this reader keeps.
  const empty = readTags(mp4({ codec: 'mp4a', sampleRate: 0, channels: 0 }));
  assert.equal(empty.sampleRate, null);
  assert.equal(empty.channels, null);
});
