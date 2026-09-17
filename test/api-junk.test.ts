import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify } from '../src/classify/classify.ts';
import { openDb } from '../src/db/index.ts';
import { refreshFirstTags } from '../src/tags/first.ts';
import { hidden, mark, resolvePath } from '../src/junk/marks.ts';
import { junkReason, STRANGERS_FLOOR, STRANGERS_PER_SONG } from '../src/junk/rule.ts';
import { inventory } from '../src/inventory/inventory.ts';
import { ask, type Db } from './helpers/api.ts';

/**
 * What the collection holds that is not a record, and what is done about it.
 *
 * The contract's §11 in one file: a rule, a label, a hiding, a switch, and an
 * allow/block edit that never deletes anything (requirements:47). The hiding is
 * the part that has to be checked *everywhere*: a filter that covers the album
 * list and not the tree is one the operator still sees the hole in, so the
 * surface is walked here route by route, over one small collection built by the
 * real classifier — the folders are rows the walk would have written, `classify`
 * reads them, and the label is whatever the rule says it is.
 */

/** What the dumping ground is called, and what its songs are called. */
const DUMP = 'Telegram Desktop';
const DUMP_SONGS: [string, string] = ['SLAVES', 'dont die alone'];

interface Fixture {
  db: Db;
  /** The dumping ground's `album.id`, so the by-id checks ask about the right row. */
  junkAlbum: number;
  /** One of its `track.id`s, for the same reason. */
  junkTrack: number;
}

/** A root, read by the real classifier, holding one record and one dumping ground. */
function library(): Fixture {
  const db = openDb(':memory:');
  const run = (sql: string, ...args: (string | number | null)[]): void => {
    db.prepare(sql).run(...args);
  };

  run('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)', 'C:/music', '2026-01-01T00:00:00Z');
  run(
    `INSERT INTO scan_run (id, started_at, finished_at, status, roots_json)
     VALUES (1, ?, ?, 'ok', '[]')`,
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:01:00Z',
  );

  for (const [id, relPath, parent, role] of [
    [1, '', '', null],
    [2, 'Кино', '', 'category'],
    [3, 'Кино/45', 'Кино', 'album'],
    [4, DUMP, '', 'album'],
    [5, 'Кино/Пиратка', 'Кино', 'album'],
  ] as [number, string, string, string | null][]) {
    run(
      'INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role) VALUES (?, 1, ?, ?, ?)',
      id,
      relPath,
      parent,
      role,
    );
  }

  let at = 100;
  const file = (folder: string, name: string, kind: string, ext: string): number => {
    const id = at++;
    run(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, ?, ?, ?, ?, 4096, 1000)`,
      id,
      `${folder}/${name}`,
      folder,
      name,
      kind,
      ext,
    );
    return id;
  };

  // The record: two songs, a cue and a cover — everything a record folder holds.
  const first = file('Кино/45', '01.flac', 'audio', 'flac');
  const second = file('Кино/45', '02.flac', 'audio', 'flac');
  file('Кино/45', 'album.cue', 'cue', 'cue');
  file('Кино/45', 'cover.jpg', 'image', 'jpg');

  // The dumping ground: two songs among twenty-seven files a record never holds.
  const slaves = file(DUMP, 'SLAVES.mp3', 'audio', 'mp3');
  const alone = file(DUMP, 'dont die alone.mp3', 'audio', 'mp3');
  for (let n = 0; n < 25; n += 1) file(DUMP, `manual-${n}.pdf`, 'other', 'pdf');

  // A second dumping ground, filed *inside* the artist's folder. The top-level
  // one tests the tree dropping a node; this one tests a count: an artist whose
  // second record is junk is an artist with one record, not an empty artist.
  const pirate = file('Кино/Пиратка', 'rip.mp3', 'audio', 'mp3');
  for (let n = 0; n < 25; n += 1) file('Кино/Пиратка', `scan-${n}.txt`, 'other', 'txt');

  classify(db);

  // The scanner writes folders; naming artists is a later stage's work, and all
  // this needs is that the record has one, so the tree has somewhere to file it.
  run("INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Кино', 'кино', 'Кино')");
  run(`UPDATE album SET artist_id = 1 WHERE rel_path = 'Кино/45'`);

  const albumOf = (relPath: string): number =>
    (db.prepare('SELECT id FROM album WHERE rel_path = ?').get(relPath) as { id: number }).id;
  const record = albumOf('Кино/45');
  const junkAlbum = albumOf(DUMP);

  const track = (
    id: number,
    albumId: number,
    fileId: number,
    title: string,
    genre: string,
    albumName: string,
  ): void => {
    run(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
       VALUES (?, ?, ?, ?, ?, 60000)`,
      id,
      albumId,
      id,
      title,
      fileId,
    );
    run("INSERT INTO file_tag (file_id, name, value, position) VALUES (?, 'genre', ?, 0)", fileId, genre);
    refreshFirstTags(db, fileId);
    // The search index is a later stage's; both sections a search answers from
    // are asked below, so it is filled here.
    run(
      'INSERT INTO track_fts (rowid, title, artist, album) VALUES (?, ?, ?, ?)',
      id,
      title,
      'Кино',
      albumName,
    );
  };

  track(1, record, first, 'Восьмиклассница', 'Rock', '45');
  track(2, record, second, 'Трамвай', 'Rock', '45');
  // The genre only the dumping ground states, so the genre list has something to
  // be wrong about: a genre nobody can be offered a song of is not a genre.
  track(3, junkAlbum, slaves, DUMP_SONGS[0], 'Voice Memo', DUMP);
  track(4, junkAlbum, alone, DUMP_SONGS[1], 'Voice Memo', DUMP);
  track(5, albumOf('Кино/Пиратка'), pirate, 'Пиратка', 'Voice Memo', 'Пиратка');

  return { db, junkAlbum, junkTrack: 3 };
}

/**
 * Whether an answer carries a word.
 *
 * The protocol answers in XML by default and in JSON on request, and a test that
 * parsed one of them would be asserting a format rather than a listing. Every
 * word asked about here — a folder's name, a song's title — is a value in both,
 * so the check is the same either way.
 */
function offers(body: Buffer, word: string): boolean {
  return body.toString().includes(word);
}

// The rule -------------------------------------------------------------------

test('a folder holding several files that are not music is not a record', () => {
  const kinds = (...names: string[]): { kind: string }[] => names.map((kind) => ({ kind }));
  const reason = (...names: string[]): string | null => junkReason(kinds(...names));
  const strangers = (n: number): string[] => Array<string>(n).fill('other');
  const audio = (n: number): string[] => Array<string>(n).fill('audio');

  assert.equal(reason('audio', 'audio', 'cue', 'image'), null, 'a record is a record');
  assert.equal(
    reason('audio', 'audio', ...strangers(STRANGERS_FLOOR - 1)),
    null,
    'and one file short of the floor is still a record — the floor is the rule',
  );

  // A record's own paperwork: what came with the release, not neighbours. This
  // is the case the floor alone got wrong on the live collection — a sound bank
  // with one demo track, six files of patch data and one song.
  assert.equal(
    reason('audio', ...strangers(6)),
    null,
    'a single with unusual paperwork is still a record — the floor is not the whole rule',
  );
  assert.equal(
    reason('audio', 'audio', ...strangers(STRANGERS_PER_SONG * 2)),
    null,
    'and files equal to the ratio are not over it',
  );

  assert.match(
    reason('audio', 'audio', ...strangers(STRANGERS_PER_SONG * 2 + 1)) ?? '',
    /not music, against 2 that are/,
    'one file over the ratio is a dumping ground, and the reason says both numbers',
  );
  // The denominator is what decides: the same twenty-one stray files beside a
  // hundred songs are a record's artwork, and beside two they are a heap.
  assert.equal(reason(...audio(100), ...strangers(21)), null);

  // Artwork and paperwork are what a record is *made* of, and a count that
  // treated them as strangers would call every cue album junk.
  assert.equal(reason('audio', 'cue', 'log', 'nfo', 'image', 'image', 'image'), null);
});

test('a hand mark outranks the rule in both directions', () => {
  const kinds = (...names: string[]): { kind: string }[] => names.map((kind) => ({ kind }));
  const dump = kinds('audio', ...Array<string>(20).fill('other'));
  const record = kinds('audio', 'audio', 'cue');

  assert.equal(junkReason(dump, 'trust'), null, 'allowed: the rule is overridden');
  assert.equal(junkReason(record, 'junk'), 'marked junk by hand', 'blocked: and so is its silence');
});

// What the scan writes -------------------------------------------------------

test('the scan labels the folder it read, and only that one', () => {
  const { db } = library();
  try {
    const rows = db
      .prepare('SELECT rel_path, junk_reason FROM album ORDER BY rel_path')
      .all() as { rel_path: string; junk_reason: string | null }[];

    assert.deepEqual(
      rows.map((row) => [row.rel_path, row.junk_reason === null]),
      [
        [DUMP, false],
        ['Кино/45', true],
        ['Кино/Пиратка', false],
      ],
      'the two dumping grounds are not records and the record is',
    );
    assert.match(rows[0]?.junk_reason ?? '', /25 files that are not music, against 2 that are/);
  } finally {
    db.close();
  }
});

test('a mark takes effect at once, without waiting for a scan', () => {
  const { db } = library();
  try {
    const reason = (relPath: string): string | null =>
      (
        db.prepare('SELECT junk_reason FROM album WHERE rel_path = ?').get(relPath) as {
          junk_reason: string | null;
        }
      ).junk_reason;

    assert.equal(mark(db, 1, DUMP, 'trust', null), null);
    assert.equal(reason(DUMP), null, 'allowed');
    assert.equal(mark(db, 1, DUMP, 'junk', 'downloaded files'), 'marked junk by hand');
    assert.equal(reason(DUMP), 'marked junk by hand', 'blocked again');

    assert.equal(mark(db, 1, 'Кино/45', 'junk', null), 'marked junk by hand');
    assert.equal(mark(db, 1, 'Кино/45', 'trust', null), null, 'and a record can be allowed back');

    assert.throws(() => mark(db, 1, 'Кино', 'junk', null), /no album at that path/);
  } finally {
    db.close();
  }
});

test('a path is resolved to the root that holds it, and only to a configured one', () => {
  const { db } = library();
  try {
    assert.deepEqual(resolvePath(db, 'C:/music/Кино/45'), { rootId: 1, relPath: 'Кино/45' });
    // Backslashes and a trailing separator are how the same folder is spelled on
    // the machine this runs on, and the operator types what the disk shows.
    assert.deepEqual(resolvePath(db, 'C:\\music\\Кино\\45\\'), { rootId: 1, relPath: 'Кино/45' });
    assert.deepEqual(resolvePath(db, 'C:/music'), { rootId: 1, relPath: '' }, 'the root itself');
    assert.equal(resolvePath(db, 'D:/elsewhere/Кино'), undefined, 'a path this server never scanned');
  } finally {
    db.close();
  }
});

// The hiding -----------------------------------------------------------------

test('every listing leaves the dumping ground out, and the switch puts it back', async () => {
  const { db } = library();
  try {
    // One case per way in: every route a client browses or searches by, and the
    // ones the operator's own client draws its tree from. The second element says
    // whether the route has a side the switch can *put it back on* — `-1` is the
    // protocol's top, which names the library and the roots and no folder at all,
    // so there is nothing there for the switch to reveal.
    const routes: [string, boolean][] = [
      ['getAlbumList2?type=alphabeticalByName', true],
      ['getAlbumList2?type=random', true],
      ['getIndexes', true],
      ['getMusicDirectory?id=-1', false],
      ['getMusicDirectory?id=vn:', true],
      ['search3?query=Telegram', true],
      ['search3?query=SLAVES', true],
      ['getRandomSongs?size=500', true],
    ];

    for (const [path, reversible] of routes) {
      const out = await ask(db, path);
      assert.equal(out.status, 200, path);
      assert.ok(!offers(out.body, DUMP), `${path} does not offer the dumping ground`);
      for (const song of DUMP_SONGS) {
        assert.ok(!offers(out.body, song), `${path} does not offer "${song}"`);
      }

      if (!reversible) continue;
      const shown = await ask(db, `${path}${path.includes('?') ? '&' : '?'}showJunk=1`);
      assert.equal(shown.status, 200, path);
      assert.ok(
        offers(shown.body, DUMP) || DUMP_SONGS.some((song) => offers(shown.body, song)),
        `${path} offers it when the switch is on`,
      );
    }

    // An artist list is the one listing the dumping ground cannot appear in —
    // no artist owns it — so what it has to say is the *count*: the second
    // dumping ground is filed inside Кино's folder, and an artist whose second
    // record is junk is an artist with one record rather than an empty one.
    const counts = (body: Buffer): string[] =>
      [...body.toString().matchAll(/albumCount="(\d+)"/g)].map((match) => match[1] ?? '');
    assert.deepEqual(counts((await ask(db, 'getArtists')).body), ['1']);
    assert.deepEqual(counts((await ask(db, 'getArtists?showJunk=1')).body), ['2']);
    assert.deepEqual(
      counts((await ask(db, 'getIndexes')).body),
      ['1'],
      'and the folder view counts the way the artist page does',
    );

    // The genre list is the one listing whose *values* come from files: a genre
    // whose every song is in a folder nobody is offered is not a genre.
    const genres = (body: Buffer): string[] =>
      [...body.toString().matchAll(/value="([^"]*)"/g)].map((match) => match[1] ?? '').sort();
    assert.deepEqual(genres((await ask(db, 'getgenres')).body), ['Rock']);
    assert.deepEqual(genres((await ask(db, 'getgenres?showJunk=1')).body), ['Rock', 'Voice Memo']);

    // And the same switch read as a setting, for the operator who wants it for a
    // whole session rather than for one request from an address bar.
    const configured = await ask(db, 'getAlbumList2?type=alphabeticalByName', {}, { showJunk: true });
    assert.ok(offers(configured.body, DUMP), 'the setting shows it too');
    const refused = await ask(
      db,
      'getAlbumList2?type=alphabeticalByName&showJunk=0',
      {},
      { showJunk: true },
    );
    assert.ok(!offers(refused.body, DUMP), 'and a request can turn it back off');
  } finally {
    db.close();
  }
});

test('a folder nobody is offered is not offered as a place to go either', async () => {
  const { db } = library();
  try {
    // The tree is built from *folders*, so hiding the record alone would leave a
    // node named after the dumping ground opening onto an empty directory — the
    // shape the operator would still see in his client.
    assert.ok(!offers((await ask(db, 'getMusicDirectory?id=vn:')).body, DUMP), 'no such node');
    assert.ok(!offers((await ask(db, 'getIndexes')).body, DUMP), 'and no such row in the view');
  } finally {
    db.close();
  }
});

test('what the listener already holds, and what an id names, are not taken away', async () => {
  const { db, junkAlbum, junkTrack } = library();
  try {
    // Hiding is about what the server *offers*. An id already in a client's hand
    // still answers — a cover rather than an error — and the listener's own
    // marks are theirs, so a song starred before a folder was blocked keeps
    // naming it rather than vanishing out of their list.
    const album = await ask(db, `getAlbum?id=al:${junkAlbum}`);
    assert.equal(album.status, 200);
    assert.ok(offers(album.body, DUMP));

    const song = await ask(db, `getSong?id=tr:${junkTrack}`);
    assert.equal(song.status, 200);
    assert.ok(offers(song.body, DUMP_SONGS[0] ?? ''));

    assert.equal((await ask(db, `star?id=tr:${junkTrack}`)).status, 200);
    assert.ok(offers((await ask(db, 'getStarred2')).body, DUMP_SONGS[0] ?? ''), 'the mark is theirs');
  } finally {
    db.close();
  }
});

test('the dump says how much is hidden, and names it', () => {
  const { db } = library();
  try {
    const dump = inventory(db);
    assert.match(dump, /albums\s+3\s+\(hidden 2\)/, 'scanned = visible + hidden, stated');
    assert.match(dump, /^hidden \(2\)$/m);
    assert.match(dump, /scan\s+#1\s+Telegram Desktop/);
    assert.match(dump, /25 files that are not music, against 2 that are/);

    mark(db, 1, 'Кино/45', 'junk', 'asked for by hand');
    const after = inventory(db);
    assert.match(after, /albums\s+3\s+\(hidden 3\)/);
    assert.match(after, /hand\s+#1\s+Кино\/45/, 'and which of them a person marked');
  } finally {
    db.close();
  }
});

test('what is hidden is reported with its source', () => {
  const { db } = library();
  try {
    assert.deepEqual(
      hidden(db).map((row) => [row.relPath, row.source]),
      [
        [DUMP, 'scan'],
        ['Кино/Пиратка', 'scan'],
      ],
    );
    mark(db, 1, 'Кино/45', 'junk', null);
    assert.deepEqual(
      hidden(db).map((row) => row.source),
      ['scan', 'hand', 'scan'],
      'the rule and the person are told apart, which a count cannot do',
    );
  } finally {
    db.close();
  }
});
