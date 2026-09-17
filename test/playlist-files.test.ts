import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEntries, readingOf, resolveEntry } from '../src/playlist/files.ts';

/**
 * A `.m3u` in the collection: which songs it names, and whether it is a list at
 * all.
 *
 * The whole of this module is a decision about *folders*, and the collection it
 * was written against has an unambiguous answer: of its 27 playlist files, all
 * 27 name songs from one folder each, and not one reaches outside the folder it
 * sits in. So the curated branch is the one no file in this library exercises —
 * which is exactly the branch a test has to, or it would be a branch nobody has
 * ever run.
 */

test('a playlist file is its paths, and not its comments', () => {
  // The extended form is what most rippers write: every path preceded by an
  // `#EXTINF` line carrying a length and a title. Neither is used — the file
  // says which songs and in what order, and what a song is called is a fact
  // about the song, which the tags and the folder already state.
  const text = [
    '#EXTM3U',
    '#EXTINF:214,Кино - Группа крови',
    '01 - Группа крови.flac',
    '#EXTINF:198,Кино - Закрой за мной дверь',
    '02 - Закрой за мной дверь.flac',
    '',
  ].join('\r\n');

  assert.deepEqual(parseEntries(text), ['01 - Группа крови.flac', '02 - Закрой за мной дверь.flac']);
});

test('a byte-order mark does not become part of the first path', () => {
  // Three bytes a Windows editor writes. Left in place they are the first
  // character of the first entry — one path that cannot be found, in a list
  // where every other one resolves, which reads from outside as a missing file.
  assert.deepEqual(parseEntries('\uFEFF01 - a.flac\n02 - b.flac'), ['01 - a.flac', '02 - b.flac']);
});

test('a path written in quotes is the path, not the quotes', () => {
  assert.deepEqual(parseEntries('"01 - a.flac"\n\'02 - b.flac\''), ['01 - a.flac', '02 - b.flac']);
});

test('a playlist of one folder is the album it sits beside', () => {
  // The ordinary case, and the one every file in this collection is: a `.m3u`
  // beside an album, listing that album. Offering it would put the library into
  // a client's playlist list a second time, folder by folder.
  const reading = readingOf(['01 - a.flac', '02 - b.flac'], '/music/Kino/45');

  assert.equal(reading.verdict, 'redundant');
  assert.equal(reading.entries, 2);
  assert.equal(reading.folders, 1);
});

test('a playlist that reaches into another folder is a list of its own', () => {
  const reading = readingOf(
    ['/music/Kino/45/01.flac', '/music/Tool/Lateralus/01.flac'],
    '/music',
  );

  assert.equal(reading.verdict, 'curated');
  assert.equal(reading.folders, 2);
});

test('a relative step out of the folder counts, and so does an absolute path', () => {
  // Both spellings arrive: a list written by hand walks up (`../Other/01.flac`)
  // and one written by a tool states the whole path. A classification that read
  // only the second would call the first redundant.
  assert.equal(readingOf(['01.flac', '../Other/01.flac'], '/music/Kino/45').verdict, 'curated');
  assert.equal(readingOf(['/music/A/01.flac', '/music/B/01.flac'], '/music').verdict, 'curated');
});

test('a playlist naming nothing is not a list to import', () => {
  // An empty file, or one whose only lines are comments: there is nothing to
  // offer, and calling it curated would create an empty playlist out of a file
  // that says nothing. Both go through the parser, which is where comments stop
  // being entries — handing the verdict a raw `#EXTM3U` would be testing the
  // parser twice and this rule not at all.
  assert.equal(readingOf(parseEntries(''), '/music/Kino/45').verdict, 'redundant');
  assert.equal(readingOf(parseEntries('#EXTM3U\n# a note\n'), '/music/Kino/45').verdict, 'redundant');
});

test('a stream is not a folder and does not make a list curated', () => {
  // A playlist may name a radio stream. No folder will ever hold one, and a
  // classification that counted it would call every album playlist with one
  // stream line a curated list.
  assert.equal(resolveEntry('http://stream.example/radio', '/music/A'), null);
  assert.equal(readingOf(['01.flac', 'http://stream.example/radio'], '/music/A').verdict, 'redundant');
});

test('the same folder spelled twice is one folder', () => {
  // Case-folded on Windows and not elsewhere, which is what the filesystems do.
  // Getting it wrong the other way would call a curated list redundant, so the
  // test pins the platform's own rule.
  const spelled = ['C:\\Music\\Kino\\45\\01.flac', 'c:/music/kino/45/02.flac'];
  const reading = readingOf(spelled, 'C:\\Music\\Kino\\45');

  assert.equal(reading.folders, process.platform === 'win32' ? 1 : 2);
});
