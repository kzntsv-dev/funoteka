import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readTags } from '../src/tags/read.ts';
import { cp1251, id3v1, id3v2, mpeg } from './helpers/bytes.ts';

/** A file with audio in it, so the tag is somewhere real rather than alone. */
function mp3(...trailing: Buffer[]): Buffer {
  return Buffer.concat([mpeg({ frames: 40, sampleRate: 44100, bitrateKbps: 128 }), ...trailing]);
}

/**
 * The same, with an ID3v2 block — which is the *first* thing in a file, where
 * the ID3v1 block is the last. Both ends at once is the shape that matters, and
 * a fixture that put the newer block after the audio would be testing a file no
 * tagger writes.
 */
function mp3WithV2(v2: Buffer, ...trailing: Buffer[]): Buffer {
  return Buffer.concat([v2, mpeg({ frames: 40, sampleRate: 44100, bitrateKbps: 128 }), ...trailing]);
}

test('an ID3v1 block at the end of an mp3 yields its fields', () => {
  const read = readTags(
    mp3(id3v1({ title: 'A Song', artist: 'An Artist', album: 'An Album', year: '1997', comment: 'a note', genre: 17 })),
  );

  assert.deepEqual(read.tags, [
    { name: 'title', value: 'A Song' },
    { name: 'artist', value: 'An Artist' },
    { name: 'album', value: 'An Album' },
    { name: 'date', value: '1997' },
    { name: 'comment', value: 'a note' },
    { name: 'genre', value: 'Rock' },
  ]);
  // The tag block is what was found at this end of the file, and the audio
  // behind it is still an MPEG stream — the two are different questions, which
  // is what lets the delivery layer keep playing the file as it stands.
  assert.equal(read.container, 'id3v1');
  assert.equal(read.codec, 'mp3');
  // The genre is a name because the table answers it, and `17` is Rock.
  assert.equal(read.durationRefused, false);
});

test('an ID3v1.1 block states a track number, and v1.0 does not', () => {
  const tracked = readTags(mp3(id3v1({ version: '1.1', title: 'T', track: 12 })));
  assert.deepEqual(tracked.tags.find((tag) => tag.name === 'tracknumber'), {
    name: 'tracknumber',
    value: '12',
  });

  // The same bytes with a track of zero are a v1.0 tag: the format has no way
  // to tell them apart, and neither does any reader.
  const untracked = readTags(mp3(id3v1({ title: 'T' })));
  assert.equal(untracked.tags.find((tag) => tag.name === 'tracknumber'), undefined);
});

test('a field ends at its first NUL, and space padding comes off', () => {
  // The suite has a whole pair of cases for this, and states the expectation in
  // words: junk after the terminator "should not show up for the user". The
  // other padding is spaces, which is what taggers other than that suite's
  // generator write — and it has to come off *after* the NUL is honoured, or a
  // tag holding `"112\0"` would read as three digits and pass a year check.
  const read = readTags(
    mp3(id3v1({ raw: { title: Buffer.from('12345\0\0\0junk', 'latin1') }, title: undefined })),
  );
  assert.equal(read.tags.find((tag) => tag.name === 'title')?.value, '12345');

  const padded = readTags(mp3(id3v1({ raw: { artist: Buffer.from('A Band      ', 'latin1') } })));
  assert.equal(padded.tags.find((tag) => tag.name === 'artist')?.value, 'A Band');
});

test('a year that is not four digits is refused, and the refusal is said', () => {
  // Two shapes, both of them the suite's own failure cases: `"   3"` (space
  // padding around a one-digit year) and `"112\0"` (three digits and a
  // terminator). A reader that trimmed the padding before honouring the NUL
  // would read the second as `112` and file it as a year.
  for (const bytes of [Buffer.from('   3', 'latin1'), Buffer.from('112\0', 'latin1')]) {
    const read = readTags(mp3(id3v1({ raw: { year: bytes } })));

    assert.equal(read.tags.find((tag) => tag.name === 'date'), undefined, `${JSON.stringify(bytes)} is not a year`);
    // Silence is the thing the contract forbids: the field was read in order to
    // be refused, so the refusal has to travel out.
    assert.equal(read.refusals?.length, 1);
    assert.match(read.refusals?.[0] ?? '', /not four digits/);
  }
});

test('a year field of nothing states nothing, and is not a refusal', () => {
  // The one place this reader knowingly parts company with the suite, which
  // lists a NULL year among the cases that "should generate a decoding failure".
  // A field of NULs is not a value that was read and could not be used — there
  // is no value in it — and an mp3 whose tagger left the year empty is an
  // ordinary file rather than a damaged one. Following the suite here would file
  // a finding against every untagged year in the collection, which is the
  // aggregate mistake `tag-format-unknown` exists to avoid. The conformance tool
  // reports the divergence rather than hiding it.
  const read = readTags(mp3(id3v1({ raw: { year: Buffer.alloc(4) } })));

  assert.equal(read.tags.find((tag) => tag.name === 'date'), undefined);
  assert.equal(read.refusals, undefined);
});

test('the ends of the year range are years', () => {
  // `0000` and `9999` are the suite's boundary cases, and it puts them among the
  // ones a reader must *accept* — a year parser that checked a range instead of
  // a shape would throw both away while passing every ordinary file.
  for (const year of ['0000', '9999']) {
    const read = readTags(mp3(id3v1({ year })));
    assert.equal(read.tags.find((tag) => tag.name === 'date')?.value, year);
    assert.equal(read.refusals, undefined);
  }
});

test('a genre byte the list does not name is refused, not invented', () => {
  // The suite's own boundary: 0..79 are safe, 80..147 are a later extension,
  // and 148 and up are a decoding failure. `genres.ts` stops at 147 because the
  // sources stop there, so the same boundary falls out of the table — and a byte
  // past it is refused rather than guessed at.
  const known = readTags(mp3(id3v1({ genre: 147 })));
  assert.equal(known.tags.find((tag) => tag.name === 'genre') !== undefined, true);

  const unknown = readTags(mp3(id3v1({ genre: 200 })));
  assert.equal(unknown.tags.find((tag) => tag.name === 'genre'), undefined);
  assert.match(unknown.refusals?.[0] ?? '', /genre 200 is not in the list/);
});

test('a magic in the wrong case is not a tag at all', () => {
  // The suite calls this a decoding failure and for a decoder reporting on one
  // file it is. A scan over a collection cannot tell a lowercase `tag` from an
  // audio frame that happened to land in those bytes, and reporting every mp3
  // without a tag as a failure is the alternative — so "no tag" is the answer,
  // and it is honest about what it knows.
  const read = readTags(mp3(id3v1({ head: 'tag', title: 'x' })));

  assert.equal(read.tags.find((tag) => tag.name === 'title'), undefined);
  assert.equal(read.container, 'mpeg', 'the audio is still understood');
});

test('v2 wins, and v1 fills only what v2 did not state', () => {
  // The case the whole design turns on, and the reason the older block is kept
  // apart instead of appended. Both blocks usually coexist — the older one is
  // what a tagger wrote for players that knew nothing else — and they routinely
  // disagree, because the writer stopped maintaining one of them years ago.
  //
  // Storing both would be read downstream as two *artists*, and this project
  // turns two artists into a collaboration: the album would be filed under
  // "V2 Band + V1 Band", a credit nobody ever recorded. So the newer block
  // answers every name it speaks, and the older one answers the rest.
  const v2 = id3v2([
    { id: 'TIT2', encoding: 3, text: Buffer.from('The Real Title', 'utf8') },
    { id: 'TPE1', encoding: 3, text: Buffer.from('The Real Artist', 'utf8') },
  ]);
  const older = id3v1({
    title: 'An Older Title',
    artist: 'An Older Artist',
    album: 'Only The Old Block Album',
    genre: 17,
  });

  const read = readTags(mp3WithV2(v2, older));

  // What the stage will write: the newer block's values...
  assert.deepEqual(read.tags.filter((tag) => tag.name === 'title'), [
    { name: 'title', value: 'The Real Title' },
  ]);
  assert.deepEqual(read.tags.filter((tag) => tag.name === 'artist'), [
    { name: 'artist', value: 'The Real Artist' },
  ]);
  // ...and the older block is handed over whole, for the stage to choose from.
  // The reader reports what the block says; which of it is *used* is the
  // stage's decision, and keeping it out of `tags` is the reader's only part in
  // it. Filtering here instead would put a second copy of the priority rule in
  // a second place, free to drift from the one in `apply.ts`.
  assert.deepEqual(read.fallbackTags, [
    { name: 'title', value: 'An Older Title' },
    { name: 'artist', value: 'An Older Artist' },
    { name: 'album', value: 'Only The Old Block Album' },
    { name: 'date', value: '2003' },
    { name: 'genre', value: 'Rock' },
  ]);
});

test('the older block is read even when the newer one has nothing to fall back for', () => {
  // A v1 block that repeats what v2 already says keeps its refusals: a field
  // read and thrown away is worth saying whatever became of the tag around it.
  const v2 = id3v2([{ id: 'TIT2', encoding: 3, text: Buffer.from('T', 'utf8') }]);
  const read = readTags(
    mp3WithV2(v2, id3v1({ title: 'T', raw: { year: Buffer.from('   3', 'latin1') } })),
  );

  assert.match(read.refusals?.[0] ?? '', /not four digits/);
});

test('a file with no ID3v1 block is unchanged', () => {
  const before = readTags(mp3());
  assert.equal(before.container, 'mpeg');
  assert.deepEqual(before.tags, []);
  assert.equal(before.fallbackTags, undefined);
  assert.equal(before.refusals, undefined);
});

test('a tag in a code page nothing declares is decoded, and the call is reported', () => {
  // ID3v1 predates any convention about encoding — the suite has a category of
  // cases for exactly that — so a Russian rip's tag is as likely to be CP1251 as
  // Latin-1, and the two are the same bytes. Nothing in the block declares
  // which, which is why the *verdict* travels out beside the text.
  const read = readTags(
    mp3(id3v1({ title: undefined, raw: { title: cp1251('Аквариум') } })),
  );

  assert.equal(read.tags.find((tag) => tag.name === 'title')?.value, 'Аквариум');
  assert.equal(read.encoding?.encoding, 'windows-1251');
  assert.ok((read.encoding?.confidence ?? 1) < 1, 'a guess must not be reported as certain');
});

test('a tag whose text really is utf-8 is reported as certain', () => {
  const read = readTags(
    mp3(id3v1({ raw: { title: Buffer.from('räksmörgås', 'utf8') } })),
  );

  assert.equal(read.tags.find((tag) => tag.name === 'title')?.value, 'räksmörgås');
  assert.equal(read.encoding?.encoding, 'utf-8');
  assert.equal(read.encoding?.confidence, 1);
});
