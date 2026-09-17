import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { classify } from '../src/classify/classify.ts';
import { openDb } from '../src/db/index.ts';
import { scan } from '../src/scan/scan.ts';
import { tempRoot } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDb>;

function fixture(tree: Record<string, string>): string {
  const root = tempRoot('funoteka-classify-');
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function roles(db: Db): Record<string, string> {
  const rows = db.prepare('SELECT rel_path, role FROM folder ORDER BY rel_path').all() as {
    rel_path: string;
    role: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.rel_path, r.role]));
}

test('an album named by its folder loses the Discogs noise', () => {
  // The folder is a record sleeve written in one line, and the format note is
  // not part of the record's name.
  const root = fixture({ '1996 - Greatest Dicks (CD, Comp)/01.mp3': 'a' });
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);

  const album = db.prepare('SELECT title, title_source FROM album').get() as {
    title: string;
    title_source: string;
  };
  assert.equal(album.title, 'Greatest Dicks');
  assert.equal(album.title_source, 'folder', 'still the folder, just a readable one');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a folder that is already a title keeps every character of it', () => {
  // Conservatism is the whole difficulty of this rule, and this is the floor:
  // a name with nothing to strip must come back byte for byte.
  const root = fixture({
    'Green Desert/01.flac': 'a',
    '燃えない灰 (Moenai Hai)/01.flac': 'b',
    'Nirvana (UK)/01.flac': 'c',
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);

  const titles = (
    db.prepare('SELECT title FROM album ORDER BY rel_path').all() as { title: string }[]
  ).map((row) => row.title);

  assert.deepEqual(titles.sort(), ['Green Desert', 'Nirvana (UK)', '燃えない灰 (Moenai Hai)'].sort());

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a root that is itself an album is named by the folder it points at', () => {
  // The Gerogerigegege rips are root-level albums, so the name comes from the
  // root path and the artist-first grammar is the one that applies.
  const parent = tempRoot('funoteka-classify-root-');
  const root = join(parent, 'The Gerogerigegege - 2016 - 燃えない灰 (Moenai Hai)');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '01.flac'), 'a');

  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);

  const album = db.prepare('SELECT rel_path, title FROM album').get() as {
    rel_path: string;
    title: string;
  };
  assert.equal(album.rel_path, '', 'the root is the album');
  assert.equal(album.title, '燃えない灰 (Moenai Hai)');

  rmSync(parent, { recursive: true, force: true });
  db.close();
});

test('folder roles are written back to the meta layer', () => {
  const root = fixture({
    'Trance/Ibiza 2026/01.mp3': 'a',
    'Rock/Opiate/01.flac': 'b',
    'emptydir/.keep': 'c',
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);

  assert.deepEqual(roles(db), {
    'Rock': 'category',
    'Rock/Opiate': 'album',
    'Trance': 'category',
    'Trance/Ibiza 2026': 'album',
    'emptydir': 'empty',
  });

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('album identity is the folder path, one row per album folder', () => {
  const root = fixture({
    'Green Desert/green.cue': 'cue',
    'Green Desert/Green Desert.m4a': 'audio',
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  const counters = classify(db);

  assert.equal(counters.albums, 1);
  const album = db.prepare('SELECT rel_path, title, release_id, disc_number FROM album').get() as {
    rel_path: string;
    title: string;
    release_id: number | null;
    disc_number: number | null;
  };
  assert.equal(album.rel_path, 'Green Desert');
  assert.equal(album.title, 'Green Desert');
  assert.equal(album.release_id, null);
  assert.equal(album.disc_number, null);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a shelf of albums holding one two-disc set is not a box', () => {
  // Two `CD n` children among a shelf of albums turned the artist's folder into
  // a box and every album in it into a disc of that box. Nothing showed it for
  // as long as the API answered with album rows; the moment it answered with
  // *records*, sixteen of the operator's Slipknot releases collapsed into the
  // two albums named after the folders that held them.
  const root = fixture({
    'Artist/1999 - First/01.flac': 'a',
    'Artist/2001 - Second/01.flac': 'b',
    'Artist/2014 - Third - CD 1/01.flac': 'c',
    'Artist/2014 - Third - CD 2/01.flac': 'd',
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  const counters = classify(db);

  // A shelf is not a box — the role below says so — and since `task:2804` that
  // is a separate question from whether it carries a release. The pair inside
  // it is one record; the albums beside the pair are not, which is the whole of
  // what this test was written to protect.
  assert.equal(counters.releases, 1, 'the pair is a record');
  assert.equal(counters.albums, 4, 'every folder keeps its own album');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM album WHERE release_id IS NOT NULL').get() as { n: number }).n,
    2,
    'and only the pair belongs to it',
  );

  const byPath = roles(db);
  assert.equal(byPath['Artist'], 'category', 'the artist folder is what it looks like');
  assert.equal(byPath['Artist/2014 - Third - CD 1'], 'album', 'and nothing is promoted to a disc');
  assert.equal(byPath['Artist/2014 - Third - CD 2'], 'album');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a two-disc set inside a shelf is one release, and the shelf is not', () => {
  // The shelf above is not a box, so the pair of discs inside it never groups:
  // each disc becomes a record of its own, they agree on a name, and a client
  // is shown `.5 The Gray Chapter` twice with nothing to choose between them.
  //
  // A release row is what groups them, and the shelf folder is what it is keyed
  // by — but only the *disc-named* children join it. The other albums of the
  // shelf stay albums: making the shelf a box is the shape that collapsed
  // sixteen releases into two, and the whole difference is this list.
  const root = fixture({
    'Slipknot AAC 320/1999 - Slipknot/01.flac': 'a',
    'Slipknot AAC 320/2001 - Iowa/01.flac': 'b',
    'Slipknot AAC 320/2004 - Vol. 3/01.flac': 'c',
    'Slipknot AAC 320/2008 - All Hope Is Gone/01.flac': 'd',
    'Slipknot AAC 320/2014 - .5 The Gray Chapter - CD 1 [JP - WPCR-16130]/01.flac': 'e',
    'Slipknot AAC 320/2014 - .5 The Gray Chapter - CD 2 [JP - WPCR-16131]/01.flac': 'f',
    'Slipknot AAC 320/2019 - We Are Not Your Kind/01.flac': 'g',
    'Slipknot AAC 320/2022 - The End, So Far/01.flac': 'h',
    // The artist's own folder, beside the shelf rather than above it — which is
    // where the shelf's name gets `AAC 320` removed from it, and where this
    // collection actually keeps it.
    'Slipknot/2014 - 5 The Gray Chapter (Special Edition)/01.flac': 'i',
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  const counters = classify(db);

  assert.equal(counters.releases, 1, 'the shelf carries one release: the pair');

  const release = db.prepare('SELECT id, rel_path, title, title_source FROM release').get() as {
    id: number;
    rel_path: string;
    title: string;
    title_source: string;
  };
  assert.equal(release.rel_path, 'Slipknot AAC 320');
  // Named after what it holds — the discs — and nothing more. What tells one
  // shelf from the next needs the *artist*, which this stage writes none of, so
  // it is appended by the stage that runs after everything that names anything
  // (`shelf-name.ts`, `test/shelf-name.test.ts`). Writing it here would have
  // meant either losing it to the tag that names the record next, or forcing
  // the folder's spelling on every album of every shelf.
  assert.equal(release.title, '.5 The Gray Chapter');
  assert.equal(release.title_source, 'folder');

  const attached = (
    db.prepare('SELECT rel_path FROM album WHERE release_id = ? ORDER BY rel_path').all(release.id) as {
      rel_path: string;
    }[]
  ).map((row) => row.rel_path);
  assert.deepEqual(attached, [
    'Slipknot AAC 320/2014 - .5 The Gray Chapter - CD 1 [JP - WPCR-16130]',
    'Slipknot AAC 320/2014 - .5 The Gray Chapter - CD 2 [JP - WPCR-16131]',
  ]);

  const free = db
    .prepare('SELECT COUNT(*) AS n FROM album WHERE release_id IS NULL')
    .get() as { n: number };
  assert.equal(free.n, 7, "the shelf's other six albums, and the one the artist has beside it");

  // And the discs are numbered, so the pair plays in order and the record's own
  // representative row is the first disc.
  const numbers = (
    db
      .prepare('SELECT disc_number FROM album WHERE release_id = ? ORDER BY disc_number')
      .all(release.id) as { disc_number: number }[]
  ).map((row) => row.disc_number);
  assert.deepEqual(numbers, [1, 2]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a shelf holding two disc sets is left alone rather than merged into one', () => {
  // A release is keyed by its folder (`UNIQUE (root_id, rel_path)`), so a shelf
  // can carry exactly one — and two sets pooled into it would not merely be
  // named together: `We Are Not Your Kind` would stop existing, its four songs
  // joining another record's totals. Four separate records with colliding names
  // are recoverable; a record that was never made is not.
  const root = fixture({
    'Slipknot AAC 320/2001 - Iowa/01.flac': 'a',
    'Slipknot AAC 320/2014 - .5 The Gray Chapter - CD 1 [JP - WPCR-16130]/01.flac': 'b',
    'Slipknot AAC 320/2014 - .5 The Gray Chapter - CD 2 [JP - WPCR-16131]/01.flac': 'c',
    'Slipknot AAC 320/2019 - We Are Not Your Kind - CD 1 [JP - WPCR-18229]/01.flac': 'd',
    'Slipknot AAC 320/2019 - We Are Not Your Kind - CD 2 [JP - WPCR-18230]/01.flac': 'e',
    'Slipknot/2014 - 5 The Gray Chapter (Special Edition)/01.flac': 'f',
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  const counters = classify(db);

  assert.equal(counters.releases, 0, 'one folder cannot carry two releases');
  const attached = db
    .prepare('SELECT COUNT(*) AS n FROM album WHERE release_id IS NOT NULL')
    .get() as { n: number };
  assert.equal(attached.n, 0, 'and nothing is poured into the one it could carry');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a box becomes a release with each CD as a disc album', () => {
  const root = fixture({
    'Disintegration/CD1/01.flac': 'a',
    'Disintegration/CD2/01.flac': 'b',
    'Disintegration/CD3/01.flac': 'c',
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  const counters = classify(db);

  assert.equal(counters.releases, 1);
  assert.equal(counters.albums, 3);

  const release = db.prepare('SELECT id, rel_path, title FROM release').get() as {
    id: number;
    rel_path: string;
    title: string;
  };
  assert.equal(release.rel_path, 'Disintegration');
  assert.equal(release.title, 'Disintegration');

  const discs = db
    .prepare('SELECT rel_path, release_id, disc_number FROM album ORDER BY disc_number')
    .all() as { rel_path: string; release_id: number; disc_number: number }[];

  assert.deepEqual(
    discs.map((d) => [d.rel_path, d.disc_number]),
    [
      ['Disintegration/CD1', 1],
      ['Disintegration/CD2', 2],
      ['Disintegration/CD3', 3],
    ],
  );
  for (const disc of discs) assert.equal(disc.release_id, release.id);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the box folder itself is a release, not an album', () => {
  // "box = release + discs": giving the box an album row too would show the
  // same music twice in any album listing.
  const root = fixture({ 'Box/CD1/01.flac': 'a', 'Box/CD2/01.flac': 'b' });
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);

  const boxAlbum = db.prepare('SELECT COUNT(*) AS n FROM album WHERE rel_path = ?').get('Box') as {
    n: number;
  };
  assert.equal(boxAlbum.n, 0);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('categories and empty folders produce no albums', () => {
  const root = fixture({ 'Rock/Opiate/01.flac': 'a', 'scans/notes.txt': 'b' });
  const db = openDb(':memory:');
  scan(db, [root]);
  const counters = classify(db);

  assert.equal(counters.albums, 1);
  assert.equal(counters.byRole.category, 1);
  assert.equal(counters.byRole.empty, 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('classifying twice changes nothing', () => {
  const root = fixture({ 'Box/CD1/01.flac': 'a', 'Box/CD2/01.flac': 'b' });
  const db = openDb(':memory:');
  scan(db, [root]);

  classify(db);
  const before = db.prepare('SELECT COUNT(*) AS n FROM album').get() as { n: number };
  classify(db);
  const after = db.prepare('SELECT COUNT(*) AS n FROM album').get() as { n: number };
  const releases = db.prepare('SELECT COUNT(*) AS n FROM release').get() as { n: number };

  assert.equal(after.n, before.n);
  assert.equal(releases.n, 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the same album path under two roots stays two albums', () => {
  // requirements:39 §2 — pressings and cross-root duplicates are NOT merged.
  const rootA = fixture({ 'Tool/10000 Days/01.flac': 'a' });
  const rootB = fixture({ 'Tool/10000 Days/01.flac': 'b' });
  const db = openDb(':memory:');
  scan(db, [rootA, rootB]);
  const counters = classify(db);

  assert.equal(counters.albums, 2);
  const rows = db.prepare('SELECT COUNT(DISTINCT root_id) AS n FROM album').get() as { n: number };
  assert.equal(rows.n, 2);

  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
  db.close();
});

test('scanning a folder that is itself the album names it after the folder', () => {
  const root = fixture({ '01.flac': 'a', '02.flac': 'b' });
  const db = openDb(':memory:');
  scan(db, [root]);
  const counters = classify(db);

  assert.equal(counters.albums, 1);
  const album = db.prepare('SELECT rel_path, title FROM album').get() as {
    rel_path: string;
    title: string;
  };
  assert.equal(album.rel_path, '');
  assert.ok(album.title.length > 0, 'a root-level album still needs a name');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an album whose folder vanished is dropped, and its release with it', () => {
  // classify is the layer that owns album and release rows, so it is the layer
  // that lets them go. It runs after the scan, so by the time it looks, the
  // folder rows for what disappeared are already gone.
  // Three discs, so that losing one leaves the box a box: with a single disc
  // left the folder stops being one at all, and the release would go with it
  // for a reason that has nothing to do with the sweep.
  const root = fixture({
    'Box/CD1/01.flac': 'a',
    'Box/CD2/02.flac': 'b',
    'Box/CD3/03.flac': 'c',
  });
  const db = openDb(':memory:');
  const albums = (): string[] =>
    (db.prepare('SELECT rel_path FROM album ORDER BY rel_path').all() as { rel_path: string }[]).map(
      (row) => row.rel_path,
    );
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  scan(db, [root]);
  classify(db);
  assert.deepEqual(albums(), ['Box/CD1', 'Box/CD2', 'Box/CD3'], 'precondition: three disc albums');
  assert.equal(count('SELECT COUNT(*) AS n FROM release'), 1);

  rmSync(join(root, 'Box', 'CD2'), { recursive: true, force: true });
  scan(db, [root]);
  const after = classify(db);

  assert.equal(after.albums, 2);
  assert.deepEqual(albums(), ['Box/CD1', 'Box/CD3']);
  assert.equal(count('SELECT COUNT(*) AS n FROM release'), 1, 'the box itself is still on disk');

  rmSync(join(root, 'Box'), { recursive: true, force: true });
  scan(db, [root]);
  classify(db);

  assert.deepEqual(albums(), []);
  assert.equal(count('SELECT COUNT(*) AS n FROM release'), 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no dangling references');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a root-level album survives a rescan that saw it', () => {
  // Its rel_path is '' and no folder row describes it, so a sweep keyed on
  // "does a folder back this album" would delete the album that IS the root.
  const root = fixture({ '01.flac': 'a', '02.flac': 'b' });
  const db = openDb(':memory:');

  scan(db, [root]);
  classify(db);
  scan(db, [root]);
  classify(db);

  const count = (db.prepare('SELECT COUNT(*) AS n FROM album').get() as { n: number }).n;
  assert.equal(count, 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});
