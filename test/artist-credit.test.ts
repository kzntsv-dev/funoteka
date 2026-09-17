import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitCredit } from '../src/artist/credit.ts';

/** The names alone, which is what most assertions care about. */
function names(raw: string): string[] {
  return splitCredit(raw).map((entry) => entry.name);
}

/**
 * The invariant the whole design rests on: reading a credit as a list must not
 * lose the string it was read from. If this holds, "catch maximally" is safe —
 * a wrong split can always be undone, because nothing was thrown away.
 */
function assertRoundTrips(raw: string): void {
  const rebuilt = splitCredit(raw)
    .map((entry) => entry.joinPhrase + entry.name)
    .join('');
  assert.equal(rebuilt, raw, `reassembly of ${JSON.stringify(raw)} must be exact`);
}

test('a lone name is one entry with nothing joining it', () => {
  assert.deepEqual(splitCredit('Cock E.S.P.'), [{ name: 'Cock E.S.P.', joinPhrase: '' }]);
});

test('a plus splits, and the phrase keeps its spaces verbatim', () => {
  const entries = splitCredit('Cock E.S.P. + Thirdorgan');

  assert.deepEqual(entries, [
    { name: 'Cock E.S.P.', joinPhrase: '' },
    { name: 'Thirdorgan', joinPhrase: ' + ' },
  ]);
  assertRoundTrips('Cock E.S.P. + Thirdorgan');
});

test('every real collaboration form on the sample splits', () => {
  // Taken from the tags of Cock E.S.P, which is where the joined strings live.
  assert.deepEqual(names('Merzbow & Cock E.S.P.'), ['Merzbow', 'Cock E.S.P.']);
  assert.deepEqual(names('Violent Onsen Geisha / Cock E.S.P.'), ['Violent Onsen Geisha', 'Cock E.S.P.']);
  assert.deepEqual(names('Aube / Cock E.S.P.'), ['Aube', 'Cock E.S.P.']);
  assert.deepEqual(names('Arvo Zylo + Cock E.S.P.'), ['Arvo Zylo', 'Cock E.S.P.']);
  assert.deepEqual(names('Evil Moisture & Cock E.S.P.'), ['Evil Moisture', 'Cock E.S.P.']);
  assert.deepEqual(names('Cock E.S.P. + Panicsville'), ['Cock E.S.P.', 'Panicsville']);
  assert.deepEqual(names('Suffering Bastard + Cock E.S.P.'), ['Suffering Bastard', 'Cock E.S.P.']);
});

test('a word joins only when it stands alone as a word', () => {
  // The measurement that shaped this rule: a bare token matched anywhere turns
  // an artist's own name into two artists, and it is not a near-miss.
  assert.deepEqual(names('Extreme Noise Terror'), ['Extreme Noise Terror']);
  assert.deepEqual(names('The Nihilist Spasm Band'), ['The Nihilist Spasm Band']);
  assert.deepEqual(names('Andrew Bird'), ['Andrew Bird']);
  assert.deepEqual(names('Xzibit'), ['Xzibit']);

  // ...and when it does stand alone, it joins.
  assert.deepEqual(names('Simon and Garfunkel'), ['Simon', 'Garfunkel']);
  assert.deepEqual(names('Malcolm X and Xzibit'), ['Malcolm X', 'Xzibit']);
});

test('a capital X is a name, not a joiner', () => {
  // 'Malcolm X' is one artist; the token is only ever the lower-case word.
  assert.deepEqual(names('Malcolm X'), ['Malcolm X']);
});

test('the phrases a human wrote survive in the entry they joined', () => {
  const entries = splitCredit('Merzbow & Cock E.S.P.');

  assert.equal(entries[1]?.joinPhrase, ' & ');
  // No space around the symbol is a different string, and stays different.
  assert.equal(splitCredit('Merzbow&Cock E.S.P.')[1]?.joinPhrase, '&');
});

test('what the rules cannot know, they do not hide', () => {
  // `Smell & Quim` is ONE artist, and no rule available to a core with no
  // external knowledge can tell it from a collaboration. It splits — and the
  // original string is kept on the album row precisely so this stays visible
  // rather than becoming a quiet lie.
  assert.deepEqual(names('Smell & Quim'), ['Smell', 'Quim']);
  assert.deepEqual(names('Florence + the Machine'), ['Florence', 'the Machine']);

  // The nested case is worse, and honest about it: three parts where the truth
  // is two (`Cock E.S.P.` + `Smell & Quim`).
  assert.deepEqual(names('Cock E.S.P. & Smell & Quim'), [
    'Cock E.S.P.',
    'Smell',
    'Quim',
  ]);
  assertRoundTrips('Cock E.S.P. & Smell & Quim');
});

test('the original round-trips for every form, split or not', () => {
  for (const raw of [
    'Cock E.S.P.',
    'Cock E.S.P. + Thirdorgan',
    'Merzbow & Cock E.S.P.',
    'Aube / Cock E.S.P.',
    'Smell & Quim',
    'Florence + the Machine',
    'The Gerogerigegege',
    'Кино',
    'Виктор Цой',
    'Cock E.S.P. feat. Thirdorgan',
    'Coil vs ELpH',
  ]) {
    assertRoundTrips(raw);
  }
});

test('a joiner at either end is part of the name, not a split', () => {
  // A trailing `&` would otherwise produce an entry with an empty name, and
  // the round-trip would be broken for exactly the malformed input that most
  // needs it kept.
  assert.deepEqual(names('&'), ['&']);
  assert.deepEqual(names('Cock E.S.P. +'), ['Cock E.S.P. +']);
});

test('whitespace around the whole credit is not part of any name', () => {
  const entries = splitCredit('  Cock E.S.P. + Thirdorgan  ');

  assert.deepEqual(entries.map((e) => e.name), ['Cock E.S.P.', 'Thirdorgan']);
  // Outer whitespace is the one thing not reproduced, and that is deliberate:
  // a name with a leading space is a name that sorts wrongly forever.
  assert.equal(
    entries.map((e) => e.joinPhrase + e.name).join(''),
    'Cock E.S.P. + Thirdorgan',
  );
});
