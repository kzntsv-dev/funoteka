import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { classify } from '../src/classify/classify.ts';
import { scan } from '../src/scan/scan.ts';
import { applyTags } from '../src/tags/apply.ts';
import { refreshFirstTags } from '../src/tags/first.ts';
import { flac } from './helpers/bytes.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The eight tags a listing shows, in the row the listing now reads them from.
 *
 * `file_tag_first` exists so that a page of five hundred songs stops asking
 * `file_tag` eight times a song — 10.04 ms a page that way against 6.37 off the
 * row, measured, with every other shape worse (task:2925). What that buys is
 * only worth having if the row answers **exactly** what the eight correlated
 * subqueries answered, so that is what these tests assert, against the
 * subqueries themselves rather than against a restatement of the rule.
 *
 * The oracle below is deliberately the old form, written out here: an oracle
 * that shared an implementation with the thing under test would agree with it
 * about being wrong. `migrations/036_file_tag_first.sql` carries a third
 * spelling of the same rule for the backfill, and it is the same rule by
 * construction — this pins the two that can drift.
 */

type Db = ReturnType<typeof openDb>;

const FIRST_TAGS: readonly (readonly [string, string])[] = [
  ['genre', 'genre'],
  ['artist', 'track_artist'],
  ['itunesadvisory', 'advisory_itunes'],
  ['rtng', 'advisory_mp4'],
  ['replaygain_track_gain', 'rg_track_gain'],
  ['replaygain_album_gain', 'rg_album_gain'],
  ['replaygain_track_peak', 'rg_track_peak'],
  ['replaygain_album_peak', 'rg_album_peak'],
];

const COLUMNS = FIRST_TAGS.map(([, column]) => column);

const TRIMMED = `TRIM(ft.value, ' ' || CHAR(9) || CHAR(10) || CHAR(13) || CHAR(160) || CHAR(12288))`;

/** What the listing asked before there was a row: one subquery per name. */
function oracle(db: Db, fileId: number): (string | null)[] {
  const asked = FIRST_TAGS.map(
    ([name, column]) =>
      `(SELECT ${TRIMMED} FROM file_tag ft
         WHERE ft.file_id = f.id AND ft.name = '${name}' AND ${TRIMMED} <> ''
         ORDER BY ft.position LIMIT 1) AS ${column}`,
  );
  const found = db.prepare(`SELECT ${asked.join(', ')} FROM file f WHERE f.id = ?`).get(fileId);
  return COLUMNS.map((column) => (found?.[column] ?? null) as string | null);
}

/** What the row says. A file with no row is a file with no values. */
function row(db: Db, fileId: number): (string | null)[] {
  const found = db.prepare(
    `SELECT ${COLUMNS.join(', ')} FROM file_tag_first WHERE file_id = ?`,
  ).get(fileId);
  return COLUMNS.map((column) => (found?.[column] ?? null) as string | null);
}

/** A collection with one file and one track, and whatever tags it is handed. */
function collection(tags: readonly (readonly [string, string, number])[]): Db {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run('C:\\music', '2026-01-01T00:00:00Z');
  db.prepare(
    `INSERT INTO album (id, root_id, rel_path, title, title_source)
     VALUES (10, 1, 'Album', 'Album', 'folder')`,
  ).run();
  db.prepare(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (11, 1, 'Album/one.flac', 'Album', 'one.flac', 'audio', 'flac', 4096, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
     VALUES (1, 10, 1, 'One', 11, 60000)`,
  ).run();

  const write = db.prepare('INSERT INTO file_tag (file_id, name, value, position) VALUES (11, ?, ?, ?)');
  for (const [name, value, position] of tags) write.run(name, value, position);
  refreshFirstTags(db, 11);
  return db;
}

/** The names, as a handy record for the assertions that read like prose. */
const named = (values: (string | null)[]): Record<string, string | null> =>
  Object.fromEntries(COLUMNS.map((column, at) => [column, values[at] ?? null]));

test('the rule: first by position, trimmed, and an empty value falls through', () => {
  const db = collection([
    // Two artist lines, which is how a file writes a collaboration.
    ['artist', 'First Named', 0],
    ['artist', 'Second Named', 1],
    // A genre that is nothing but a tab, then the genre that means something:
    // the empty one is not a value, so the second line answers.
    ['genre', '\t', 0],
    ['genre', '  Rock  ', 1],
    // Padding of the kind a tagger leaves: a no-break space and an ideographic
    // space, which SQLite's one-argument TRIM would walk straight past.
    ['itunesadvisory', '\u00a01\u3000', 0],
    // A name that is not one of the eight, which this table is not about.
    ['title', 'One', 0],
  ]);

  assert.deepEqual(named(row(db, 11)), {
    genre: 'Rock',
    track_artist: 'First Named',
    advisory_itunes: '1',
    advisory_mp4: null,
    rg_track_gain: null,
    rg_album_gain: null,
    rg_track_peak: null,
    rg_album_peak: null,
  });

  db.close();
});

test('the row answers exactly what the eight subqueries answered', () => {
  // Every awkward shape at once, against the oracle rather than against a
  // restatement: repeated names, hidden whitespace, an empty first line, a
  // value stated only at a later position, and four names no file has.
  const shapes: readonly (readonly [string, string, number][])[] = [
    [],
    [['genre', 'Rock', 0]],
    [['genre', '   ', 0], ['genre', 'Rock', 3]],
    [['artist', 'A', 0], ['artist', 'B', 1], ['artist', 'C', 2]],
    [['rtng', '4', 0], ['itunesadvisory', '2', 0]],
    [['replaygain_track_gain', '-7.66 dB', 0], ['replaygain_album_peak', '1.00000000', 0]],
    [['genre', '\u3000\u00a0', 0]],
    [['title', 'not one of the eight', 0]],
  ];

  for (const tags of shapes) {
    const db = collection(tags);
    assert.deepEqual(
      row(db, 11),
      oracle(db, 11),
      `a row built from ${JSON.stringify(tags)} must say what the subqueries said`,
    );
    db.close();
  }
});

test('a tag taken out of the file leaves the row, rather than standing in it', () => {
  // The scanner deletes every tag of a file and writes what it read, so a genre
  // taken out of the file has to leave the meta layer. A write that only
  // inserted when there was something to insert would leave the old row
  // standing — a file that no longer states a genre would go on being listed
  // under one.
  const db = collection([['genre', 'Rock', 0]]);
  assert.equal(named(row(db, 11)).genre, 'Rock');

  db.prepare("DELETE FROM file_tag WHERE file_id = 11 AND name = 'genre'").run();
  refreshFirstTags(db, 11);

  assert.equal(named(row(db, 11)).genre, null);
  assert.deepEqual(row(db, 11), oracle(db, 11));

  db.close();
});

test('a file the scanner read says so to a client, off the row the stage wrote', async () => {
  // End to end, on real bytes: the stage reads a FLAC's Vorbis comments, writes
  // `file_tag` and the row beside it in one transaction, and the listing answers
  // from the row. Nothing here writes `file_tag` by hand, so this is the half a
  // fixture cannot show — that the stage writes the second thing at all.
  const root = tempRoot('funoteka-first-');
  mkdirSync(join(root, 'Album'), { recursive: true });
  writeFileSync(
    join(root, 'Album', 'one.flac'),
    Buffer.concat([
      flac({
        tags: {
          GENRE: 'Rock',
          ARTIST: 'Kino',
          ITUNESADVISORY: '1',
          REPLAYGAIN_TRACK_GAIN: '-7.66 dB',
          REPLAYGAIN_TRACK_PEAK: '0.99960327',
        },
      }),
      Buffer.alloc(200_000, 7),
    ]),
  );

  const db = openDb(':memory:');
  try {
    scan(db, [root]);
    classify(db);
    applyTags(db);

    const fileId = (db.prepare('SELECT id FROM file').get() as { id: number }).id;
    assert.deepEqual(
      named(row(db, fileId)),
      {
        genre: 'Rock',
        track_artist: 'Kino',
        advisory_itunes: '1',
        advisory_mp4: null,
        rg_track_gain: '-7.66 dB',
        rg_album_gain: null,
        rg_track_peak: '0.99960327',
        rg_album_peak: null,
      },
      'the stage wrote the row, and wrote the file’s own values into it',
    );
    assert.deepEqual(row(db, fileId), oracle(db, fileId), 'and it agrees with the subqueries');
  } finally {
    db.close();
  }
});
