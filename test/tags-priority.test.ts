import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { applyArtists } from '../src/artist/apply.ts';
import { classify } from '../src/classify/classify.ts';
import { applyCues } from '../src/cue/engine.ts';
import { openDb } from '../src/db/index.ts';
import type { Probe } from '../src/probe/ffprobe.ts';
import { scan } from '../src/scan/scan.ts';
import { applyTags } from '../src/tags/apply.ts';
import { flac, id3v2 } from './helpers/bytes.ts';
import { tempRoot } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDb>;

const IMAGE_CUE = `PERFORMER "Tangerine Dream"
TITLE "Green Desert"
FILE "Green Desert.flac" WAVE
TRACK 01 AUDIO
TITLE "Green Desert"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "White Clouds"
INDEX 01 19:24:00
`;

function fixture(tree: Record<string, string | Buffer>): string {
  const root = tempRoot('funoteka-priority-');
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function probeReturning(durationMs: number): (absPath: string) => Probe {
  return () => ({
    durationMs,
    codec: 'flac',
    sampleRate: 44100,
    channels: 2,
    bitrate: 1000,
    ok: true,
    err: null,
  });
}

/** The whole pipeline, in the order the contract puts it in. */
function run(root: string, db: Db): void {
  scan(db, [root]);
  classify(db);
  applyTags(db);
  applyCues(db, { probe: probeReturning(2_100_000) });
  applyArtists(db);
}

function albumOf(db: Db, relPath: string): { title: string | null; title_source: string | null } {
  const row = db
    .prepare('SELECT title, title_source FROM album WHERE rel_path = ?')
    .get(relPath) as { title: string | null; title_source: string | null } | undefined;
  assert.ok(row !== undefined, `no album at "${relPath}"`);
  return { title: row.title, title_source: row.title_source };
}

/** `1 - First.flac` -> its title, for the whole album in ordinal order. */
function trackTitles(db: Db, relPath: string): (string | null)[] {
  const albumId = (
    db.prepare('SELECT id FROM album WHERE rel_path = ?').get(relPath) as { id: number }
  ).id;
  const rows = db
    .prepare('SELECT title FROM track WHERE album_id = ? ORDER BY ordinal')
    .all(albumId) as { title: string | null }[];
  return rows.map((row) => row.title);
}

/** Where each of those titles came from, in the same order. */
function trackSources(db: Db, relPath: string): (string | null)[] {
  const albumId = (
    db.prepare('SELECT id FROM album WHERE rel_path = ?').get(relPath) as { id: number }
  ).id;
  const rows = db
    .prepare('SELECT title_source FROM track WHERE album_id = ? ORDER BY ordinal')
    .all(albumId) as { title_source: string | null }[];
  return rows.map((row) => row.title_source);
}

test('a cue title beats a tag, and the source says so', () => {
  // The whole point of recording a source: the album title is never empty, so
  // without it a tag could not tell the folder's placeholder from a name the
  // cue deliberately chose.
  const root = fixture({
    'Green Desert/Green Desert.flac': flac({ tags: { ALBUM: 'Tag Album' } }),
    'Green Desert/green.cue': IMAGE_CUE,
  });
  const db = openDb(':memory:');
  run(root, db);

  assert.deepEqual(albumOf(db, 'Green Desert'), {
    title: 'Green Desert',
    title_source: 'cue',
  });

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a tag title beats the folder, which is all a folder ever was', () => {
  const root = fixture({
    'untitled rip 03/01.mp3': id3v2([
      { id: 'TALB', encoding: 3, text: Buffer.from('Green Desert', 'utf8') },
      { id: 'TIT2', encoding: 3, text: Buffer.from('Green Desert', 'utf8') },
    ]),
  });
  const db = openDb(':memory:');
  run(root, db);

  assert.deepEqual(albumOf(db, 'untitled rip 03'), {
    title: 'Green Desert',
    title_source: 'tag',
  });

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a folder with neither cue nor tag keeps its name, marked as the folder', () => {
  const root = fixture({ 'Untitled Rip/01.mp3': Buffer.from('no tags here', 'utf8') });
  const db = openDb(':memory:');
  run(root, db);

  assert.deepEqual(albumOf(db, 'Untitled Rip'), {
    title: 'Untitled Rip',
    title_source: 'folder',
  });

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('tracks nothing describes are named from their own tags', () => {
  // The 279-file case: separate files, no cue anywhere, titles sitting in the
  // files themselves. Before this they were all `(untitled)`.
  const root = fixture({
    'Rip/01.mp3': id3v2([{ id: 'TIT2', encoding: 3, text: Buffer.from('First', 'utf8') }]),
    'Rip/02.mp3': id3v2([{ id: 'TIT2', encoding: 3, text: Buffer.from('Second', 'utf8') }]),
  });
  const db = openDb(':memory:');
  run(root, db);

  assert.deepEqual(trackTitles(db, 'Rip'), ['First', 'Second']);
  assert.deepEqual(trackSources(db, 'Rip'), ['tag', 'tag']);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('an untagged scene rip is named from the file names it was handed', () => {
  // The Kroogi sample [[task:2710]] was found on: no tags in any file, a folder
  // name that states the credit and the release group, and files whose own names
  // carry the titles. Before the name was a source these nine were `(untitled)`,
  // and nothing said so — the dump simply showed no name.
  const bytes = Buffer.from('no tags in here', 'utf8');
  const root = fixture({
    'Aquarium_-_Archangelsk-2011-Kroogi.com/01-aquarium_-_back_to_archangelsk-kroogi.mp3': bytes,
    'Aquarium_-_Archangelsk-2011-Kroogi.com/02-aquarium_-_red_river-kroogi.mp3': bytes,
  });
  const db = openDb(':memory:');
  // The rip is scanned as its own root, which is how it arrives: the album has
  // no folder, its name is the name of the directory it was unpacked into.
  run(join(root, 'Aquarium_-_Archangelsk-2011-Kroogi.com'), db);

  // The album and its artist already came from the folder name; the tracks are
  // what was missing, and the file names are what answers.
  assert.deepEqual(albumOf(db, ''), { title: 'Archangelsk', title_source: 'folder' });
  assert.deepEqual(trackTitles(db, ''), ['back to archangelsk', 'red river']);
  assert.deepEqual(trackSources(db, ''), ['name', 'name']);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a cue still names its own tracks, and the tag only fills what it left blank', () => {
  // A cue TRACK with no TITLE names nothing; the file's own tag is still a
  // better answer than an empty cell. Where the cue does speak, it is the
  // authority — it is the only thing here that knows about the order of a rip.
  const cue = `TITLE "Green Desert"
FILE "a.flac" WAVE
TRACK 01 AUDIO
TITLE "From The Cue"
INDEX 01 00:00:00
FILE "b.flac" WAVE
TRACK 02 AUDIO
INDEX 01 01:00:00
`;
  const root = fixture({
    'Album/a.flac': flac({ tags: { TITLE: 'From The Tag' } }),
    'Album/b.flac': flac({ tags: { TITLE: 'Also From The Tag' } }),
    'Album/album.cue': cue,
  });
  const db = openDb(':memory:');
  run(root, db);

  assert.deepEqual(trackTitles(db, 'Album'), ['From The Cue', 'Also From The Tag']);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('an image-cue album takes no track titles from tags at all', () => {
  // One file holds every track, so a TITLE tag on it describes the file, not
  // track 7 — there is no honest way to spread it across the segments.
  const root = fixture({
    'Green Desert/Green Desert.flac': flac({ tags: { TITLE: 'The Whole File' } }),
    'Green Desert/green.cue': IMAGE_CUE,
  });
  const db = openDb(':memory:');
  run(root, db);

  assert.deepEqual(trackTitles(db, 'Green Desert'), ['Green Desert', 'White Clouds']);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a whole-file track reports the duration its container states', () => {
  // No cue bounds these, and no decoder ran: the number is in the header.
  const bytes = flac({ sampleRate: 44100, totalSamples: 882_000 });
  const root = fixture({ 'Rip/01.flac': bytes, 'Rip/02.flac': bytes });
  const db = openDb(':memory:');
  run(root, db);

  const albumId = (
    db.prepare("SELECT id FROM album WHERE rel_path = 'Rip'").get() as { id: number }
  ).id;
  const rows = db
    .prepare('SELECT duration_ms FROM track WHERE album_id = ? ORDER BY ordinal')
    .all(albumId) as { duration_ms: number | null }[];

  assert.deepEqual(
    rows.map((row) => row.duration_ms),
    [20_000, 20_000],
  );

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a cue performer beats a tag artist', () => {
  const root = fixture({
    'Green Desert/Green Desert.flac': flac({ tags: { ARTIST: 'Someone Else' } }),
    'Green Desert/green.cue': IMAGE_CUE,
  });
  const db = openDb(':memory:');
  run(root, db);

  const artist = db
    .prepare(
      `SELECT a.name AS name FROM album al JOIN artist a ON a.id = al.artist_id WHERE al.rel_path = 'Green Desert'`,
    )
    .get() as { name: string } | undefined;

  assert.equal(artist?.name, 'Tangerine Dream');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('an album no cue describes is named after the artist its files state', () => {
  // The stage that this was always missing: `apply.ts` said outright that it
  // could not read tags because nothing parsed them.
  const root = fixture({
    'Rip/01.mp3': id3v2([{ id: 'TPE1', encoding: 3, text: Buffer.from('Tangerine Dream', 'utf8') }]),
    'Rip/02.mp3': id3v2([{ id: 'TPE1', encoding: 3, text: Buffer.from('Tangerine Dream', 'utf8') }]),
  });
  const db = openDb(':memory:');
  run(root, db);

  const artist = db
    .prepare(
      `SELECT a.name AS name FROM album al JOIN artist a ON a.id = al.artist_id WHERE al.rel_path = 'Rip'`,
    )
    .get() as { name: string } | undefined;

  assert.equal(artist?.name, 'Tangerine Dream');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('ALBUMARTIST is preferred over ARTIST, which is what it is for', () => {
  const root = fixture({
    'Rip/01.mp3': id3v2([
      { id: 'TPE2', encoding: 3, text: Buffer.from('Various Artists', 'utf8') },
      { id: 'TPE1', encoding: 3, text: Buffer.from('Track One Band', 'utf8') },
    ]),
  });
  const db = openDb(':memory:');
  run(root, db);

  const artist = db
    .prepare(
      `SELECT a.name AS name FROM album al JOIN artist a ON a.id = al.artist_id WHERE al.rel_path = 'Rip'`,
    )
    .get() as { name: string } | undefined;

  assert.equal(artist?.name, 'Various Artists');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a compilation whose tracks disagree on ARTIST gets no album artist', () => {
  // Naming it after whichever file sorted first would be confidently wrong.
  // "Not determined" is the honest answer, and it is the one the column
  // already means.
  const root = fixture({
    'Rip/01.mp3': id3v2([{ id: 'TPE1', encoding: 3, text: Buffer.from('First Band', 'utf8') }]),
    'Rip/02.mp3': id3v2([{ id: 'TPE1', encoding: 3, text: Buffer.from('Second Band', 'utf8') }]),
  });
  const db = openDb(':memory:');
  run(root, db);

  const artist = db
    .prepare("SELECT artist_id FROM album WHERE rel_path = 'Rip'")
    .get() as { artist_id: number | null };

  assert.equal(artist.artist_id, null);

  db.close();
  rmSync(root, { recursive: true, force: true });
});
