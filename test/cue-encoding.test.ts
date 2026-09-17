import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { classify } from '../src/classify/classify.ts';
import { applyCues } from '../src/cue/engine.ts';
import { openDb } from '../src/db/index.ts';
import type { Probe } from '../src/probe/ffprobe.ts';
import { scan } from '../src/scan/scan.ts';
import { CERTAIN } from '../src/text/encoding.ts';
import { cp1251 } from './helpers/bytes.ts';
import { tempRoot } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDb>;

/**
 * A Russian rip, written the way one actually arrives: CP1251 bytes, no
 * declaration anywhere. Left alone, `Привет` becomes `Ïðèâåò` in the meta layer
 * and nothing complains — which is the failure this stage exists to prevent.
 *
 * Verbatim from the collection (`1982 - 45 (Moroz Rec.)/image.cue`), trimmed
 * after the third track so the fixture stays readable; the full file is
 * thirteen tracks in exactly this shape.
 */
const CYRILLIC_CUE = `REM GENRE "Rock"
REM DATE 1982
REM DISCID A5095C0D
PERFORMER "Кино"
TITLE "45 (Moroz Rec.)"
REM DISCNUMBER 1
REM TOTALDISCS 1
FILE "01. Время есть, а денег нет.m4a" WAVE
  TRACK 01 AUDIO
    TITLE "Время есть, а денег нет"
    PERFORMER "Кино"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Просто хочешь ты знать"
    PERFORMER "Кино"
    INDEX 00 04:09:62
FILE "02. Просто хочешь ты знать.m4a" WAVE
    INDEX 01 00:00:00
  TRACK 03 AUDIO
    TITLE "Алюминиевые огурцы"
    PERFORMER "Кино"
    INDEX 00 03:27:50
FILE "03. Алюминиевые огурцы.m4a" WAVE
    INDEX 01 00:00:00
`;

/**
 * The spanning shape: one cue above two album folders, naming a file in each.
 * One cue reaches two albums — that the same file is read once per album is the
 * matcher's business, while the encoding it was read under is a fact about the
 * cue rather than about either album.
 */
const SPANNING_CUE = `PERFORMER "Кино"
TITLE "Сборник"
FILE "A/01.flac" WAVE
TRACK 01 AUDIO
TITLE "Песня"
INDEX 01 00:00:00
FILE "B/01.flac" WAVE
TRACK 02 AUDIO
TITLE "Другая песня"
INDEX 01 00:00:00
`;

const AUDIO_FILES: Record<string, string> = {
  '01. Время есть, а денег нет.m4a': 'a',
  '02. Просто хочешь ты знать.m4a': 'b',
  '03. Алюминиевые огурцы.m4a': 'c',
};

/** The album folder the cue above describes, with the audio it names. */
function albumTree(cue: string | Buffer): Record<string, string | Buffer> {
  const tree: Record<string, string | Buffer> = { 'Aquarium/image.cue': cue };
  for (const [name, content] of Object.entries(AUDIO_FILES)) tree[`Aquarium/${name}`] = content;
  return tree;
}

function fixture(tree: Record<string, string | Buffer>): string {
  const root = tempRoot('funoteka-encoding-');
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

function prepare(tree: Record<string, string | Buffer>): { db: Db; root: string } {
  const root = fixture(tree);
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  return { db, root };
}

function trackTitles(db: Db): string[] {
  return (db.prepare('SELECT title FROM track ORDER BY ordinal').all() as { title: string }[]).map(
    (row) => row.title,
  );
}

function cueRow(db: Db): { encoding: string; encoding_confidence: number } {
  return db.prepare('SELECT encoding, encoding_confidence FROM cue').get() as {
    encoding: string;
    encoding_confidence: number;
  };
}

test('a CP1251 cue is read as CP1251, not mojibaked', () => {
  const { db, root } = prepare(albumTree(cp1251(CYRILLIC_CUE)));

  applyCues(db, { probe: probeReturning(200_000) });

  assert.deepEqual(trackTitles(db), [
    'Время есть, а денег нет',
    'Просто хочешь ты знать',
    'Алюминиевые огурцы',
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the detected encoding is recorded against the cue', () => {
  const { db, root } = prepare(albumTree(cp1251(CYRILLIC_CUE)));

  applyCues(db, { probe: probeReturning(200_000) });

  const cue = cueRow(db);
  assert.equal(cue.encoding, 'windows-1251');
  assert.ok(cue.encoding_confidence < CERTAIN, 'a detected family is an inference, not a fact');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a confident inference is recorded as information, not as a warning', () => {
  // `Алюминиевые` is an eleven-byte run: the detector is not hedging, and a
  // scan of 50k files must not bury its real warnings under tens of thousands
  // of rows saying a well-understood cue was well understood.
  const { db, root } = prepare(albumTree(cp1251(CYRILLIC_CUE)));

  applyCues(db, { probe: probeReturning(200_000) });

  const issue = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'cue-encoding-guessed'")
    .get() as { severity: string; detail: string } | undefined;

  assert.ok(issue, 'the contract forbids losing this quietly (requirements:39)');
  assert.equal(issue.severity, 'info');
  assert.match(issue.detail, /1251/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a parent cue is reported once, not once per album it matches', () => {
  const { db, root } = prepare({
    'release.cue': cp1251(SPANNING_CUE),
    'A/01.flac': 'a',
    'B/01.flac': 'b',
  });

  const counters = applyCues(db, { probe: probeReturning(200_000) });

  // One cue, matched twice — that part is the matcher's business and is fine.
  assert.equal(counters.cues, 2);

  // The inference, though, is a fact about the cue, not about the album.
  const reported = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'cue-encoding-guessed'")
    .get() as { n: number };
  assert.equal(reported.n, 1, 'restating one inference per album is noise');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a UTF-8 cue is certain and raises no issue', () => {
  const { db, root } = prepare(albumTree(Buffer.from(CYRILLIC_CUE, 'utf8')));

  applyCues(db, { probe: probeReturning(200_000) });

  assert.deepEqual(trackTitles(db), [
    'Время есть, а денег нет',
    'Просто хочешь ты знать',
    'Алюминиевые огурцы',
  ]);

  assert.equal(cueRow(db).encoding, 'utf-8');
  assert.equal(cueRow(db).encoding_confidence, CERTAIN);

  const issue = db.prepare("SELECT 1 FROM issue WHERE kind = 'cue-encoding-guessed'").get();
  assert.equal(issue, undefined, 'nothing was inferred, so there is nothing to report');

  rmSync(root, { recursive: true, force: true });
  db.close();
});
