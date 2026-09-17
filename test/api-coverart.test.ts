import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { ask, type Db } from './helpers/api.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The pictures, as bytes a reader can check by eye.
 *
 * Not real JPEGs, on purpose: what reaches the client is the collection's own
 * file, and a fixture that only *described* an image could not say whether it
 * did. The extension is the whole of what the server reads.
 */
const FRONT = Buffer.from('FRONT-COVER-JPEG-BYTES');
const BACK = Buffer.from('BACK-COVER-IT-IS-NOT');
const SCAN_ONE = Buffer.from('SCAN-001');
const SCAN_TWO = Buffer.from('SCAN-002');
const ROOT_ART = Buffer.from('ROOT-ART-JPEG');

interface Answer {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
  };
}

/**
 * A collection of four folders, arranged so that every rule has something to
 * fail against.
 *
 *   - `Album` holds a `cover.jpg` beside a `back.jpg` and a `001.jpg`, and both
 *     of the others sort before it — so a rule that took the first picture, or
 *     the first by any other name, would answer with the wrong one.
 *   - `Scans` holds numbered pictures and nothing that names a side, which is
 *     what a full-scan folder looks like.
 *   - `Bare` holds no picture at all.
 *   - the root itself holds one, which is what a root whose album is the
 *     download folder looks like.
 */
function collection(): { db: Db; root: string } {
  const root = tempRoot('funoteka-cover-');

  const put = (relPath: string, bytes: Buffer): void => {
    mkdirSync(join(root, relPath, '..'), { recursive: true });
    writeFileSync(join(root, relPath), bytes);
  };

  put('Album/back.jpg', BACK);
  put('Album/001.jpg', SCAN_ONE);
  put('Album/cover.jpg', FRONT);
  put('Album/whole.flac', Buffer.from('audio'));
  put('Album/image.flac', Buffer.from('image'));

  put('Scans/002.jpg', SCAN_TWO);
  put('Scans/001.jpg', SCAN_ONE);
  put('Scans/song.flac', Buffer.from('audio'));

  put('Bare/song.flac', Buffer.from('audio'));
  put('Bare/loose.flac', Buffer.from('audio'));

  put('front.jpeg', ROOT_ART);

  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(
    root,
    '2026-01-01T00:00:00Z',
  );

  const folder = (id: number, relPath: string, role: string): void => {
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role) VALUES (?, 1, ?, NULL, ?)`,
    ).run(id, relPath, role);
  };
  folder(1, 'Album', 'album');
  folder(2, 'Scans', 'empty');
  folder(3, 'Bare', 'album');

  const file = (id: number, relPath: string, name: string, kind: string): void => {
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const folderPath = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    // The size the walk would have measured, so the column is the file's rather
    // than a number this fixture invented.
    const size = statSync(join(root, relPath)).size;
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1000)`,
    ).run(id, relPath, folderPath, name, kind, ext, size);
  };

  file(1, 'Album/back.jpg', 'back.jpg', 'image');
  file(2, 'Album/001.jpg', '001.jpg', 'image');
  file(3, 'Album/cover.jpg', 'cover.jpg', 'image');
  file(4, 'Album/whole.flac', 'whole.flac', 'audio');
  file(5, 'Album/image.flac', 'image.flac', 'audio');
  file(6, 'Scans/002.jpg', '002.jpg', 'image');
  file(7, 'Scans/001.jpg', '001.jpg', 'image');
  file(8, 'Scans/song.flac', 'song.flac', 'audio');
  file(9, 'Bare/song.flac', 'song.flac', 'audio');
  file(10, 'Bare/loose.flac', 'loose.flac', 'audio');
  file(11, 'front.jpeg', 'front.jpeg', 'image');

  db.prepare(
    `INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Кино', 'kino', 'Кино'), (2, 'Tool', 'tool', 'Tool')`,
  ).run();

  const album = (id: number, relPath: string, artistId: number): void => {
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, artist_id) VALUES (?, 1, ?, ?, ?)`,
    ).run(id, relPath, relPath, artistId);
  };
  album(1, 'Album', 1);
  album(2, 'Scans', 1);
  album(3, 'Bare', 2);

  const track = (
    id: number,
    albumId: number | null,
    ordinal: number,
    fileId: number,
    start: number | null,
  ): void => {
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 5000)`,
    ).run(id, albumId, ordinal, `Track ${id}`, fileId, start, start === null ? null : start + 1000);
  };
  track(1, 1, 1, 4, null);
  track(2, 1, 2, 5, 1000);
  track(3, 2, 1, 8, null);
  track(4, 3, 1, 9, null);
  track(5, null, 1, 10, null);

  return { db, root };
}

async function withCollection(work: (db: Db, root: string) => Promise<void>): Promise<void> {
  const { db, root } = collection();
  try {
    await work(db, root);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('an album is served the picture that says it is the front one', async () => {
  // Two pictures sort before `cover.jpg` in this folder — `001.jpg` and
  // `back.jpg` — so an answer that took the first of them would be the back of
  // the record, or a booklet page, and the client would show it as the cover.
  await withCollection(async (db) => {
    const response = await ask(db, 'getCoverArt?id=al-1');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(response.body, FRONT);
  });
});

test('a folder whose pictures name no side is read in the order it was walked', async () => {
  // A full-scan folder is `001.jpg`, `002.jpg`, … with nothing that says which
  // is the front. The first one is, and it is the only answer that does not
  // depend on the order the filesystem happened to hand them over in.
  await withCollection(async (db) => {
    const response = await ask(db, 'getCoverArt?id=al-2');
    assert.deepEqual(response.body, SCAN_ONE);
  });
});

test('a track is served the cover of the record it is on', async () => {
  await withCollection(async (db) => {
    // A whole file and a cue track cut out of an image answer alike: both are
    // songs of the album, and the album's art is the album's art.
    assert.deepEqual((await ask(db, 'getCoverArt?id=tr-1')).body, FRONT);
    assert.deepEqual((await ask(db, 'getCoverArt?id=tr-2')).body, FRONT);
  });
});

test('a track on no album is served its own folder’s art', async () => {
  // `Bare` holds no picture, so this is the refusal case reached by the other
  // road: a song the meta layer could not attach to a record still has a folder.
  await withCollection(async (db) => {
    const body = JSON.parse((await ask(db, 'getCoverArt?id=tr-5&f=json')).body.toString('utf8')) as Answer;
    assert.equal(body['subsonic-response'].status, 'failed');
    assert.equal(body['subsonic-response'].error?.code, 70);
  });
});

test('an artist is served the cover of the first record under it', async () => {
  await withCollection(async (db) => {
    const response = await ask(db, 'getCoverArt?id=ar-1');
    assert.deepEqual(response.body, FRONT, 'the album named Альбом sorts before Scans');
  });
});

test('a folder and a root are served their own pictures', async () => {
  await withCollection(async (db) => {
    assert.deepEqual((await ask(db, 'getCoverArt?id=fd-1')).body, FRONT);
    assert.deepEqual((await ask(db, 'getCoverArt?id=ro-1')).body, ROOT_ART, 'the root is a folder too');
    assert.equal((await ask(db, 'getCoverArt?id=ro-1')).headers.get('content-type'), 'image/jpeg');
  });
});

test('a folder holding no picture is refused, and says which folder', async () => {
  // Not an empty 200: a client that is told "no cover" draws its own
  // placeholder, and one handed zero bytes draws a broken image.
  await withCollection(async (db) => {
    const response = await ask(db, 'getCoverArt?id=al-3&f=json');
    assert.equal(response.status, 200, 'the protocol carries its refusals in the body');

    const body = JSON.parse(response.body.toString('utf8')) as Answer;
    assert.equal(body['subsonic-response'].status, 'failed');
    assert.equal(body['subsonic-response'].error?.code, 70);
    assert.match(body['subsonic-response'].error?.message ?? '', /Bare/);
  });
});

test('an id naming nothing is refused the same way as one naming no picture', async () => {
  await withCollection(async (db) => {
    for (const id of ['al-999', 'tr-999', 'zz:1', 'nonsense']) {
      const body = JSON.parse((await ask(db, `getCoverArt?id=${id}&f=json`)).body.toString('utf8')) as Answer;
      assert.equal(body['subsonic-response'].error?.code, 70, id);
    }
  });
});

test('the size a client asks for does not change the picture it is given', async () => {
  // The protocol lets a server scale, and this one does not: nothing in the
  // runtime can decode an image, and the collection's own file is the truest
  // answer available. Stated as a test so that adding a scaler is a change
  // someone has to mean rather than one that slips in.
  await withCollection(async (db) => {
    const scaled = await ask(db, 'getCoverArt?id=al-1&size=64');
    assert.deepEqual(scaled.body, FRONT);
  });
});

test('a record whose folder holds no picture is served the one inside its files', async () => {
  // Measured on the live collection: 54 of the 59 albums with no folder image
  // carry their art inside their files. The bytes are not copied into the meta
  // layer — the serving is a range of the audio file, the same bargain the cue
  // segments make with time.
  const root = tempRoot('funoteka-cover-embedded-');
  try {
    const image = Buffer.from('EMBEDDED-COVER-BYTES');
    const audio = Buffer.concat([Buffer.alloc(37), image, Buffer.alloc(11)]);
    mkdirSync(join(root, 'Bare'), { recursive: true });
    writeFileSync(join(root, 'Bare', 'song.m4a'), audio);

    const db = openDb(':memory:');
    db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(root, 'x');
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (1, 1, 'Bare/song.m4a', 'Bare', 'song.m4a', 'audio', 'm4a', ?, 1000)`,
    ).run(audio.length);
    db.prepare(
      `INSERT INTO cover_art (file_id, mime, picture_type, offset, length) VALUES (1, 'image/jpeg', 3, 37, ?)`,
    ).run(image.length);
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title) VALUES (9, 1, 'Bare', 'Bare')`,
    ).run();
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms) VALUES (1, 9, 1, 'Song', 1, 1000)`,
    ).run();

    const response = await ask(db, 'getCoverArt?id=al-9');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg', 'the file’s own statement of what it is');
    assert.deepEqual(response.body, image, 'exactly the image, not the audio around it');

    // And a picture beside the record still wins: an operator who put one in the
    // folder put it there to be the cover, where what a file carries is often
    // whatever the encoder happened to embed.
    writeFileSync(join(root, 'Bare', 'cover.jpg'), FRONT);
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (2, 1, 'Bare/cover.jpg', 'Bare', 'cover.jpg', 'image', 'jpg', ?, 1000)`,
    ).run(FRONT.length);

    assert.deepEqual((await ask(db, 'getCoverArt?id=al-9')).body, FRONT, 'the folder wins');
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A one-artist collection over a real directory.
 *
 * Real files, not rows alone: the route measures a picture it is about to serve,
 * so a fixture whose bytes were only described would answer `undefined` for a
 * reason that has nothing to do with the rule under test.
 */
function shelf(
  work: (db: Db, put: (relPath: string, bytes: Buffer) => void) => void,
): { db: Db; root: string } {
  const root = tempRoot('funoteka-cover-shelf-');
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(root, '2026-01-01T00:00:00Z');
  db.prepare(
    `INSERT INTO artist (id, name, name_key, sort_key) VALUES (1, 'Кино', 'kino', 'Кино')`,
  ).run();
  work(db, (relPath, bytes) => {
    mkdirSync(join(root, relPath, '..'), { recursive: true });
    writeFileSync(join(root, relPath), bytes);
  });
  return { db, root };
}

/** A row of the tree, and the file the walk would have measured in it. */
function shelve(db: Db, id: number, relPath: string, kind: string, size: number): void {
  if (kind === 'folder') {
    db.prepare(
      `INSERT INTO folder (id, root_id, rel_path, parent_rel_path, role) VALUES (?, 1, ?, NULL, 'album')`,
    ).run(id, relPath);
    return;
  }
  const cut = relPath.lastIndexOf('/');
  db.prepare(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1000)`,
  ).run(
    id,
    relPath,
    relPath.slice(0, cut),
    relPath.slice(cut + 1),
    kind,
    relPath.slice(relPath.lastIndexOf('.') + 1),
    size,
  );
}

test('an artist’s record keyed on a file is asked about the folder that file is in', async () => {
  // A flat rip: the album's row names the audio file, not a directory, and the
  // art sits beside it in the folder. The artist branch reaches its folders
  // through the records' *songs*, so a walk that asked each record on its own
  // and stopped at the record's own row would look in a path that is a file, and
  // answer "no cover" for a record whose folder is full of art.
  const { db, root } = shelf((db, put) => {
    put('Rip/whole.flac', Buffer.from('audio'));
    put('Rip/front.jpg', FRONT);
    shelve(db, 1, 'Rip', 'folder', 0);
    shelve(db, 1, 'Rip/whole.flac', 'audio', 5);
    shelve(db, 2, 'Rip/front.jpg', 'image', FRONT.length);
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, artist_id) VALUES (1, 1, 'Rip/whole.flac', 'Rip', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms) VALUES (1, 1, 1, 'Song', 1, 1000)`,
    ).run();
  });
  try {
    assert.deepEqual((await ask(db, 'getCoverArt?id=ar-1')).body, FRONT);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an artist whose records’ pictures name no side keeps the records’ own order', async () => {
  // Neither folder says which picture is the front, so nothing about the names
  // can decide and the order the folders were offered is the whole of the
  // answer. The first record is asked first, and a walk that gathered the
  // folders as an unordered set would answer with whichever it happened to
  // reach — the second record's sleeve, drawn as the first one's.
  //
  // The ids are deliberately the wrong way round: `First` is album 2 and
  // `Second` is album 1. A fixture where the id rose with the path would let
  // `ORDER BY al.id` answer `SCAN_ONE` for the wrong reason, and the test would
  // stay green while the ordering it is named for was gone — measured, both
  // that and a walk of the lookup's map instead of the records list passed the
  // earlier form of this test.
  const { db, root } = shelf((db, put) => {
    put('First/001.jpg', SCAN_ONE);
    put('First/a.flac', Buffer.from('audio'));
    put('Second/001.jpg', SCAN_TWO);
    put('Second/b.flac', Buffer.from('audio'));
    for (const [id, relPath, picture, pictureFile, audio, name] of [
      [2, 'First', SCAN_ONE, 3, 4, 'a.flac'],
      [1, 'Second', SCAN_TWO, 1, 2, 'b.flac'],
    ] as const) {
      shelve(db, id, relPath, 'folder', 0);
      shelve(db, pictureFile, `${relPath}/001.jpg`, 'image', picture.length);
      shelve(db, audio, `${relPath}/${name}`, 'audio', 5);
      db.prepare(
        `INSERT INTO album (id, root_id, rel_path, title, artist_id) VALUES (?, 1, ?, ?, 1)`,
      ).run(id, relPath, relPath);
      db.prepare(
        `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms) VALUES (?, ?, 1, ?, ?, 1000)`,
      ).run(id, id, name, audio);
    }
  });
  try {
    assert.deepEqual((await ask(db, 'getCoverArt?id=ar-1')).body, SCAN_ONE, 'First is asked first');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
