import { test } from 'node:test';
import assert from 'node:assert/strict';

import { biographyOf } from '../src/artist/nfo.ts';

/**
 * What an artist's `.nfo` says about them.
 *
 * The collection's own note about an artist — written by Jellyfin, sitting in
 * the folder named for them — is the one offline source of a biography this
 * project has. It is an XML document the scan never parsed: `.nfo` files are
 * recorded as files and their text is not in the meta layer, so the answer is
 * read out of the document here, once, at the point a client asks for it.
 *
 * The shape below is the real one: a UTF-8 document with a byte-order mark, a
 * `<biography>` holding the long text, an `<outline>` holding a short one, and
 * entities where the text had an ampersand.
 */

const DOCUMENT = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<artist>
  <plot>Ignored.</plot>
  <outline>A short line, not the biography.</outline>
  <biography>The Cure are an English rock band formed in Crawley in 1976.</biography>
  <musicbrainzartistid>69ee3720-a7cb-4402-bd9c-15d1f5f7c4e0</musicbrainzartistid>
</artist>`;

test('the biography is read out of the artist document', () => {
  assert.equal(
    biographyOf(DOCUMENT),
    'The Cure are an English rock band formed in Crawley in 1976.',
  );
});

test('the outline is not mistaken for the biography', () => {
  const onlyOutline = `<artist><outline>A short line.</outline></artist>`;
  assert.equal(biographyOf(onlyOutline), null, 'a summary is not the long text');
});

test('an absent biography answers with nothing rather than with a summary', () => {
  assert.equal(biographyOf(`<artist><title>Tool</title></artist>`), null);
});

test('an empty biography is nothing, not an empty string', () => {
  assert.equal(biographyOf(`<artist><biography></biography></artist>`), null);
  assert.equal(biographyOf(`<artist><biography>   \n  </biography></artist>`), null);
});

test('entities are unescaped, because the text is what a client shows', () => {
  assert.equal(
    biographyOf(`<artist><biography>Siouxsie &amp; the Banshees</biography></artist>`),
    'Siouxsie & the Banshees',
  );
});

test('an entity the document cannot mean is left as it was written', () => {
  // A note read off disk is somebody else's file, and a document that is not
  // well-formed XML can still be read. `&#1114112;` is one past the last code
  // point Unicode has and `String.fromCodePoint` refuses it; a surrogate is a
  // number XML's own `Char` production excludes. Neither is a character this
  // reader can resolve, so neither is resolved — and neither throws: the caller
  // has no other place to catch a malformed file, and a biography that cannot
  // be read is a biography the artist does not have.
  assert.equal(
    biographyOf(`<artist><biography>Before &#1114112; after</biography></artist>`),
    'Before &#1114112; after',
  );
  assert.equal(
    biographyOf(`<artist><biography>x&#x110000;y</biography></artist>`),
    'x&#x110000;y',
  );
  assert.equal(
    biographyOf(`<artist><biography>n&#999999999;m</biography></artist>`),
    'n&#999999999;m',
  );
  assert.equal(
    biographyOf(`<artist><biography>a&#xD800;b</biography></artist>`),
    'a&#xD800;b',
    'a lone surrogate is not a character XML has',
  );
});

test('a byte-order mark does not hide the document', () => {
  assert.equal(biographyOf(`﻿${DOCUMENT}`), biographyOf(DOCUMENT));
});

test('the text keeps its own lines, and loses only the whitespace around it', () => {
  assert.equal(
    biographyOf(`<artist><biography>\n  First line.\n  Second line.\n</biography></artist>`),
    'First line.\n  Second line.',
  );
});
