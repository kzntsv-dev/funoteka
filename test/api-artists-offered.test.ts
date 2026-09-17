import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { ask, type Db } from './helpers/api.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * Which artists a client is offered.
 *
 * Two ways to earn a place, and the operator settled both. A folder named for
 * you is the first: `Кино/` opens, so Кино is an artist a client can browse to.
 * The `albumartist` tag is the second, and it exists because the first rule
 * left out somebody real — `Виктор Цой` leads Кино, his records are filed in
 * Кино's folder, and the tag on those files names him as the record's artist.
 *
 * The second rule earns its keep by what it *excludes*. A collaborator on a
 * split is a track artist: `Merzbow + Cock E.S.P.` states who plays, not whose
 * record it is, and its files carry no `albumartist` at all. That is the line —
 * not "is the credit shared", which would readmit every split, and not "is the
 * name a person", which no rule can decide.
 */

function collection(): { db: Db; root: string } {
  const root = tempRoot('funoteka-offered-');

  const put = (relPath: string, bytes: Buffer | string): void => {
    mkdirSync(join(root, relPath, '..'), { recursive: true });
    writeFileSync(join(root, relPath), bytes);
  };

  put('Кино/1984 - Концерт/song.flac', Buffer.from('a'));
  put('Кино/1988 - Группа Крови/song.flac', Buffer.from('b'));
  put('Cock E.S.P/1999 - Merzbow + Cock E.S.P. - Split/song.flac', Buffer.from('c'));

  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(
    root,
    '2026-01-01T00:00:00Z',
  );

  const folder = (id: number, relPath: string, parent: string, role: string): void => {
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role) VALUES (?, 1, ?, ?, ?)`,
    ).run(id, relPath, parent, role);
  };
  folder(1, 'Кино', '', 'category');
  folder(2, 'Кино/1984 - Концерт', 'Кино', 'album');
  folder(3, 'Кино/1988 - Группа Крови', 'Кино', 'album');
  folder(4, 'Cock E.S.P', '', 'category');
  folder(5, 'Cock E.S.P/1999 - Merzbow + Cock E.S.P. - Split', 'Cock E.S.P', 'album');

  const file = (id: number, relPath: string, kind: string): void => {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const size = statSync(join(root, relPath)).size;
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1000)`,
    ).run(id, relPath, relPath.slice(0, relPath.lastIndexOf('/')), name, kind, ext, size);
  };
  file(1, 'Кино/1984 - Концерт/song.flac', 'audio');
  file(2, 'Кино/1988 - Группа Крови/song.flac', 'audio');
  file(3, 'Cock E.S.P/1999 - Merzbow + Cock E.S.P. - Split/song.flac', 'audio');

  const tag = (fileId: number, name: string, value: string): void => {
    db.prepare(`INSERT INTO file_tag (file_id, name, value, position) VALUES (?, ?, ?, 0)`).run(
      fileId,
      name,
      value,
    );
  };
  // The record filed under Кино is Viktor Tsoi's, and the file says so.
  tag(1, 'albumartist', 'Виктор Цой');
  tag(1, 'artist', 'Виктор Цой');
  tag(2, 'albumartist', 'Кино');
  // The split names both players and neither is the record's album artist.
  tag(3, 'artist', 'Merzbow & Cock E.S.P.');

  db.prepare(
    `INSERT INTO artist (id, name, name_key, sort_key) VALUES
       (15, 'Кино', 'кино', 'Кино'),
       (52, 'Виктор Цой', 'виктор цои', 'Виктор Цой'),
       (26, 'Merzbow', 'merzbow', 'Merzbow')`,
  ).run();

  const album = (id: number, relPath: string, artistId: number): void => {
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, artist_id) VALUES (?, 1, ?, ?, ?)`,
    ).run(id, relPath, relPath, artistId);
  };
  album(1, 'Кино/1984 - Концерт', 52);
  album(2, 'Кино/1988 - Группа Крови', 15);
  album(3, 'Cock E.S.P/1999 - Merzbow + Cock E.S.P. - Split', 26);

  return { db, root };
}

async function offered(db: Db): Promise<string[]> {
  const answer = await ask(db, 'getArtists?f=json');
  const body = JSON.parse(answer.body.toString('utf8'))['subsonic-response'];
  return (body.artists?.index ?? []).flatMap((group: { artist: { name: string }[] }) =>
    group.artist.map((one) => one.name),
  );
}

test('an artist the albumartist tag names is offered, folder or no folder', async () => {
  const { db, root } = collection();
  try {
    const names = await offered(db);
    assert.ok(names.includes('Кино'), 'the folder named for Кино is its own way in');
    assert.ok(
      names.includes('Виктор Цой'),
      'his records are filed in Кино folder, and the tag on the files names him',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an artist the folders never named is counted by credit, and opens to it', async () => {
  // The other half of the count `getArtists` now takes from the tree. Виктор Цой
  // has no folder named for him — his record is filed inside `Кино/` — so the
  // tree has nothing to say about him and both sides fall back to the credit.
  // Four of the collection's twenty-one artists are on this branch, and a fix
  // aimed at the folder side breaks them silently: a count that reads the tree
  // unconditionally answers 0 here, and a row saying 0 while the page holds one
  // is the same defect arriving through the other door.
  const { db, root } = collection();
  try {
    const listed = await ask(db, 'getArtists?f=json');
    const rows = JSON.parse(listed.body.toString('utf8'))['subsonic-response'].artists.index.flatMap(
      (group: { artist: { id: string; name: string; albumCount: number }[] }) => group.artist,
    );
    const row = rows.find((one: { name: string }) => one.name === 'Виктор Цой');
    assert.ok(row, 'the albumartist tag offers him, folder or no folder');

    const answer = await ask(db, 'getArtist?id=ar-52&f=json');
    const page = JSON.parse(answer.body.toString('utf8'))['subsonic-response'];
    assert.equal(page.artist.album.length, 1, 'his one record is filed inside Кино');
    assert.equal(row.albumCount, page.artist.album.length, 'and the row counts it');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a collaborator on a split is not offered, having no albumartist tag', async () => {
  const { db, root } = collection();
  try {
    const names = await offered(db);
    assert.equal(
      names.includes('Merzbow'),
      false,
      'a split states who plays, not whose record it is',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a compound albumartist tag names every artist it lists', async () => {
  // `Аквариум, Kyiv Virtuosi` is one tag naming two artists, and the operator
  // confirmed both are artists. `splitCredit` keeps commas because it also
  // serves track credits, where `Artist, The` is one name — so this reader
  // splits them, having a tag that is a list rather than a name.
  //
  // The second name is given a record of its own here, because being named by a
  // tag is not enough on its own: an artist the collection holds no record of is
  // a dead end, and `artists` already refuses to offer one. That is a different
  // rule from this one, and this test is about the split.
  const { db, root } = collection();
  try {
    db.prepare(
      `INSERT INTO artist (id, name, name_key, sort_key)
       VALUES (41, 'Kyiv Virtuosi', 'kyiv virtuosi', 'Kyiv Virtuosi')`,
    ).run();
    // A record of its own, in a folder that is not named for it — so the folder
    // rule cannot be what offers it and the tag has to be.
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role)
       VALUES (6, 1, 'Live Archives', '', 'category'), (7, 1, 'Live Archives/2017 - Symphonia', 'Live Archives', 'album')`,
    ).run();
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, artist_id)
       VALUES (4, 1, 'Live Archives/2017 - Symphonia', 'Symphonia', 41)`,
    ).run();
    db.prepare(
      `INSERT INTO file_tag (file_id, name, value, position) VALUES (1, 'albumartist', ?, 1)`,
    ).run('Аквариум, Kyiv Virtuosi');

    const names = await offered(db);
    assert.ok(names.includes('Kyiv Virtuosi'), 'the second name in the tag is an artist too');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
