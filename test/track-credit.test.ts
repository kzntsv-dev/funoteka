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
import { tempRoot } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDb>;

/**
 * One image, one cue, and a PERFORMER per track.
 *
 * The record's own credit is the cue's album-level PERFORMER; each track carries
 * what the ripper wrote beside it. That is the shape this stage reads — and the
 * shape a live disc arrives in, which is where the notes about the room come
 * from.
 */
function albumCue(record: string, tracks: { title: string; performer: string }[]): string {
  const body = tracks
    .map(
      (track, index) =>
        `  TRACK ${String(index + 1).padStart(2, '0')} AUDIO\n` +
        `    TITLE "${track.title}"\n` +
        `    PERFORMER "${track.performer}"\n` +
        `    INDEX 01 ${String(index).padStart(2, '0')}:00:00\n`,
    )
    .join('');
  return `PERFORMER "${record}"\nTITLE "An Album"\nFILE "album.flac" WAVE\n${body}`;
}

function fixture(tree: Record<string, string | Buffer>): string {
  const root = tempRoot('funoteka-track-credit-');
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

function prepare(cue: string): { db: Db; root: string } {
  const root = fixture({ 'Album/album.flac': 'not really audio', 'Album/album.cue': cue });
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  applyTags(db);
  applyCues(db, { probe: probeReturning(300_000) });
  applyArtists(db);
  return { db, root };
}

/** The credits written, as `ordinal -> names`, which is what a reader sees. */
function creditsOf(db: Db): Record<number, string[]> {
  const rows = db
    .prepare(
      `SELECT t.ordinal AS ordinal, ar.name AS name
         FROM track_credit tc
         JOIN track t ON t.id = tc.track_id
         JOIN artist ar ON ar.id = tc.artist_id
        ORDER BY t.ordinal, tc.position`,
    )
    .all() as { ordinal: number; name: string }[];
  const out: Record<number, string[]> = {};
  for (const row of rows) (out[row.ordinal] ??= []).push(row.name);
  return out;
}

test('a track whose performer is not the record keeps a credit of its own', () => {
  // The case the whole thing is for: a record credited to two people whose
  // tracks are each by one of them. `track.artist_id` holds one artist and so
  // cannot say this; a list can (task:2729).
  const { db, root } = prepare(
    albumCue('Кино & Джоанна Стингрей', [
      { title: 'A Song', performer: 'Кино' },
      { title: 'Another', performer: 'Джоанна Стингрей' },
    ]),
  );

  assert.deepEqual(creditsOf(db), { 1: ['Кино'], 2: ['Джоанна Стингрей'] });

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a track repeating its record credit is not given a row of its own', () => {
  // 1862 of the live collection's 2626 stated performers say what the record
  // already says. A row repeating it would have to be kept in step for no
  // reason — and the comparison is by identity, not by the string, so a
  // spelling the artist stage has already folded does not count as a difference.
  const { db, root } = prepare(
    albumCue('Кино', [
      { title: 'A Song', performer: 'Кино' },
      { title: 'Another', performer: 'Кино' },
    ]),
  );

  assert.deepEqual(creditsOf(db), {});

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a performer that names the room is refused out loud, and is not an artist', () => {
  // A ripper writing PERFORMER on a live recording says who was *audible*, and
  // `Публика` is the audience. It must not become an artist — a search answering
  // `Публика` answers something nobody asked — and the refusal must be said, or
  // it is the same loss in a smaller place.
  const { db, root } = prepare(
    albumCue('Кино', [
      { title: 'A Song', performer: 'Кино' },
      { title: 'Live', performer: 'Публика' },
    ]),
  );

  const declined = db
    .prepare("SELECT detail FROM issue WHERE kind = 'track-performer-declined'")
    .all() as { detail: string }[];
  assert.equal(declined.length, 1, 'the refusal is reported once, for the track that earned it');
  assert.match(declined[0]?.detail ?? '', /Публика/);

  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM artist WHERE name LIKE '%Публика%'").get() as { n: number })
      .n,
    0,
    'and it is not a row in the artist table',
  );

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a name only a track states is reported rather than silently dropped', () => {
  // The one way this can lose a name: it is on no record's credit and in no
  // artist folder, so there is no row to point at. Resolving it anyway would be
  // inventing an identity — the guess this stage refuses everywhere else — so it
  // is reported instead (task:2729, and 120 of them in the live collection).
  const { db, root } = prepare(
    albumCue('Кино', [
      { title: 'A Song', performer: 'Кино' },
      { title: 'With a guest', performer: 'Совершенно Незнакомый Гость' },
    ]),
  );

  const unresolved = db
    .prepare("SELECT detail FROM issue WHERE kind = 'track-performer-unresolved'")
    .all() as { detail: string }[];
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0]?.detail ?? '', /Совершенно Незнакомый Гость/);
  assert.deepEqual(creditsOf(db), {});

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a guest another record knows is resolved through the name itself', () => {
  // A name only *this* track states has no artist folder and no place in the
  // record's own credit — so the group lookup misses it, and the fallback
  // answers: the bare name, and only to a row that already exists. Here the guest
  // is on another record's credit, which is the ordinary way a session player is
  // known at all. A name nobody else knows is the previous test: reported, not
  // invented.
  const root = fixture({
    'A/album.flac': 'not really audio',
    'A/album.cue': albumCue('Кино & Джоанна Стингрей', [
      { title: 'Together', performer: 'Кино' },
    ]),
    'B/album.flac': 'not really audio',
    'B/album.cue': albumCue('Кино', [
      { title: 'A Song', performer: 'Кино' },
      { title: 'With a guest', performer: 'Джоанна Стингрей' },
    ]),
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  applyTags(db);
  applyCues(db, { probe: probeReturning(300_000) });
  applyArtists(db);

  const guest = db
    .prepare(
      `SELECT ar.name AS name
         FROM track_credit tc
         JOIN artist ar ON ar.id = tc.artist_id
         JOIN track t ON t.id = tc.track_id
         JOIN album al ON al.id = t.album_id
        WHERE al.rel_path = 'B'`,
    )
    .all() as { name: string }[];
  assert.deepEqual(guest.map((row) => row.name), ['Джоанна Стингрей']);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM artist WHERE name = ?').get('Джоанна Стингрей') as { n: number }).n,
    1,
    'and the guest is one row, kept by the prune because a credit names it',
  );

  db.close();
  rmSync(root, { recursive: true, force: true });
});
