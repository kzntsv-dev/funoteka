import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseCue, resolveRef } from '../src/cue/match.ts';
import { parseCue } from '../src/cue/parse.ts';
import type { WalkedFile } from '../src/scan/walk.ts';

function audio(name: string): WalkedFile {
  return {
    relPath: `album/${name}`,
    folderRelPath: 'album',
    name,
    kind: 'audio',
    ext: name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
    size: 1000,
    mtimeMs: 1,
  };
}

test('the cue whose FILE matches a real audio file wins', () => {
  // The Tool rip ships FLAC.cue next to WAV.cue; only one of them describes a
  // file that is actually there.
  const cues = [
    { relPath: 'album/WAV.cue', doc: parseCue('FILE "Opiate.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
    { relPath: 'album/FLAC.cue', doc: parseCue('FILE "Opiate.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
  ];

  const chosen = chooseCue(cues, [audio('Opiate.flac')]);
  assert.equal(chosen?.cue.relPath, 'album/FLAC.cue');
  assert.equal(chosen?.audio.name, 'Opiate.flac');
  assert.equal(chosen?.how, 'exact-name');
});

test('a cue declaring WAVE for an m4a still matches — the tag is not trusted', () => {
  // green.cue says `FILE "... .m4a" WAVE`; the file is an ALAC .m4a.
  const cues = [
    {
      relPath: 'album/green.cue',
      doc: parseCue('FILE "Tangerine Dream - Green Desert.m4a" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n'),
    },
  ];

  const chosen = chooseCue(cues, [audio('Tangerine Dream - Green Desert.m4a')]);
  assert.equal(chosen?.how, 'exact-name');
  assert.equal(chosen?.audio.name, 'Tangerine Dream - Green Desert.m4a');
});

test('a cue naming the right file with the wrong extension still matches', () => {
  // Confirmed in the wild: cue says .wav, the rip is .flac.
  const cues = [
    { relPath: 'album/album.cue', doc: parseCue('FILE "Opiate.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
  ];

  const chosen = chooseCue(cues, [audio('Opiate.flac')]);
  assert.equal(chosen?.audio.name, 'Opiate.flac');
  assert.equal(chosen?.how, 'stem');
});

test('matching ignores case, because rips do too', () => {
  const cues = [
    { relPath: 'album/a.cue', doc: parseCue('FILE "GREEN.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
  ];

  const chosen = chooseCue(cues, [audio('green.flac')]);
  assert.equal(chosen?.how, 'exact-name');
});

test('a cue naming a file the folder does not hold describes nothing, even alone', () => {
  // The matcher's last rule was a guess: nothing landed, but the folder held
  // exactly one audio file, so the cue was taken as describing it. It cost an
  // album its tracks when the cue belonged to a rip that was not there
  // ([[task:2712]]), and it is gone. A `FILE` that names nothing is a document
  // about something else, whatever the folder happens to hold.
  const cues = [
    { relPath: 'album/cd.cue', doc: parseCue('FILE "something-else.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
  ];

  assert.equal(chooseCue(cues, [audio('CDImage.flac')]), null);
});

test('the name-matched cue beats the barely-plausible one', () => {
  const cues = [
    { relPath: 'album/other.cue', doc: parseCue('FILE "unrelated.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
    { relPath: 'album/right.cue', doc: parseCue('FILE "Opiate.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
  ];

  const chosen = chooseCue(cues, [audio('Opiate.flac')]);
  assert.equal(chosen?.cue.relPath, 'album/right.cue');
  assert.equal(chosen?.how, 'exact-name');
});

test('a folder of separate tracks with a cue still resolves', () => {
  // tracks+cue: many audio files. The cue names one of them but describes the
  // album, so any real audio file is enough to accept the cue.
  const cues = [
    {
      relPath: 'album/box.cue',
      doc: parseCue('FILE "01 - Plainsong.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n'),
    },
  ];

  const files = [audio('01 - Plainsong.flac'), audio('02 - Pictures of You.flac')];
  const chosen = chooseCue(cues, files);
  assert.equal(chosen?.cue.relPath, 'album/box.cue');
  assert.equal(chosen?.audio.name, '01 - Plainsong.flac');
});

test('a cue reference resolves against the folder the cue lives in', () => {
  assert.equal(resolveRef('Album', 'image.flac'), 'Album/image.flac');
  assert.equal(resolveRef('Artist/Album', '../image.flac'), 'Artist/image.flac');
  assert.equal(resolveRef('Artist/Album/CD1', '../../image.flac'), 'Artist/image.flac');
  assert.equal(resolveRef('', 'Album/image.flac'), 'Album/image.flac');
  assert.equal(resolveRef('Album', './image.flac'), 'Album/image.flac');
  // `..` at the root stays at the root rather than escaping it.
  assert.equal(resolveRef('', '../image.flac'), 'image.flac');
});

test('an upward reference finds the audio it names', () => {
  // The cue sits above the album it describes and points up-and-over.
  const cues = [
    {
      relPath: 'Album/whole.cue',
      doc: parseCue('FILE "../shared/image.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n'),
    },
  ];
  const shared: WalkedFile = {
    relPath: 'shared/image.flac',
    folderRelPath: 'shared',
    name: 'image.flac',
    kind: 'audio',
    ext: 'flac',
    size: 1,
    mtimeMs: 1,
  };

  const chosen = chooseCue(cues, [shared]);
  assert.equal(chosen?.audio.relPath, 'shared/image.flac');
  assert.equal(chosen?.how, 'exact-name');
});

test('a stem match never reaches across folders', () => {
  // Two albums each holding `image.flac`; a cue in one must not claim the
  // other's file just because the names line up.
  const cues = [
    { relPath: 'A/album.cue', doc: parseCue('FILE "image.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
  ];
  const other: WalkedFile = {
    relPath: 'B/image.flac',
    folderRelPath: 'B',
    name: 'image.flac',
    kind: 'audio',
    ext: 'flac',
    size: 1,
    mtimeMs: 1,
  };

  // Nothing the cue names is here at all: `B/image.flac` shares a stem with the
  // `A/image.wav` the cue declares, and only the folder tells the two readings
  // apart — which is exactly why the folder has to agree.
  assert.equal(chooseCue(cues, [other]), null);
});

test('no audio means no match, even with a perfectly good cue', () => {
  const cues = [
    { relPath: 'album/orphan.cue', doc: parseCue('FILE "missing.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
  ];

  assert.equal(chooseCue(cues, []), null);
});

test('with no cues there is nothing to choose', () => {
  assert.equal(chooseCue([], [audio('a.flac')]), null);
});

test('ties are broken deterministically by cue path', () => {
  const cues = [
    { relPath: 'album/b.cue', doc: parseCue('FILE "img.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
    { relPath: 'album/a.cue', doc: parseCue('FILE "img.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n') },
  ];

  const once = chooseCue(cues, [audio('img.flac')]);
  const twice = chooseCue([...cues].reverse(), [audio('img.flac')]);
  assert.equal(once?.cue.relPath, twice?.cue.relPath);
});
