import { test } from 'node:test';
import assert from 'node:assert/strict';

import { artistFolderOf, qualifiedKey } from '../src/artist/folder.ts';
import { artistName } from '../src/artist/name.ts';

// The folder a key came from, which is what tells two same-named artists apart.
// Pure function, bounded input, so these are input/output pairs with no fixture
// and no database (tdd-criteria, ironclad rule 2).

test('the outermost ancestor named like the artist is the artist folder', () => {
  assert.deepEqual(
    artistFolderOf({ albumRelPath: 'Music/Nirvana/Nevermind', rootPath: '/m', key: 'nirvana' }),
    { id: '/m:Music/Nirvana', rootPath: '/m', relPath: 'Music/Nirvana' },
  );

  assert.equal(
    artistFolderOf({ albumRelPath: 'Nirvana/Sub/Nirvana/Album', rootPath: '/m', key: 'nirvana' })
      ?.relPath,
    'Nirvana',
    'the outer of the two, not the one nearest the album',
  );
});

test('a record named after its own band is not a second artist folder', () => {
  // The band's self-titled record sits at `Artist/Artist/…`, so the record
  // carries the artist's name exactly as the artist folder does. Reading the
  // nearest match makes the record a second artist and splits one band in two.
  assert.equal(
    artistFolderOf({
      albumRelPath: 'Music/Nirvana/Nirvana/Disc 1',
      rootPath: '/m',
      key: 'nirvana',
    })?.relPath,
    'Music/Nirvana',
  );

  // One level deeper, for the same reason.
  assert.equal(
    artistFolderOf({
      albumRelPath: 'Music/Nirvana/Nirvana/Sub/Album',
      rootPath: '/m',
      key: 'nirvana',
    })?.relPath,
    'Music/Nirvana',
  );
});

// The measured trap (wiki:3519): one name literally contains the other, and
// they are two different bands. Anything but whole-name equality merges them.
test('a folder that merely contains the name is not the artist folder', () => {
  assert.equal(
    artistFolderOf({ albumRelPath: 'Music/Nirvana Tribute/Album', rootPath: '/m', key: 'nirvana' }),
    null,
  );
  assert.equal(
    artistFolderOf({ albumRelPath: 'Странные игры/Album', rootPath: '/m', key: 'игры' }),
    null,
    'Странные игры is not Игры',
  );
  assert.equal(
    artistFolderOf({ albumRelPath: 'Игры/Album', rootPath: '/m', key: 'игры' })?.relPath,
    'Игры',
    'and Игры itself still matches',
  );
});

test('an album folder is not an artist folder, however it is named', () => {
  // `Music/Nirvana` here is the album, not the artist. The only folder above it
  // is `Music`, which is not the band, so there is no artist folder to find.
  assert.equal(
    artistFolderOf({ albumRelPath: 'Music/Nirvana', rootPath: '/m', key: 'nirvana' }),
    null,
  );

  // And an album that *is* its root has nothing above it at all — the root is
  // its own folder, and a record's folder is never its artist's.
  assert.equal(
    artistFolderOf({ albumRelPath: '', rootPath: '/m/Кино', key: 'кино' }),
    null,
  );
});

test('the root itself can be the artist folder, Windows separators and all', () => {
  // The root is the one path that does not come from the walk, and on Windows
  // `realpathSync.native` hands it back with backslashes. Reading a basename off
  // it naively yields the whole path, the match never fires, and the showcase
  // passes on Linux while failing on the machine this runs on.
  assert.deepEqual(
    artistFolderOf({
      albumRelPath: '1989 ● Последний герой',
      rootPath: 'C:\\Users\\demo\\Downloads\\Кино',
      key: 'кино',
    }),
    {
      id: 'C:\\Users\\demo\\Downloads\\Кино:',
      rootPath: 'C:\\Users\\demo\\Downloads\\Кино',
      relPath: '',
    },
  );
});

test('a root that only looks like the artist is not one', () => {
  // The other half of the real Кино collection: an album root whose name does
  // not reduce to the key. It has no artist folder, and that is what keeps the
  // band one artist across both roots.
  assert.equal(
    artistFolderOf({
      albumRelPath: '1989 ● Последний герой',
      rootPath: '/d/Кино ● Каталог Maschina Records',
      key: 'кино',
    }),
    null,
  );
});

test('an album with no artist folder anywhere above it has none', () => {
  assert.equal(artistFolderOf({ albumRelPath: 'Music/Some Album', rootPath: '/m', key: 'nirvana' }), null);
  assert.equal(artistFolderOf({ albumRelPath: 'Album', rootPath: '/m', key: 'nirvana' }), null);
});

test('the folder name is read at the key level, so an inverted spelling still matches', () => {
  // `Cure, The` and a folder called `The Cure` are the same artist — that is the
  // reduction the key already performs, so the folder lookup uses it too.
  assert.equal(
    artistFolderOf({ albumRelPath: 'Music/The Cure/Pornography', rootPath: '/m', key: 'cure' })
      ?.relPath,
    'Music/The Cure',
  );
});

test('an empty key finds no folder at all', () => {
  // `artistName('The').key` is '', and matching on it would let the first
  // folder whose name is also not a name — `The` itself — become an artist.
  assert.equal(artistFolderOf({ albumRelPath: 'Music/The/Album', rootPath: '/m', key: '' }), null);
});

test('a suffix cannot collide with a base key', () => {
  // The invariant is not "`#` never appears in a key" — an artist named `#` keys
  // to `#` through the symbol-only fallback. It is that a key containing `#` has
  // no letter or digit anywhere (that is the only way the fallback fires), while
  // a suffixed key always ends in one. The sets cannot meet.
  assert.equal(artistName('#').key, '#', 'the fallback really does produce a key with # in it');

  assert.equal(qualifiedKey('nirvana', 0), 'nirvana');
  assert.equal(qualifiedKey('nirvana', 1), 'nirvana#2');
  assert.equal(qualifiedKey('#', 1), '##2');

  assert.notEqual(artistName('##2').key, '##2', 'a name reading `##2` keys to `2`, not to itself');
  assert.equal(artistName('##2').key, '2');
  assert.equal(artistName('nirvana#2').key, 'nirvana 2');
});
