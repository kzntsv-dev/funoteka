import { test } from 'node:test';
import assert from 'node:assert/strict';

import { basenameOf, compareNatural, rootBasenameOf } from '../src/util/names.ts';

test('a meta-layer path is split on the separator the walk writes', () => {
  assert.equal(basenameOf('a/b/track.flac'), 'track.flac');
  assert.equal(basenameOf('track.flac'), 'track.flac');
});

test('a root basename survives either separator and trailing slashes', () => {
  // The root is the one path the walk did not produce: it comes from
  // `realpathSync.native`, which on Windows answers with backslashes. A basename
  // that knows only `/` returns the whole path there and the folder name on
  // Linux, so one unchanged collection gets two different answers depending on
  // the machine reading it.
  assert.equal(rootBasenameOf('C:\\Users\\demo\\Downloads\\Кино'), 'Кино');
  assert.equal(rootBasenameOf('/home/demo/music/Кино'), 'Кино');
  assert.equal(rootBasenameOf('/home/demo/music/Кино/'), 'Кино');
  assert.equal(rootBasenameOf('C:\\'), 'C:');
  assert.equal(rootBasenameOf('/'), '');
});

test('digit runs compare as numbers, and text runs by code unit', () => {
  // This orders the files of an album, so the case that matters is the one that
  // was silently wrong: `10` sorting before `2` puts the tenth track second.
  const ordered = ['10 - y', '2 - x', '2 - z', '1 - w'].sort(compareNatural);

  assert.deepEqual(ordered, ['1 - w', '2 - x', '2 - z', '10 - y']);
  assert.ok(compareNatural('2 - x', '10 - y') < 0);
  assert.ok(compareNatural('10 - y', '2 - x') > 0);
});

test('ordering does not depend on the host locale', () => {
  // The rule this replaces asked `localeCompare` for `sensitivity: 'base'`,
  // whose ordering comes from the host's ICU data and default locale — so the
  // same unchanged collection would number its tracks differently on two
  // machines. What that option was doing is done here instead, and these are the
  // two things it was doing.
  assert.equal(compareNatural('a', 'A'), 0, 'case is folded');
  assert.equal(compareNatural('Détachment', 'Detachment'), 0, 'accents are folded');
  assert.ok(compareNatural('Björk', 'Blur') < 0, 'and what is folded still orders');
});
