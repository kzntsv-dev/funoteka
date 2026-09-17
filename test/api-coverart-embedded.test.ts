import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyArtists } from '../src/artist/apply.ts';
import { classify } from '../src/classify/classify.ts';
import { applyCues } from '../src/cue/engine.ts';
import { openDb } from '../src/db/index.ts';
import { scan } from '../src/scan/scan.ts';
import { applyTags } from '../src/tags/apply.ts';
import { ask } from './helpers/api.ts';
import { ogg } from './helpers/bytes.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The cover a file carries inside a comment, all the way to a client.
 *
 * The one path in this project where a picture is *derived* rather than ranged:
 * an Ogg file holds its cover as base64 in a `METADATA_BLOCK_PICTURE` comment,
 * scattered across pages by the lacing rule, so no run of the file is the image.
 * `api-coverart.test.ts` builds its meta layer by hand and could not say whether
 * this works — the round trip is the whole feature, so this one runs the real
 * stages over a real file.
 *
 * The collection this was written for is exactly this shape: twenty-five albums
 * of `.ogg` whose folders hold no image at all, every cover inside the files.
 */
const COVER = Buffer.from('A-COVER-INSIDE-THE-FILE', 'utf8');

test('a cover a file carries inside a comment reaches the client', async () => {
  const root = tempRoot('funoteka-cover-comment-');
  mkdirSync(join(root, 'PolnaLyubvi', 'V'), { recursive: true });
  writeFileSync(
    join(root, 'PolnaLyubvi', 'V', '01.ogg'),
    ogg({
      tags: { ARTIST: 'PolnaLyubvi', ALBUM: 'V', TITLE: 'A Song' },
      picture: { mime: 'image/png', data: COVER },
    }),
  );

  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  applyTags(db);
  // The chain as the CLI runs it. The cue stage is what makes the files into
  // tracks, and the artist stage reads credits off tracks — so a test that
  // stopped at the tags would be testing a state the project never runs in.
  applyCues(db, {
    probe: () => ({
      durationMs: 200_000,
      codec: 'vorbis',
      sampleRate: 44_100,
      channels: 2,
      bitrate: 0,
      ok: true,
      err: null,
    }),
  });
  applyArtists(db);

  // What the scan wrote down: a region, not an image — and the flag that says
  // so, which is the only thing stopping the delivery layer sending a client a
  // few hundred kilobytes of base64 and calling it a PNG.
  const cover = db.prepare('SELECT kind, offset, length FROM cover_art').get() as {
    kind: string;
    offset: number;
    length: number;
  };
  assert.equal(cover.kind, 'indirect', 'the bytes are not a range of the file');
  assert.ok(cover.length > 0);

  const album = db.prepare('SELECT id FROM album').get() as { id: number };
  const response = await ask(db, `getCoverArt?id=al:${album.id}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(response.body, COVER);

  // And the artist answers with its record's cover, which is the other half of
  // the same report: there is no picture of the band anywhere, and the first of
  // its records is what a client is given instead.
  const artist = db.prepare('SELECT id FROM artist').get() as { id: number };
  const viaArtist = await ask(db, `getCoverArt?id=ar:${artist.id}`);

  assert.equal(viaArtist.status, 200);
  assert.deepEqual(viaArtist.body, COVER);

  // HEAD asks what a GET would bring, and for a derived picture that means the
  // derivation happens anyway — the length is not knowable without it.
  const head = await ask(db, `getCoverArt?id=al:${album.id}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), COVER.length);
  assert.equal(head.body.length, 0);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a cover whose file has gone answers honestly, not with an internal error', async () => {
  // The row points at a region of a file that is no longer there — which happens
  // as soon as a track is deleted or renamed and the scan has not run again, and
  // `serve` does not scan by itself. The reader answers `null` for that, and the
  // route turns it into a 404 naming the file. It did not: `openSync` sat outside
  // the `try`, the `ENOENT` escaped, and the client was told the server had
  // broken instead of being told there is no cover.
  const root = tempRoot('funoteka-cover-gone-');
  mkdirSync(join(root, 'PolnaLyubvi', 'V'), { recursive: true });
  const file = join(root, 'PolnaLyubvi', 'V', '01.ogg');
  writeFileSync(
    file,
    ogg({
      tags: { ARTIST: 'PolnaLyubvi', ALBUM: 'V', TITLE: 'A Song' },
      picture: { mime: 'image/png', data: COVER },
    }),
  );

  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  applyTags(db);
  applyCues(db, {
    probe: () => ({
      durationMs: 200_000,
      codec: 'vorbis',
      sampleRate: 44_100,
      channels: 2,
      bitrate: 0,
      ok: true,
      err: null,
    }),
  });
  applyArtists(db);

  const album = db.prepare('SELECT id FROM album').get() as { id: number };
  rmSync(file);

  const answer = await ask(db, `getCoverArt?id=al:${album.id}&f=json`);
  const body = JSON.parse(answer.body.toString('utf8'))['subsonic-response'];

  // The protocol carries a refusal in the envelope at HTTP 200, so the code is
  // what a client reads — and 0 is the one it reads as "the server broke".
  assert.equal(body.error?.code, 70, 'the code for "there is no such thing here"');
  assert.match(String(body.error?.message ?? ''), /could not be read/);

  db.close();
  rmSync(root, { recursive: true, force: true });
});
