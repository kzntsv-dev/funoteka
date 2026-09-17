import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCue, parseCueTime } from '../src/cue/parse.ts';

test('a mark is recorded with the file it was written in', () => {
  // A cue writes the pregap of a track that opens a file at the *end* of the file
  // before it, so `INDEX 00` can sit in one FILE and `INDEX 01` in the next — and
  // their times are then counted from different starts. Recorded without saying
  // which file each came from, the row read `index00_ms 295173, index01_ms 0`:
  // a track ending before it began. Measured on this collection, 31 such rows of
  // 1001, across six cues (task:2755).
  const doc = parseCue(`FILE "01.flac" WAVE
  TRACK 01 AUDIO
    TITLE "One"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Two"
    INDEX 00 04:00:00
FILE "02.flac" WAVE
    INDEX 01 00:00:00
`);

  const [first, second] = doc.tracks;
  assert.equal(first?.index00FileIndex, null, 'a track with no pregap says nothing');
  assert.equal(first?.index01FileIndex, 0);

  assert.equal(second?.index00Ms, 240_000, 'the pregap, counted from its own file');
  assert.equal(second?.index00FileIndex, 0, 'which is the file before the track');
  assert.equal(second?.index01Ms, 0, 'and the track itself starts the next one');
  assert.equal(second?.index01FileIndex, 1, 'so the two marks name two files');
});

/**
 * The snippets below are real cue files from the collection, kept verbatim.
 * `green.cue` and `II.cue` both declare `FILE ... WAVE` for a file that is
 * actually `.m4a` — the FILE-mismatch case the matrix warns about.
 */
const GREEN_DESERT = `REM DATE 1973
REM GENRE "Berlin School, Electronic"
REM COMMENT "From Cassette 1986"
TITLE "Green Desert"
PERFORMER "Tangerine Dream"
REM COUNTRY "UK"
REM CATALOG "Jive – HOP C226"
FILE "Tangerine Dream - Green Desert.m4a" WAVE
REM COOLNESS "Off The Charts; Ça dégage dur; Отлично; ¡Que Chévere!"

TRACK 01 AUDIO
TITLE "Green Desert"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "White Clouds"
INDEX 01 19:24:00
TRACK 03 AUDIO
TITLE "Astral Voyager"
INDEX 01 24:30:00
TRACK 04 AUDIO
TITLE "Indian Summer"
INDEX 01 31:36:00
`;

const ASOT = `TITLE "A State Of Trance: Ibiza 2026"
PERFORMER "Various Artists"
REM GENRE "Trance"
REM DATE "2026-08-28"
FILE "01. VA - A State Of Trance_Ibiza 2026 - Pulse.mp3" MP3

TRACK 01 AUDIO
  INDEX 01 00:00:00
  TITLE "No Mercy (JDX Intro Edit)"
  PERFORMER "Armin van Buuren & Adam Beyer"
TRACK 02 AUDIO
  INDEX 01 04:39:73
  TITLE "Here In My Arms (Enjoy The Silence)"
  PERFORMER "Armin van Buuren & Silver Panda"
TRACK 13 AUDIO
  INDEX 01 40:49:60
  TITLE "March"
  PERFORMER "Goom Gum"
`;

test('cue times are read as CD frames, 75 to the second', () => {
  assert.equal(parseCueTime('00:00:00'), 0);
  assert.equal(parseCueTime('19:24:00'), 19 * 60_000 + 24_000);
  // Real value from ASOT disc 1: 4 min 39 s and 73 frames.
  assert.equal(parseCueTime('04:39:73'), 4 * 60_000 + 39_000 + Math.round((73 * 1000) / 75));
});

test('cue times tolerate frames at the very top of the range', () => {
  // Frames run 0..74; rips in the wild use both 73 and 74.
  assert.equal(parseCueTime('37:42:74'), 37 * 60_000 + 42_000 + Math.round((74 * 1000) / 75));
});

test('cue times may omit frames entirely', () => {
  assert.equal(parseCueTime('05:31'), 5 * 60_000 + 31_000);
});

test('nonsense times are rejected rather than guessed', () => {
  assert.equal(parseCueTime(''), null);
  assert.equal(parseCueTime('later'), null);
  assert.equal(parseCueTime('1:2:3:4'), null);
});

test('album-level fields come out of the cue', () => {
  const doc = parseCue(GREEN_DESERT);

  assert.equal(doc.title, 'Green Desert');
  assert.equal(doc.performer, 'Tangerine Dream');
  assert.equal(doc.rem['DATE'], '1973');
  assert.equal(doc.rem['GENRE'], 'Berlin School, Electronic');
  assert.equal(doc.rem['COUNTRY'], 'UK');
  assert.equal(doc.rem['CATALOG'], 'Jive – HOP C226');
});

test('a cue written the way this collection writes them has nothing unrecognised', () => {
  // The counter below is only worth its keep if it is quiet on a real cue. Both
  // of these are verbatim files from the collection, and a report on either
  // would be a report on every cue in the library.
  assert.deepEqual(parseCue(GREEN_DESERT).unrecognized, []);
  assert.deepEqual(parseCue(ASOT).unrecognized, []);
});

test('a line no command claims is reported rather than dropped', () => {
  // `FILE My Album.flac FLAC`, written without the quotes the grammar wants.
  // The parser cannot guess where the name ends and the type begins, so the
  // line is not read — and until this, nothing said so.
  const doc = parseCue(`TITLE "Broken"
FILE My Album.flac FLAC
TRACK 01 AUDIO
TITLE "One"
INDEX 01 00:00:00
`);

  assert.deepEqual(doc.unrecognized, [
    { line: 2, text: 'FILE My Album.flac FLAC', malformed: true },
  ]);
  assert.deepEqual(doc.files, [], 'the file reference went with it');
  assert.equal(doc.tracks[0]?.title, 'One', 'and the rest of the cue still reads');
});

test('a FILE line that does not parse shifts every TRACK after it to the file before', () => {
  // The damage the report is for. Two discs in one cue, the second FILE
  // unreadable: `fileIndex` is "how many files have been opened", so the second
  // disc's tracks are counted against the *first* disc's image — offsets that
  // look reasonable and point at the wrong audio.
  const doc = parseCue(`FILE "01.flac" WAVE
TRACK 01 AUDIO
INDEX 01 00:00:00
FILE My Album.flac FLAC
TRACK 01 AUDIO
INDEX 01 00:00:00
`);

  assert.equal(doc.files.length, 1, 'the second FILE never registered');
  assert.equal(doc.tracks.length, 2);
  assert.equal(doc.tracks[1]?.fileIndex, 0, 'so the second disc reads as the first');
  assert.equal(doc.unrecognized.length, 1, 'and the reason is on the record');
});

test('commands this reader reads nothing out of are not called unrecognised', () => {
  // The pregap, the flags, the ISRC and the songwriter are cue syntax this
  // project deliberately does not store — the split stage takes its answer from
  // `INDEX 00`, and a credit is not something the artist stage reads off a cue.
  // Counting them would fire on most cues in the library and mean nothing by it.
  //
  // `CATALOG` is not in this list and never was a decision: see the test below.
  const doc = parseCue(`CDTEXTFILE "album.cdt"
PREGAP 00:02:00
FILE "a.flac" WAVE
TRACK 01 AUDIO
FLAGS DCP
ISRC USRC17607839
SONGWRITER "Someone"
POSTGAP 00:02:00
INDEX 01 00:00:00
`);

  assert.deepEqual(doc.unrecognized, []);
  assert.equal(doc.tracks[0]?.index01Ms, 0, 'and the track still reads');
});

test('a catalogue number written as the CATALOG command is read, not dropped', () => {
  // Measured over the library: 21 of its 263 cues state a catalogue number as a
  // bare `CATALOG` line, and not one of those 21 also writes it as `REM
  // CATALOG` — which is the only form `cue.catalog` was ever filled from. So
  // twenty-one real EANs reached no column and no report, and the line was
  // filed under "understood and not kept" (task:2756, finding 2).
  const doc = parseCue(`CATALOG 4988015085082
TITLE "Slipknot"
FILE "a.flac" WAVE
TRACK 01 AUDIO
INDEX 01 00:00:00
`);

  assert.equal(doc.rem['CATALOG'], '4988015085082');
  assert.deepEqual(doc.unrecognized, [], 'and it is not reported as a line nobody read');
});

test('the CATALOG command outranks the REM comment, whichever order they are in', () => {
  // `REM CATALOG` is a comment convention and `CATALOG` is the format's own
  // field for the same number. No cue in the collection writes both; the rule
  // is here so that the first one that does is read the same way twice.
  const commandLast = parseCue('REM CATALOG "REM VALUE"\nCATALOG 1234567890123\n');
  const commandFirst = parseCue('CATALOG 1234567890123\nREM CATALOG "REM VALUE"\n');

  assert.equal(commandLast.rem['CATALOG'], '1234567890123');
  assert.equal(commandFirst.rem['CATALOG'], '1234567890123');
});

test('the REM form still reads when it is the only one there', () => {
  const doc = parseCue('REM CATALOG "Jive – HOP C226"\nTITLE "X"\n');

  assert.equal(doc.rem['CATALOG'], 'Jive – HOP C226');
  assert.deepEqual(doc.unrecognized, []);
});

test('a line that is not cue syntax is reported as information, not as damage', () => {
  // A ripper's stray header. Nothing was lost with it, which is the difference
  // `malformed` carries: this one is worth a reader's attention and not a
  // warning.
  const doc = parseCue(`ExactAudioCopy v0.99 prebeta 3 from 4. November 2007
TITLE "X"
FILE "a.flac" WAVE
TRACK 01 AUDIO
INDEX 01 00:00:00
`);

  assert.deepEqual(doc.unrecognized, [
    { line: 1, text: 'ExactAudioCopy v0.99 prebeta 3 from 4. November 2007', malformed: false },
  ]);
});

test('a TRACK line missing its type is a broken command, and takes its marks with it', () => {
  // `TRACK 01` with no AUDIO/DATA after it is not a track this parser can open,
  // and the INDEX that follows has nothing to belong to — so it is reported for
  // the same reason, which is what makes the count a count of what was lost
  // rather than of how many lines happened to look odd.
  const doc = parseCue('FILE "a.flac" WAVE\nTRACK 01\nINDEX 01 00:00:00\n');

  assert.equal(doc.tracks.length, 0);
  assert.deepEqual(doc.unrecognized, [
    { line: 2, text: 'TRACK 01', malformed: true },
    { line: 3, text: 'INDEX 01 00:00:00', malformed: true },
  ]);
});

test('line numbers are the ones an editor shows', () => {
  // The report names the line so a person can open the file and look. Blank
  // lines are skipped and still count, which is the only way the number is any
  // use.
  const doc = parseCue('\n\nTITLE "X"\n\nnot cue\n');

  assert.equal(doc.unrecognized[0]?.line, 5);
});

test('the FILE line keeps its declared type even when it contradicts reality', () => {
  // The parser must report what the cue says. Deciding that a "WAVE" file is
  // really an .m4a is the matcher's job, not the parser's.
  const doc = parseCue(GREEN_DESERT);

  assert.equal(doc.files.length, 1);
  assert.equal(doc.files[0]?.name, 'Tangerine Dream - Green Desert.m4a');
  assert.equal(doc.files[0]?.type, 'WAVE');
});

test('tracks carry their number, title and index', () => {
  const doc = parseCue(GREEN_DESERT);

  assert.equal(doc.tracks.length, 4);
  assert.deepEqual(
    doc.tracks.map((t) => [t.ordinal, t.title, t.index01Ms]),
    [
      [1, 'Green Desert', 0],
      [2, 'White Clouds', 19 * 60_000 + 24_000],
      [3, 'Astral Voyager', 24 * 60_000 + 30_000],
      [4, 'Indian Summer', 31 * 60_000 + 36_000],
    ],
  );
});

test('per-track performers are read where the cue has them', () => {
  const doc = parseCue(ASOT);

  assert.equal(doc.tracks.length, 3);
  assert.equal(doc.tracks[0]?.performer, 'Armin van Buuren & Adam Beyer');
  assert.equal(doc.tracks[2]?.performer, 'Goom Gum');
  // Track numbers are not required to be contiguous.
  assert.equal(doc.tracks[2]?.ordinal, 13);
});

test('a track without its own performer leaves it unset', () => {
  // Filling this in from the album PERFORMER is a fallback, and belongs to the
  // consumer — the parser reports only what the file says.
  const doc = parseCue(GREEN_DESERT);
  assert.equal(doc.tracks[0]?.performer, null);
});

test('INDEX 00 pregap is captured separately from INDEX 01', () => {
  const doc = parseCue(`PERFORMER "The Cure"
TITLE "Disintegration"
FILE "image.flac" WAVE
  TRACK 01 AUDIO
    TITLE "Plainsong"
    INDEX 00 00:00:00
    INDEX 01 00:00:32
  TRACK 02 AUDIO
    TITLE "Pictures of You"
    INDEX 00 05:15:00
    INDEX 01 05:17:00
`);

  // INDEX 00 is where the pregap starts, INDEX 01 where the track does; for
  // the first track that is 32 frames of silence before the music.
  assert.equal(doc.tracks[0]?.index00Ms, 0);
  assert.equal(doc.tracks[0]?.index01Ms, Math.round((32 * 1000) / 75));
  assert.equal(doc.tracks[1]?.index00Ms, 5 * 60_000 + 15_000);
  assert.equal(doc.tracks[1]?.index01Ms, 5 * 60_000 + 17_000);
});

test('a cue with no TRACK lines yields no tracks rather than throwing', () => {
  const doc = parseCue('TITLE "Broken"\nFILE "x.flac" WAVE\n');
  assert.deepEqual(doc.tracks, []);
  assert.equal(doc.title, 'Broken');
});

test('blank lines and stray whitespace do not disturb the parse', () => {
  const doc = parseCue('\n\n   TITLE "Spaced"  \n\n  FILE "a.flac" WAVE \n\n\n');
  assert.equal(doc.title, 'Spaced');
  assert.equal(doc.files[0]?.name, 'a.flac');
});

test('a BOM at the start of the file does not corrupt the first key', () => {
  // Windows rips are full of these; without stripping it, the first line
  // parses as a key nobody recognises and the title is silently lost.
  const doc = parseCue(`﻿TITLE "Bom"\nPERFORMER "Someone"\n`);
  assert.equal(doc.title, 'Bom');
  assert.equal(doc.performer, 'Someone');
});
