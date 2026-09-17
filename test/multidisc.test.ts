import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { classify } from '../src/classify/classify.ts';
import { applyCues } from '../src/cue/engine.ts';
import { openDb } from '../src/db/index.ts';
import type { Probe } from '../src/probe/ffprobe.ts';
import { scan } from '../src/scan/scan.ts';
import { applyTags } from '../src/tags/apply.ts';
import { basenameOf } from '../src/util/names.ts';
import { id3v2 } from './helpers/bytes.ts';
import { tempRoot } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDb>;

/**
 * A release ripped flat: three discs as one image + one cue each, no
 * subfolders. Modelled on the real ASOT Ibiza 2026 rip, whose discs are named
 * Pulse / Frequency / Energy inside the file names.
 */
function discCue(albumTitle: string, image: string): string {
  return `TITLE "${albumTitle}"
PERFORMER "Various Artists"
FILE "${image}" MP3
TRACK 01 AUDIO
TITLE "Opening"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Closing"
INDEX 01 05:00:00
`;
}

const ALBUM = 'A State Of Trance: Ibiza 2026';
const PREFIX = 'VA - A State Of Trance_Ibiza 2026 - ';

function fixture(tree: Record<string, string | Buffer>): string {
  const root = tempRoot('funoteka-multidisc-');
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function flatRip(): Record<string, string> {
  const tree: Record<string, string> = {};
  const discs: [string, string][] = [
    ['01', 'Pulse'],
    ['02', 'Frequency'],
    ['03', 'Energy'],
  ];
  for (const [number, name] of discs) {
    const stem = `${number}. ${PREFIX}${name}`;
    tree[`Release/${stem}.mp3`] = 'audio';
    tree[`Release/${stem}.cue`] = discCue(ALBUM, `${stem}.mp3`);
  }
  return tree;
}

function probeReturning(durationMs: number): (absPath: string) => Probe {
  return () => ({
    durationMs,
    codec: 'mp3',
    sampleRate: 44100,
    channels: 2,
    bitrate: 320,
    ok: true,
    err: null,
  });
}

function prepare(tree: Record<string, string | Buffer>): { db: Db; root: string } {
  const root = fixture(tree);
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  return { db, root };
}

test('a flat release keeps the audio its discs did not claim', () => {
  // A file beside the pairs — a bonus track, a rip whose cue never matched —
  // used to reach no album and no track at all: the albums went to the images
  // and the branch that would have given the folder one was reachable only with
  // fewer than two pairs. The file stayed visible in `unaccounted`, which counts
  // the live table, but no stage had moved and no issue had been filed.
  const { db, root } = prepare({ ...flatRip(), 'Release/bonus.mp3': 'audio' });

  applyCues(db, { probe: probeReturning(600_000) });

  const loose = db
    .prepare(
      `SELECT t.ordinal, t.title, a.rel_path AS album
         FROM track t
         JOIN file f ON f.id = t.file_id
         JOIN album a ON a.id = t.album_id
        WHERE f.rel_path = 'Release/bonus.mp3'`,
    )
    .all() as { ordinal: number; title: string; album: string }[];

  assert.equal(loose.length, 1, 'the loose file reaches exactly one track');
  assert.equal(loose[0]?.album, 'Release', "under the box's own album");
  assert.equal(loose[0]?.title, 'bonus', 'named by its file, since nothing else names it');

  // And the discs are not read a second time under it: three discs of two
  // tracks each, plus the loose file once.
  const total = (db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number }).n;
  assert.equal(total, 7, 'no disc is also a track of the album whose folder holds it');

  const unaccounted = db
    .prepare(
      `SELECT f.rel_path FROM file f
        WHERE f.kind = 'audio'
          AND NOT EXISTS (SELECT 1 FROM track t WHERE t.file_id = f.id)
          AND NOT EXISTS (SELECT 1 FROM cue c WHERE c.audio_file_id = f.id)`,
    )
    .all();

  assert.deepEqual(unaccounted, [], 'and no audio file is left without a track or a cue');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a flat release is one release, not one album', () => {
  const { db, root } = prepare(flatRip());

  const counters = classify(db);

  assert.equal(counters.releases, 1);
  assert.equal(counters.albums, 3);
  // The folder itself is the release, so it gets no album row.
  const folderAlbum = db.prepare('SELECT COUNT(*) AS n FROM album WHERE rel_path = ?').get('Release') as {
    n: number;
  };
  assert.equal(folderAlbum.n, 0);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('each disc is an album named after its own file', () => {
  const { db, root } = prepare(flatRip());
  classify(db);

  const albums = (
    db
      .prepare('SELECT rel_path, title, disc_number FROM album ORDER BY disc_number')
      .all() as { rel_path: string; title: string; disc_number: number }[]
  ).map((row) => ({ ...row }));

  assert.deepEqual(
    albums.map((a) => [a.title, a.disc_number]),
    [
      ['Pulse', 1],
      ['Frequency', 2],
      ['Energy', 3],
    ],
  );
  // Identity is still a path — here, the image each disc lives in.
  assert.ok(albums[0]?.rel_path.endsWith('Pulse.mp3'));

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a flat box whose discs are named CD1 and CD2 keeps those names', () => {
  // The Kino box: one folder, two images, each named after its disc and nothing
  // else. `discTitles` strips what the discs have in common — which for these is
  // `CD` — and `1` and `2` is what was left, so the album list showed one record
  // as two entries called `1` and `2`. A folder box has no such hole: its discs
  // are *folders* and each name is kept whole (`CD1 ● Группа крови`), so the
  // flat pair's equivalent of that name is the one its file carries
  // (task:2756, finding 7).
  const { db, root } = prepare({
    'CD1.flac': 'a',
    'CD1.cue': discCue('Группа крови', 'CD1.flac'),
    'CD2.flac': 'b',
    'CD2.cue': discCue('Группа крови', 'CD2.flac'),
  });
  classify(db);

  const albums = db
    .prepare('SELECT title, disc_number FROM album ORDER BY disc_number')
    .all() as { title: string; disc_number: number }[];

  assert.deepEqual(
    albums.map((row) => [row.title, row.disc_number]),
    [
      ['CD1', 1],
      ['CD2', 2],
    ],
    'a disc is named by what it is called, not by the number stripping left behind',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a disc whose name survives the strip is still named by what survives', () => {
  // The other half of the rule above, and the reason it is a test on *letters*
  // rather than a rewrite of the strip: `01 - Pulse` and `02 - Energy` agree on
  // nothing but their numbering, so `Pulse` and `Energy` survive and are what
  // the discs are called. They must not be replaced by their file names.
  const { db, root } = prepare({
    'Release/01 - Pulse.mp3': 'a',
    'Release/01 - Pulse.cue': discCue('Pulse', '01 - Pulse.mp3'),
    'Release/02 - Energy.mp3': 'b',
    'Release/02 - Energy.cue': discCue('Energy', '02 - Energy.mp3'),
  });
  classify(db);

  const titles = (
    db.prepare('SELECT title FROM album ORDER BY disc_number').all() as { title: string }[]
  ).map((row) => row.title);

  assert.deepEqual(titles, ['Pulse', 'Energy']);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('every disc is split by its own cue — no disc loses its tracks', () => {
  const { db, root } = prepare(flatRip());

  const counters = applyCues(db, { probe: probeReturning(600_000) });

  assert.equal(counters.byShape['image-cue'], 3);
  assert.equal(counters.tracks, 6);
  assert.equal(counters.cues, 3);

  // Each of the six tracks plays from the image of its own disc, never another.
  const mismatched = db
    .prepare(
      `SELECT COUNT(*) AS n FROM track t
       JOIN album a ON a.id = t.album_id
       JOIN file f ON f.id = t.file_id
       WHERE a.rel_path <> f.rel_path`,
    )
    .get() as { n: number };
  assert.equal(mismatched.n, 0, 'a track must play from its own disc image');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('disc titles come from the file name, not the cue', () => {
  // All three cues carry the same TITLE — the disc names live in the filenames,
  // so taking the cue title would name three different discs identically.
  const { db, root } = prepare(flatRip());
  classify(db);

  const titles = (
    db.prepare('SELECT title FROM album ORDER BY disc_number').all() as { title: string }[]
  ).map((r) => r.title);

  assert.equal(new Set(titles).size, 3);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an ordinary album with two cues is not mistaken for a release', () => {
  // FLAC.cue + WAV.cue beside one image: stems flac/wav/opiate share nothing,
  // so no stem carries both a cue and an audio file, and the folder must stay a
  // plain album rather than becoming a one-disc "release".
  const { db, root } = prepare({
    'Opiate/Opiate.flac': 'audio',
    'Opiate/FLAC.cue': 'FILE "Opiate.flac" WAVE\nTRACK 01 AUDIO\nTITLE "A"\nINDEX 01 00:00:00\n',
    'Opiate/WAV.cue': 'FILE "Opiate.wav" WAVE\nTRACK 01 AUDIO\nTITLE "A"\nINDEX 01 00:00:00\n',
  });

  const counters = classify(db);

  assert.equal(counters.releases, 0);
  assert.equal(counters.albums, 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a flat multi-disc pairs a cue named after its file, not only by stem', () => {
  // One convention, two writings, and both are in the collection: ASOT ships
  // `… - Pulse.cue` beside `… - Pulse.mp3`, and the Maschina Kino rips ship
  // `… CD1.flac.cue` beside `… CD1.flac`. `stemOf` strips one extension, so the
  // second names its disc `… CD1.flac` while the file's own stem is `… CD1` —
  // the pair never formed, the folder read as one album holding two images, and
  // every disc past the first lost its tracks: MASHCD290 declares 30 and two
  // survived (task:2708). The fixture has to carry both writings or the fix
  // breaks on the first of them.
  const { db, root } = prepare({
    'Release/01 - Pulse.mp3': 'a',
    'Release/01 - Pulse.cue': discCue('Pulse', '01 - Pulse.mp3'),
    'Release/02 - Energy.flac': 'b',
    'Release/02 - Energy.flac.cue': discCue('Energy', '02 - Energy.flac'),
  });

  const counters = classify(db);

  assert.equal(counters.releases, 1, 'two image+cue pairs are a release');
  assert.equal(counters.albums, 2, 'and each disc is an album of its own');

  applyCues(db, { probe: probeReturning(600_000) });

  const perAlbum = db
    .prepare(
      `SELECT a.rel_path AS album, COUNT(t.id) AS n
         FROM album a LEFT JOIN track t ON t.album_id = a.id
        GROUP BY a.id ORDER BY a.rel_path`,
    )
    .all() as { album: string; n: number }[];

  assert.deepEqual(
    perAlbum.map((row) => row.n),
    [2, 2],
    `each disc keeps its own tracks, got:\n${JSON.stringify(perAlbum)}`,
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a single image+cue pair is a plain album, not a one-disc release', () => {
  // A pair exists, but one disc is not a box set.
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/Green Desert.cue': 'TITLE "GD"\nFILE "Green Desert.m4a" WAVE\nTRACK 01 AUDIO\nTITLE "A"\nINDEX 01 00:00:00\n',
  });

  const counters = classify(db);

  assert.equal(counters.releases, 0);
  assert.equal(counters.albums, 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a root that is itself the album still gets its tracks', () => {
  // Scanning an album folder as the root puts its files at rel_path '', and the
  // walk never creates a folder row for the root. Reading '' as a file path
  // silently dropped every track — the album was recognised, then emptied.
  const { db, root } = prepare({
    'Green Desert.m4a': 'audio',
    'green.cue': `TITLE "Green Desert"
FILE "Green Desert.m4a" WAVE
TRACK 01 AUDIO
TITLE "Green Desert"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "White Clouds"
INDEX 01 19:24:00
`,
  });

  const counters = applyCues(db, { probe: probeReturning(2_100_000) });

  assert.equal(counters.tracks, 2);
  const last = db.prepare('SELECT segment_end_ms FROM track ORDER BY ordinal DESC LIMIT 1').get() as {
    segment_end_ms: number | null;
  };
  assert.equal(last.segment_end_ms, 2_100_000);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the release takes its name from the cue, not the folder', () => {
  // The folder is `[2026-08-28] … [ARDI4701]`; the cue says what the record is
  // actually called, and wiki:3499 §8 gives the cue priority.
  const { db, root } = prepare(flatRip());

  applyCues(db, { probe: probeReturning(600_000) });

  const release = db.prepare('SELECT title FROM release').get() as { title: string };
  assert.equal(release.title, ALBUM);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a disc keeps its own name while the release takes the cue title', () => {
  const { db, root } = prepare(flatRip());

  applyCues(db, { probe: probeReturning(600_000) });

  const titles = (
    db.prepare('SELECT title FROM album ORDER BY disc_number').all() as { title: string }[]
  ).map((row) => row.title);
  assert.deepEqual(titles, ['Pulse', 'Frequency', 'Energy']);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the catalogue number is kept from the cue', () => {
  const { db, root } = prepare({
    'Album/image.flac': 'audio',
    'Album/album.cue': `TITLE "Catalogued"
REM CATALOG "Jive – HOP C226"
REM DATE 1973
FILE "image.flac" WAVE
TRACK 01 AUDIO
TITLE "A"
INDEX 01 00:00:00
`,
  });

  applyCues(db, { probe: probeReturning(1000) });

  const cue = db.prepare('SELECT catalog, rem_json FROM cue').get() as {
    catalog: string;
    rem_json: string;
  };
  assert.equal(cue.catalog, 'Jive – HOP C226');
  assert.equal((JSON.parse(cue.rem_json) as Record<string, string>)['DATE'], '1973');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a box whose discs are named after their albums is still a box', () => {
  // Structural detection sees only "a folder of albums" here — nothing is
  // called CD1. The folder name is the remaining evidence, and the disc numbers
  // come from order because the names carry none.
  const { db, root } = prepare({
    'Box Set/The Wall/01.flac': 'a',
    'Box Set/Animals/01.flac': 'b',
    'Box Set/Wish You Were Here/01.flac': 'c',
  });

  const counters = classify(db);

  assert.equal(counters.releases, 1);
  const discs = (
    db.prepare('SELECT title, disc_number FROM album ORDER BY disc_number').all() as {
      title: string;
      disc_number: number;
    }[]
  ).map((row) => ({ ...row }));
  assert.deepEqual(
    discs.map((d) => [d.title, d.disc_number]),
    [
      ['Animals', 1],
      ['The Wall', 2],
      ['Wish You Were Here', 3],
    ],
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a folder merely named Box is not a box on the name alone', () => {
  // One album inside is not a release; the name is a hint, never a decision.
  const { db, root } = prepare({ 'Box/Opiate/01.flac': 'a' });

  const counters = classify(db);

  assert.equal(counters.releases, 0);
  assert.equal(counters.albums, 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue one level above the album still describes it', () => {
  // Real layout: the cue lives at the root and names the album folder's file.
  // Selecting cues by folder alone left it unread — no cue row, no tracks
  // named, and not a word about it.
  const { db, root } = prepare({
    'Album/01.flac': 'a',
    'Album/02.flac': 'b',
    'whole.cue': `TITLE "Whole"
PERFORMER "Someone"
FILE "Album/01.flac" WAVE
TRACK 01 AUDIO
TITLE "First"
INDEX 01 00:00:00
FILE "Album/02.flac" WAVE
TRACK 02 AUDIO
TITLE "Second"
INDEX 01 03:00:00
`,
  });

  const counters = applyCues(db, { probe: probeReturning(1000) });

  assert.equal(counters.cues, 1, 'the root cue must be found and read');
  const titles = (
    db.prepare('SELECT title FROM track ORDER BY ordinal').all() as { title: string | null }[]
  ).map((row) => row.title);
  assert.deepEqual(titles, ['First', 'Second']);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an album that yields no tracks says so instead of going quiet', () => {
  // The net that would have caught the emptied-album bug above.
  const { db, root } = prepare({
    'Release/CD1/a.flac': 'x',
    'Release/CD2/b.flac': 'y',
  });
  classify(db);

  applyCues(db, { probe: probeReturning(1000) });

  const orphan = db
    .prepare('SELECT COUNT(*) AS n FROM issue WHERE kind = ?')
    .get('album-without-tracks') as { n: number };
  const emptyAlbums = db
    .prepare('SELECT COUNT(*) AS n FROM album a WHERE NOT EXISTS (SELECT 1 FROM track t WHERE t.album_id = a.id)')
    .get() as { n: number };
  assert.equal(orphan.n, emptyAlbums.n, 'every empty album must be reported');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a CD folder that only wraps an album is not itself a disc', () => {
  // Box/CD1/disc/01.flac: promoting CD1 to a disc would create a disc album
  // with nothing in it AND leave the real album as a phantom row one level
  // down — two files turning into four albums, two of them empty.
  const { db, root } = prepare({
    'Box/CD1/disc/01.flac': 'a',
    'Box/CD2/disc/01.flac': 'b',
  });

  const counters = classify(db);
  assert.equal(counters.albums, 2);

  const cueCounters = applyCues(db, { probe: probeReturning(1000) });
  assert.equal(cueCounters.tracks, 2);

  const empty = db
    .prepare('SELECT COUNT(*) AS n FROM album a WHERE NOT EXISTS (SELECT 1 FROM track t WHERE t.album_id = a.id)')
    .get() as { n: number };
  assert.equal(empty.n, 0, 'no album may be left with nothing in it');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a box holding loose audio of its own does not lose it', () => {
  const { db, root } = prepare({
    'Box/CD1/01.flac': 'a',
    'Box/CD2/01.flac': 'b',
    'Box/bonus.flac': 'c',
  });
  classify(db);

  // Without an album row for the box itself, bonus.flac reaches no track.
  const counters = applyCues(db, { probe: probeReturning(1000) });
  assert.equal(counters.tracks, 3);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue track with no INDEX 01 is recorded, not fatal', () => {
  const { db, root } = prepare({
    'Album/image.flac': 'audio',
    'Album/album.cue': `TITLE "Broken"
FILE "image.flac" WAVE
TRACK 01 AUDIO
TITLE "Indexed"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "No index here"
`,
  });

  // Used to throw NOT NULL constraint failed and kill the entire scan.
  const counters = applyCues(db, { probe: probeReturning(600_000) });

  assert.ok(counters.tracks >= 1);
  const stored = db.prepare('SELECT COUNT(*) AS n FROM cue_track').get() as { n: number };
  assert.equal(stored.n, 2);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue repeating a track number is reported, not fatal', () => {
  const { db, root } = prepare({
    'Album/image.flac': 'audio',
    'Album/album.cue': `TITLE "Duplicate"
FILE "image.flac" WAVE
TRACK 01 AUDIO
TITLE "First"
INDEX 01 00:00:00
TRACK 01 AUDIO
TITLE "Again"
INDEX 01 03:00:00
`,
  });

  // Used to throw UNIQUE constraint failed and kill the entire scan.
  const counters = applyCues(db, { probe: probeReturning(600_000) });

  assert.ok(counters.tracks >= 1);
  const issue = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'cue-duplicate-track'")
    .get() as { n: number };
  assert.equal(issue.n, 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a second cue beside the working one is still reported', () => {
  const { db, root } = prepare({
    'Album/image.flac': 'audio',
    'Album/image.cue': 'TITLE "Good"\nFILE "image.flac" WAVE\nTRACK 01 AUDIO\nTITLE "A"\nINDEX 01 00:00:00\n',
    'Album/WAV.cue': 'TITLE "Stale"\nFILE "image.wav" WAVE\nTRACK 01 AUDIO\nTITLE "B"\nINDEX 01 00:00:00\n',
  });

  const counters = applyCues(db, { probe: probeReturning(600_000) });

  assert.equal(counters.cues, 1);
  const issue = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'cue-unmatched'")
    .get() as { n: number };
  assert.equal(issue.n, 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('cue issues carry the scan run they belong to', () => {
  const { db, root } = prepare({
    'Album/image.flac': 'audio',
    'Album/album.cue': 'FILE "missing.wav" WAVE\nTRACK 01 AUDIO\nTITLE "x"\nINDEX 01 00:00:00\n',
  });

  applyCues(db, { probe: probeReturning(600_000) });

  const orphan = db
    .prepare('SELECT COUNT(*) AS n FROM issue WHERE scan_run_id IS NULL')
    .get() as { n: number };
  assert.equal(orphan.n, 0, 'every issue must be attributable to a run');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// The other shape of a flat multi-disc, and the harder one: the discs are named
// after the record, `Disc N` sits in the middle of the file name rather than at
// the front, and each cue states its own disc's label instead of the album's.
// Modelled on the real `Pink Floyd - The Wall (JPN Remastered)` sample.

const WALL_BOX = 'Pink Floyd - The Wall (JPN Remastered)';
const WALL_DISCS = ['Pink Floyd - The Wall [Disc 1]', 'Pink Floyd - The Wall [1994 Remaster](Disc 2)'];

function wallRip(): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const disc of WALL_DISCS) {
    // The cue names this disc, not the record — which is what EAC actually wrote.
    const label = disc.replace('Pink Floyd - ', '');
    tree[`${WALL_BOX}/${disc}.ape`] = 'audio';
    tree[`${WALL_BOX}/${disc}.cue`] = discCue(label, `${disc}.ape`);
  }
  return tree;
}

/** Disc number per file, keyed by the file's own name. */
function discNumbers(db: Db): Record<string, number> {
  const rows = db
    .prepare('SELECT rel_path, disc_number FROM album ORDER BY disc_number')
    .all() as { rel_path: string; disc_number: number | null }[];
  return Object.fromEntries(rows.map((row) => [basenameOf(row.rel_path), row.disc_number ?? -1]));
}

test('a disc number written in the file name is read, not replaced by position', () => {
  // `leadingNumber` looks at the START of the name, and `Pink Floyd - The Wall
  // [Disc 1].ape` has no number there — so both discs fell back to their sort
  // position, and the sort put `[1994…` (the second disc) first. The names say
  // which disc is which, plainly; nothing was reading them.
  const { db, root } = prepare(wallRip());
  classify(db);

  assert.deepEqual(discNumbers(db), {
    'Pink Floyd - The Wall [Disc 1].ape': 1,
    'Pink Floyd - The Wall [1994 Remaster](Disc 2).ape': 2,
  });

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a disc title is not a fragment cut out of the middle of a bracket', () => {
  // Stripping the shared prefix character by character cut inside `[`, leaving
  // `1994 Remaster](Disc 2)` and `Disc 1]` — a title that starts mid-bracket.
  const { db, root } = prepare(wallRip());
  classify(db);

  const titles = (
    db.prepare('SELECT title FROM album ORDER BY disc_number').all() as { title: string }[]
  ).map((row) => row.title);

  assert.deepEqual(titles, ['The Wall [Disc 1]', 'The Wall [1994 Remaster](Disc 2)']);
  for (const title of titles) {
    assert.doesNotMatch(title, /^\W*\]/, 'a title may not open on a closing bracket');
  }

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a disc label does not become the name of the whole release', () => {
  // Both discs write their cue TITLE onto the one release row, so the last one
  // won and the box ended up called `The Wall [Disc 1]` — the name of a disc,
  // not of the record. A name carrying a disc marker names that disc.
  const { db, root } = prepare(wallRip());

  applyCues(db, { probe: probeReturning(600_000) });

  const release = db.prepare('SELECT title, title_source FROM release').get() as {
    title: string;
    title_source: string;
  };
  assert.equal(release.title, WALL_BOX, 'the box keeps the name its folder states, note and all');
  assert.equal(release.title_source, 'folder', 'and says where it came from');

  // The refusal is recorded as well as kept in `cue.title` (task:2697): the
  // issue is what a reader sees without going looking, and the column is what
  // the decision was about.
  const declined = db
    .prepare("SELECT detail FROM issue WHERE kind = 'release-title-declined'")
    .get() as { detail: string } | undefined;
  assert.ok(declined, 'a declined title has to be said out loud');
  assert.match(declined.detail, /The Wall \[Disc 1\]/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test("a cue's own title is kept", () => {
  // `doc.title` was read inside the run that read the cue and then dropped on
  // the floor: CATALOG and the REM block got columns in migration 003, TITLE
  // got none. It is the cue's name for the record, and the same reason 003
  // gives for CATALOG applies to it word for word.
  const { db, root } = prepare({
    'Album/image.flac': 'audio',
    'Album/album.cue': `TITLE "Catalogued"
FILE "image.flac" WAVE
TRACK 01 AUDIO
TITLE "A"
INDEX 01 00:00:00
`,
  });

  applyCues(db, { probe: probeReturning(1000) });

  const cue = db.prepare('SELECT title FROM cue').get() as { title: string };
  assert.equal(cue.title, 'Catalogued');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a title the chain turns away is kept, not only mentioned', () => {
  // Both of the Wall's cues label their own disc, so neither names the record
  // and the release keeps its folder name — that part was already right. What
  // was missing is the label itself: it lived only inside the run, so once the
  // run ended the sole trace of what the cue said was the issue text. A refusal
  // is a judgement about a value, and the value has to outlive the judgement to
  // be reviewable at all.
  const { db, root } = prepare(wallRip());

  applyCues(db, { probe: probeReturning(600_000) });

  const titles = (
    db.prepare('SELECT title FROM cue ORDER BY title').all() as { title: string }[]
  ).map((row) => row.title);
  assert.deepEqual(titles, ['The Wall [1994 Remaster](Disc 2)', 'The Wall [Disc 1]']);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('one unmarked sibling cue does not get to name the box', () => {
  // Per-cue refusal is not enough. `The Wall [Disc 1]` carries a marker and is
  // refused; `The Wall 1994 Remaster` does not, and on a per-cue rule it would
  // simply name the record after its own disc. A box is named once, and only
  // when its discs agree.
  const first = 'Pink Floyd - The Wall [Disc 1]';
  const second = 'Pink Floyd - The Wall [1994 Remaster]';
  const { db, root } = prepare({
    [`${WALL_BOX}/${first}.ape`]: 'a',
    [`${WALL_BOX}/${first}.cue`]: discCue('The Wall [Disc 1]', `${first}.ape`),
    [`${WALL_BOX}/${second}.ape`]: 'b',
    [`${WALL_BOX}/${second}.cue`]: discCue('The Wall 1994 Remaster', `${second}.ape`),
  });

  applyCues(db, { probe: probeReturning(600_000) });

  const release = db.prepare('SELECT title, title_source FROM release').get() as {
    title: string;
    title_source: string;
  };
  assert.equal(release.title, WALL_BOX, 'the discs disagree, so the box keeps its own, note and all');
  assert.equal(release.title_source, 'folder');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a box whose cues name only discs still takes a real album tag', () => {
  // Refusing the cue must not swallow the tag behind it: the cue named a disc,
  // so it has no say — but the files' own ALBUM does name the record, and a tag
  // beating the folder is the whole priority chain.
  const tree: Record<string, string | Buffer> = {};
  for (const disc of WALL_DISCS) {
    const label = disc.replace('Pink Floyd - ', '');
    tree[`${WALL_BOX}/${disc}.mp3`] = id3v2([
      { id: 'TALB', encoding: 3, text: Buffer.from('The Wall', 'utf8') },
    ]);
    tree[`${WALL_BOX}/${disc}.cue`] = discCue(label, `${disc}.mp3`);
  }

  const root = fixture(tree);
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  applyTags(db);
  applyCues(db, { probe: probeReturning(600_000) });

  const release = db.prepare('SELECT title, title_source FROM release').get() as {
    title: string;
    title_source: string;
  };
  assert.equal(release.title, 'The Wall', 'the tag names the record the cues only labelled');
  assert.equal(release.title_source, 'tag');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a box whose discs state different album tags takes neither of them', () => {
  // The tag path wrote a release's name from whichever disc it reached first
  // and said nothing about it, so a box of discs carrying different ALBUM tags
  // was called after one of them — the confident guess the album level already
  // refuses to make when one record's files disagree. The cue path has gathered
  // the whole box and decided once since task:2697; the tag's half of that rule
  // was missing (task:2728).
  const tree: Record<string, string | Buffer> = {};
  for (const [index, disc] of WALL_DISCS.entries()) {
    const album = index === 0 ? 'The Wall' : 'The Wall [Remastered]';
    tree[`${WALL_BOX}/${disc}.mp3`] = id3v2([
      { id: 'TALB', encoding: 3, text: Buffer.from(album, 'utf8') },
    ]);
    tree[`${WALL_BOX}/${disc}.cue`] = discCue(disc.replace('Pink Floyd - ', ''), `${disc}.mp3`);
  }

  const root = fixture(tree);
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  applyTags(db);
  applyCues(db, { probe: probeReturning(600_000) });

  const release = db.prepare('SELECT title, title_source FROM release').get() as {
    title: string;
    title_source: string;
  };
  assert.equal(release.title, WALL_BOX, 'the box keeps the name its folder states, note and all');
  assert.equal(release.title_source, 'folder');

  const ambiguous = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'title-tag-ambiguous'")
    .all() as { severity: string; detail: string }[];

  assert.equal(ambiguous.length, 1, 'one finding about the box, not one per disc');
  assert.equal(ambiguous[0]?.severity, 'info');
  assert.match(ambiguous[0]?.detail ?? '', /The Wall \[Remastered\]/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a stated disc marker outranks a leading track number', () => {
  // `01 - …[Disc 2]` says which disc it is; the `01` is only the order it was
  // ripped in. Reading the leading number first swapped the two.
  const { db, root } = prepare({
    'Box/01 - The Wall [Disc 2].ape': 'a',
    'Box/01 - The Wall [Disc 2].cue': discCue('The Wall [Disc 2]', '01 - The Wall [Disc 2].ape'),
    'Box/02 - The Wall [Disc 1].ape': 'b',
    'Box/02 - The Wall [Disc 1].cue': discCue('The Wall [Disc 1]', '02 - The Wall [Disc 1].ape'),
  });
  classify(db);

  assert.deepEqual(discNumbers(db), {
    '01 - The Wall [Disc 2].ape': 2,
    '02 - The Wall [Disc 1].ape': 1,
  });

  rmSync(root, { recursive: true, force: true });
  db.close();
});
