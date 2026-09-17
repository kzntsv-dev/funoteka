import { test } from 'node:test';
import assert from 'node:assert/strict';

import { playable } from '../src/stream/segment.ts';

test('a codec a browser plays, in a container it opens, is sent as it is', () => {
  const pairs: [string, string][] = [
    ['flac', 'flac'],
    ['mp3', 'mp3'],
    ['aac', 'm4a'],
    ['opus', 'ogg'],
    ['vorbis', 'ogg'],
    ['pcm_s16le', 'wav'],
  ];
  for (const [codec, ext] of pairs) assert.equal(playable(codec, ext), true, `${codec} in .${ext}`);
});

test('a container no browser opens is re-encoded whatever is inside it', () => {
  // The two reasons stand on their own: knowing the audio is fine does not make
  // the file playable if nothing can open the box it is in.
  assert.equal(playable('flac', 'ape'), false);
  assert.equal(playable('pcm_s16le', 'dsf'), false);
});

test('the ones it cannot are re-encoded, whatever the container is named', () => {
  // ALAC lives in the same `.m4a` as AAC and no browser decodes it, which is
  // why the codec — and not the extension — has to decide.
  assert.equal(playable('alac', 'm4a'), false);
  assert.equal(playable('ape', 'ape'), false);
  assert.equal(playable('wavpack', 'wv'), false);
});

test('a codec the scan could not name falls back to the container', () => {
  // The probe is optional and an older scan wrote the container's name into the
  // codec column, so "unknown" is a state the rule has to answer anyway. A
  // container the browser plays goes out as it is; anything else is re-encoded,
  // because bytes a client cannot play are worse than a slower answer.
  assert.equal(playable(null, 'mp3'), true, '274 songs of the collection are here');
  assert.equal(playable(null, 'm4a'), true);
  assert.equal(playable(null, 'ogg'), true);
  assert.equal(playable('id3v2', 'mp3'), true, 'an older scan stored the container name');
  assert.equal(playable(null, 'ape'), false);
  assert.equal(playable('unknown_to_us', 'wv'), false);
});
