import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { classify } from '../src/classify/classify.ts';
import { applyCues } from '../src/cue/engine.ts';
import { openDb } from '../src/db/index.ts';
import { applyPlaylists } from '../src/playlist/import.ts';
import * as store from '../src/playlist/store.ts';
import type { Probe } from '../src/probe/ffprobe.ts';
import { scan } from '../src/scan/scan.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The playlist files a collection carries, weighed against the meta layer.
 *
 * Runs on disk and through the real stages, because the question is about a
 * file's *contents* measured against where its entries point — a fixture that
 * handed `applyPlaylists` a string would be testing the parser twice and the
 * stage not at all.
 *
 * Two folders, each an image with a cue, so that a list naming both is a curated
 * list and a list naming one is its album.
 */
const CUE = (image: string, tracks: [string, string][]): string =>
  `TITLE "${image}"
FILE "${image}.flac" WAVE
${tracks
  .map(([name, at], n) => `TRACK ${String(n + 1).padStart(2, '0')} AUDIO\nTITLE "${name}"\nINDEX 01 ${at}`)
  .join('\n')}
`;

const probe: (absPath: string) => Probe = () => ({
  durationMs: 8 * 60_000,
  codec: 'flac',
  sampleRate: 44100,
  channels: 2,
  bitrate: 1000,
  ok: true,
  err: null,
});

function fixture(tree: Record<string, string>): string {
  const root = tempRoot('funoteka-lists-');
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function build(db: ReturnType<typeof openDb>, root: string): void {
  scan(db, [root]);
  classify(db);
  applyCues(db, { probe });
}

const COLLECTION = {
  'Kino/45/Kino.flac': 'audio',
  'Kino/45/Kino.cue': CUE('Kino', [
    ['Группа крови', '00:00:00'],
    ['Закрой за мной дверь', '04:00:00'],
  ]),
  'Tool/Lateralus/Tool.flac': 'audio',
  'Tool/Lateralus/Tool.cue': CUE('Tool', [['The Grudge', '00:00:00']]),
};

test('a playlist listing one album is ignored, and the issue says why', () => {
  // The ordinary case, and the one every playlist file in this collection is.
  // Offering it would list the album a second time in a client's playlists.
  const root = fixture({
    ...COLLECTION,
    'Kino/45/45.m3u': '#EXTM3U\nKino.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);

  const counters = applyPlaylists(db);

  assert.equal(counters.files, 1);
  assert.equal(counters.redundant, 1);
  assert.equal(counters.imported, 0);
  assert.deepEqual(store.playlists(db), [], 'no playlist was made');

  const issue = db
    .prepare("SELECT severity, detail FROM issue WHERE stage = 'playlists' AND kind = 'playlist-redundant'")
    .get() as { severity: string; detail: string } | undefined;
  assert.ok(issue, 'and the drop is said out loud');
  assert.equal(issue.severity, 'info');
  assert.match(issue.detail, /1 folder/);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a playlist reaching into another folder becomes a playlist', () => {
  const root = fixture({
    ...COLLECTION,
    'list.m3u': '#EXTM3U\nKino/45/Kino.flac\nTool/Lateralus/Tool.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);

  const counters = applyPlaylists(db);

  assert.equal(counters.curated, 1);
  assert.equal(counters.imported, 1);

  const [made] = store.playlists(db);
  assert.equal(made?.name, 'list', 'named after the file, without its extension');
  assert.equal(made?.song_count, 3, 'two songs of the first image, one of the second');

  // Joined and ordered outside, not through `IN (… ORDER BY …)`: an ordering
  // inside a subquery is discarded by the set it feeds, and this assertion is
  // about the order the playlist holds.
  const songs = db
    .prepare(
      `SELECT t.title AS title FROM playlist_track pt
         JOIN track t ON t.id = pt.track_id
        WHERE pt.playlist_id = 1
        ORDER BY pt.position`,
    )
    .all() as { title: string }[];
  assert.deepEqual(songs.map((one) => one.title), ['Группа крови', 'Закрой за мной дверь', 'The Grudge']);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('reading the same file again updates its playlist instead of making another', () => {
  // The file is what the list is: a second scan must find the row it made, or
  // a daily scan would leave a playlist per day.
  const root = fixture({
    ...COLLECTION,
    'list.m3u': '#EXTM3U\nKino/45/Kino.flac\nTool/Lateralus/Tool.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);
  applyPlaylists(db);
  const first = store.playlists(db)[0];

  // The list changes: the image it already named is named once more, at the end.
  writeFileSync(join(root, 'list.m3u'), '#EXTM3U\nKino/45/Kino.flac\nTool/Lateralus/Tool.flac\nKino/45/Kino.flac\n');
  build(db, root);
  const counters = applyPlaylists(db);

  const after = store.playlists(db);
  assert.equal(after.length, 1, 'still one playlist, not two');
  assert.equal(after[0]?.id, first?.id, 'and it is the same one');
  assert.equal(counters.imported, 1);
  // The image again, at the end, and an image is two songs: the same file may
  // sit in a playlist more than once, and this one now does.
  assert.equal(after[0]?.song_count, 5, 'with what the file now says');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a file that stops being a list takes its playlist with it', () => {
  // Edited down to its own folder, the file no longer asks for a playlist, and
  // a stale one left behind would be a list the collection does not have.
  const root = fixture({
    ...COLLECTION,
    'list.m3u': '#EXTM3U\nKino/45/Kino.flac\nTool/Lateralus/Tool.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);
  applyPlaylists(db);
  assert.equal(store.playlists(db).length, 1);

  writeFileSync(join(root, 'list.m3u'), '#EXTM3U\nKino/45/Kino.flac\n');
  build(db, root);
  applyPlaylists(db);

  assert.deepEqual(store.playlists(db), [], 'the playlist went with the list');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a deleted playlist file leaves nothing behind', () => {
  const root = fixture({
    ...COLLECTION,
    'list.m3u': '#EXTM3U\nKino/45/Kino.flac\nTool/Lateralus/Tool.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);
  applyPlaylists(db);

  rmSync(join(root, 'list.m3u'));
  build(db, root);

  assert.deepEqual(store.playlists(db), [], 'the list is the file, and the file is gone');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('an entry that names no song here is counted, and the rest is imported', () => {
  // A list made on another machine names music this library does not have. The
  // songs that are here are worth having; the ones that are not are said out
  // loud rather than dropped.
  const root = fixture({
    ...COLLECTION,
    'list.m3u': '#EXTM3U\nKino/45/Kino.flac\n../Elsewhere/Gone.flac\nTool/Lateralus/Tool.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);

  const counters = applyPlaylists(db);

  assert.equal(counters.entriesMissing, 1);
  assert.equal(counters.imported, 1);
  assert.equal(store.playlists(db)[0]?.song_count, 3, 'the two images that are here');

  const issue = db
    .prepare("SELECT detail FROM issue WHERE kind = 'playlist-entries-missing'")
    .get() as { detail: string } | undefined;
  assert.match(issue?.detail ?? '', /1 of 3 entries/);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a list naming nothing this library holds imports nothing', () => {
  // An empty playlist would be a promise the library cannot keep — a client
  // opens it and finds silence with no explanation.
  const root = fixture({
    ...COLLECTION,
    // Two folders, neither of them here: the list is curated by where it
    // points, so the verdict is not what is being questioned — what happens
    // when nothing in it lands is.
    'list.m3u': '#EXTM3U\n../Elsewhere/Gone.flac\n../Other/Too.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);

  const counters = applyPlaylists(db);

  assert.equal(counters.curated, 1);
  assert.equal(counters.imported, 0);
  assert.deepEqual(store.playlists(db), []);
  const issue = db
    .prepare("SELECT kind FROM issue WHERE kind = 'playlist-nothing-imported'")
    .get() as { kind: string } | undefined;
  assert.ok(issue);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a .pls is reported as unread rather than read as a .m3u', () => {
  // A different document — an INI with numbered `FileN=` keys. Read as a bare
  // list it yields no entries at all, and "redundant" would be the answer to a
  // question nobody asked.
  const root = fixture({ ...COLLECTION, 'list.pls': '[playlist]\nFile1=Kino/45/Kino.flac\n' });
  const db = openDb(':memory:');
  build(db, root);

  applyPlaylists(db);

  const issue = db
    .prepare("SELECT kind, detail FROM issue WHERE kind = 'playlist-format-not-read'")
    .get() as { detail: string } | undefined;
  assert.match(issue?.detail ?? '', /\.pls/);
  assert.deepEqual(store.playlists(db), []);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a scan that changes nothing does not move the playlist', () => {
  // `changed_at` is what a client syncs by, and a scan is not a change to the
  // playlist. Rewriting the row every run would make every client re-read every
  // imported list because a scan ran.
  const root = fixture({
    ...COLLECTION,
    'list.m3u': '#EXTM3U\nKino/45/Kino.flac\nTool/Lateralus/Tool.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);
  applyPlaylists(db);
  const before = store.playlists(db)[0];

  build(db, root);
  const counters = applyPlaylists(db);

  const after = store.playlists(db)[0];
  assert.equal(counters.unchanged, 1, 'the file said what the playlist already said');
  assert.equal(after?.changed_at, before?.changed_at, 'so nothing was written');
  assert.equal(after?.song_count, before?.song_count);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a file that stops naming anything here loses its playlist', () => {
  // Curated by where it points, and then it points at music this library does
  // not have: the row it made is no longer what the file says, and leaving it
  // would be a list the collection does not have. Deleting the file is the
  // other way this happens and is tested below; this is the file staying and
  // its contents ceasing to land.
  const root = fixture({
    ...COLLECTION,
    'list.m3u': '#EXTM3U\nKino/45/Kino.flac\nTool/Lateralus/Tool.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);
  applyPlaylists(db);
  assert.equal(store.playlists(db).length, 1);

  writeFileSync(join(root, 'list.m3u'), '#EXTM3U\n../Elsewhere/Gone.flac\n../Other/Too.flac\n');
  build(db, root);
  const counters = applyPlaylists(db);

  assert.deepEqual(store.playlists(db), [], 'the row went with the reading');
  assert.equal(counters.imported, 0);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a list carried from another machine says so rather than blaming the folder', () => {
  // Every entry in one folder, and not one of them a file this library has: the
  // verdict is still redundant, but the reason a client is shown must not be
  // "the folder already offers this" — the folder offers nothing of the kind.
  const root = fixture({
    ...COLLECTION,
    '45.m3u': '#EXTM3U\nD:/Music/Kino/45/01.flac\nD:/Music/Kino/45/02.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);

  applyPlaylists(db);

  const issue = db
    .prepare("SELECT detail FROM issue WHERE kind = 'playlist-redundant'")
    .get() as { detail: string } | undefined;
  assert.match(issue?.detail ?? '', /2 of them naming nothing here/);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('two files with the same name are two lists a client can tell apart', () => {
  // `A/list.m3u` and `B/list.m3u` are two lists, and a sidebar showing `list`
  // twice is a sidebar where one of them cannot be chosen. The name is what a
  // person reads — the row is found by its file either way — so the folder goes
  // into it, the way a record whose name collides gains its own note.
  const root = fixture({
    ...COLLECTION,
    'A/list.m3u': '#EXTM3U\n../Kino/45/Kino.flac\n../Tool/Lateralus/Tool.flac\n',
    'B/list.m3u': '#EXTM3U\n../Tool/Lateralus/Tool.flac\n../Kino/45/Kino.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);

  applyPlaylists(db);

  const names = store.playlists(db).map((one) => one.name).sort();
  assert.deepEqual(names, ['list', 'list (B)']);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a file whose name begins with two dots is a file, not a step out of the root', () => {
  // `..odd.flac` lies in the root and is a file; `../odd.flac` is outside it.
  // A bare `startsWith('..')` reads the first as the second and drops an entry
  // that is right there.
  const root = fixture({
    ...COLLECTION,
    '..odd.flac': 'audio',
    'list.m3u': '#EXTM3U\n..odd.flac\nKino/45/Kino.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);

  const counters = applyPlaylists(db);

  assert.equal(counters.entriesMissing, 0, 'both entries are here');
  assert.equal(store.playlists(db)[0]?.song_count, 3, 'the odd file and the two of the image');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('an unchanged file is not read off disk again', () => {
  // The bytes are decoded once and kept, so a scan over a library whose lists
  // did not change reads no list at all. Pinned by handing the stage a reader
  // that refuses to be called a second time.
  const root = fixture({
    ...COLLECTION,
    'list.m3u': '#EXTM3U\nKino/45/Kino.flac\nTool/Lateralus/Tool.flac\n',
  });
  const db = openDb(':memory:');
  build(db, root);
  applyPlaylists(db);

  build(db, root);
  const counters = applyPlaylists(db, {
    readBytes: () => {
      throw new Error('the file was read again');
    },
  });

  assert.equal(counters.unreadable, 0, 'nothing was read, so nothing failed');
  assert.equal(counters.filesRead, 0, 'and the counter says so');
  assert.equal(counters.files, 1, 'the file was still taken up and weighed');
  assert.equal(counters.curated, 1, 'the verdict is reached again — from the cached text');
  assert.equal(store.playlists(db).length, 1);

  db.close();
  rmSync(root, { recursive: true, force: true });
});
