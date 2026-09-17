import { test } from 'node:test';
import assert from 'node:assert/strict';

import { titleFromFileName } from '../src/cue/track-name.ts';

// The album folder names here are the real ones the rule was measured against —
// a name that states a credit is what licenses dropping a field from the file's
// own name, so these strings are the whole of the evidence under test.
const KROOGI = 'Aquarium_-_Archangelsk-2011-Kroogi.com';
const SPLIT = '1994 - Cock E.S.P. + Thirdorgan - Split (Cass, C60)';
const KINO_ROOT = 'Кино ● Каталог Maschina Records';
const KINO_LIVE =
  '1986 ● Концерт «Спасём мир» (ЛДМ, 19.10.1986) (2022, Maschina Records, MASHCD-148)';

test('the scene layout names a track after its own field', () => {
  // Kroogi's rip: `_` for a space, `_-_` between artist and title, the release
  // group glued to the tail. All three are the scene's, none of them is the
  // record's, and only the middle field is the track's.
  assert.equal(
    titleFromFileName('01-aquarium_-_back_to_archangelsk-kroogi.mp3', KROOGI),
    'back to archangelsk',
  );
  assert.equal(titleFromFileName('02-aquarium_-_red_river-kroogi.mp3', KROOGI), 'red river');
});

test('a plain numbered file is its own name without the number', () => {
  assert.equal(
    titleFromFileName('01. Imps Of The Perverse.mp3', 'Greatest Dicks (CD, Comp)'),
    'Imps Of The Perverse',
  );
  assert.equal(
    titleFromFileName('01 - Farewell Dream Treatment (aka Our Dreams is Over).flac', 'Final Chapter'),
    'Farewell Dream Treatment (aka Our Dreams is Over)',
  );
});

test('the scene writes the artist in front of the track, and the folder says which', () => {
  // A split record: every track carries its own player, and no two of them are
  // the same, so nothing about "the album's artist" could find these — the
  // folder *name* can, because it lists both.
  assert.equal(
    titleFromFileName('03. Cock E.S.P. - Great White Organ.mp3', SPLIT),
    'Great White Organ',
  );
  assert.equal(
    titleFromFileName('01. Thirdorgan - Vacuum Device Part I.mp3', SPLIT),
    'Vacuum Device Part I',
  );
});

test('a field the folder never mentions is the track, not the album', () => {
  assert.equal(
    titleFromFileName('01. Some Other Band - A Song.mp3', SPLIT),
    'Some Other Band - A Song',
  );
  assert.equal(titleFromFileName('01. Untitled.mp3', 'Collaboration (Cass, C60)'), 'Untitled');
});

test('dashes inside a title survive; only the leading credit is a field', () => {
  assert.equal(
    titleFromFileName(
      '12. Emil Hagstrom - Annoying Guitar - Annoying Guitarist.mp3',
      '1997 - Cock E.S.P. + Emil Hagstrom - Diary Of A Female Pop Vocalist (Cass)',
    ),
    'Annoying Guitar - Annoying Guitarist',
  );
});

test('a bare number is never eaten by its own rule', () => {
  // `01.mp3` states a number and nothing else. Stripping it would leave a file
  // with no name at all, which is worse than a file named `01`.
  assert.equal(titleFromFileName('01.mp3', 'Untitled Rip'), '01');
});

test('an underscore is a space only where the scene wrote the separator', () => {
  // The folder parser refuses to fold `_` for the same reason: without the
  // written `_-_` there is no evidence this is a scene name, and a title may
  // carry an underscore of its own.
  assert.equal(titleFromFileName('my_cool_track.mp3', 'Untitled Rip'), 'my_cool_track');
});

test('without an album name the file still speaks, it is just not corroborated', () => {
  assert.equal(
    titleFromFileName('01. Cock E.S.P. - Great White Organ.mp3', null),
    'Cock E.S.P. - Great White Organ',
  );
  assert.equal(titleFromFileName('01. Imps Of The Perverse.mp3', ''), 'Imps Of The Perverse');
});

test('an album named after the track does not swallow it', () => {
  // The failure this rule was narrowed against: a file called after the record
  // it holds. Dropping a *trailing* field because the folder agrees would leave
  // `Кино` as the title of `Кино - Спасём мир`.
  assert.equal(
    titleFromFileName('Кино - Спасём мир (MASHCD-148).flac', KINO_LIVE),
    'Кино - Спасём мир (MASHCD-148)',
  );
});

test('a Cyrillic credit is read the same way a Latin one is', () => {
  assert.equal(titleFromFileName('01. Кино - Ночь.mp3', KINO_ROOT), 'Ночь');
});

test('the release group comes off only under the scene separator', () => {
  // `-Destroyer` is glued to its word exactly as `-kroogi` is, and the album
  // name mentions it too. What keeps it is the missing `_-_`: this name is not
  // a scene one, so its glued dash is a hyphen in a title.
  assert.equal(
    titleFromFileName('01. Cock E.S.P. - Amp-Destroyer.mp3', 'Destroyer Sessions'),
    'Cock E.S.P. - Amp-Destroyer',
  );
});
