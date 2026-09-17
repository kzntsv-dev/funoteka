import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFile } from '../src/scan/kinds.ts';

test('audio extensions map to audio', () => {
  // Real fixtures from the collection matrix (wiki:3499 "Формат" row).
  assert.equal(classifyFile('Tangerine Dream - Green Desert.m4a'), 'audio'); // ALAC image
  assert.equal(classifyFile('01. VA - ASOT Ibiza 2026 - Pulse.mp3'), 'audio');
  assert.equal(classifyFile('Opiate.flac'), 'audio');
  assert.equal(classifyFile('image.ape'), 'audio');
  assert.equal(classifyFile('image.tta'), 'audio');
  assert.equal(classifyFile('image.aiff'), 'audio');
  assert.equal(classifyFile('image.aif'), 'audio');
  assert.equal(classifyFile('image.wav'), 'audio');
});

test('a video container is not music', () => {
  // `.mp4` is a video container — audio-only material uses `.m4a`, which is
  // already above. Treating the extension as audio put a live video clip into
  // the library as a track, from a folder the collection keeps its clips in.
  // Real fixture: `Royksopp Discography/La Route Du Rock/La Route Du Rock 12
  // (2002 Live).mp4`.
  assert.equal(classifyFile('La Route Du Rock 12 (2002 Live).mp4'), 'other');
  assert.equal(classifyFile('01 So Easy.m4a'), 'audio', 'm4a stays audio');
});

test('extension match is case-insensitive', () => {
  // Real fixture: the Green Desert rip ships `A.JPEG`, `cover.JPEG`, `text.JPEG`.
  assert.equal(classifyFile('cover.JPEG'), 'image');
  assert.equal(classifyFile('A.JPEG'), 'image');
  assert.equal(classifyFile('Opiate.FLAC'), 'audio');
  assert.equal(classifyFile('GREEN.CUE'), 'cue');
});

test('sidecar kinds', () => {
  assert.equal(classifyFile('green.cue'), 'cue');
  assert.equal(classifyFile('album.nfo'), 'nfo');
  assert.equal(classifyFile('Opiate.log'), 'log');
  assert.equal(classifyFile('cover.jpg'), 'image');
  assert.equal(classifyFile('folder.png'), 'image');
});

test('playlists are their own kind', () => {
  assert.equal(classifyFile('curated.m3u'), 'playlist');
  assert.equal(classifyFile('curated.m3u8'), 'playlist');
  assert.equal(classifyFile('radio.pls'), 'playlist');
});

test('non-media falls through to other', () => {
  assert.equal(classifyFile('notes.txt'), 'other');
  assert.equal(classifyFile('release.torrent'), 'other');
  assert.equal(classifyFile('Thumbs.db'), 'other');
  assert.equal(classifyFile('noextension'), 'other');
});

test('dotfiles are not extensions', () => {
  // `.DS_Store` and friends: a leading dot marks a hidden file, not an extension.
  assert.equal(classifyFile('.DS_Store'), 'other');
  assert.equal(classifyFile('.cue'), 'other');
});

test('classification is driven by the basename, not the directory', () => {
  assert.equal(classifyFile('some.dir/cover.jpg'), 'image');
  assert.equal(classifyFile('C:\\Music\\album\\track.flac'), 'audio');
});
