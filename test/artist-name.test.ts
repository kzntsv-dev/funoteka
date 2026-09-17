import { test } from 'node:test';
import assert from 'node:assert/strict';

import { artistName } from '../src/artist/name.ts';

/**
 * The two levels are the whole idea, so most of these assert both at once.
 *
 * `folded` normalises only what is obviously the same record — case,
 * punctuation, whitespace, the definite article. `key` goes further and also
 * drops a disambiguator. The gap between them is exactly where a merge stops
 * being obvious, which is what the ambiguity flag reads.
 */

test('the definite article is folded away whichever end it is on', () => {
  const written = artistName('The Cure');
  const inverted = artistName('Cure, The');
  const bare = artistName('cure');

  assert.equal(written.key, 'cure');
  assert.equal(inverted.key, 'cure');
  assert.equal(bare.key, 'cure');

  // All three names are one artist, and none of them needed anything thrown
  // away to say so.
  assert.equal(written.folded, 'cure');
  assert.equal(inverted.folded, 'cure');
  assert.equal(bare.folded, 'cure');
  assert.equal(written.stripped, null);
});

test('the name as written survives untouched', () => {
  const result = artistName('  The   Cure  ');

  assert.equal(result.name, 'The Cure', 'tidy, but the artist is still called that');
});

test('a sort key puts the article last, and does not invert twice', () => {
  assert.equal(artistName('The Cure').sortKey, 'Cure, The');
  assert.equal(artistName('Cure, The').sortKey, 'Cure, The');
  assert.equal(artistName('Cure').sortKey, 'Cure');
});

test('case and punctuation do not survive the fold', () => {
  assert.equal(artistName('guns n roses').key, artistName("Guns N' Roses").key);
  assert.equal(artistName('Guns N’ Roses').key, artistName("Guns N' Roses").key);
  assert.equal(artistName('Guns N’ Roses').key, 'guns n roses');
});

test('a disambiguator is dropped from the key but kept in the fold', () => {
  // This is the case the flag exists for: `(UK)` is a human saying "there is
  // more than one of these". Dropping it merges two artists, and the fold
  // still remembers they were written differently.
  const result = artistName('Nirvana (UK)');

  assert.equal(result.key, 'nirvana');
  assert.equal(result.folded, 'nirvana uk');
  assert.equal(result.stripped, 'UK');
  assert.equal(result.name, 'Nirvana (UK)', 'the name a human sees keeps the warning');
});

test('an inverted article still folds when a disambiguator follows it', () => {
  // Regression. Dropping `(UK)` used to leave a trailing space, so the article
  // regex — anchored at the end of the string — never matched, and `Cure, The
  // (UK)` keyed as `cure the` while `Cure, The` keyed as `cure`: one artist,
  // two rows, on exactly the example the contract names.
  assert.equal(artistName('Cure, The (UK)').key, 'cure');
  assert.equal(artistName('Cure, The').key, 'cure');
  assert.equal(artistName('The Cure (UK)').key, 'cure');
});

test('a name of pure punctuation is still a name', () => {
  // `!!!` and `∆` are artists. Folding them away as if they were the empty
  // string would drop those albums silently — and, worse, give every
  // symbol-only act the same empty key to merge into.
  assert.equal(artistName('!!!').key, '!!!');
  assert.equal(artistName('∆').key, '∆');
  assert.notEqual(artistName('!!!').key, artistName('∆').key);
});

test('square brackets disambiguate too', () => {
  const result = artistName('Nirvana [US]');

  assert.equal(result.key, 'nirvana');
  assert.equal(result.stripped, 'US');
});

test('a name that is nothing but an article has no key', () => {
  // Not an artist. The caller has to be able to tell, rather than creating a
  // row called `the` that every such album then merges into.
  assert.equal(artistName('The').key, '');
  assert.equal(artistName('   ').key, '');
  assert.equal(artistName('').key, '');
});

test('a name that is a suffix of another is not folded into it', () => {
  // From the collection: `Игры` is a band that formed out of `Странные игры`
  // after the latter broke up. One name contains the other, so anything
  // reaching for substring or prefix matching merges two real, distinct acts —
  // and the relationship between them is not something a scanner can know.
  assert.equal(artistName('Игры').key, 'игры');
  assert.equal(artistName('Странные игры').key, 'странные игры');
  assert.notEqual(artistName('Игры').key, artistName('Странные игры').key);
});

test('a non-Latin name is left alone', () => {
  const result = artistName('Кино');

  assert.equal(result.name, 'Кино');
  assert.equal(result.key, 'кино');
  assert.equal(result.sortKey, 'Кино');
  assert.equal(result.stripped, null);
});

test('a parenthetical that is not a disambiguator is still stripped, and reported', () => {
  // `(Live)` on an artist name is odd, but the module cannot tell it from a
  // disambiguator, and guessing in the other direction would merge nothing.
  // It strips, says what it stripped, and lets the flag carry the doubt.
  const result = artistName('Portishead (Live)');

  assert.equal(result.key, 'portishead');
  assert.equal(result.stripped, 'Live');
});

test('an initialism with dots folds to the same key as one without', () => {
  // The collection holds both spellings of one act — twelve albums under
  // `Cock E.S.P.`, two under `Cock Esp` — and they were two rows with no flag
  // between them, because the fold turned the dots into spaces and left
  // `cock e s p` beside `cock esp`. Punctuation is the same class as case here,
  // and a dot inside a word is part of the word.
  assert.equal(artistName('Cock E.S.P.').folded, artistName('Cock Esp').folded);
  assert.equal(artistName('Cock E.S.P.').key, artistName('Cock Esp').key);
  assert.equal(artistName('Cock E.S.P.').key, 'cock esp');

  // What the fold does not touch: the name a human sees keeps its dots.
  assert.equal(artistName('Cock E.S.P.').name, 'Cock E.S.P.');
});

test('a dot standing between two words is still a separator', () => {
  // The narrowing that keeps the rule above off names that are not
  // initialisms: `Dr. Dre` has a space after its dot, and the dot was the
  // separator that space was standing in for.
  assert.equal(artistName('Dr. Dre').folded, 'dr dre');
  assert.equal(artistName('St. Vincent').folded, 'st vincent');
  assert.notEqual(artistName('Dr. Dre').folded, 'drdre');
});

test('a spelling that lost its accent is the same artist', () => {
  // Measured over the live collection, these are the only two pairs this
  // merges, and every other name in it is untouched.
  //
  // The claim is about the collection rather than about Unicode: an unaccented
  // spelling is nearly always a tag that lost its accent, not a name written
  // differently on purpose. The opposite would be a collector deliberately
  // typing `Royksopp`, and nobody does that.
  assert.equal(artistName('Royksopp').key, artistName('Röyksopp').key);
  assert.equal(artistName('Sigur Ros').key, artistName('Sigur Rós').key);

  // The fold is not a transliteration, and scripts are left alone: `Кино` and
  // `Kino` stay two keys, because Cyrillic-to-Latin is a mapping between
  // alphabets rather than a fold, and `translit.ts` is where that is argued.
  assert.notEqual(artistName('Кино').key, artistName('Kino').key);
  assert.notEqual(artistName('Аквариум').key, artistName('Aquarium').key);
});

test('an accent written two ways is one key', () => {
  // `ö` as one code point and as `o` plus U+0308 are the same letter, and a
  // tree ripped on macOS stores the second while a tag usually holds the first.
  // Decomposing before the marks come off is what makes both answers the same
  // one — and it is also what makes `Bjork`, with no mark at all, join them.
  assert.equal(artistName('Björk').key, artistName('Björk').key);
  assert.equal(artistName('Björk').key, 'bjork');

  // The name a human is shown keeps its accent; only the key loses it.
  assert.equal(artistName('Röyksopp').name, 'Röyksopp');
});

test('a name written entirely in brackets is the name', () => {
  // `[LINKIN PARK]` is how a file states the artist, not a qualifier of one, and
  // stripping it left an empty name — which the key reads as "not a name". So
  // one act the collection writes two ways became two identities, one of them
  // nameless, and thirteen records of `Linkin Park Japan CD` carried no album
  // artist at all: the credit was claimed and then dropped for having no key
  // (task:2837). Measured on the live collection: the stage gains exactly those
  // thirteen, loses none, and creates no new artist row.
  assert.equal(artistName('[LINKIN PARK]').key, artistName('Linkin Park').key);
  assert.equal(artistName('[LINKIN PARK]').key, 'linkin park');

  // A bracket that *qualifies* a name still does, which is what the rule is for.
  assert.equal(artistName('Cure, The (UK)').key, 'cure');
  assert.equal(artistName('Nirvana (UK)').key, 'nirvana');
});
