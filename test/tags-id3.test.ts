import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deflateSync } from 'node:zlib';

import { resolveGenre } from '../src/tags/genres.ts';
import { readTags } from '../src/tags/read.ts';
import { cp1251, id3Text, id3v2, synchsafe } from './helpers/bytes.ts';

test('a declaration contradicted by the bytes is reported as the guess it is', () => {
  // The frame says latin-1; the bytes underneath are CP1251. The decoder trusts
  // neither the declaration nor the bytes alone, and the file carries the call.
  const bytes = id3v2([{ id: 'TPE1', encoding: 0, text: cp1251('Аквариум') }]);
  const result = readTags(bytes);

  assert.equal(result.encoding?.encoding, 'windows-1251');
  assert.deepEqual(result.tags, [{ name: 'artist', value: 'Аквариум' }]);
  assert.ok((result.encoding?.confidence ?? 1) < 1, 'a guess must not be reported as certain');
});

test('a frame that is honestly declared is certain', () => {
  const bytes = id3v2([{ id: 'TIT2', encoding: 0, text: Buffer.from('Green Desert', 'latin1') }]);

  assert.equal(readTags(bytes).encoding?.confidence, 1);
});

test('an ID3 tag with nothing readable reports no encoding', () => {
  // An empty tag decoded no text, so there is no call to report.
  assert.equal(readTags(id3v2([])).encoding, null);
});

test('a frame that is not text is not stored as a value', () => {
  // Bytes taken verbatim from a real rip in the collection: the frame declares
  // latin-1 and holds what is really an unsynchronised UTF-16 blob. Read as
  // declared it decodes to control characters and NULs — and splitting that on
  // NULs would turn one broken frame into a dozen one-character "titles",
  // which then outrank a perfectly readable folder name.
  const garbage = Buffer.from('00002501ff00fe470072006500610074', 'hex');
  const bytes = id3v2([{ id: 'TALB', encoding: 0, text: garbage }]);
  const result = readTags(bytes);

  assert.deepEqual(result.tags, []);
});

test('a frame that is not text is not reported as certain either', () => {
  // Dropping the value must not also drop the finding: the file's tags are
  // malformed, and that is worth saying rather than quietly swallowing.
  const garbage = Buffer.from('00002501ff00fe470072006500610074', 'hex');
  const result = readTags(id3v2([{ id: 'TALB', encoding: 0, text: garbage }]));

  assert.ok((result.encoding?.confidence ?? 1) < 1, 'a body that is not text is not a certain read');
});

test('an ID3v2 tag yields the frames that name things', () => {
  const bytes = id3v2([
    { id: 'TIT2', encoding: 3, text: id3Text(3, 'Green Desert') },
    { id: 'TPE1', encoding: 3, text: id3Text(3, 'Tangerine Dream') },
    { id: 'TALB', encoding: 3, text: id3Text(3, 'Green Desert') },
    { id: 'TRCK', encoding: 3, text: id3Text(3, '2/3') },
  ]);

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'title', value: 'Green Desert' },
    { name: 'artist', value: 'Tangerine Dream' },
    { name: 'album', value: 'Green Desert' },
    { name: 'tracknumber', value: '2/3' },
  ]);
});

test('an encoding byte that lies about the bytes is caught, not obeyed', () => {
  // Byte 0 claims Latin-1. The bytes are CP1251. Believing the claim is how
  // Russian tags turn into mojibake.
  const bytes = id3v2([{ id: 'TPE1', encoding: 0, text: cp1251('Аквариум') }]);

  assert.deepEqual(readTags(bytes).tags, [{ name: 'artist', value: 'Аквариум' }]);
});

test('a v2.4 frame is sized in seven-bit bytes, not as a plain number', () => {
  // 200 bytes of text: under a plain big-endian read the size would come out as
  // 128 * 200, and the walk would run off the end of the tag.
  const long = 'x'.repeat(200);
  const bytes = id3v2([{ id: 'TIT2', encoding: 3, text: id3Text(3, long) }], { version: 4 });

  assert.deepEqual(readTags(bytes).tags, [{ name: 'title', value: long }]);
});

test('the same frame in a v2.3 tag is sized as a plain number', () => {
  const long = 'y'.repeat(200);
  const bytes = id3v2([{ id: 'TIT2', encoding: 3, text: id3Text(3, long) }], { version: 3 });

  assert.deepEqual(readTags(bytes).tags, [{ name: 'title', value: long }]);
});

test('a v2.4 frame the writer escaped is read back whole', () => {
  // The shape every mp3 in the Cock E.S.P sample has: the frame declares
  // UTF-16, so its bytes open on the `FF FE` BOM — which a writer must escape
  // to `FF 00 FE`, or a reader hunting for a frame sync finds one. Read as
  // stored, the value starts `\u0001ÿ\u0000` and the album goes unnamed.
  const bytes = id3v2(
    [{ id: 'TALB', encoding: 1, text: id3Text(1, 'Greatest Dicks II'), unsynchronised: true }],
    { version: 4 },
  );

  assert.deepEqual(readTags(bytes).tags, [{ name: 'album', value: 'Greatest Dicks II' }]);
});

test('a tag that escaped every frame says so once, in its header', () => {
  // The header flag is not a summary of "something somewhere was escaped": the
  // spec has it mean every frame was, and forbids setting it otherwise. So a
  // frame that carries no format flags of its own is still escaped, and the
  // reader has to honour the header rather than the frame.
  const bytes = id3v2(
    [{ id: 'TIT2', encoding: 1, text: id3Text(1, 'Cockworld') }],
    { version: 4, unsynchroniseAll: true },
  );

  assert.deepEqual(readTags(bytes).tags, [{ name: 'title', value: 'Cockworld' }]);
});

test('the data length indicator is not required to escape a frame', () => {
  // The spec calls the indicator desirable, not mandatory. A reader that keyed
  // on it would drop the escape — and the text — for a writer that omitted it.
  const bytes = id3v2(
    [
      {
        id: 'TIT2',
        encoding: 1,
        text: id3Text(1, 'Maschinenwerk'),
        unsynchronised: true,
        dataLengthIndicator: false,
      },
    ],
    { version: 4 },
  );

  assert.deepEqual(readTags(bytes).tags, [{ name: 'title', value: 'Maschinenwerk' }]);
});

test('an escaped `FF 00` is a literal one, not an escaped `FF`', () => {
  // The reason the writer escapes `FF 00` to `FF 00 00` rather than leaving it:
  // in UTF-16 a literal `FF 00` is an ordinary letter (`ÿ`), and a decoder that
  // read it as an escaped `FF` would eat the letter's low byte. Both cases sit
  // in one value here — the BOM's `FF Ex`, and the letter's `FF 00`.
  const text = 'AÿB';
  const bytes = id3v2(
    [{ id: 'TALB', encoding: 1, text: id3Text(1, text), unsynchronised: true }],
    { version: 4 },
  );

  assert.deepEqual(readTags(bytes).tags, [{ name: 'album', value: text }]);
});

test('frames nothing here knows are skipped, and the rest still arrive', () => {
  const bytes = id3v2([
    { id: 'TIT2', encoding: 3, text: id3Text(3, 'Green Desert') },
    { id: 'APIC', encoding: 3, text: Buffer.from([0, 1, 2, 3, 4, 5]) },
    { id: 'TPE1', encoding: 3, text: id3Text(3, 'Tangerine Dream') },
  ]);

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'title', value: 'Green Desert' },
    { name: 'artist', value: 'Tangerine Dream' },
  ]);
});

test('padding ends the walk rather than being read as a frame', () => {
  const tag = id3v2([{ id: 'TIT2', encoding: 3, text: id3Text(3, 'Green Desert') }]);
  // A tag with room to spare is padded with zeros, which is not a frame id.
  const padded = Buffer.concat([tag, Buffer.alloc(64)]);

  assert.deepEqual(readTags(padded).tags, [{ name: 'title', value: 'Green Desert' }]);
});

test('a tag that stops mid-frame yields what it holds and never throws', () => {
  const whole = id3v2([
    { id: 'TIT2', encoding: 3, text: id3Text(3, 'Green Desert') },
    { id: 'TPE1', encoding: 3, text: id3Text(3, 'Tangerine Dream') },
  ]);

  const cut = whole.subarray(0, whole.length - 6);
  const tags = readTags(cut).tags;

  assert.deepEqual(tags[0], { name: 'title', value: 'Green Desert' });
});

test('an ID3v2 tag says nothing about duration', () => {
  // Nothing in the tag block states a length; guessing one from a frame would
  // be inventing a number.
  const bytes = id3v2([{ id: 'TIT2', encoding: 3, text: id3Text(3, 'Green Desert') }]);

  assert.equal(readTags(bytes).durationMs, null);
});

test('an ID3v2.2 tag is read, not reported as a file with no tags', () => {
  // The operator's Kroogi rips, written by iTunes 10: v2.2 names a frame with
  // three letters (`TP1`, `TAL`, `TRK`) and sizes it in three plain bytes, so
  // its frame header is six bytes where every later version uses ten. Walked as
  // a v2.3 tag, the first id comes out as `TP1\0` — not a frame id — and the
  // walk stopped there: a file with a complete, correct tag was read as having
  // none, and everything downstream believed it. ffprobe reads the same files
  // without complaint, which is how the difference was found (task:2711).
  const bytes = id3v2(
    [
      { id: 'TP1', encoding: 1, text: id3Text(1, 'Аквариум') },
      { id: 'TAL', encoding: 1, text: id3Text(1, 'Архангельск') },
      { id: 'TT2', encoding: 1, text: id3Text(1, 'Назад в Архангельск') },
      { id: 'TRK', encoding: 0, text: Buffer.from('1/9', 'latin1') },
      { id: 'TYE', encoding: 0, text: Buffer.from('2011', 'latin1') },
    ],
    { version: 2 },
  );

  const read = readTags(bytes);

  assert.equal(read.container, 'id3v2');
  assert.deepEqual(
    read.tags.map((tag) => [tag.name, tag.value]),
    [
      ['artist', 'Аквариум'],
      ['album', 'Архангельск'],
      ['title', 'Назад в Архангельск'],
      ['tracknumber', '1/9'],
      ['date', '2011'],
    ],
  );
});

test('a v2.2 frame the reader has no name for is stepped over, not fatal', () => {
  // The walk is by declared size, so an unknown frame — a picture, a frame from
  // a table this reader does not carry — costs nothing. The frames after it are
  // still read, which is the property that makes the short-header walk safe.
  const bytes = id3v2(
    [
      { id: 'PIC', encoding: 0, text: Buffer.from('not a picture really', 'latin1') },
      { id: 'TT2', encoding: 0, text: Buffer.from('After the picture', 'latin1') },
    ],
    { version: 2 },
  );

  const read = readTags(bytes);

  assert.deepEqual(
    read.tags.map((tag) => [tag.name, tag.value]),
    [['title', 'After the picture']],
  );
});

test('a genre written as a reference to the ID3v1 list is resolved', () => {
  // ID3v2.3 section 4.2.1: a genre may be written "(" number ")" from the list
  // in Appendix A, so "(17)" is not the string "(17)" — it is Rock. Storing the
  // reference would put a number where a genre belongs, and it would be the only
  // such value in the collection: a FLAC states its genre in words.
  const bytes = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('(17)', 'latin1') }]);

  assert.deepEqual(readTags(bytes).tags, [{ name: 'genre', value: 'Rock' }]);
});

test('a refinement after the reference is dropped, as every other reader drops it', () => {
  // "(52)Electronic" and "(4)Eurodisco" both name a genre and then refine it.
  // The style is the one ffprobe follows — the reference resolves and the tail
  // goes — and matching it matters more here than the refinement's few words,
  // because ffprobe is the instrument this project checks itself against.
  const electronic = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('(52)Electronic', 'latin1') }]);
  const eurodisco = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('(4)Eurodisco', 'latin1') }]);
  const several = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('(51)(39)', 'latin1') }]);

  assert.deepEqual(readTags(electronic).tags, [{ name: 'genre', value: 'Electronic' }]);
  assert.deepEqual(readTags(eurodisco).tags, [{ name: 'genre', value: 'Disco' }]);
  assert.deepEqual(readTags(several).tags, [{ name: 'genre', value: 'Techno-Industrial' }]);
});

test('a genre that already is a word is left alone', () => {
  const bytes = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('Retro', 'latin1') }]);

  assert.deepEqual(readTags(bytes).tags, [{ name: 'genre', value: 'Retro' }]);
});

test('a bare number is a reference too, which is how v2.4 writes one', () => {
  // ID3v2.4 section 4.2.3 gives the example "21" $00 "Eurodisco", so the
  // reference is the number itself rather than one in brackets.
  const bytes = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('17', 'latin1') }]);

  assert.deepEqual(readTags(bytes).tags, [{ name: 'genre', value: 'Rock' }]);
});

test('RX and CR resolve, which the specification defines and ffprobe does not', () => {
  // A deliberate difference from the second instrument. Section 4.2.1 defines
  // two content types beside the numeric ones — RX is Remix, CR is Cover — and
  // says they work the same way; v2.4 writes them without brackets. ffprobe
  // leaves both as typed, and a reader that left them too would be storing a
  // string the specification gives a meaning to.
  const remix = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('(RX)', 'latin1') }]);
  const cover = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('(CR)', 'latin1') }]);
  const bare = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('RX', 'latin1') }]);

  assert.deepEqual(readTags(remix).tags, [{ name: 'genre', value: 'Remix' }]);
  assert.deepEqual(readTags(cover).tags, [{ name: 'genre', value: 'Cover' }]);
  assert.deepEqual(readTags(bare).tags, [{ name: 'genre', value: 'Remix' }]);
});

test('a reference the list cannot answer is left as the file wrote it', () => {
  // The table ends at 147, where the sources do: the appendices stop at 125 and
  // the official test suite names 126..147 and then says "unknown". ffprobe
  // knows names past that, but they come from ffmpeg's own list, which is an
  // implementation rather than a text — so "(148)" stays a string rather than
  // becoming a number from somewhere with no source behind it.
  const beyond = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('(148)', 'latin1') }]);
  const nonsense = id3v2([{ id: 'TCON', encoding: 0, text: Buffer.from('(abc)', 'latin1') }]);

  assert.deepEqual(readTags(beyond).tags, [{ name: 'genre', value: '(148)' }]);
  assert.deepEqual(readTags(nonsense).tags, [{ name: 'genre', value: '(abc)' }]);
});

test('a v2.2 genre reference resolves the same way', () => {
  const bytes = id3v2([{ id: 'TCO', encoding: 0, text: Buffer.from('(17)', 'latin1') }], { version: 2 });

  assert.deepEqual(readTags(bytes).tags, [{ name: 'genre', value: 'Rock' }]);
});

test('a frame that says it is compressed is decompressed', () => {
  // ID3v2.4 §4.1.2: "Frame is compressed using zlib deflate method. If set,
  // this requires the 'Data Length Indicator' bit to be set as well." ffprobe
  // reads such a frame — the bytes here were handed to it and it returned the
  // title — so a reader that stored the zlib header as a title was losing a
  // value that a second instrument proves is there.
  const text = Buffer.concat([Buffer.from([0]), Buffer.from('Green Desert', 'latin1')]);
  const bytes = id3v2(
    [
      {
        id: 'TIT2',
        encoding: 0,
        text: Buffer.alloc(0),
        format: 0x09, // k compression | p data length indicator
        raw: Buffer.concat([synchsafe(text.length), deflateSync(text)]),
      },
    ],
    { version: 4 },
  );

  assert.deepEqual(readTags(bytes).tags, [{ name: 'title', value: 'Green Desert' }]);
});

test('a v2.3 compressed frame is decompressed too, ahead of its other fields', () => {
  // §3.3.1: compressed "using zlib with 4 bytes for 'decompressed size'
  // appended to the frame header", and the additions come in the order of the
  // flags %ijk00000 — so four bytes of size first. ffprobe does not implement
  // this half, so the specification is the only thing behind it.
  const text = Buffer.concat([Buffer.from([0]), Buffer.from('Green Desert', 'latin1')]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(text.length, 0);
  const bytes = id3v2(
    [
      {
        id: 'TIT2',
        encoding: 0,
        text: Buffer.alloc(0),
        format: 0x80, // i compression
        raw: Buffer.concat([size, deflateSync(text)]),
      },
    ],
    { version: 3 },
  );

  assert.deepEqual(readTags(bytes).tags, [{ name: 'title', value: 'Green Desert' }]);
});

test('a v2.4 group byte is stepped over, not read as the encoding', () => {
  // §4.1.2, flag h: "If set, a group identifier byte is added to the frame."
  // It comes before the data, so a reader that ignored it would take the group
  // for the frame's text encoding and decode the title one byte out of step.
  const bytes = id3v2(
    [
      {
        id: 'TIT2',
        encoding: 0,
        text: Buffer.alloc(0),
        format: 0x40, // h grouping
        raw: Buffer.concat([Buffer.from([0x07]), Buffer.from([0]), Buffer.from('Green Desert', 'latin1')]),
      },
    ],
    { version: 4 },
  );

  assert.deepEqual(readTags(bytes).tags, [{ name: 'title', value: 'Green Desert' }]);
});

test('an encrypted frame yields nothing rather than ciphertext as a title', () => {
  // §4.1.2, flag m: the method byte names a scheme, and this reader implements
  // none. What is behind it is ciphertext, and decoding that as text is how a
  // plausible-looking title that the file never contained gets stored.
  const bytes = id3v2(
    [
      {
        id: 'TIT2',
        encoding: 0,
        text: Buffer.alloc(0),
        format: 0x04, // m encryption
        raw: Buffer.concat([Buffer.from([0x01]), Buffer.from([0]), Buffer.from('Green Desert', 'latin1')]),
      },
    ],
    { version: 4 },
  );

  assert.deepEqual(readTags(bytes).tags, []);
});

test('a frame the reader declined is said out loud, not dropped in silence', () => {
  // The reading is right — ciphertext is not a title — and until now it was
  // invisible: a file whose frame was encrypted read exactly like a rip that
  // never had tags, and `tag-format-unknown` cannot fire for it because the
  // container *was* recognised. What the reader would not use goes up through
  // `refusals` and the stage writes it down as an issue (task:2754).
  const encrypted = id3v2(
    [
      {
        id: 'TIT2',
        encoding: 0,
        text: Buffer.alloc(0),
        format: 0x04, // m encryption
        raw: Buffer.concat([
          Buffer.from([0x01]),
          Buffer.from([0]),
          Buffer.from('Green Desert', 'latin1'),
        ]),
      },
    ],
    { version: 4 },
  );
  const read = readTags(encrypted);
  assert.deepEqual(read.tags, [], 'still nothing read out of it');
  assert.equal(read.refusals?.length, 1, 'and the refusal is carried out of the reader');
  assert.match(String(read.refusals?.[0]), /TIT2 is encrypted/);

  // A frame this reader ignores whatever it says is not a loss, and reporting it
  // would put a line on every file that carries a `PRIV` or a `GEOB`.
  const ignored = id3v2(
    [{ id: 'PRIV', encoding: 0, text: Buffer.alloc(0), format: 0x04, raw: Buffer.from([1, 2, 3]) }],
    { version: 4 },
  );
  assert.equal(readTags(ignored).refusals, undefined, 'nothing was lost, so nothing is said');

  // The tag-level case: v2.2's whole tag dropped because the spec says to, which
  // is a bigger loss than a frame and was equally silent.
  const compressed = id3v2([], { version: 2 });
  compressed[5] = (compressed[5] ?? 0) | 0x40; // v2.2 §3.1: the tag is compressed
  const whole = readTags(compressed);
  assert.deepEqual(whole.tags, []);
  assert.match(String(whole.refusals?.[0]), /marked compressed/);
});

test('the genre resolution is a pure function of the value, on every shape the spec names', () => {
  // Tested directly rather than through a frame, because the frame path adds a
  // rule this has nothing to do with: a decoded text that is mostly control
  // characters is dropped whole before anything is split, and a short
  // NUL-separated value ("21\0Eurodisco") trips it. Not one of the 700 mp3
  // files here carries a text frame with an interior NUL after its
  // unsynchronisation is removed, so the two rules have yet to meet in a real
  // file — and a test that built one would be testing the meeting, not this.
  assert.equal(resolveGenre('(17)'), 'Rock');
  assert.equal(resolveGenre('17'), 'Rock');
  assert.equal(resolveGenre('(017)'), 'Rock');
  assert.equal(resolveGenre('(52)Electronic'), 'Electronic');
  assert.equal(resolveGenre('(4)Eurodisco'), 'Disco');
  assert.equal(resolveGenre('(51)(39)'), 'Techno-Industrial');
  assert.equal(resolveGenre('(RX)'), 'Remix');
  assert.equal(resolveGenre('CR'), 'Cover');
  assert.equal(resolveGenre('(125)'), 'Dance Hall');
  assert.equal(resolveGenre('(126)'), 'Goa');
  assert.equal(resolveGenre('(147)'), 'Synthpop');
  assert.equal(resolveGenre('Retro'), 'Retro');
  assert.equal(resolveGenre('Rock (17)'), 'Rock (17)');
  assert.equal(resolveGenre('(148)'), '(148)');
  assert.equal(resolveGenre('(abc)'), '(abc)');
  assert.equal(resolveGenre('()'), '()');
  assert.equal(resolveGenre('((I can figure out any genre)'), '((I can figure out any genre)');
});

test('a short value separated by NUL is a list, not a broken frame', () => {
  // Section 4.2: "All text information frames supports multiple strings, stored
  // as a null separated list", and its own example is this shape. The guard
  // against control characters used to judge the *whole* body, so the separator
  // counted against the value it separated — one NUL in thirteen bytes is 7.7%,
  // over the 5% line — and the value was thrown away before it was ever split
  // (task:2738).
  const bytes = id3v2([
    { id: 'TCON', encoding: 3, text: Buffer.from(`21${String.fromCharCode(0)}Eurodisco`, 'utf8') },
  ]);

  assert.deepEqual(readTags(bytes).tags, [
    // '21' is ID3v1's code for Ska, and the resolver runs per part — which is
    // the other half of the same rule §4.2.1 states.
    { name: 'genre', value: 'Ska' },
    { name: 'genre', value: 'Eurodisco' },
  ]);
});

test('a body read in the wrong width is still not a list of values', () => {
  // What the guard is for, and the reason judging the *parts* is not the same as
  // giving up on it: `ABC` in UTF-16LE read one byte at a time is `A`, `B`, `C`
  // with NULs between them, and one tag per letter would outrank a folder name
  // that was readable all along. Every part a single character is that shape.
  const bytes = id3v2([
    { id: 'TIT2', encoding: 0, text: Buffer.from('410042004300', 'hex') },
  ]);

  assert.deepEqual(readTags(bytes).tags, []);
});

// The two tag-level escaping cases below are one arrangement read twice, and the
// shape that shows it is a UTF-16 frame: its BOM is `FF FE`, which the escaping
// writes `FF 00 FE` on disk. A v2.2 or v2.3 tag declares the escaping for the
// whole tag and its frame sizes count the *clean* bytes, so a reader that walks
// the stored ones steps into the middle of the next frame — which is how the
// first of these was found (task:2753). v2.4 declares it per frame and counts
// the stored bytes, so it is the second test that must not change.
const BOM_TEXT = (text: string): Buffer => id3Text(1, text);

test('a v2.3 tag that escapes its whole body is decoded before it is walked', () => {
  const bytes = id3v2(
    [
      { id: 'TIT2', encoding: 1, text: BOM_TEXT('A') },
      { id: 'TPE1', encoding: 0, text: Buffer.from('B', 'latin1') },
    ],
    { version: 3, unsynchroniseAll: true },
  );

  // Both frames, not just the escaped one: the point of the bug was that the
  // walk read the second frame from an offset the escaping had shifted.
  assert.deepEqual(readTags(bytes).tags, [
    { name: 'title', value: 'A' },
    { name: 'artist', value: 'B' },
  ]);
});

test('a v2.2 tag that escapes its whole body is decoded the same way', () => {
  // §5 of v2.2 is §5 of v2.3 in the same words, so the arrangement is the same
  // and the reader treats it the same — the ids are the only difference.
  const bytes = id3v2(
    [
      { id: 'TT2', encoding: 1, text: BOM_TEXT('A') },
      { id: 'TP1', encoding: 0, text: Buffer.from('B', 'latin1') },
    ],
    { version: 2, unsynchroniseAll: true },
  );

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'title', value: 'A' },
    { name: 'artist', value: 'B' },
  ]);
});

// The reader used to hold a table of nine frames, so what a FLAC in the same
// library kept — every field its comment block names — an mp3 dropped, and the
// meta layer could not be read across the two (task:2737). What replaced the
// table is §4.2's own rule, that text frames are the ones whose ids begin with
// `T`, and the tests below are that rule plus the two shapes the rule does not
// cover: the comment, and the date.
test('a text frame outside the old nine is kept under the standard word for it', () => {
  const bytes = id3v2([
    { id: 'TCOP', encoding: 0, text: Buffer.from('2005 EMI Records', 'latin1') },
    { id: 'TPUB', encoding: 0, text: Buffer.from('Astralwerks', 'latin1') },
    { id: 'TLAN', encoding: 0, text: Buffer.from('eng', 'latin1') },
  ]);

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'copyright', value: '2005 EMI Records' },
    { name: 'publisher', value: 'Astralwerks' },
    { name: 'language', value: 'eng' },
  ]);
});

test('a text frame the table has no word for is kept under its own identifier', () => {
  // §4.2 settles which frames are text; it does not promise this reader knows a
  // word for each of them. The file's text is text either way, and a container
  // deciding which tags exist is the defect being closed here.
  const bytes = id3v2([{ id: 'TZZZ', encoding: 0, text: Buffer.from('private extension', 'latin1') }]);

  assert.deepEqual(readTags(bytes).tags, [{ name: 'tzzz', value: 'private extension' }]);
});

test('a v2.2 tag keeps the same frames under its own three-letter ids', () => {
  const bytes = id3v2(
    [
      { id: 'TCR', encoding: 0, text: Buffer.from('2005 EMI Records', 'latin1') },
      { id: 'TPB', encoding: 0, text: Buffer.from('Astralwerks', 'latin1') },
    ],
    { version: 2 },
  );

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'copyright', value: '2005 EMI Records' },
    { name: 'publisher', value: 'Astralwerks' },
  ]);
});

test('a frame that holds no text is still not a tag', () => {
  // The rule widens what is *read*, not what is believed: `PRIV` is an opaque
  // body, and a value cut out of one would be an invention in a table of names.
  const bytes = id3v2([
    { id: 'PRIV', encoding: 0, text: Buffer.from('M/MediaClassSecondaryID', 'latin1') },
    { id: 'UFID', encoding: 0, text: Buffer.from('http://musicbrainz.org', 'latin1') },
  ]);

  assert.deepEqual(readTags(bytes).tags, []);
});

test('a comment is a tag, and its description does not name it', () => {
  // §4.11 of v2.3: the encoding, a three-byte language, a short description,
  // then the text. The description tells several comments apart — it is not a
  // field name, which is what a TXXX description is — so a file that writes
  // `title` there has not thereby stated a title, and one that writes
  // `iTunPGAP` has written a comment rather than a field of that name. Taking
  // it as a name let a comment be read ahead of the title the tag states, and
  // let the genre resolver answer for the name it invented (task:2851).
  //
  // Written as byte lists rather than as a string with NULs in it, which is the
  // rule this repository states beside its own fixtures: a control character in
  // a source file is invisible, survives review, and turns the file binary.
  const emptyDescription = id3v2([
    {
      id: 'COMM',
      encoding: 0,
      text: Buffer.concat([
        Buffer.from('eng', 'latin1'),
        Buffer.from([0]),
        Buffer.from('Vocal by Anneli', 'latin1'),
      ]),
    },
  ]);
  assert.deepEqual(readTags(emptyDescription).tags, [
    { name: 'comment', value: 'Vocal by Anneli' },
  ]);

  const namedLikeATag = id3v2([
    {
      id: 'COMM',
      encoding: 0,
      text: Buffer.concat([
        Buffer.from('eng', 'latin1'),
        Buffer.from('title', 'latin1'),
        Buffer.from([0]),
        Buffer.from('not a title', 'latin1'),
      ]),
    },
    { id: 'TIT2', encoding: 0, text: Buffer.from('Real Title', 'latin1') },
  ]);
  assert.deepEqual(
    readTags(namedLikeATag).tags,
    [
      { name: 'comment', value: 'not a title' },
      { name: 'title', value: 'Real Title' },
    ],
    'a comment cannot shadow the title the tag states',
  );
});

test('the date is put together from the frames the standard splits it across', () => {
  // §4.2.1 keeps the year in `TYER` and the day and month in `TDAT` as `DDMM`,
  // and says nothing about composing them. This reader composes them the way
  // ffmpeg does, because ffmpeg is the second reader this project measures
  // against and its answer keeps a day the year alone loses.
  const dated = id3v2([
    { id: 'TYER', encoding: 0, text: Buffer.from('2005', 'latin1') },
    { id: 'TDAT', encoding: 0, text: Buffer.from('1209', 'latin1') },
  ]);
  assert.deepEqual(readTags(dated).tags, [{ name: 'date', value: '2005-09-12' }]);
});

test('a date frame that states no date leaves the year the tag does state', () => {
  // `0000` is what a writer puts in `TDAT` when it has no date, and `2005-00-00`
  // is an invention wearing a date's shape.
  const zeroed = id3v2([
    { id: 'TYER', encoding: 0, text: Buffer.from('2005', 'latin1') },
    { id: 'TDAT', encoding: 0, text: Buffer.from('0000', 'latin1') },
  ]);
  assert.deepEqual(readTags(zeroed).tags, [{ name: 'date', value: '2005' }]);

  // And a tag that states no year yields no date at all: four bare digits under
  // a name other code reads a year out of is worse than silence.
  const dayOnly = id3v2([{ id: 'TDAT', encoding: 0, text: Buffer.from('1209', 'latin1') }]);
  assert.deepEqual(readTags(dayOnly).tags, []);
});

test('a v2.4 tag that states its own date keeps the one it wrote', () => {
  // v2.4, said out loud: the fixture writes 2.3 unless told otherwise, and a
  // v2.3 tag cannot state a TDRC at all — the test was reading its own TYER back
  // and calling it v2.4 (task:2851).
  const bytes = id3v2([
    { id: 'TDRC', encoding: 0, text: Buffer.from('2005-09-12', 'latin1') },
    { id: 'TYER', encoding: 0, text: Buffer.from('1999', 'latin1') },
  ],
    { version: 4 },
  );

  assert.deepEqual(readTags(bytes).tags, [{ name: 'date', value: '2005-09-12' }]);
});

test('a v2.4 tag that escapes every frame keeps the frame walk it had', () => {
  // The header flag in v2.4 is a summary of per-frame escapes, and its frame
  // sizes count the bytes on disk. Decoding the whole tag here is what
  // `id3v2.4.0-changes` §3 calls a way to corrupt a tag, so this is the case
  // that must read exactly as it did before the two above were fixed.
  const bytes = id3v2(
    [
      { id: 'TIT2', encoding: 1, text: BOM_TEXT('A') },
      { id: 'TPE1', encoding: 0, text: Buffer.from('B', 'latin1') },
    ],
    { version: 4, unsynchroniseAll: true },
  );

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'title', value: 'A' },
    { name: 'artist', value: 'B' },
  ]);
});

test('a v2.2 user-defined frame is named by its description, as TXXX is', () => {
  // §4.2.2 of `id3v2-00`: v2.2 writes this frame with three letters. Read as an
  // ordinary text frame it yielded the description as a *value*, under a name no
  // document uses, and the artist the frame named never reached the stage that
  // looks for it — the defect the frame table was widened to end, left open for
  // the spelling two thirds of the Kroogi rips use (task:2851, both axes).
  const bytes = id3v2(
    [
      {
        id: 'TXX',
        encoding: 0,
        text: Buffer.concat([
          Buffer.from('ALBUMARTIST', 'latin1'),
          Buffer.from([0]),
          Buffer.from('Kino', 'latin1'),
        ]),
      },
    ],
    { version: 2 },
  );

  assert.deepEqual(readTags(bytes).tags, [{ name: 'albumartist', value: 'Kino' }]);
});

test('a user-defined name is not read as the word it happens to spell', () => {
  // The genre resolver answers for the frame the standard defines as the content
  // type, and it is asked for by frame rather than by name. A file free to name
  // its own field `genre` is free to mean anything by it, and reading a `17`
  // there as Rock would be deciding what the file meant (task:2851).
  const bytes = id3v2([
    {
      id: 'TXXX',
      encoding: 0,
      text: Buffer.concat([
        Buffer.from('genre', 'latin1'),
        Buffer.from([0]),
        Buffer.from('17', 'latin1'),
      ]),
    },
  ]);

  assert.deepEqual(readTags(bytes).tags, [{ name: 'genre', value: '17' }]);
});

test('a user-defined `date` does not suppress the date the tag states', () => {
  // The composite defers to `TDRC` — the standard's own whole timestamp — and
  // not to any tag that happens to be called `date`. The weaker test threw away
  // the year, the day and the month that the frames existing for them stated
  // (task:2851).
  const bytes = id3v2([
    {
      id: 'TXXX',
      encoding: 0,
      text: Buffer.concat([
        Buffer.from('date', 'latin1'),
        Buffer.from([0]),
        Buffer.from('1999-01-02', 'latin1'),
      ]),
    },
    { id: 'TYER', encoding: 0, text: Buffer.from('2005', 'latin1') },
    { id: 'TDAT', encoding: 0, text: Buffer.from('1209', 'latin1') },
  ]);

  assert.deepEqual(readTags(bytes).tags, [
    { name: 'date', value: '1999-01-02' },
    { name: 'date', value: '2005-09-12' },
  ]);
});
