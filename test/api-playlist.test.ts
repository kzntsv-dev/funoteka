import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { classify } from '../src/classify/classify.ts';
import { applyCues } from '../src/cue/engine.ts';
import { openDb } from '../src/db/index.ts';
import * as store from '../src/playlist/store.ts';
import type { Probe } from '../src/probe/ffprobe.ts';
import { scan } from '../src/scan/scan.ts';
import { ask } from './helpers/api.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * Playlists: the one part of the API that writes.
 *
 * Written against a hand-built meta layer, like the other API suites and for
 * the same reason — what is under test is what a client is told and what the
 * server keeps, and a fixture that went through the scanner would be asserting
 * the scanner first. The one thing that cannot be asserted that way is the
 * criterion this whole feature exists for — *a playlist survives a scan* — so
 * that one test goes to disk and runs the real stages.
 *
 * The collection is small and awkward on purpose: songs with a record, a song
 * with none, and two records so that a playlist can hold a song from each.
 */
function collection(path = ':memory:'): ReturnType<typeof openDb> {
  const db = openDb(path);
  const run = (sql: string, ...args: (string | number | null)[]): void => {
    db.prepare(sql).run(...args);
  };

  run('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)', 'C:/music', '2026-01-01T00:00:00Z');
  run("INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Кино', 'кино', 'Кино')");
  for (const [id, relPath] of [
    [10, 'Кино/Группа крови'],
    [11, 'Кино/Звезда по имени Солнце'],
  ] as [number, string][]) {
    run(
      `INSERT INTO album (id, root_id, rel_path, title, title_source, artist_id)
       VALUES (?, 1, ?, ?, 'folder', 1)`,
      id,
      relPath,
      relPath.slice(relPath.lastIndexOf('/') + 1),
    );
  }

  const file = (id: number, relPath: string): void => {
    run(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, ?, ?, 'audio', 'flac', 4096, 1000)`,
      id,
      relPath,
      relPath.slice(0, relPath.lastIndexOf('/')),
      relPath.slice(relPath.lastIndexOf('/') + 1),
    );
  };

  const track = (id: number, albumId: number | null, ordinal: number, title: string): void => {
    file(100 + id, `Кино/${title}/${String(ordinal).padStart(2, '0')}.flac`);
    run(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      id,
      albumId,
      ordinal,
      title,
      100 + id,
      id * 60_000,
    );
  };

  track(1, 10, 1, 'Группа крови');
  track(2, 10, 2, 'Закрой за мной дверь');
  track(3, 11, 1, 'Звезда по имени Солнце');
  // A song on no record at all: a playlist may hold it, and its picture is then
  // its own file's rather than a record's.
  track(4, null, 1, 'Loose');

  return db;
}

interface Entry {
  id: string;
  title: string;
}

interface Playlist {
  id: string;
  name: string;
  comment?: string;
  owner: string;
  public: boolean;
  readonly: boolean;
  songCount: number;
  duration: number;
  created: string;
  changed: string;
  coverArt?: string;
  entry?: Entry[];
}

interface Envelope {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
    playlists?: { playlist: Playlist[] };
    playlist?: Playlist;
  };
}

async function envelope(
  db: ReturnType<typeof openDb>,
  path: string,
): Promise<Envelope['subsonic-response']> {
  const response = await ask(db, path);
  return (JSON.parse(response.body.toString('utf8')) as Envelope)['subsonic-response'];
}

/** Post a form body, which is how the protocol carries a repeated parameter. */
async function post(
  db: ReturnType<typeof openDb>,
  method: string,
  fields: [string, string][],
): Promise<Envelope['subsonic-response']> {
  const body = fields
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  const response = await ask(db, `${method}?f=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  return (JSON.parse(response.body.toString('utf8')) as Envelope)['subsonic-response'];
}

test('a server with no playlists says so rather than refusing the call', async () => {
  // The answer a client gets before anything is created — and it has to be an
  // empty list and not a failure: a client that read a failure here would
  // decide the server has no playlists *feature*, and never offer to make one.
  const db = collection();

  const answer = await envelope(db, 'getPlaylists?f=json');
  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.playlists?.playlist, []);

  db.close();
});

test('createPlaylist keeps the songs it was given, in the order they came', async () => {
  const db = collection();

  const made = await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-2'],
    ['songId', 'tr-1'],
  ]);

  assert.equal(made.status, 'ok');
  assert.equal(made.playlist?.name, 'Дорога');
  assert.equal(made.playlist?.songCount, 2);
  assert.deepEqual(made.playlist?.entry?.map((song) => song.title), [
    'Закрой за мной дверь',
    'Группа крови',
  ]);
  // Three minutes in, from 60 s and 120 s: the length is the sum of the songs'.
  assert.equal(made.playlist?.duration, 180);
  assert.equal(made.playlist?.owner, 'demo');
  assert.equal(made.playlist?.public, false);
  assert.equal(made.playlist?.created, made.playlist?.changed, 'nothing has changed it yet');
  // OpenSubsonic's rule for a field of its own: a server that supports it says
  // so even when it has nothing to report, which is how a client tells
  // "editable" from "this server has never heard of the question".
  assert.equal(made.playlist?.readonly, false);

  db.close();
});

test('the list a client browses carries no songs, and the one it opens does', async () => {
  // Two methods, one question asked twice: a sidebar draws names and lengths,
  // and a page that opened one carries the entries. Sending every song of every
  // playlist to draw a sidebar is the cost this split exists to avoid.
  const db = collection();
  await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
  ]);

  const listed = await envelope(db, 'getPlaylists?f=json');
  const opened = await envelope(db, 'getPlaylist?f=json&id=pl-1');

  assert.equal(listed.playlists?.playlist[0]?.name, 'Дорога');
  assert.equal(listed.playlists?.playlist[0]?.entry, undefined, 'the list carries no entries');
  assert.deepEqual(opened.playlist?.entry?.map((song) => song.id), ['tr-1']);
  // The same numbers in both, which is the whole contract between them — and
  // the same picture: a sidebar draws a cover beside the name, and an answer
  // that carried one only when the playlist was opened would leave it blank
  // where it is looked at.
  assert.equal(opened.playlist?.songCount, listed.playlists?.playlist[0]?.songCount);
  assert.equal(opened.playlist?.duration, listed.playlists?.playlist[0]?.duration);
  assert.equal(opened.playlist?.coverArt, 'al-10', 'the first song\'s record');
  assert.equal(listed.playlists?.playlist[0]?.coverArt, 'al-10');

  db.close();
});

test('a playlist is asked about by the id it was handed, and by no other', async () => {
  const db = collection();
  await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
  ]);

  const song = await envelope(db, 'getPlaylist?f=json&id=tr-1');
  assert.equal(song.status, 'failed');
  assert.equal(song.error?.code, 70, 'a track id names no playlist, and saying so is the answer');

  const missing = await envelope(db, 'getPlaylist?f=json&id=pl-99');
  assert.equal(missing.status, 'failed');
  assert.equal(missing.error?.code, 70);

  const nothing = await envelope(db, 'getPlaylist?f=json');
  assert.equal(nothing.status, 'failed');
  assert.equal(nothing.error?.code, 10, 'no id at all is a missing parameter, not a missing playlist');

  // And an id written the way `Number` would read it but this server never
  // handed out: `pl-1e3` is not a playlist, and saying "no such playlist" about
  // it is only true if the reading is strict.
  for (const written of ['pl-1e3', 'pl-0x10', 'pl: 1', 'pl-1.0']) {
    const odd = await envelope(db, `getPlaylist?f=json&id=${encodeURIComponent(written)}`);
    assert.equal(odd.status, 'failed', `${written} names nothing`);
    assert.equal(odd.error?.code, 70);
  }

  // **And an id from before the separator changed names the same playlist.**
  // That is the whole of what the change was allowed to cost, and this is where
  // it was broken first: the parse compared against the prefix *constant*, so
  // changing the constant stopped recognising `pl:` — a client holding a
  // playlist id from before was told there is no such playlist, while the
  // commit that changed the separator said nothing would be orphaned
  // (task:2896).
  const listed = await envelope(db, 'getPlaylists?f=json');
  const handed = listed.playlists?.playlist[0]?.id as string | undefined;
  assert.match(String(handed), /^pl-\d+$/u, 'and the one it hands out now is the hyphen');

  const before = await envelope(
    db,
    `getPlaylist?f=json&id=${String(handed).replace('pl-', 'pl:')}`,
  );
  assert.equal(before.status, 'ok', 'an id written before the change still resolves');
  assert.equal(before.playlist?.id, handed, 'and it is the same playlist');

  db.close();
});

test('createPlaylist on an id that exists replaces its songs', async () => {
  // The protocol folds "make" and "set the contents of" into one method, and
  // the difference is one parameter. A client that re-saves a playlist it
  // edited sends exactly this, and the songs it names are the whole list.
  const db = collection();
  await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
    ['songId', 'tr-2'],
  ]);

  const replaced = await post(db, 'createPlaylist', [
    ['playlistId', 'pl-1'],
    ['songId', 'tr-3'],
  ]);

  assert.equal(replaced.status, 'ok');
  assert.deepEqual(replaced.playlist?.entry?.map((song) => song.id), ['tr-3']);
  // The name is not a parameter of this call, and a playlist that lost its name
  // because a client re-filled it would be a playlist nobody can find again.
  assert.equal(replaced.playlist?.name, 'Дорога');

  const listed = await envelope(db, 'getPlaylists?f=json');
  assert.equal(listed.playlists?.playlist.length, 1, 'replaced, not added to');

  db.close();
});

test('a new playlist with no name is refused and says which parameter', async () => {
  const db = collection();

  const answer = await post(db, 'createPlaylist', [['songId', 'tr-1']]);

  assert.equal(answer.status, 'failed');
  assert.equal(answer.error?.code, 10);
  assert.match(answer.error?.message ?? '', /name/);

  db.close();
});

test('a song the server does not have is refused, and no playlist is made', async () => {
  // The refusal is the feature. A playlist quietly one song short is one the
  // client cannot tell from the playlist it asked for, and the song that went
  // missing would only surface when somebody played the list through.
  const db = collection();

  const answer = await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
    ['songId', 'tr-99'],
  ]);

  assert.equal(answer.status, 'failed');
  assert.equal(answer.error?.code, 70);
  assert.match(answer.error?.message ?? '', /tr-99/);

  const listed = await envelope(db, 'getPlaylists?f=json');
  assert.deepEqual(listed.playlists?.playlist, [], 'and nothing was written');

  db.close();
});

test('updatePlaylist adds to the end and drops by the position it was given', async () => {
  const db = collection();
  await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
    ['songId', 'tr-2'],
    ['songId', 'tr-3'],
  ]);

  await post(db, 'updatePlaylist', [
    ['playlistId', 'pl-1'],
    ['songIndexToRemove', '1'],
    ['songIdToAdd', 'tr-4'],
  ]);

  const opened = await envelope(db, 'getPlaylist?f=json&id=pl-1');
  assert.deepEqual(opened.playlist?.entry?.map((song) => song.id), ['tr-1', 'tr-3', 'tr-4']);

  db.close();
});

test('the positions a client sends are the ones it was shown', async () => {
  // Two removals in one call, and they are read against the list the client is
  // holding rather than against the list as it is being emptied: `0` and `2` are
  // the first and the last of what it has on screen. Read step by step instead,
  // the second would land on the song that had shifted into that place.
  const db = collection();
  await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
    ['songId', 'tr-2'],
    ['songId', 'tr-3'],
  ]);

  await post(db, 'updatePlaylist', [
    ['playlistId', 'pl-1'],
    ['songIndexToRemove', '0'],
    ['songIndexToRemove', '2'],
  ]);

  const opened = await envelope(db, 'getPlaylist?f=json&id=pl-1');
  assert.deepEqual(opened.playlist?.entry?.map((song) => song.id), ['tr-2']);

  db.close();
});

test('a field the client did not send is left alone', async () => {
  const db = collection();
  await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
  ]);
  await post(db, 'updatePlaylist', [
    ['playlistId', 'pl-1'],
    ['comment', 'на дачу'],
    ['public', 'true'],
  ]);

  await post(db, 'updatePlaylist', [
    ['playlistId', 'pl-1'],
    ['name', 'Дорога дальняя'],
  ]);

  const opened = await envelope(db, 'getPlaylist?f=json&id=pl-1');
  assert.equal(opened.playlist?.name, 'Дорога дальняя');
  assert.equal(opened.playlist?.comment, 'на дачу', 'the comment was not sent, and is not gone');
  assert.equal(opened.playlist?.public, true);

  // And the exception, which is the comment: sending nothing keeps it, sending
  // nothing *as a comment* takes it off. A name of nothing is not a rename.
  await post(db, 'updatePlaylist', [
    ['playlistId', 'pl-1'],
    ['name', ''],
    ['comment', ''],
  ]);

  const cleared = await envelope(db, 'getPlaylist?f=json&id=pl-1');
  assert.equal(cleared.playlist?.name, 'Дорога дальняя', 'an empty name is not a name');
  assert.equal(cleared.playlist?.comment, undefined, 'an empty comment is a comment taken off');

  db.close();
});

test('renaming through createPlaylist keeps the songs', async () => {
  // The protocol folds renaming into the method that sets a playlist's
  // contents, and a client that renames sends an id and a name and nothing
  // else. Reading that silence as "the list is now empty" would throw the
  // listener's songs away while answering `ok` — and the criterion this feature
  // is accepted by names renaming as a thing of its own.
  const db = collection();
  await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
    ['songId', 'tr-2'],
  ]);

  const renamed = await post(db, 'createPlaylist', [
    ['playlistId', 'pl-1'],
    ['name', 'Дорога дальняя'],
  ]);

  assert.equal(renamed.status, 'ok');
  assert.equal(renamed.playlist?.name, 'Дорога дальняя');
  assert.equal(renamed.playlist?.songCount, 2, 'the songs were not named, and are not gone');
  assert.deepEqual(renamed.playlist?.entry?.map((song) => song.id), ['tr-1', 'tr-2']);

  // Saying nothing about the songs is not saying none of them: a client that
  // means to empty a playlist sends the parameter with nothing in it.
  await post(db, 'createPlaylist', [['playlistId', 'pl-1'], ['songId', '']]);
  const emptied = await envelope(db, 'getPlaylist?f=json&id=pl-1');
  assert.deepEqual(emptied.playlist?.entry, []);

  db.close();
});

test('a playlist read from a file is not the listener\'s to change', async () => {
  // A `.m3u` in the collection is a list this server imported, and the file is
  // what that list *is*: the stage rewrites the row from it on every scan that
  // re-reads it. An edit made through the API would therefore last until the
  // next scan and a deletion would be undone by the one after — so neither is
  // accepted, and the client is told which kind of list it is holding before it
  // offers the controls at all.
  const db = collection();
  const file = (db.prepare('SELECT id FROM file LIMIT 1').get() as { id: number }).id;
  store.create(db, 'Из файла', [1, 2], file);

  const listed = await envelope(db, 'getPlaylists?f=json');
  assert.equal(listed.playlists?.playlist[0]?.readonly, true, 'a client is told');

  const renamed = await post(db, 'updatePlaylist', [
    ['playlistId', 'pl-1'],
    ['name', 'Моё'],
  ]);
  assert.equal(renamed.status, 'failed');
  assert.equal(renamed.error?.code, 50, 'not this caller\'s list to change');
  assert.match(renamed.error?.message ?? '', /read from a file/);

  const deleted = await post(db, 'deletePlaylist', [['id', 'pl-1']]);
  assert.equal(deleted.status, 'failed');
  assert.equal(deleted.error?.code, 50);

  const opened = await envelope(db, 'getPlaylist?f=json&id=pl-1');
  assert.equal(opened.status, 'ok', 'and it is still there, unedited');
  assert.equal(opened.playlist?.name, 'Из файла');

  // The listener's own playlist beside it is editable, which is what makes the
  // refusal a statement about this row rather than about the route.
  await post(db, 'createPlaylist', [
    ['name', 'Моё'],
    ['songId', 'tr-3'],
  ]);
  const mine = await envelope(db, 'getPlaylists?f=json');
  assert.deepEqual(
    mine.playlists?.playlist.map((one) => [one.name, one.readonly]),
    [
      ['Из файла', true],
      ['Моё', false],
    ],
  );

  db.close();
});

test('a deleted playlist does not hand its id to the next one', async () => {
  // `INTEGER PRIMARY KEY` is the rowid, so a row created after a deletion takes
  // the number the deleted row had. A client holding a playlist — a bookmark, a
  // half-played queue — would then be shown somebody else's list under an id it
  // was given, and nothing in the answer would say so. See migration 025.
  const db = collection();
  await post(db, 'createPlaylist', [
    ['name', 'Первая'],
    ['songId', 'tr-1'],
  ]);
  await post(db, 'deletePlaylist', [['id', 'pl-1']]);

  const made = await post(db, 'createPlaylist', [
    ['name', 'Вторая'],
    ['songId', 'tr-2'],
  ]);

  assert.notEqual(made.playlist?.id, 'pl-1', 'the id is handed out once');

  db.close();
});

test('an edit moves `changed` and leaves `created` where it was', async () => {
  // The two stamps are what a client syncs by, and a playlist whose `changed`
  // never moved would tell it the copy it holds is current.
  const db = collection();
  const made = await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
  ]);

  // A millisecond later, because the real clock is too coarse to tell the two
  // instants apart — and a test that could not tell them apart would pass
  // against a route that never stamped the edit at all.
  const later = new Date(Date.parse(made.playlist?.created ?? '') + 1000).toISOString();
  db.prepare('UPDATE playlist SET created_at = ? WHERE id = 1').run(later);

  await post(db, 'updatePlaylist', [
    ['playlistId', 'pl-1'],
    ['name', 'Дорога дальняя'],
  ]);

  const opened = await envelope(db, 'getPlaylist?f=json&id=pl-1');
  assert.equal(opened.playlist?.created, later, 'the playlist was not made again');
  assert.notEqual(opened.playlist?.changed, later);

  db.close();
});

test('deletePlaylist takes the playlist and leaves the songs', async () => {
  const db = collection();
  await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
    ['songId', 'tr-2'],
  ]);

  const gone = await post(db, 'deletePlaylist', [['id', 'pl-1']]);
  assert.equal(gone.status, 'ok');

  const listed = await envelope(db, 'getPlaylists?f=json');
  assert.deepEqual(listed.playlists?.playlist, []);
  const song = await envelope(db, 'getSong?f=json&id=tr-1');
  assert.equal(song.status, 'ok', 'a playlist is a view of the songs, not a place they live');

  const again = await post(db, 'deletePlaylist', [['id', 'pl-1']]);
  assert.equal(again.status, 'failed', 'and a second call names nothing');
  assert.equal(again.error?.code, 70);

  db.close();
});

test('the same song twice is two entries, and two plays', async () => {
  const db = collection();

  const made = await post(db, 'createPlaylist', [
    ['name', 'На репите'],
    ['songId', 'tr-1'],
    ['songId', 'tr-1'],
  ]);

  assert.equal(made.playlist?.songCount, 2);
  assert.equal(made.playlist?.duration, 120, 'counted twice, because it is played twice');

  db.close();
});

test('a song that leaves the disk leaves the playlist, and the playlist stays', async () => {
  // The one thing a playlist cannot survive: the file is gone, the sweep drops
  // the track, and an entry pointing at a row that is not there would be a
  // playlist that fails to open. The playlist itself is the listener's and is
  // not the sweep's to touch.
  const db = collection();
  await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', 'tr-1'],
    ['songId', 'tr-2'],
    ['songId', 'tr-3'],
  ]);

  db.prepare('DELETE FROM track WHERE id = 2').run();

  const opened = await envelope(db, 'getPlaylist?f=json&id=pl-1');
  assert.equal(opened.status, 'ok', 'the playlist is still there');
  assert.deepEqual(opened.playlist?.entry?.map((song) => song.id), ['tr-1', 'tr-3']);
  assert.equal(opened.playlist?.songCount, 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'and nothing dangles');

  db.close();
});

test('an empty playlist is a playlist, with no entries and no picture', async () => {
  // A client that makes a playlist and fills it later is the ordinary way one
  // is made — and an answer that named a cover for it would name a picture of
  // nothing.
  const db = collection();

  const made = await post(db, 'createPlaylist', [['name', 'Пустой']]);

  assert.equal(made.status, 'ok');
  assert.deepEqual(made.playlist?.entry, []);
  assert.equal(made.playlist?.songCount, 0);
  assert.equal(made.playlist?.duration, 0);
  assert.equal(made.playlist?.coverArt, undefined);

  const deleted = await post(db, 'deletePlaylist', [['id', 'pl-1']]);
  assert.equal(deleted.status, 'ok');

  db.close();
});

test('a save waits for the writer holding the database, and says so when it cannot', async () => {
  // The meta layer has two writers by design: a scan holds the file for seconds
  // at a time, and this API writes the listener's playlists. What that costs a
  // client was measured on a copy of the live database, against a second
  // connection holding the lock: with a plain `BEGIN` the save was refused in
  // **2.6–17 ms**, because a transaction that has taken its read snapshot and
  // then tries to become a writer when somebody else holds the lock is refused
  // without the busy handler ever being consulted — and every mutation here
  // reads (`nextId`, `entriesOf`) before it writes. `BEGIN IMMEDIATE` asks for
  // the lock where waiting is allowed, and the save waits as configured.
  //
  // Both halves are pinned here, and neither is the number of milliseconds: the
  // wait is long enough not to be the immediate refusal, and the client is told
  // what happened rather than handed "Internal error".
  const dir = tempRoot('funoteka-playlist-');
  const db = collection(join(dir, 'funoteka.db'));

  const other = new DatabaseSync(join(dir, 'funoteka.db'));
  other.exec('PRAGMA busy_timeout = 0');
  other.exec('BEGIN IMMEDIATE');
  other.prepare('UPDATE playlist_sequence SET next = next').run();

  const started = performance.now();
  const refused = await post(db, 'createPlaylist', [
    ['name', 'Во время скана'],
    ['songId', 'tr-1'],
  ]);
  const took = performance.now() - started;

  assert.equal(refused.status, 'failed');
  assert.match(refused.error?.message ?? '', /try again/, 'and says what to do about it');
  assert.ok(took >= 150, `gave up after ${Math.round(took)} ms — it never waited at all`);

  other.exec('COMMIT');
  other.close();

  // And once the other writer is done, the same save goes through — which is
  // the whole point of waiting rather than refusing.
  const made = await post(db, 'createPlaylist', [['name', 'После скана'], ['songId', 'tr-1']]);
  assert.equal(made.status, 'ok');
  assert.equal(made.playlist?.name, 'После скана');

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a playlist keeps its place across a scan', async () => {
  // The acceptance criterion this feature is for. The scanner rebuilds every
  // derived row it owns on each run, so the question is not whether the
  // playlist table is left alone — it is whether the *tracks* keep their ids
  // while that happens, because the entries name them.
  const root = tempRoot('funoteka-playlist-');
  mkdirSync(join(root, 'Undertow'), { recursive: true });
  writeFileSync(join(root, 'Undertow', 'Undertow.flac'), 'audio');
  writeFileSync(
    join(root, 'Undertow', 'Undertow.cue'),
    `TITLE "Undertow"
PERFORMER "Tool"
FILE "Undertow.flac" WAVE
TRACK 01 AUDIO
TITLE "Intolerance"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Prison Sex"
INDEX 01 04:00:00
`,
  );

  const db = openDb(':memory:');
  const probe: (absPath: string) => Probe = () => ({
    durationMs: 8 * 60_000,
    codec: 'flac',
    sampleRate: 44100,
    channels: 2,
    bitrate: 1000,
    ok: true,
    err: null,
  });

  const build = (): void => {
    scan(db, [root]);
    classify(db);
    applyCues(db, { probe });
  };

  build();
  const before = (db.prepare('SELECT id, title FROM track ORDER BY ordinal').all() ?? []) as {
    id: number;
    title: string;
  }[];
  assert.equal(before.length, 2, 'the cue split the image into two songs');

  await post(db, 'createPlaylist', [
    ['name', 'Дорога'],
    ['songId', `tr:${before[1]?.id}`],
    ['songId', `tr:${before[0]?.id}`],
  ]);

  // All four of the things the criterion names are done before the second scan,
  // not just the first: made, renamed, added to, taken from. They are four ways
  // into the same two tables, and a rule that only the creation survives would
  // be a rule nobody checked.
  // The first song off, the same song back on the end: the playlist keeps both
  // its songs and changes its order, which is what a listener editing a list
  // does, and it is a change no rescan may undo.
  await post(db, 'updatePlaylist', [
    ['playlistId', 'pl-1'],
    ['name', 'Дорога дальняя'],
    ['songIndexToRemove', '0'],
    ['songIdToAdd', `tr:${before[1]?.id}`],
  ]);

  build();

  const after = db.prepare('SELECT id, title FROM track ORDER BY ordinal').all() as {
    id: number;
    title: string;
  }[];
  assert.deepEqual(after, before, 'a rescan of an unchanged folder keeps the ids');

  const opened = await envelope(db, 'getPlaylist?f=json&id=pl-1');
  assert.equal(opened.playlist?.name, 'Дорога дальняя', 'the rename survived too');
  assert.deepEqual(
    opened.playlist?.entry?.map((song) => song.title),
    ['Intolerance', 'Prison Sex'],
    'and the playlist still names its songs, in its own order',
  );

  // And the other half of the criterion, in the same run: the playlist that is
  // still there keeps its id, and a song that is gone takes its entry with it.
  rmSync(join(root, 'Undertow', 'Undertow.cue'));
  build();

  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'nothing dangles');
  const afterLoss = await envelope(db, 'getPlaylist?f=json&id=pl-1');
  assert.equal(afterLoss.status, 'ok', 'the playlist is still there, under its own id');
  assert.equal(afterLoss.playlist?.name, 'Дорога дальняя');

  rmSync(root, { recursive: true, force: true });
  db.close();
});
