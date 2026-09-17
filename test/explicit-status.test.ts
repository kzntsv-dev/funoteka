import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explicitStatusOf } from '../src/api/browse.ts';
import { openDb } from '../src/db/index.ts';
import { refreshFirstTags } from '../src/tags/first.ts';
import { ask, type Db } from './helpers/api.ts';

/**
 * How a song says what it is rated, which OpenSubsonic asks of every `Child`.
 *
 * The field is small and the trap in it is not: the protocol names **two** tags
 * with **two** numberings — "ITUNESADVISORY: 1 = explicit, 2 = clean, MP4 rtng:
 * 1 or 4 = explicit, 2 = clean" — and reading one numbering for both would make
 * every `rtng` of 4 a song of unknown rating. Which tag a value came from is
 * therefore part of what it says (task:2866).
 */

test('the two numberings are read as the specification gives them', () => {
  assert.equal(explicitStatusOf('1', null), 'explicit');
  assert.equal(explicitStatusOf('2', null), 'clean');
  assert.equal(explicitStatusOf(null, '1'), 'explicit');
  assert.equal(explicitStatusOf(null, '4'), 'explicit', 'and four is only this tag’s');

  // The pair that says the numberings are not one: 4 is explicit to `rtng` and
  // means nothing to `ITUNESADVISORY`, so a single column could not have held
  // both without inventing an answer for one of them.
  assert.equal(explicitStatusOf('4', null), '', 'four names nothing in this tag');
  assert.equal(explicitStatusOf(null, '2'), 'clean');

  assert.equal(explicitStatusOf(null, null), '', 'nobody rated it, which is an answer');
  assert.equal(explicitStatusOf('', null), '', 'and so is an empty tag');
  assert.equal(explicitStatusOf('yes', null), '', 'a value that is not a number names nothing');
});

/** One song, with whatever tags it is given. */
function collection(tags: [string, string][]): { db: Db; close: () => void } {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(
    'C:\\music',
    '2026-01-01T00:00:00Z',
  );
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
  db.prepare(
    `INSERT INTO audio_probe (file_id, codec, sample_rate, channels, bitrate, probe_ok, probe_method)
     VALUES (11, 'flac', 44100, 2, 900000, 1, 1)`,
  ).run();

  const tag = db.prepare(
    'INSERT INTO file_tag (file_id, name, value, position) VALUES (11, ?, ?, 0)',
  );
  for (const [name, value] of tags) tag.run(name, value);
  // The row a listing reads them off, which the scanner writes beside the tags
  // and this stands in for (task:2925).
  refreshFirstTags(db, 11);

  return { db, close: () => db.close() };
}

const statusOf = async (db: Db): Promise<unknown> => {
  const body = JSON.parse((await ask(db, 'getSong?id=tr-1&f=json')).body.toString('utf8')) as {
    'subsonic-response': { song?: { explicitStatus?: unknown } };
  };
  return body['subsonic-response'].song?.explicitStatus;
};

test('a song whose file says it is explicit says so to a client', async () => {
  // The tag reaches the field by the same road the genre takes: `file_tag` is a
  // bag of everything the scan read, and this one is read straight out of it.
  // `itunesadvisory` needs nothing added to any reader — a Vorbis comment and an
  // ID3v2 `TXXX` frame both land under their own name already.
  const tagged = collection([['itunesadvisory', '1']]);
  assert.equal(await statusOf(tagged.db), 'explicit');
  tagged.close();

  const mp4 = collection([['rtng', '1']]);
  assert.equal(await statusOf(mp4.db), 'explicit', 'and the MP4 atom is read too');
  mp4.close();
});

test('a song nobody rated is rated the empty string, not left out', async () => {
  // The protocol gives this field a third value and it is `""`, so an unrated
  // song has an answer rather than an absence — unlike `genre` beside it, where
  // a client handed `""` would have a genre whose name is nothing. Every song of
  // this collection is in this case: not one `itunesadvisory` and not one `rtng`
  // in any of its `file_tag` rows, measured (task:2866).
  const unrated = collection([]);
  assert.equal(await statusOf(unrated.db), '');
  unrated.close();

  const nonsense = collection([['itunesadvisory', 'maybe']]);
  assert.equal(await statusOf(nonsense.db), '', 'and a tag that names no rating is no rating');
  nonsense.close();
});
