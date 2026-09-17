import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { ask, type Db } from './helpers/api.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The picture beside an artist, which is a fact about the artist.
 *
 * An album's cover is a fact about the record, and the two are not
 * interchangeable: a client draws round avatars in its artist list, and an
 * album cover there is a record standing in for a person. The collection keeps
 * the artist's own picture in the artist's own folder — `folder.jpg` at the top
 * of `Lana Del Rey/`, put there by the operator — so the artist's folder has to
 * be one of the folders the id asks about at all. It was not: `ar:` gathered the
 * folders of the artist's *records*, and the folder named for the artist was
 * never among them.
 */

const ARTIST_PHOTO = Buffer.from('LANA-ARTIST-PHOTO-JPEG');
const ALBUM_COVER = Buffer.from('BORN-TO-DIE-FRONT-COVER');
const TOOL_ALBUM = Buffer.from('LATERALUS-FRONT-COVER');

/**
 * Two artists and the difference between them.
 *
 * `Lana Del Rey` owns the folder named after her, and her records live one
 * level down in it. `Tool` owns nothing: `Lateralus` is the record's own folder
 * and does not open with the artist's name, so there is no picture of Tool to
 * be found and the album's is the only honest answer left.
 */
function collection(): { db: Db; root: string } {
  const root = tempRoot('funoteka-cover-artist-');

  const put = (relPath: string, bytes: Buffer): void => {
    mkdirSync(join(root, relPath, '..'), { recursive: true });
    writeFileSync(join(root, relPath), bytes);
  };

  put('Lana Del Rey/folder.jpg', ARTIST_PHOTO);
  put('Lana Del Rey/2012 - Born To Die/front.jpg', ALBUM_COVER);
  put('Lateralus/front.jpg', TOOL_ALBUM);

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
  folder(1, 'Lana Del Rey', '', 'category');
  folder(2, 'Lana Del Rey/2012 - Born To Die', 'Lana Del Rey', 'album');
  folder(3, 'Lateralus', '', 'album');

  const file = (id: number, relPath: string, kind: string): void => {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const folderPath = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const size = statSync(join(root, relPath)).size;
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1000)`,
    ).run(id, relPath, folderPath, name, kind, ext, size);
  };
  file(1, 'Lana Del Rey/folder.jpg', 'image');
  file(2, 'Lana Del Rey/2012 - Born To Die/front.jpg', 'image');
  file(3, 'Lateralus/front.jpg', 'image');

  db.prepare(
    `INSERT INTO artist (id, name, name_key, sort_key)
     VALUES (59, 'Lana Del Rey', 'lana del rey', 'Lana Del Rey'), (9, 'Tool', 'tool', 'Tool')`,
  ).run();

  const album = (id: number, relPath: string, artistId: number): void => {
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, artist_id) VALUES (?, 1, ?, ?, ?)`,
    ).run(id, relPath, relPath, artistId);
  };
  album(1, 'Lana Del Rey/2012 - Born To Die', 59);
  album(2, 'Lateralus', 9);

  return { db, root };
}

test("an artist's folder holds their photo, and it beats their records' covers", async () => {
  const { db, root } = collection();
  try {
    const answer = await ask(db, 'getCoverArt?id=ar-59');

    assert.equal(answer.status, 200);
    assert.deepEqual(
      answer.body,
      ARTIST_PHOTO,
      "the artist's own folder.jpg answers, not the front cover of her record",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an artist owning no folder still falls back to a record cover', async () => {
  const { db, root } = collection();
  try {
    const answer = await ask(db, 'getCoverArt?id=ar-9');

    assert.equal(answer.status, 200);
    assert.deepEqual(
      answer.body,
      TOOL_ALBUM,
      'nothing is named for Tool, so the record cover is the only answer there is',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
