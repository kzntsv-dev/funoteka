import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { applyArtists } from '../src/artist/apply.ts';
import { classify } from '../src/classify/classify.ts';
import { applyCues } from '../src/cue/engine.ts';
import { openDb } from '../src/db/index.ts';
import { inventory } from '../src/inventory/inventory.ts';
import type { Probe } from '../src/probe/ffprobe.ts';
import { scan } from '../src/scan/scan.ts';
import { applyTags } from '../src/tags/apply.ts';
import { tempRoot } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDb>;

const IMAGE_CUE = `PERFORMER "Tangerine Dream"
TITLE "Green Desert"
FILE "Green Desert.m4a" WAVE
TRACK 01 AUDIO
TITLE "Green Desert"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "White Clouds"
INDEX 01 19:24:00
TRACK 03 AUDIO
TITLE "Astral Voyager"
INDEX 01 24:30:00
`;

/** A one-track image and its cue, performed by `performer`. */
function cueFor(performer: string): string {
  return `PERFORMER "${performer}"
TITLE "An Album"
FILE "album.flac" WAVE
TRACK 01 AUDIO
TITLE "A Song"
INDEX 01 00:00:00
`;
}

function fixture(tree: Record<string, string>): string {
  const root = tempRoot('funoteka-inventory-');
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

function run(root: string, db: Db): void {
  scan(db, [root]);
  classify(db);
  applyTags(db);
  applyCues(db, { probe: probeReturning(2_100_000) });
  applyArtists(db);
}

/** The lines the dump gives a track, whatever the columns between. */
function trackLines(out: string): string[] {
  return out.split('\n').filter((line) => /^\s{8}\d{2}\.\s/.test(line));
}

test('a track whose performer is not the record’s is shown on its own line', () => {
  // The record's credit is true of the record and false of every track on it: a
  // compilation is credited `Various Artists` while each track names its own.
  // The cue is where that fact lives, and nothing showed it — the dump printed a
  // track's number, title and file, so a reader could not tell a PERFORMER the
  // stage had parsed from one it had dropped (task:2727 §6).
  const root = fixture({
    'Comp/album.flac': 'audio',
    'Comp/album.cue': `PERFORMER "Various Artists"
TITLE "Compilation"
FILE "album.flac" WAVE
TRACK 01 AUDIO
TITLE "First"
PERFORMER "Armin van Buuren"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Second"
PERFORMER "Публика"
INDEX 01 05:00:00
`,
  });
  const db = openDb(':memory:');
  run(root, db);

  const lines = trackLines(inventory(db, { dbPath: 'meta.db' }));

  assert.equal(lines.length, 2, `expected two track lines, got:\n${lines.join('\n')}`);
  assert.match(lines[0] ?? '', /Armin van Buuren/);
  assert.match(lines[1] ?? '', /Публика/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a record whose every track says what the record says is not repeated per track', () => {
  // Tool, on the sample: eleven albums, every one of them stating a single
  // PERFORMER and it is the record's own. Printed per track that is 164
  // identical lines informing nothing — the same noise `creditOf` already
  // refuses to make for a one-name credit. The silence is the rule working, not
  // the label going missing.
  const root = fixture({
    'Album/album.flac': 'audio',
    'Album/album.cue': `PERFORMER "Tool"
TITLE "An Album"
FILE "album.flac" WAVE
TRACK 01 AUDIO
TITLE "A Song"
PERFORMER "Tool"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Another"
PERFORMER "Tool"
INDEX 01 04:00:00
`,
  });
  const db = openDb(':memory:');
  run(root, db);

  const lines = trackLines(inventory(db, { dbPath: 'meta.db' }));

  assert.equal(lines.length, 2, `expected two track lines, got:\n${lines.join('\n')}`);
  for (const line of lines) {
    assert.doesNotMatch(line, /Tool/, `the record's own name belongs on the record's line:\n${line}`);
  }

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the dump renders the classified collection, counters and all', () => {
  const root = fixture({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
    'Кино/45/01.flac': 'a',
    'Кино/45/02.flac': 'b',
  });
  const db = openDb(':memory:');
  run(root, db);

  const out = inventory(db, { dbPath: 'meta.db' });

  assert.match(out, /funoteka inventory — meta\.db/);
  assert.match(out, /roots\n\s+#1\s+/);

  // Counters are what acceptance reads for "no silent loss".
  assert.match(out, /albums\s+2/);
  assert.match(out, /tracks\s+5/);
  assert.match(out, /artists\s+1/);

  // A cue album lists its N tracks, not one row for the image.
  assert.match(out, /Tangerine Dream/);
  // The ordinal and the title sit on one line, whatever the columns between.
  assert.match(out, /01\..*Green Desert/);
  assert.match(out, /03\..*Astral Voyager/);

  // An album nobody claimed is shown rather than dropped.
  assert.match(out, /\(unattributed\)/);
  assert.match(out, /Кино\/45/);

  assert.match(out, /unaccounted/);
  assert.match(out, /audio files with no track or cue\s+0/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an image-cue album is marked as split, a plain one is not', () => {
  const root = fixture({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
    'Кино/45/01.flac': 'a',
  });
  const db = openDb(':memory:');
  run(root, db);

  const out = inventory(db, { dbPath: 'meta.db' });
  // An album line is indented under its artist and opens with its root mark.
  const albumLines = out.split('\n').filter((line) => /^\s{4}#\d+\s/.test(line));

  assert.equal(albumLines.length, 2, `expected two albums, got:\n${albumLines.join('\n')}`);

  assert.ok(
    albumLines.some((line) => /split/.test(line)),
    `expected a split album among:\n${albumLines.join('\n')}`,
  );
  assert.ok(
    albumLines.some((line) => !/split/.test(line)),
    'expected a plain album beside it',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('only the latest run’s issues are listed', () => {
  // Issue rows accumulate across runs — see the filed task — so the dump has to
  // read the run it describes, or every re-scan would repeat the list.
  const root = fixture({
    'Album/01.flac': 'a',
    'Album/02.flac': 'b',
    // A leftover cue beside a rip that is gone: it matches no audio, so the
    // stage says so — once per run, which is exactly what the dump must not
    // repeat.
    'Album/ghost.cue': 'FILE "missing.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n',
  });
  const db = openDb(':memory:');
  run(root, db);
  run(root, db);

  const out = inventory(db, { dbPath: 'meta.db' });

  assert.equal(
    (out.match(/cue-unmatched/g) ?? []).length,
    1,
    'the list must describe one run, not every run so far',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a second run over an unchanged collection reports what a fresh one does', () => {
  // The acceptance criterion, and it did not hold. The tags stage re-reads only
  // the files the ledger reports changed, so a second run over an unchanged
  // collection wrote no rows at all — while the report of every file it had
  // already read stayed on the first run's id, where the dump could not see it.
  // The reader was shown fewer issues than a first read of the same collection
  // gives, which is the silence the criterion exists to forbid (task:2726).
  const root = fixture({
    'Кино/45/01.flac': 'a',
    'Кино/45/02.flac': 'b',
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
  });

  const incremental = openDb(':memory:');
  run(root, incremental);
  run(root, incremental);

  const fresh = openDb(':memory:');
  run(root, fresh);

  // The run line and the ledger describe the run, not the collection: a second
  // run has another id and its own timestamp, and a ledger with something to
  // compare against.
  const reported = (db: Db): string =>
    inventory(db, { dbPath: 'meta.db' })
      .replace(/^run \d+.*$/m, 'run N')
      .replace(/\(run \d+\)/g, '(run N)')
      .replace(/^.*\bledger\b.*$/m, '');

  assert.equal(reported(incremental), reported(fresh));

  rmSync(root, { recursive: true, force: true });
  incremental.close();
  fresh.close();
});

test('the dump says how much of the collection the last walk found unmoved', () => {
  // Without this the dump cannot answer "did the rescan do anything", which is
  // half of what it is for.
  const root = fixture({ 'Album/a.flac': 'a', 'Album/b.flac': 'b' });
  const db = openDb(':memory:');
  run(root, db);

  assert.match(
    inventory(db, { dbPath: 'meta.db' }),
    /ledger\s+0 of 2 files unmoved/,
    'nothing has a previous state to compare against yet',
  );

  scan(db, [root]);

  assert.match(inventory(db, { dbPath: 'meta.db' }), /ledger\s+2 of 2 files unmoved/);

  writeFileSync(join(root, 'Album', 'a.flac'), 'changed');
  scan(db, [root]);

  assert.match(
    inventory(db, { dbPath: 'meta.db' }),
    /ledger\s+1 of 2 files unmoved/,
    'the touched file must fall out of the unmoved count',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a credit longer than one name is shown, not reduced to its first', () => {
  // Acceptance reads this dump, and `Cock E.S.P.` alone would look like the
  // album's artist while hiding that it is a collaboration.
  const root = fixture({
    '1994 - Cock E.S.P. + Thirdorgan - Split (Cass, C60)/01.flac': 'a',
  });
  const db = openDb(':memory:');
  run(root, db);

  const out = inventory(db, { dbPath: 'meta.db' });

  assert.match(out, /credit\s+Cock E\.S\.P\. \+ Thirdorgan/, 'the credit verbatim');
  assert.match(out, /artist-credit-split/, 'and the reading is listed as an issue');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an album named by one artist shows no credit line at all', () => {
  // The common case must not grow noise: a single name is already on the line
  // above it.
  const root = fixture({ 'Кино/45/01.flac': 'a' });
  const db = openDb(':memory:');
  run(root, db);

  assert.doesNotMatch(inventory(db, { dbPath: 'meta.db' }), /credit\s/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an empty database says so instead of printing nothing', () => {
  const db = openDb(':memory:');
  const out = inventory(db, { dbPath: 'meta.db' });

  assert.match(out, /funoteka inventory — meta\.db/);
  assert.match(out, /no scan/i);

  db.close();
});

test('two homonyms are two blocks, not one block holding both', () => {
  // The dump is where a human goes to check the classification, so a split that
  // is real in the table has to be real here. Keyed on the display name, two
  // artists who share one would print as a single block owning both albums —
  // the split would be invisible at exactly the place it is looked for.
  const root = fixture({
    'Music/Nirvana/Nevermind/album.flac': 'a',
    'Music/Nirvana/Nevermind/album.cue': cueFor('Nirvana'),
    'Other/Nirvana/Bleach/album.flac': 'b',
    'Other/Nirvana/Bleach/album.cue': cueFor('Nirvana'),
  });
  const db = openDb(':memory:');
  run(root, db);

  const out = inventory(db, { dbPath: 'meta.db' });
  const blocks = out.split('\n').filter((line) => /^\s{2}\S.*\s+\d+ albums?(\s+\[.*\])?$/.test(line));

  assert.equal(blocks.length, 2, `expected two artist blocks, got:\n${blocks.join('\n')}`);
  assert.ok(
    blocks.every((line) => /Nirvana/.test(line) && /1 album/.test(line)),
    `each block owns one album, not both:\n${blocks.join('\n')}`,
  );
  assert.ok(
    blocks.some((line) => /\[nirvana#2\]/.test(line)),
    `one block has to carry the suffixed key, or the two are indistinguishable:\n${blocks.join('\n')}`,
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});
