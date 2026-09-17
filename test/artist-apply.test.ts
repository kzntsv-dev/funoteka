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
import { id3v2, ogg } from './helpers/bytes.ts';
import { tempRoot } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDb>;

/** A one-track image and its cue, performed by `performer`. */
function albumCue(performer: string): string {
  return `PERFORMER "${performer}"
TITLE "An Album"
FILE "album.flac" WAVE
TRACK 01 AUDIO
TITLE "A Song"
INDEX 01 00:00:00
`;
}

function fixture(tree: Record<string, string | Buffer>): string {
  const root = tempRoot('funoteka-artist-');
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

/** The chain as the CLI runs it, so a stage never sees a state it cannot meet. */
function prepare(tree: Record<string, string | Buffer>): { db: Db; root: string } {
  const root = fixture(tree);
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  applyTags(db);
  applyCues(db, { probe: probeReturning(200_000) });
  return { db, root };
}

function artists(db: Db): { name: string; name_key: string; sort_key: string; ambiguous: number }[] {
  return (
    db.prepare('SELECT name, name_key, sort_key, ambiguous FROM artist ORDER BY name_key').all() as {
      name: string;
      name_key: string;
      sort_key: string;
      ambiguous: number;
    }[]
  ).map((row) => ({ ...row }));
}

test("a cue's PERFORMER becomes the album's artist", () => {
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Кино'),
  });

  const counters = applyArtists(db);

  assert.equal(counters.artists, 1);
  assert.equal(counters.linked, 1);
  assert.deepEqual(artists(db), [
    { name: 'Кино', name_key: 'кино', sort_key: 'Кино', ambiguous: 0 },
  ]);

  const album = db.prepare('SELECT artist_id FROM album').get() as { artist_id: number };
  assert.ok(album.artist_id, 'the album must point at the artist');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a PERFORMER holding only a tab names nobody', () => {
  // The emptiness guard on the cue's `performer` reads SQLite's one-argument
  // `TRIM`, which removes spaces and leaves a tab where it found it — the short
  // form `f87ff9a` corrected in the tag reads. Read on its own, the query says a
  // performer of `"\t"` passes the guard and becomes an artist whose name is
  // invisible; the quotes in the cue keep the tab from the line trim, so the
  // value really does arrive as a tab.
  //
  // It cannot become an artist, and this pins where the job is actually done. The
  // row *is* selected — the guard lets the tab through, exactly as the short form
  // does — and the credit dies one step later in `claim`: `splitCredit` answers
  // `[]` for a value that is nothing but whitespace, so nothing is claimed and no
  // artist is made (`apply.ts`). Checked for a tab, a space, a no-break space, an
  // ideographic space and a mixture: all five give no entries. So on this path the
  // guard only saves rows, and the day someone loosens `splitCredit` is the day it
  // stops being decorative.
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('\t'),
  });

  const counters = applyArtists(db);

  assert.equal(counters.artists, 0, 'a tab is not a name');
  assert.deepEqual(artists(db), []);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('spellings that differ only in article are one artist, and not flagged', () => {
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('The Cure'),
    'B/album.flac': 'b',
    'B/album.cue': albumCue('Cure, The'),
  });

  const counters = applyArtists(db);

  assert.equal(counters.artists, 1, 'two spellings, one artist');
  assert.equal(counters.ambiguous, 0, 'nothing was discarded to merge these');
  assert.equal(counters.linked, 2, 'both albums point at them');
  assert.equal(artists(db)[0]?.name, 'The Cure', 'the plainest spelling is the display name');

  const linked = db.prepare('SELECT COUNT(*) AS n FROM album WHERE artist_id IS NOT NULL').get() as {
    n: number;
  };
  assert.equal(linked.n, 2);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a disambiguator merged away is flagged, never silently', () => {
  // Two artists, one name. The deterministic rules cannot tell them apart, so
  // they must not pretend to: the merge happens and says so.
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Nirvana'),
    'B/album.flac': 'b',
    'B/album.cue': albumCue('Nirvana (UK)'),
  });

  const counters = applyArtists(db);

  assert.equal(counters.artists, 1);
  assert.equal(counters.ambiguous, 1);
  assert.equal(artists(db)[0]?.ambiguous, 1);

  const issue = db
    .prepare("SELECT detail FROM issue WHERE kind = 'artist-ambiguous'")
    .get() as { detail: string } | undefined;
  assert.ok(issue, 'the merge has to be visible outside the artist table too');
  assert.match(issue.detail, /Nirvana \(UK\)/);
  assert.match(issue.detail, /nirvana/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue that names no performer leaves the album without an artist', () => {
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': `TITLE "An Album"\nFILE "album.flac" WAVE\nTRACK 01 AUDIO\nTITLE "A Song"\nINDEX 01 00:00:00\n`,
  });

  const counters = applyArtists(db);

  assert.equal(counters.artists, 0);
  assert.equal(artists(db).length, 0);

  const album = db.prepare('SELECT artist_id FROM album').get() as { artist_id: number | null };
  assert.equal(album.artist_id, null, 'unknown is null, not a guess');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a performer that is only an article is not an artist', () => {
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('The'),
  });

  applyArtists(db);

  assert.equal(artists(db).length, 0, 'no row that every such cue would then merge into');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue above a folder album still reaches it', () => {
  // Regression, and a silent one: the album is one level below the cue that
  // names it, so looking only at the audio file's own path and at the cue's
  // folder found neither. The artist row appeared, `linked` stayed 0, the
  // album kept a null artist, and nothing anywhere said so.
  const { db, root } = prepare({
    'whole.cue': `PERFORMER "Кино"
TITLE "The Whole Record"
FILE "Album/01.flac" WAVE
TRACK 01 AUDIO
TITLE "A Song"
INDEX 01 00:00:00
`,
    'Album/01.flac': 'a',
  });

  const counters = applyArtists(db);

  assert.equal(counters.linked, 1, "the cue names the album it sits above");
  const album = db.prepare("SELECT artist_id FROM album WHERE rel_path = 'Album'").get() as {
    artist_id: number | null;
  };
  assert.ok(album.artist_id, 'an album the cue describes must not stay artistless');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('one act under two roots is one artist, though its albums stay two', () => {
  // The point of the whole stage: album identity is root-qualified, artist
  // identity is not. The same band filed under two roots is one artist with
  // albums in both.
  const first = fixture({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Кино'),
  });
  const second = fixture({
    'B/album.flac': 'b',
    'B/album.cue': albumCue('Кино'),
  });

  const db = openDb(':memory:');
  scan(db, [first, second]);
  classify(db);
  applyCues(db, { probe: probeReturning(200_000) });

  const counters = applyArtists(db);

  assert.equal(counters.artists, 1, 'artist identity is not root-scoped');
  const albums = db.prepare('SELECT COUNT(*) AS n FROM album').get() as { n: number };
  assert.equal(albums.n, 2, 'album identity is');
  assert.equal(counters.linked, 2);

  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
  db.close();
});

test('a cue that never matched anything does not name the album', () => {
  // Two audio files, so the sole-audio fallback cannot apply and the cue is
  // genuinely unmatched. Its performer describes a record that is not here,
  // and the album must not be given it.
  const { db, root } = prepare({
    'A/one.flac': 'a',
    'A/two.flac': 'b',
    'A/gone.cue': `PERFORMER "Кино"
FILE "gone.flac" WAVE
TRACK 01 AUDIO
TITLE "A Song"
INDEX 01 00:00:00
`,
  });

  applyArtists(db);

  assert.equal(artists(db).length, 0, 'an unmatched cue names nothing');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue that stops describing anything stops naming the album', () => {
  // The harder half. This cue *was* matched, so its row exists and carries the
  // performer; when the rip it described goes missing the binding is cleared
  // but the row and its performer are not — and a stage that trusts the
  // performer alone keeps the album named after a record that is no longer
  // there.
  const { db, root } = prepare({
    'A/one.flac': 'a',
    'A/two.flac': 'b',
    'A/good.cue': `PERFORMER "Кино"
FILE "one.flac" WAVE
TRACK 01 AUDIO
TITLE "A Song"
INDEX 01 00:00:00
`,
  });

  applyArtists(db);
  assert.equal(artists(db).length, 1, 'matched, so the performer counts');

  writeFileSync(
    join(root, 'A/good.cue'),
    `PERFORMER "Кино"\nFILE "vanished.flac" WAVE\nTRACK 01 AUDIO\nTITLE "A Song"\nINDEX 01 00:00:00\n`,
  );
  scan(db, [root]);
  classify(db);
  applyCues(db, { probe: probeReturning(200_000) });

  applyArtists(db);

  const bound = db.prepare('SELECT audio_file_id, performer FROM cue').get() as {
    audio_file_id: number | null;
    performer: string | null;
  };
  assert.equal(bound.audio_file_id, null, 'the binding is what went stale');
  assert.equal(artists(db).length, 0, 'and a binding is what the artist stage needs');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an artist that loses its performer is un-derived, not left behind', () => {
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Кино'),
  });

  applyArtists(db);
  assert.equal(artists(db).length, 1);

  // The performer goes away on disk, and the chain runs again over the same
  // database — which is what a rescan is.
  writeFileSync(
    join(root, 'A/album.cue'),
    `TITLE "An Album"\nFILE "album.flac" WAVE\nTRACK 01 AUDIO\nTITLE "A Song"\nINDEX 01 00:00:00\n`,
  );
  scan(db, [root]);
  classify(db);
  applyCues(db, { probe: probeReturning(200_000) });

  const counters = applyArtists(db);

  assert.equal(counters.artists, 0, 'the stage derives from the present, so the row goes too');
  assert.equal(artists(db).length, 0);
  const album = db.prepare('SELECT artist_id FROM album').get() as { artist_id: number | null };
  assert.equal(album.artist_id, null, 'and the album stops pointing at it');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a box release gets the artist its discs got', () => {
  const { db, root } = prepare({
    'Box/CD1/album.flac': 'a',
    'Box/CD1/album.cue': albumCue('Кино'),
    'Box/CD2/album.flac': 'b',
    'Box/CD2/album.cue': albumCue('Кино'),
  });

  applyArtists(db);

  const release = db.prepare('SELECT artist_id FROM release').get() as { artist_id: number | null };
  assert.ok(release.artist_id, 'the row representing the box is an album too, and needs its artist');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// Artist credit ---------------------------------------------------------------
// `1994 - Cock E.S.P. + Thirdorgan - Split (Cass, C60)` is the real shape this
// whole feature exists for: a folder name that states the credit, on an album
// whose per-track tags disagree (2 tracks say Thirdorgan, 2 say Cock E.S.P.).

const SPLIT_FOLDER = '1994 - Cock E.S.P. + Thirdorgan - Split (Cass, C60)';

/** A folder of two plain audio files, which is an album with no cue. */
function splitTree(extra: Record<string, string | Buffer> = {}): Record<string, string | Buffer> {
  return { [`${SPLIT_FOLDER}/01.flac`]: 'a', [`${SPLIT_FOLDER}/02.flac`]: 'b', ...extra };
}

function creditOf(db: Db, relPath: string): { position: number; name: string; join_phrase: string }[] {
  const rows = db
    .prepare(
      `SELECT ac.position AS position, ar.name AS name, ac.join_phrase AS join_phrase
         FROM artist_credit ac JOIN artist ar ON ar.id = ac.artist_id
        WHERE ac.album_id = (SELECT id FROM album WHERE rel_path = ?)
        ORDER BY ac.position`,
    )
    .all(relPath) as { position: number; name: string; join_phrase: string }[];
  return rows.map((row) => ({ ...row }));
}

test("a folder's credit becomes the album's credit list", () => {
  const { db, root } = prepare(splitTree());

  applyArtists(db);

  assert.deepEqual(creditOf(db, SPLIT_FOLDER), [
    { position: 0, name: 'Cock E.S.P.', join_phrase: '' },
    { position: 1, name: 'Thirdorgan', join_phrase: ' + ' },
  ]);

  const album = db
    .prepare('SELECT credit_raw, credit_source FROM album WHERE rel_path = ?')
    .get(SPLIT_FOLDER) as { credit_raw: string | null; credit_source: string | null };
  assert.equal(album.credit_raw, 'Cock E.S.P. + Thirdorgan', 'the original stays auditable');
  assert.equal(album.credit_source, 'folder');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the album points at the first name, and the list holds the rest', () => {
  const { db, root } = prepare(splitTree());

  applyArtists(db);

  const album = db
    .prepare(
      `SELECT ar.name AS artist FROM album al JOIN artist ar ON ar.id = al.artist_id WHERE al.rel_path = ?`,
    )
    .get(SPLIT_FOLDER) as { artist: string };
  assert.equal(album.artist, 'Cock E.S.P.');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('every artist named by a credit survives the prune', () => {
  // The trap that came with the design: only the first name reaches
  // `album.artist_id`, so the rest are referenced by nothing but the credit —
  // and `pruneArtists` deletes artists that hold nothing. Left alone it would
  // delete Thirdorgan and the cascade would take the credit row with it.
  const { db, root } = prepare(splitTree());

  applyArtists(db);

  const names = artists(db).map((a) => a.name);
  assert.deepEqual(names.sort(), ['Cock E.S.P.', 'Thirdorgan']);
  assert.equal(creditOf(db, SPLIT_FOLDER).length, 2, 'and the row that named it is still there');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue still outranks the folder, as it outranks everything', () => {
  // The cue has to name a file that is actually present, or it describes
  // nothing and never binds — the same rule the stage has always followed.
  const { db, root } = prepare(
    splitTree({
      [`${SPLIT_FOLDER}/split.cue`]: `PERFORMER "Кино"
TITLE "Split"
FILE "01.flac" WAVE
TRACK 01 AUDIO
TITLE "A Song"
INDEX 01 00:00:00
`,
    }),
  );

  applyArtists(db);

  const album = db
    .prepare('SELECT credit_raw, credit_source FROM album WHERE rel_path = ?')
    .get(SPLIT_FOLDER) as { credit_raw: string | null; credit_source: string | null };
  assert.equal(album.credit_source, 'cue');
  assert.equal(album.credit_raw, 'Кино');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the folder outranks a tag, and a tag still fills a folder that says nothing', () => {
  const tagged = {
    'Plain Album/01.mp3': id3v2([
      { id: 'TPE1', encoding: 3, text: Buffer.from('Some Tagged Artist', 'utf8') },
    ]),
  };
  const { db, root } = prepare(tagged);

  applyArtists(db);

  assert.deepEqual(creditOf(db, 'Plain Album'), [
    { position: 0, name: 'Some Tagged Artist', join_phrase: '' },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a split credit is recorded, never performed quietly', () => {
  const { db, root } = prepare(splitTree());

  applyArtists(db);

  const issue = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'artist-credit-split'")
    .get() as { severity: string; detail: string } | undefined;
  assert.ok(issue, 'the reading has to be visible outside the credit table');
  assert.equal(issue.severity, 'info');
  assert.match(issue.detail, /Cock E\.S\.P\. \+ Thirdorgan/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an Ogg album under a folder named after its artist is that artist', () => {
  // The operator's `PolnaLyubvi`, in miniature: twenty-five albums of `.ogg`
  // under one folder named in Latin, every file tagging `ARTIST=PolnaLyubvi`.
  // Before the Ogg reader there were no tags, so the artist had nothing to be
  // read out of and all twenty-five albums hung with no artist at all — the
  // folder was structurally a category and nothing said otherwise.
  const { db, root } = prepare({
    'PolnaLyubvi/2018-08-27  V/01. Не покидай меня.ogg': ogg({
      tags: { ARTIST: 'PolnaLyubvi', ALBUM: 'V', TITLE: 'Не покидай меня' },
    }),
    'PolnaLyubvi/2019-10-31  Элегия/01. Элегия.ogg': ogg({
      tags: { ARTIST: 'PolnaLyubvi', ALBUM: 'Элегия', TITLE: 'Элегия' },
    }),
  });

  applyArtists(db);

  assert.deepEqual(artists(db), [
    { name: 'PolnaLyubvi', name_key: 'polnalyubvi', sort_key: 'PolnaLyubvi', ambiguous: 0 },
  ]);
  assert.equal(ownerOf(db, 'PolnaLyubvi/2018-08-27  V'), 'polnalyubvi');
  assert.equal(ownerOf(db, 'PolnaLyubvi/2019-10-31  Элегия'), 'polnalyubvi');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a folder that states no credit leaves the album without one', () => {
  const { db, root } = prepare({ 'Green Desert/01.flac': 'a' });

  applyArtists(db);

  assert.equal(creditOf(db, 'Green Desert').length, 0);
  const album = db
    .prepare('SELECT credit_raw, credit_source FROM album WHERE rel_path = ?')
    .get('Green Desert') as { credit_raw: string | null; credit_source: string | null };
  assert.equal(album.credit_raw, null);
  assert.equal(album.credit_source, null);
  assert.deepEqual(artists(db), [], 'and no artist is invented for it');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a credit re-derives each run rather than accumulating', () => {
  const { db, root } = prepare(splitTree());

  applyArtists(db);
  applyArtists(db);

  assert.equal(creditOf(db, SPLIT_FOLDER).length, 2, 'two entries, not four');
  const issues = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'artist-credit-split'")
    .get() as { n: number };
  assert.equal(issues.n, 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('running it twice changes nothing and does not double the issues', () => {
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Nirvana'),
    'B/album.flac': 'b',
    'B/album.cue': albumCue('Nirvana (UK)'),
  });

  const first = applyArtists(db);
  const second = applyArtists(db);

  assert.deepEqual(second, first);
  assert.equal(artists(db).length, 1);

  const issues = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'artist-ambiguous'")
    .get() as { n: number };
  assert.equal(issues.n, 1, 'the stage re-derives, so its issues describe the present');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// Artist folders --------------------------------------------------------------
// Two different bands can share a name, and the key cannot tell. The folder can:
// "разные арт-папки = разные артисты" (wiki:3498 §3). The key is still what
// merges — a folder only ever *splits*, and only when two real folders disagree.

/** One album, one image, one cue naming `performer`. */
function performedAlbum(albumRelPath: string, performer: string): Record<string, string> {
  return {
    [`${albumRelPath}/album.flac`]: 'a',
    [`${albumRelPath}/album.cue`]: albumCue(performer),
  };
}

/** Two bands called Nirvana, filed under folders that say so. */
const TWO_NIRVANAS = {
  ...performedAlbum('Music/Nirvana/Nevermind', 'Nirvana'),
  ...performedAlbum('Other/Nirvana/Bleach', 'Nirvana'),
};

/** The artist row a given album ended up pointing at. */
function ownerOf(db: Db, relPath: string): string | null {
  const row = db
    .prepare(
      `SELECT ar.name_key AS name_key
         FROM album al JOIN artist ar ON ar.id = al.artist_id
        WHERE al.rel_path = ?`,
    )
    .get(relPath) as { name_key: string } | undefined;
  return row?.name_key ?? null;
}

test('two homonyms in different artist folders are two artists, and the split is flagged', () => {
  const { db, root } = prepare(TWO_NIRVANAS);

  const counters = applyArtists(db);

  assert.deepEqual(artists(db), [
    { name: 'Nirvana', name_key: 'nirvana', sort_key: 'Nirvana', ambiguous: 1 },
    { name: 'Nirvana', name_key: 'nirvana#2', sort_key: 'Nirvana', ambiguous: 1 },
  ]);
  assert.equal(counters.homonyms, 1, 'one name had to be split by folder');
  assert.equal(counters.ambiguous, 2, 'and every row the split produced is a guess');

  const issue = db.prepare("SELECT severity, detail FROM issue WHERE kind = 'artist-homonym'").get() as
    | { severity: string; detail: string }
    | undefined;
  assert.ok(issue, 'the split has to be visible outside the artist table');
  assert.equal(issue.severity, 'warn');
  assert.match(issue.detail, /Music\/Nirvana/);
  assert.match(issue.detail, /Other\/Nirvana/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('each album points at the artist row of its own folder', () => {
  const { db, root } = prepare(TWO_NIRVANAS);

  applyArtists(db);

  assert.equal(ownerOf(db, 'Music/Nirvana/Nevermind'), 'nirvana');
  assert.equal(ownerOf(db, 'Other/Nirvana/Bleach'), 'nirvana#2', 'not the bare key');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('one artist folder keeps the band one artist, however the other root is named', () => {
  // The real collection: `Downloads\Кино` IS an artist folder, and
  // `Downloads\Кино ● Каталог Maschina Records` is not — its name does not
  // reduce to `кино`. One real folder is not a collision, so nothing splits and
  // the band stays one row across both, which is the outcome wiki:3519 records
  // as correct.
  const { db, root } = prepare({
    ...performedAlbum('Кино/1989 ● Последний герой', 'Кино'),
    ...performedAlbum('Кино ● Каталог Maschina Records/1990 ● Другой', 'Кино'),
  });

  const counters = applyArtists(db);

  assert.equal(counters.artists, 1);
  assert.equal(counters.homonyms, 0, 'one folder is not a collision');
  assert.deepEqual(artists(db), [
    { name: 'Кино', name_key: 'кино', sort_key: 'Кино', ambiguous: 0 },
  ]);

  const issues = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'artist-homonym'")
    .get() as { n: number };
  assert.equal(issues.n, 0);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('two roots both named after the artist are two artists, deliberately', () => {
  // Not an accident. Album identity is root-qualified under the same section of
  // the spec that gives folders their say, so the same band filed twice is two
  // of everything. The split is flagged, and the overlay layer can undo it —
  // the same trade task:2675 accepted for transliteration.
  const first = fixture(performedAlbum('Кино/1989 ● Последний герой', 'Кино'));
  const second = fixture(performedAlbum('Кино/1990 ● Другой', 'Кино'));

  const db = openDb(':memory:');
  scan(db, [first, second]);
  classify(db);
  applyCues(db, { probe: probeReturning(200_000) });

  const counters = applyArtists(db);

  assert.equal(counters.artists, 2);
  assert.equal(counters.homonyms, 1);
  assert.deepEqual(
    artists(db).map((artist) => artist.name_key),
    ['кино', 'кино#2'],
  );

  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
  db.close();
});

test('an album with no artist folder is assigned by guess, and the issue says so', () => {
  const { db, root } = prepare({
    ...performedAlbum('Music/Nirvana/Nevermind', 'Nirvana'),
    ...performedAlbum('Other/Nirvana/Bleach', 'Nirvana'),
    ...performedAlbum('Loose', 'Nirvana'),
  });

  applyArtists(db);

  const issue = db.prepare("SELECT detail FROM issue WHERE kind = 'artist-homonym'").get() as {
    detail: string;
  };
  assert.match(issue.detail, /1 album/, 'the coin-flip has to name itself');
  assert.match(issue.detail, /Music\/Nirvana/, 'and say which folder took the album');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a name can be ambiguous by spelling and by folder at once', () => {
  const { db, root } = prepare({
    ...performedAlbum('Music/Nirvana/Nevermind', 'Nirvana'),
    ...performedAlbum('Music/Nirvana/In Utero', 'Nirvana (UK)'),
    ...performedAlbum('Other/Nirvana/Bleach', 'Nirvana'),
  });

  const counters = applyArtists(db);

  assert.equal(counters.homonyms, 1, 'the folder split');
  assert.equal(counters.ambiguous, 2, 'both rows are a guess');
  assert.deepEqual(
    artists(db).map((artist) => artist.name_key),
    ['nirvana', 'nirvana#2'],
  );

  const byKind = db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM issue WHERE kind LIKE 'artist-%' GROUP BY kind ORDER BY kind`,
    )
    .all() as { kind: string; n: number }[];
  assert.deepEqual(
    byKind.map((row) => ({ ...row })),
    [
      { kind: 'artist-ambiguous', n: 1 },
      { kind: 'artist-homonym', n: 1 },
    ],
    'the two guesses are told apart rather than pooled',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a credit inside a split group resolves to that group, not the bare key', () => {
  // The silent one: the credit list is built from the entry names alone, so a
  // collaborator credited in the second folder would land on the first artist's
  // row — right name, wrong band, and nothing on the album to show for it.
  const { db, root } = prepare({
    ...performedAlbum('Music/Nirvana/Nevermind', 'Nirvana'),
    'Other/Nirvana/1994 - Nirvana + X - Split (CD)/01.flac': 'a',
    'Other/Nirvana/1994 - Nirvana + X - Split (CD)/02.flac': 'b',
  });

  applyArtists(db);

  const credited = db
    .prepare(
      `SELECT ar.name_key AS name_key
         FROM artist_credit ac
         JOIN artist ar ON ar.id = ac.artist_id
         JOIN album al ON al.id = ac.album_id
        WHERE al.rel_path = 'Other/Nirvana/1994 - Nirvana + X - Split (CD)'
          AND ac.position = 0`,
    )
    .get() as { name_key: string } | undefined;

  assert.equal(credited?.name_key, 'nirvana#2', 'the Nirvana of THIS folder');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('when one of two homonym folders goes, the survivor reclaims the bare key', () => {
  const { db, root } = prepare(TWO_NIRVANAS);
  applyArtists(db);
  assert.equal(artists(db).length, 2, 'both folders are there to start with');

  rmSync(join(root, 'Other'), { recursive: true, force: true });
  scan(db, [root]);
  classify(db);
  applyCues(db, { probe: probeReturning(200_000) });

  const counters = applyArtists(db);

  assert.equal(counters.homonyms, 0, 'one folder left, so nothing to split');
  assert.deepEqual(artists(db), [
    { name: 'Nirvana', name_key: 'nirvana', sort_key: 'Nirvana', ambiguous: 0 },
  ]);

  const stale = db
    .prepare("SELECT COUNT(*) AS n FROM artist WHERE name_key LIKE '%#%'")
    .get() as { n: number };
  assert.equal(stale.n, 0, 'and no #2 row is left holding nothing');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('re-running does not double the homonym issue', () => {
  const { db, root } = prepare(TWO_NIRVANAS);

  const first = applyArtists(db);
  const second = applyArtists(db);

  assert.deepEqual(second, first);
  const issues = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'artist-homonym'")
    .get() as { n: number };
  assert.equal(issues.n, 1, 'the stage re-derives, so its issues describe the present');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('homonyms whose folders are not named after them still merge, and that is documented', () => {
  // The edge of a path signal, pinned so nothing implies it is wider than it is.
  // This design separates artists whose folder is literally named after them; a
  // collection that never names the folder cannot be helped by it, and says so
  // with ambiguous = 0 rather than pretending.
  const { db, root } = prepare({
    ...performedAlbum('Music/Nirvana 1991/Nevermind', 'Nirvana'),
    ...performedAlbum('Other/Nirvana 1993/Bleach', 'Nirvana'),
  });

  const counters = applyArtists(db);

  assert.equal(counters.homonyms, 0);
  assert.deepEqual(artists(db), [
    { name: 'Nirvana', name_key: 'nirvana', sort_key: 'Nirvana', ambiguous: 0 },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an album that is its own root is named after that root, not after the path to it', () => {
  // The root is the one path the walk did not produce, and on Windows it comes
  // back from `realpath` with backslashes — so a basename that only knows `/`
  // answers with the whole path, and the credit the folder name states goes
  // unclaimed there while working on Linux. Two machines reading one unchanged
  // collection must not disagree about who made a record.
  const root = fixture({});
  const albumRoot = join(root, SPLIT_FOLDER);
  mkdirSync(albumRoot, { recursive: true });
  writeFileSync(join(albumRoot, '01.flac'), 'a');
  writeFileSync(join(albumRoot, '02.flac'), 'b');

  const db = openDb(':memory:');
  scan(db, [albumRoot]);
  classify(db);
  applyTags(db);
  applyCues(db, { probe: probeReturning(200_000) });

  applyArtists(db);

  const album = db
    .prepare(
      `SELECT ar.name AS artist, al.credit_source AS credit_source
         FROM album al LEFT JOIN artist ar ON ar.id = al.artist_id
        WHERE al.rel_path = ''`,
    )
    .get() as { artist: string | null; credit_source: string | null } | undefined;

  assert.equal(album?.credit_source, 'folder', 'the folder name is the credit here');
  assert.equal(album?.artist, 'Cock E.S.P.', 'read off the root folder, not off the path to it');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a self-titled box inside an artist folder is not a second artist folder', () => {
  // `Music/Nirvana/Nirvana/Disc 1` is the band's own self-titled record, not a
  // second band. Reading the *nearest* ancestor that matches makes it one: the
  // box is named after the artist too, so a single band splits in two and the
  // report warns about a homonym that does not exist.
  const { db, root } = prepare({
    ...performedAlbum('Music/Nirvana/Nevermind', 'Nirvana'),
    ...performedAlbum('Music/Nirvana/Nirvana/Disc 1', 'Nirvana'),
    ...performedAlbum('Music/Nirvana/Nirvana/Disc 2', 'Nirvana'),
  });

  const counters = applyArtists(db);

  assert.equal(counters.homonyms, 0, 'one band, so one artist folder');
  assert.deepEqual(artists(db), [
    { name: 'Nirvana', name_key: 'nirvana', sort_key: 'Nirvana', ambiguous: 0 },
  ]);
  assert.equal(ownerOf(db, 'Music/Nirvana/Nirvana/Disc 1'), 'nirvana', 'the discs are the band');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

/** What a run filed as `artist-transliteration`, in a stable order. */
function transliterationIssues(db: Db): { severity: string; detail: string }[] {
  const rows = db
    .prepare(
      `SELECT severity, detail FROM issue
        WHERE kind = 'artist-transliteration' ORDER BY detail`,
    )
    .all() as { severity: string; detail: string }[];
  return rows.map((row) => ({ ...row }));
}

test('a second run replaces the artist issues instead of adding a set', () => {
  // The same rule the cue stage keeps, and the same bug: the clear filtered on
  // the *current* run, so it guarded a repeated run inside one scan and let
  // every scan add another set. This is the stage where that was found, and the
  // whole suite passed with the old filter — which is what this test is for.
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Кино'),
    'B/album.flac': 'a',
    'B/album.cue': albumCue('Kino'),
  });

  applyArtists(db);
  assert.equal(transliterationIssues(db).length, 1);

  scan(db, [root]);
  applyArtists(db);

  assert.equal(
    transliterationIssues(db).length,
    1,
    'a second run describes the present; it does not add to a history',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('one name in two alphabets is reported, and the rows stay apart', () => {
  // The Kino catalogue: 48 cues write `PERFORMER "Кино"` and the French edition
  // of one album writes `Kino`. A human reads one band and the database holds
  // two keys — and no rule can close that gap, because transliteration is a
  // mapping between scripts rather than a fold, it is many-to-many in both
  // directions, and the schemes disagree with each other. Merging would assert
  // an identity nothing on disk states, and two bands that merely sound alike
  // would become one row with nothing downstream to show it had happened. So
  // the guess is made reviewable: the pair is named and the rows stay apart.
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Кино'),
    'B/album.flac': 'a',
    'B/album.cue': albumCue('Kino'),
  });

  applyArtists(db);

  assert.deepEqual(
    artists(db).map((row) => row.name),
    ['Kino', 'Кино'],
    'the two rows are both kept — this reports, it does not merge',
  );
  assert.deepEqual(transliterationIssues(db), [
    { severity: 'warn', detail: 'Kino / Кино — may be one name in two alphabets' },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a pairing is whole-name, so a shorter Latin name claims nothing', () => {
  // `Кино` in one alphabet, `Kino` in the other are one band; `Машина времени`
  // and `Mashina` are two, whatever they look like side by side. A pairing rule
  // loose enough to bridge them — prefix, substring, "close enough" — would be a
  // merge rule wearing a report's clothes, and the failure it buys is the silent
  // one: `Кино` and `Кино` of two different bands become a single artist. This is
  // the same whole-name discipline the artist folder lookup keeps, for the same
  // reason (wiki:3519).
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Кино'),
    'B/album.flac': 'a',
    'B/album.cue': albumCue('Машина времени'),
    'C/album.flac': 'a',
    'C/album.cue': albumCue('Mashina'),
  });

  applyArtists(db);

  assert.deepEqual(
    transliterationIssues(db),
    [],
    '`Машина времени` is not `Mashina`, and `Кино` has no `Kino` to pair with here',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a row naming several Latin neighbours reports every one of them', () => {
  // The schemes disagree, so one key can have more than one Latin neighbour:
  // `Ксения` is `Kseniya` under BGN and `Ksenia` under the simplified table,
  // and both are rows a reader would want named. Reporting the first and
  // dropping the rest without saying so is the silent-omission failure this
  // whole stage is written to avoid, so the loop does not stop early.
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Ксения'),
    'B/album.flac': 'a',
    'B/album.cue': albumCue('Kseniya'),
    'C/album.flac': 'a',
    'C/album.cue': albumCue('Ksenia'),
  });

  applyArtists(db);

  assert.deepEqual(transliterationIssues(db), [
    { severity: 'warn', detail: 'Ksenia / Ксения — may be one name in two alphabets' },
    { severity: 'warn', detail: 'Kseniya / Ксения — may be one name in two alphabets' },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('qualified keys are not paired: `#2` is a position, not a correspondence', () => {
  // Two artist folders called `Кино` become `кино` and `кино#2`, and two called
  // `Kino` become `kino` and `kino#2`. Pairing the seconds would claim the
  // second folder of one group is the second folder of the other — the index
  // counts within a group that was sorted on its own, and nothing makes the two
  // second folders the same band. The base rows already report the pairing, so
  // the qualified ones are left out and the report stays one line per band
  // rather than two identical ones.
  // Two roots, which is what makes both groups split: album identity is
  // root-qualified, so the same band filed twice is two artists — `кино#2` and
  // `kino#2` — each the second of a group sorted on its own.
  const first = fixture({
    ...performedAlbum('Кино/1989', 'Кино'),
    ...performedAlbum('Kino/1989', 'Kino'),
  });
  const second = fixture({
    ...performedAlbum('Кино/1990', 'Кино'),
    ...performedAlbum('Kino/1990', 'Kino'),
  });

  const db = openDb(':memory:');
  scan(db, [first, second]);
  classify(db);
  applyCues(db, { probe: probeReturning(200_000) });

  applyArtists(db);

  assert.deepEqual(
    artists(db).map((row) => row.name_key).sort(),
    ['kino', 'kino#2', 'кино', 'кино#2'],
    'both key groups split, so the qualified keys really are in play here',
  );
  assert.deepEqual(transliterationIssues(db), [
    { severity: 'warn', detail: 'Kino / Кино — may be one name in two alphabets' },
  ]);

  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
  db.close();
});

test('a collaborator named only by a credit still gets a located report', () => {
  // `Aube + Кино` puts both names in `artist_credit`; one of them may own no
  // album at all, so a lookup restricted to `album.artist_id` finds nothing and
  // the report is filed with a null root — which the sibling stage calls out as
  // the thing that makes an issue unfindable in the dump. The credit is where
  // such an artist actually appears, so the fallback goes through it.
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Aube + Кино'),
    'B/album.flac': 'a',
    'B/album.cue': albumCue('Kino'),
  });

  applyArtists(db);

  assert.deepEqual(transliterationIssues(db), [
    { severity: 'warn', detail: 'Kino / Кино — may be one name in two alphabets' },
  ]);
  const located = db
    .prepare(
      `SELECT COUNT(*) AS n FROM issue
        WHERE kind = 'artist-transliteration' AND rel_path IS NOT NULL`,
    )
    .get() as { n: number };
  assert.equal(located.n, 1, 'a report with no path cannot be found in the dump');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a record no source could name says so, with what its files actually state', () => {
  // The operator's series: no cue, a folder name that states no artist, and
  // files that disagree — sixteen of them, sixteen different ARTIST tags, and no
  // ALBUMARTIST anywhere. Declining to pick one is the stage's rule and it is
  // right; being silent about it was not. An empty artist reads the same whether
  // the record is a compilation nobody labelled or an artist that got lost, and
  // the two want opposite responses (task:2701).
  const { db, root } = prepare({
    'Серия/(02) (2005) Это печаль не твоя (MEL CD 60 00893)/01.mp3': id3v2([
      { id: 'TPE1', encoding: 3, text: Buffer.from('Первый', 'utf8') },
    ]),
    'Серия/(02) (2005) Это печаль не твоя (MEL CD 60 00893)/02.mp3': id3v2([
      { id: 'TPE1', encoding: 3, text: Buffer.from('Второй', 'utf8') },
    ]),
    'Серия/(02) (2005) Это печаль не твоя (MEL CD 60 00893)/03.mp3': id3v2([
      { id: 'TPE1', encoding: 3, text: Buffer.from('Третий', 'utf8') },
    ]),
  });

  applyArtists(db);

  const album = db
    .prepare("SELECT artist_id FROM album WHERE rel_path LIKE '%печаль не твоя%'")
    .get() as { artist_id: number | null };
  assert.equal(album.artist_id, null, 'a majority of one is still a guess');

  const reported = db
    .prepare("SELECT severity, detail, rel_path FROM issue WHERE kind = 'album-without-artist'")
    .get() as { severity: string; detail: string; rel_path: string | null } | undefined;

  assert.ok(reported, 'and the refusal is said out loud');
  assert.equal(reported.severity, 'info');
  assert.match(
    reported.detail,
    /3 different ARTIST tags/,
    'the count of distinct ARTISTs is what tells a compilation from a lost artist',
  );
  assert.ok(reported.rel_path, 'a report with no path cannot be found in the dump');

  // This was the one test of forty-five here that built a fixture and kept it.
  // A directory per run is a small thing to leave in the system temp, and it is
  // exactly how the two thousand six hundred beside it got there (task:2922).
  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a record its files agree on is named, and is not reported as unnamed', () => {
  // The other half, so the report cannot quietly become "every album with a tag
  // is unattributed": agreement is what a tag is for, and an album it names has
  // nothing to report.
  const { db, root } = prepare({
    'Album/01.mp3': id3v2([
      { id: 'TPE1', encoding: 3, text: Buffer.from('One Voice', 'utf8') },
    ]),
    'Album/02.mp3': id3v2([
      { id: 'TPE1', encoding: 3, text: Buffer.from('One Voice', 'utf8') },
    ]),
  });

  applyArtists(db);

  const album = db.prepare("SELECT artist_id FROM album WHERE rel_path = 'Album'").get() as {
    artist_id: number | null;
  };
  assert.notEqual(album.artist_id, null, 'agreement is what a tag is for');

  const reported = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'album-without-artist'")
    .get() as { n: number };
  assert.equal(reported.n, 0, 'a named record has nothing to report');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a guest named inside every credit does not cost the album its artist', () => {
  // `Sigur Rós` on two tracks of `Kveikur Expanded LP` and `Sigur Rós & Blanck
  // Mass` on the third — the operator's Kveikur, which reached the client with
  // no artist at all. Two answers to one question, but one of them is the other
  // plus somebody: splitting each credit on its joiners and keeping what they
  // all contain finds the artist the record is by, and leaves the guest to
  // `track_artist`, which is what it is for.
  const track = (artist: string): Buffer =>
    id3v2([
      { id: 'TIT2', encoding: 3, text: Buffer.from('A track', 'utf8') },
      { id: 'TPE1', encoding: 3, text: Buffer.from(artist, 'utf8') },
    ]);

  const { db, root } = prepare({
    'Sigur Rós/2013 - Kveikur/Kveikur LP/01.mp3': track('Sigur Rós'),
    'Sigur Rós/2013 - Kveikur/Kveikur LP/02.mp3': track('Sigur Rós'),
    'Sigur Rós/2013 - Kveikur/Kveikur LP/03.mp3': track('Sigur Rós & Blanck Mass'),
  });

  applyArtists(db);

  const linked = db
    .prepare(
      `SELECT ar.name AS name FROM album al JOIN artist ar ON ar.id = al.artist_id
        WHERE al.rel_path LIKE '%Kveikur LP'`,
    )
    .get() as { name: string } | undefined;
  assert.equal(linked?.name, 'Sigur Rós', 'the artist every credit contains');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a split is still nobody’s record, and a majority still does not name it', () => {
  // The rule above answers only with a name **every** file states, which is why
  // it is not the majority rule this project rejected: `{Demonologists}` and
  // `{Cock E.S.P.}` have nothing in common, so ten tracks to one still leaves
  // the album with no artist rather than naming it after the one.
  const track = (artist: string): Buffer =>
    id3v2([{ id: 'TPE1', encoding: 3, text: Buffer.from(artist, 'utf8') }]);

  const { db, root } = prepare({
    'Split/01.mp3': track('Demonologists'),
    'Split/02.mp3': track('Demonologists'),
    'Split/03.mp3': track('Cock E.S.P.'),
  });

  applyArtists(db);

  const linked = db
    .prepare("SELECT artist_id FROM album WHERE rel_path = 'Split'")
    .get() as { artist_id: number | null };
  assert.equal(linked.artist_id, null, 'the honest answer for a split is none');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a merged artist is shown by the spelling that kept its accent', () => {
  // The unaccented spelling is the *more common* one here — two records against
  // one — so the count alone would show `Royksopp`. It is the wrong question to
  // ask: the accent is the part a tag loses on its way through a ripper, so the
  // spelling carrying it is the one somebody wrote down, and the plain one is
  // what came out the other end.
  const { db, root } = prepare({
    'A/album.flac': 'a',
    'A/album.cue': albumCue('Röyksopp'),
    'B/album.flac': 'b',
    'B/album.cue': albumCue('Royksopp'),
    'C/album.flac': 'c',
    'C/album.cue': albumCue('Royksopp'),
  });

  const counters = applyArtists(db);

  assert.equal(counters.artists, 1, 'three spellings of one name, one artist');
  assert.equal(counters.linked, 3);
  assert.equal(artists(db)[0]?.name, 'Röyksopp', 'the accent is what was written down');

  rmSync(root, { recursive: true, force: true });
  db.close();
});
