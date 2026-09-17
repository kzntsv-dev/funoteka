import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { ask, type Db } from './helpers/api.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * What a client is told about an artist.
 *
 * The protocol asks this question in `getArtistInfo2` and the collection can
 * answer it offline: the note about the artist is the `artist.nfo` in the
 * folder named for them, and the picture is the one `getCoverArt` already
 * serves.
 *
 * This docstring used to say `musicBrainzId` had no source, and a review found
 * the opposite: the id sits in that same `artist.nfo`, under
 * `<musicbrainzartistid>`. `lastFmUrl` genuinely has none. The route returns
 * neither today.
 */

const BIOGRAPHY = 'The Cure are an English rock band formed in Crawley in 1976.';

const ARTIST_NFO = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<artist>
  <outline>A short line, not the biography.</outline>
  <biography>${BIOGRAPHY}</biography>
</artist>`;

/**
 * Three artists, and the difference between them.
 *
 * `Кино` owns the folder named for them and the note about them; its records
 * are credited to two names, so the folder holds a *related* artist as well.
 * `Tool` owns a folder with no note in it. `Виктор Цой` owns nothing — the
 * records credited to them sit inside Кино's folder.
 */
function collection(): { db: Db; root: string } {
  const root = tempRoot('funoteka-artistinfo-');

  const put = (relPath: string, bytes: Buffer | string): void => {
    mkdirSync(join(root, relPath, '..'), { recursive: true });
    writeFileSync(join(root, relPath), bytes);
  };

  put('Кино/artist.nfo', ARTIST_NFO);
  put('Кино/folder.jpg', Buffer.from('KINO-ARTIST-PHOTO'));
  put('Кино/1984 - Концерт/song.flac', Buffer.from('audio'));
  put('Кино/1988 - Группа Крови/song.flac', Buffer.from('audio'));
  put('Tool/1992 - Opiate/song.flac', Buffer.from('audio'));

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
  folder(4, 'Tool', '', 'category');
  folder(5, 'Tool/1992 - Opiate', 'Tool', 'album');

  const file = (id: number, relPath: string, kind: string): void => {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const folderPath = relPath.slice(0, relPath.lastIndexOf('/'));
    const size = statSync(join(root, relPath)).size;
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1000)`,
    ).run(id, relPath, folderPath, name, kind, ext, size);
  };
  file(1, 'Кино/artist.nfo', 'nfo');
  file(2, 'Кино/folder.jpg', 'image');
  file(3, 'Кино/1984 - Концерт/song.flac', 'audio');
  file(4, 'Кино/1988 - Группа Крови/song.flac', 'audio');
  file(5, 'Tool/1992 - Opiate/song.flac', 'audio');

  db.prepare(
    `INSERT INTO artist (id, name, name_key, sort_key) VALUES
       (15, 'Кино', 'кино', 'Кино'),
       (52, 'Виктор Цой', 'виктор цои', 'Виктор Цой'),
       (9, 'Tool', 'tool', 'Tool')`,
  ).run();

  const album = (id: number, relPath: string, artistId: number): void => {
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, artist_id) VALUES (?, 1, ?, ?, ?)`,
    ).run(id, relPath, relPath, artistId);
  };
  album(1, 'Кино/1984 - Концерт', 52);
  album(2, 'Кино/1988 - Группа Крови', 15);
  album(3, 'Tool/1992 - Opiate', 9);

  return { db, root };
}

interface Info {
  biography?: string;
  smallImageUrl?: string;
  mediumImageUrl?: string;
  largeImageUrl?: string;
  similarArtist?: { id: string; name: string; albumCount: number }[];
}

async function info(db: Db, id: string): Promise<{ status: string; info?: Info; error?: unknown }> {
  const answer = await ask(db, `getArtistInfo2?id=${encodeURIComponent(id)}&f=json`);
  const body = JSON.parse(answer.body.toString('utf8'))['subsonic-response'];
  return { status: body.status, info: body.artistInfo2, error: body.error };
}

test('the biography is the note the collection keeps in the artist folder', async () => {
  const { db, root } = collection();
  try {
    const { status, info: answer } = await info(db, 'ar-15');
    assert.equal(status, 'ok');
    assert.equal(answer?.biography, BIOGRAPHY);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the picture is named as a URL to this server, not invented', async () => {
  const { db, root } = collection();
  try {
    const { info: answer } = await info(db, 'ar-15');
    for (const field of ['smallImageUrl', 'mediumImageUrl', 'largeImageUrl'] as const) {
      const url = new URL(answer?.[field] ?? '');
      assert.equal(url.protocol, 'http:', `${field} is absolute`);
      assert.equal(url.pathname, '/rest/getCoverArt', `${field} asks this server`);
      assert.equal(url.searchParams.get('id'), 'ar-15', `${field} names the artist asked about`);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the artists sharing the folder are offered, and the artist itself is not', async () => {
  const { db, root } = collection();
  try {
    const { info: answer } = await info(db, 'ar-15');
    assert.deepEqual(
      answer?.similarArtist?.map((one) => [one.id, one.name]),
      [['ar-52', 'Виктор Цой']],
      'the other credit in Кино folder, and not Кино itself',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an artist whose folder holds no note answers with no biography', async () => {
  const { db, root } = collection();
  try {
    const { status, info: answer } = await info(db, 'ar-9');
    assert.equal(status, 'ok', 'no note is an answer, not a refusal');
    assert.equal(answer?.biography, undefined);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an artist owning no folder at all is still answerable', async () => {
  const { db, root } = collection();
  try {
    const { status } = await info(db, 'ar-52');
    assert.equal(status, 'ok', 'Виктор Цой is a real artist with records to show');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an id naming no artist is refused rather than answered emptily', async () => {
  const { db, root } = collection();
  try {
    const { status } = await info(db, 'ar-404');
    assert.equal(status, 'failed');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
