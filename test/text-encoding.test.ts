import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CERTAIN, decodeId3Text, decodeText, decodeVorbisText } from '../src/text/encoding.ts';
import { cp1251, utf16be } from './helpers/bytes.ts';

/**
 * The bytes here are the point of the exercise, so they are built rather than
 * pasted: a fixture you cannot read is a fixture you cannot check.
 */

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

// --- BOM -------------------------------------------------------------------
// A byte-order mark is a declaration, not a hint: when one is present there is
// nothing left to guess, and the detector must say so.

test('UTF-8 BOM wins outright and is not left in the text', () => {
  const result = decodeText(Buffer.concat([BOM_UTF8, Buffer.from('TITLE "Отлично"', 'utf8')]));

  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.text, 'TITLE "Отлично"');
  assert.equal(result.confidence, CERTAIN);
  assert.match(result.basis, /bom/i);
});

test('UTF-16LE BOM decodes to the same text', () => {
  const result = decodeText(
    Buffer.concat([BOM_UTF16LE, Buffer.from('PERFORMER "Отлично"', 'utf16le')]),
  );

  assert.equal(result.encoding, 'utf-16le');
  assert.equal(result.text, 'PERFORMER "Отлично"');
  assert.equal(result.confidence, CERTAIN);
});

test('UTF-16BE BOM decodes to the same text', () => {
  const result = decodeText(Buffer.concat([BOM_UTF16BE, utf16be('PERFORMER "Отлично"')]));

  assert.equal(result.encoding, 'utf-16be');
  assert.equal(result.text, 'PERFORMER "Отлично"');
  assert.equal(result.confidence, CERTAIN);
});

// --- UTF-8 -----------------------------------------------------------------
// Plain ASCII is the common case and carries no ambiguity at all: every
// candidate encoding agrees on it, so there is nothing to infer.

test('ASCII is UTF-8 with nothing inferred', () => {
  const result = decodeText(Buffer.from('FILE "cd1.flac" WAVE', 'utf8'));

  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.text, 'FILE "cd1.flac" WAVE');
  assert.equal(result.confidence, CERTAIN);
});

test('valid multi-byte UTF-8 is taken at face value', () => {
  // A run of CP1251 Cyrillic cannot pass strict UTF-8: those are lead bytes
  // demanding continuations that Cyrillic text never supplies.
  const result = decodeText(Buffer.from('PERFORMER "Аквариум"', 'utf8'));

  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.text, 'PERFORMER "Аквариум"');
  assert.equal(result.confidence, CERTAIN);
});

test('UTF-8 that decodes to C1 controls is not trusted', () => {
  // U+0080..U+009F only ever reaches a document through a broken re-encode.
  const result = decodeText(Buffer.from([0x41, 0xc2, 0x97, 0x42]));

  assert.equal(result.text.codePointAt(1), 0x97); // the C1 control survives, but is flagged
  assert.ok(result.confidence < CERTAIN);
  assert.match(result.basis, /c1|mojibake/i);
});

test('UTF-16 without a BOM is flagged, not passed off as ASCII', () => {
  // `FILE` in UTF-16LE is `46 00 49 00 …`, and every one of those bytes is
  // valid ASCII. A reader that stops at "it validates" calls this certain and
  // the cue parses as `F\0I\0L\0E\0` — the silent plausible-but-wrong outcome
  // the control-ratio guard exists to prevent.
  const result = decodeText(Buffer.from('FILE "cd1.flac"', 'utf16le'));

  assert.ok(result.confidence < CERTAIN);
  assert.match(result.basis, /control|utf-16/i);
});

test('UTF-16 Cyrillic without a BOM is flagged too', () => {
  // The harder half: Cyrillic in UTF-16LE is `1f 04 40 04 …` — not a NUL in
  // sight, so sniffing for interleaved zeros would miss it entirely. The
  // result is letters interleaved with U+0004, and that ratio is the tell.
  const result = decodeText(Buffer.from('Аквариум', 'utf16le'));

  assert.ok(result.confidence < CERTAIN);
  assert.match(result.basis, /control/i);
});

// --- The 8-bit single-byte family -----------------------------------------
// Once UTF-8 fails, the bytes are a Windows code page and the candidates
// genuinely overlap: `0xC0..0xFF` is Cyrillic in CP1251 and accented Latin in
// CP1252, while `0xA0..0xBF` is largely the same table in both. The separator
// that holds up is density — Cyrillic prose is *made* of those bytes, Western
// accented text merely sprinkles them.

test('Cyrillic prose in CP1251 is recognised as CP1251', () => {
  const result = decodeText(cp1251('TITLE "Привет, мир!"'));

  assert.equal(result.encoding, 'windows-1251');
  assert.equal(result.text, 'TITLE "Привет, мир!"');
  assert.ok(result.confidence > 0 && result.confidence < CERTAIN);
});

test('a Cyrillic line padded with ASCII is still CP1251', () => {
  const result = decodeText(cp1251('REM PERFORMER "Аквариум"'));

  assert.equal(result.encoding, 'windows-1251');
  assert.equal(result.text, 'REM PERFORMER "Аквариум"');
});

test('accented Western text stays CP1252', () => {
  const result = decodeText(Buffer.from('TITLE "Ça dégage dur"', 'latin1'));

  assert.equal(result.encoding, 'windows-1252');
  assert.equal(result.text, 'TITLE "Ça dégage dur"');
});

test('one accented letter does not flip a Western file to CP1251', () => {
  // The case density has to survive: 1 high byte in 8 is a French word, not
  // Russian. A naive "any byte >= 0xC0" rule decodes this to `CafЙ`.
  const result = decodeText(Buffer.from('REM Café', 'latin1'));

  assert.equal(result.encoding, 'windows-1252');
  assert.equal(result.text, 'REM Café');
});

test('CP1252 punctuation in 0x80..0x9F does not decide the family', () => {
  // CP1252's own „ … – — live in that range, so its presence is not evidence
  // of Cyrillic. Only density is — here 5 high bytes in 18, a Western ratio.
  const result = decodeText(
    Buffer.from([
      0x52, 0x45, 0x4d, 0x20, // "REM "
      0x93, 0x43, 0x61, 0x66, 0xe9, 0x20, // “Café
      0x64, 0xe9, 0x6a, 0xe0, 0x20, 0x76, 0x75, 0x94, // déjà vu”
    ]),
  );

  assert.equal(result.encoding, 'windows-1252');
  assert.equal(result.text, 'REM “Café déjà vu”');
  assert.ok(result.confidence < CERTAIN);
});

test('a long English log with one Russian line is still CP1251', () => {
  // Verbatim shape from the collection: an EAC log written by the English UI,
  // hundreds of ASCII letters of boilerplate, and a single Russian line near
  // the top. Cyrillic is 4% of its letters, so a share-based rule reads it as
  // Western and hands back `Êèíî / Ïîñëåäíèé ãåðîé` — which is exactly what
  // the collection's own logs produced before this rule.
  const log = `EAC extraction logfile from 2. May 2008, 17:23 for CD
Кино / Последний герой

Used drive  : PIONEER DVD-RW  DVR-109   Adapter: 0  ID: 0
Read mode   : Secure with NO C2, accurate stream, disable cache
Combined read/write offset correction : 48
Overread into Lead-In and Lead-Out : No
Used output format : Internal WAV Routines
Fill up missing offset samples with silence : Yes
Delete leading and trailing silent blocks : No
Null samples used in CRC calculations : Yes
Used interface : Native Win32 interface for Win NT & 2000

TOC of the extracted CD
     Track |   Start  |  Length  | Start sector | End sector
    ---------------------------------------------------------
        1  |  0:00.00 |  4:04.69 |         0    |    18369
        2  |  4:04.69 |  3:57.00 |     18369    |    36144
`;

  const result = decodeText(cp1251(log));

  assert.equal(result.encoding, 'windows-1251');
  assert.match(result.text, /Кино \/ Последний герой/);
  assert.ok(result.confidence < CERTAIN, 'still an inference, just a well-founded one');
});

test('the same log with an accented name stays CP1252', () => {
  // The mirror of the case above: identical boilerplate, Western name. Nothing
  // is adjacent here, so the run rule must not fire.
  const log = `EAC extraction logfile from 2. May 2008, 17:23 for CD
Kino / Dernier Héros

Used drive  : PIONEER DVD-RW  DVR-109   Adapter: 0  ID: 0
Read mode   : Secure with NO C2, accurate stream, disable cache
Combined read/write offset correction : 48
Overread into Lead-In and Lead-Out : No
Used output format : Internal WAV Routines
Fill up missing offset samples with silence : Yes
`;

  const result = decodeText(Buffer.from(log, 'latin1'));

  assert.equal(result.encoding, 'windows-1252');
  assert.match(result.text, /Dernier Héros/);
});

test('an eight-bit verdict is reported, not asserted', () => {
  const result = decodeText(cp1251('REM Отлично'));

  assert.ok(result.confidence < CERTAIN);
  assert.match(result.basis, /1251/);
});

// --- ID3v2 -----------------------------------------------------------------
// ID3v2 frames carry their own declared encoding byte. The declared value is
// frequently a lie: rippers write `0` (Latin-1) over CP1251 bytes, which is the
// mis-flag case the design spec calls out.

test('ID3v2 encoding byte 3 is UTF-8', () => {
  const result = decodeId3Text(3, Buffer.from('Аквариум\0', 'utf8'));

  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.text, 'Аквариум');
  assert.equal(result.confidence, CERTAIN);
});

test('ID3v2 encoding byte 0 declared Latin-1 and actually Latin-1', () => {
  const result = decodeId3Text(0, Buffer.from('Café\0', 'latin1'));

  assert.equal(result.encoding, 'windows-1252');
  assert.equal(result.text, 'Café');
});

test('ID3v2 encoding byte 0 lying over CP1251 bytes is caught', () => {
  const result = decodeId3Text(0, Buffer.concat([cp1251('Аквариум'), Buffer.from([0])]));

  assert.equal(result.encoding, 'windows-1251');
  assert.equal(result.text, 'Аквариум');
  assert.match(result.basis, /mislab|declar|1251/i);
});

test('ID3v2 encoding byte 3 claimed over CP1251 bytes is caught too', () => {
  // The same lie with a different flag: a ripper that "upgraded" to UTF-8
  // without converting the bytes underneath.
  const result = decodeId3Text(3, Buffer.concat([cp1251('Аквариум'), Buffer.from([0])]));

  assert.equal(result.encoding, 'windows-1251');
  assert.equal(result.text, 'Аквариум');
  assert.match(result.basis, /mislab|declar|1251|utf-8/i);
});

test('ID3v2 encoding byte 1 is UTF-16 with a little-endian BOM', () => {
  const result = decodeId3Text(
    1,
    Buffer.concat([
      BOM_UTF16LE,
      Buffer.from('Аквариум', 'utf16le'),
      Buffer.from([0, 0]),
    ]),
  );

  assert.equal(result.encoding, 'utf-16le');
  assert.equal(result.text, 'Аквариум');
  assert.equal(result.confidence, CERTAIN);
});

test('ID3v2 encoding byte 1 with a big-endian BOM follows the BOM', () => {
  const result = decodeId3Text(
    1,
    Buffer.concat([BOM_UTF16BE, utf16be('Аквариум'), Buffer.from([0, 0])]),
  );

  assert.equal(result.encoding, 'utf-16be');
  assert.equal(result.text, 'Аквариум');
});

test('ID3v2 encoding byte 2 is UTF-16BE', () => {
  const result = decodeId3Text(2, Buffer.concat([utf16be('Аквариум'), Buffer.from([0, 0])]));

  assert.equal(result.encoding, 'utf-16be');
  assert.equal(result.text, 'Аквариум');
  assert.equal(result.confidence, CERTAIN);
});

test('an unknown ID3v2 encoding byte is reported rather than assumed', () => {
  const result = decodeId3Text(9, Buffer.from('Café\0', 'latin1'));

  assert.equal(result.text, 'Café');
  assert.ok(result.confidence < CERTAIN);
  assert.match(result.basis, /9/);
});

test('a UTF-16 value ending in an ASCII character keeps it', () => {
  // Regression. NUL stripping used to run on the byte array, where `CD1\0` in
  // UTF-16LE is `43 00 44 00 31 00 00 00` and three trailing bytes disappear
  // together — leaving five, an odd length, which decodes to `CD�`.
  // Any tag ending in an ASCII character lost it, silently.
  const result = decodeId3Text(
    1,
    Buffer.concat([BOM_UTF16LE, Buffer.from('CD1\0', 'utf16le')]),
  );

  assert.equal(result.text, 'CD1');
  assert.equal(result.encoding, 'utf-16le');
});

test('an ID3v2 UTF-8 frame carrying C1 controls is not certain', () => {
  // The same guard decodeText applies, now shared: a frame declaring UTF-8
  // that decodes to U+0097 is a code page re-encoded twice over, and saying
  // `CERTAIN` here would mean the rule held in one path out of three.
  const result = decodeId3Text(3, Buffer.from([0x41, 0xc2, 0x97, 0x42]));

  assert.equal(result.encoding, 'utf-8');
  assert.ok(result.confidence < CERTAIN);
  assert.match(result.basis, /c1/i);
});

// --- FLAC Vorbis comments --------------------------------------------------
// Vorbis comments are UTF-8 by specification, so validation is the whole job:
// when it holds, nothing was inferred. Russian rips still break it.

test('a conforming Vorbis comment is UTF-8', () => {
  const result = decodeVorbisText(Buffer.from('Аквариум', 'utf8'));

  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.text, 'Аквариум');
  assert.equal(result.confidence, CERTAIN);
});

test('a Vorbis comment that is not UTF-8 falls back and says so', () => {
  const result = decodeVorbisText(cp1251('Аквариум'));

  assert.equal(result.encoding, 'windows-1251');
  assert.equal(result.text, 'Аквариум');
  assert.match(result.basis, /vorbis|utf-8/i);
});

test('a Vorbis comment carrying C1 controls is not certain', () => {
  const result = decodeVorbisText(Buffer.from([0x41, 0xc2, 0x97, 0x42]));

  assert.equal(result.encoding, 'utf-8');
  assert.ok(result.confidence < CERTAIN);
  assert.match(result.basis, /c1/i);
});

// --- Empty -----------------------------------------------------------------

test('empty input decodes to empty text', () => {
  const result = decodeText(Buffer.alloc(0));

  assert.equal(result.text, '');
  assert.equal(result.confidence, CERTAIN);
});
