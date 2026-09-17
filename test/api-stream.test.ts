import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { ask, type Db } from './helpers/api.ts';
import { mpeg } from './helpers/bytes.ts';
import { keyOf } from '../src/stream/recode.ts';
import { planWholeFile } from '../src/stream/segment.ts';
import { flac, flacFrameSize, flacFrames, type ReadFrame } from './helpers/flac.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The tags a built file is stamped with. What they say is not this file's
 * question — `tags-encode.test.ts` is where that lives — but a stub is still a
 * song's worth of fields, so a reader can tell the tag being present from the
 * tag being empty.
 */
const TAGS = {
  title: 'Tramvai',
  artist: 'Кино',
  albumArtist: 'Кино',
  album: '45',
  trackNumber: 2,
  discNumber: 1,
  date: '1982',
  genre: 'Rock',
} as const;
/** Sixteen bytes, so that `bytes=2-5` is a claim a reader can check by eye. */
const BYTES = Buffer.from('ABCDEFGHIJKLMNOP');

/** As much of a refusal as these tests read. */
interface Answer {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
  };
}

// The image the cue tracks are cut from. Ten seconds of it: a hundred frames of
// 4096 samples at 44.1 kHz, each frame 72 bytes, so every offset below is
// arithmetic a reader can follow rather than a number copied from a run.
const IMAGE = flac({ frames: 100, blockSize: 4096, bodyBytes: 64, sampleRate: 44100 });
const OPUS = Buffer.from('OggS and then OpusHead');
const IMAGE_AUDIO_START = 4 + 4 + 34;
const FRAME_SIZE = 72;
const FRAME_SAMPLES = 4096;
/**
 * A frame's audio, which is the body and not the two bytes of CRC-16 after it:
 * those cover the frame and change when its header does.
 */
const FRAME_AUDIO = 64;

/** Three seconds of mp3, in frames of its own: 200 frames of 1152 samples. */
const MP3 = mpeg({ frames: 200, sampleRate: 44100, bitrateKbps: 128 });
const MP3_FRAME_SIZE = 417;
const MP3_FRAME_SAMPLES = 1152;

const frameAt = (first: number, size: number, samples: number, ms: number): number =>
  Math.floor((ms * 44100) / 1000 / samples) * size + first;

/**
 * A collection of four images, one whole song, and three songs cut from them.
 *
 * The images are real files of their formats: what is under test is the bytes
 * that reach a client, and a fixture that only described them could not say
 * whether they did.
 */
function collection(): { db: Db; root: string } {
  const root = tempRoot('funoteka-stream-');
  mkdirSync(join(root, 'Album'), { recursive: true });
  writeFileSync(join(root, 'Album', 'whole.flac'), BYTES);
  writeFileSync(join(root, 'Album', 'image.flac'), IMAGE);
  writeFileSync(join(root, 'Album', 'image.mp3'), MP3);
  writeFileSync(join(root, 'Album', 'image.m4a'), Buffer.from('not really an mp4'));
  writeFileSync(join(root, 'Album', 'broken.flac'), Buffer.from('fLaC and then nonsense'));
  // Two whole files that differ only in what the scan's probe said about them:
  // the same `.m4a` holds AAC in one and ALAC in the other, and only the codec
  // tells them apart.
  writeFileSync(join(root, 'Album', 'lossless.m4a'), Buffer.from('an ALAC file'));
  writeFileSync(join(root, 'Album', 'lossy.m4a'), Buffer.from('an AAC file, honestly'));
  writeFileSync(join(root, 'Album', 'whole.ape'), Buffer.from('MAC and then an ape'));
  // An Ogg stream carrying Opus, which the extension says and the bytes would
  // not: the type a client is handed has to come from what the file *is*, and
  // the two halves of this server used to disagree about it (task:2920).
  writeFileSync(join(root, 'Album', 'whole.opus'), OPUS);

  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(
    root,
    '2026-01-01T00:00:00Z',
  );

  const files: [number, string, string, number][] = [
    [1, 'whole.flac', 'Album/whole.flac', BYTES.length],
    [2, 'image.flac', 'Album/image.flac', IMAGE.length],
    [3, 'image.mp3', 'Album/image.mp3', MP3.length],
    [4, 'image.m4a', 'Album/image.m4a', 17],
    [5, 'broken.flac', 'Album/broken.flac', 23],
    [6, 'lossless.m4a', 'Album/lossless.m4a', 12],
    [7, 'lossy.m4a', 'Album/lossy.m4a', 21],
    [8, 'whole.ape', 'Album/whole.ape', 20],
    [9, 'whole.opus', 'Album/whole.opus', OPUS.length],
  ];
  for (const [id, name, rel, size] of files) {
    const ext = name.slice(name.lastIndexOf('.') + 1);
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, 'Album', ?, 'audio', ?, ?, 1000)`,
    ).run(id, rel, name, ext, size);
  }

  // What the scan's ffprobe made of the two, which is the whole difference
  // between them as far as the delivery layer is concerned.
  for (const [fileId, codec] of [
    [6, 'alac'],
    [7, 'aac'],
  ] as [number, string][]) {
    db.prepare(
      `INSERT INTO audio_probe (file_id, duration_ms, codec, sample_rate, channels, bitrate, probe_ok)
       VALUES (?, 4000, ?, 44100, 2, 900000, 1)`,
    ).run(fileId, codec);
  }

  db.prepare(
    `INSERT INTO album (id, root_id, rel_path, title, title_source) VALUES (9, 1, 'Album', 'Album', 'folder')`,
  ).run();

  const tracks: [number, number, string, number, number | null, number | null][] = [
    [1, 1, 'Whole', 1, null, null],
    [2, 2, 'Cut from FLAC', 2, 2000, 4000],
    [3, 3, 'Cut from mp3', 3, 1000, 2000],
    [4, 4, 'Cut from m4a', 4, 2000, 4000],
    [5, 5, 'Cut from a broken image', 5, 0, 1000],
    [6, 6, 'A whole ALAC file', 6, null, null],
    [7, 7, 'A whole AAC file', 7, null, null],
    [8, 8, 'A whole Monkey’s Audio file', 8, null, null],
    [9, 9, 'A whole Opus file', 9, null, null],
  ];
  for (const [id, ordinal, title, fileId, start, end] of tracks) {
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
       VALUES (?, 9, ?, ?, ?, ?, ?, 5000)`,
    ).run(id, ordinal, title, fileId, start, end);
  }

  return { db, root };
}

/** The whole thing, with the directory cleaned up after it. */
async function withCollection(work: (db: Db, root: string) => Promise<void>): Promise<void> {
  const { db, root } = collection();
  try {
    await work(db, root);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('stream answers with the file, and says that it can be asked for parts', async () => {
  await withCollection(async (db) => {
    const response = await ask(db, 'stream?id=tr-1');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/flac');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-length'), String(BYTES.length));
    assert.deepEqual(response.body, BYTES);
  });
});

test('a range is answered with the bytes it named, and where they sit', async () => {
  // This is how seeking works: a client dragged to the middle of a track sends
  // a range and expects the bytes from there, not the file from the start.
  await withCollection(async (db) => {
    const partial = await ask(db, 'stream?id=tr-1', { headers: { range: 'bytes=2-5' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 2-5/${BYTES.length}`);
    assert.equal(partial.body.toString('utf8'), 'CDEF');

    const open = await ask(db, 'stream?id=tr-1', { headers: { range: 'bytes=10-' } });
    assert.equal(open.body.toString('utf8'), 'KLMNOP', 'from ten to the end');

    // A suffix range measures from the end. Read as a start it would serve the
    // first four bytes, which is the opposite of what was asked.
    const suffix = await ask(db, 'stream?id=tr-1', { headers: { range: 'bytes=-4' } });
    assert.equal(suffix.headers.get('content-range'), `bytes 12-15/${BYTES.length}`);
    assert.equal(suffix.body.toString('utf8'), 'MNOP');
  });
});

test('a range that is past the end is refused as HTTP refuses it', async () => {
  await withCollection(async (db) => {
    const response = await ask(db, 'stream?id=tr-1', { headers: { range: 'bytes=99-100' } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${BYTES.length}`);
  });
});

test('HEAD asks what a GET would bring, and is not brought it', async () => {
  await withCollection(async (db) => {
    const response = await ask(db, 'stream?id=tr-1', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(BYTES.length));
    assert.equal(response.body.byteLength, 0);
  });
});

/**
 * A built FLAC file's metadata blocks, walked the way section 8 defines the
 * chain: where its audio begins, and what its comment block says.
 *
 * The library's own reader is not used, deliberately — this is the second
 * opinion about bytes the server has just written, and a reader that shared an
 * assumption with the writer would agree with it about a wrong file.
 */
function flacHeader(bytes: Buffer): { audioStart: number; comments: string[] } {
  let at = 4;
  const comments: string[] = [];

  for (;;) {
    const header = bytes[at] ?? 0;
    const length = ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    const body = at + 4;

    // Type 4 is the Vorbis comment (RFC 9639 §8.6): a little-endian vendor
    // length and string, a count, then each field as its own length and bytes.
    if ((header & 0x7f) === 4) {
      let cursor = body + 4 + bytes.readUInt32LE(body);
      const count = bytes.readUInt32LE(cursor);
      cursor += 4;
      for (let n = 0; n < count; n += 1) {
        const size = bytes.readUInt32LE(cursor);
        cursor += 4;
        comments.push(bytes.subarray(cursor, cursor + size).toString('utf8'));
        cursor += size;
      }
    }

    at = body + length;
    if ((header & 0x80) !== 0) return { audioStart: at, comments };
  }
}

/**
 * The ID3v2 tag a built mp3 segment is served behind, and what its frames say.
 *
 * The version is checked here rather than assumed: 2.4 is the one whose frame
 * sizes are syncsafe, and a writer that said 2.4 while sizing frames the 2.3 way
 * would produce a tag whose second frame is read from the wrong offset.
 */
function id3Tag(bytes: Buffer): { length: number; frames: string[] } {
  assert.equal(bytes.subarray(0, 3).toString('latin1'), 'ID3');
  assert.equal(bytes[3], 4, 'version 2.4, which is the one with UTF-8 and syncsafe sizes');

  const syncsafe = (at: number): number =>
    ((bytes[at] ?? 0) << 21) |
    ((bytes[at + 1] ?? 0) << 14) |
    ((bytes[at + 2] ?? 0) << 7) |
    (bytes[at + 3] ?? 0);

  const length = 10 + syncsafe(6);
  const frames: string[] = [];
  let at = 10;
  while (at < length) {
    const id = bytes.subarray(at, at + 4).toString('latin1');
    const size = syncsafe(at + 4);
    const body = bytes.subarray(at + 10, at + 10 + size);
    // The first byte of a text frame says how the rest is encoded, and 3 is
    // UTF-8 — the encoding 2.3 does not have and this collection needs.
    assert.equal(body[0], 3, `${id} is UTF-8`);
    frames.push(`${id}=${body.subarray(1).toString('utf8')}`);
    at += 10 + size;
  }
  return { length, frames };
}

/** The audio of each frame — everything after its header and before its footer. */
function bodiesOf(bytes: Buffer, frames: ReadFrame[], audioStart: number): Buffer[] {
  const bodies: Buffer[] = [];
  let at = audioStart;
  for (const frame of frames) {
    at += frame.headerBytes;
    bodies.push(bytes.subarray(at, at + FRAME_AUDIO));
    at += FRAME_AUDIO + 2;
  }
  return bodies;
}

test('a FLAC cue track is served as a FLAC file, not as the disc it came from', async () => {
  // The whole point of the segment work. The image is ten seconds long and the
  // track is two of them; bytes cut out of the middle would still announce the
  // ten, so the header is rebuilt with the segment's own length in it, and the
  // frames after it are the ones the cue's times name.
  await withCollection(async (db) => {
    const response = await ask(db, 'stream?id=tr-2');

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/flac');
    assert.equal(response.headers.get('accept-ranges'), 'bytes', 'a track is not a file, but it can be sought');

    const body = response.body;

    // 2000 ms is sample 88200, inside frame 21; 4000 ms is sample 176400, which
    // frame 44 starts at.
    const from = IMAGE_AUDIO_START + 21 * FRAME_SIZE;
    const to = IMAGE_AUDIO_START + 44 * FRAME_SIZE;
    const frames = 23;

    assert.equal(body.subarray(0, 4).toString('latin1'), 'fLaC');

    // What the built file says about itself, which is the defect task:2895
    // names: a cut segment arrived with one `STREAMINFO` and no other block, so
    // a client that saved it had a file whose own player could name nothing.
    const { audioStart, comments } = flacHeader(body);
    assert.deepEqual(
      comments,
      ['TITLE=Cut from FLAC', 'ALBUM=Album', 'TRACKNUMBER=2'],
      'the song, and only what the collection knows — no empty fields',
    );
    assert.equal(body.length, audioStart + (to - from));

    // The stream information the segment is served behind states the length of
    // the *segment*: 23 frames of 4096 samples, in the 36 bits section 8.2
    // gives the total sample count.
    const packed = body.readBigUInt64BE(IMAGE_AUDIO_START - 34 + 10);
    assert.equal(Number(packed & ((1n << 36n) - 1n)), frames * FRAME_SAMPLES);
    assert.equal(Number((packed >> 44n) & ((1n << 20n) - 1n)), 44100, 'and the rate it really is');

    // The frames are the segment's own, and their numbers have to say so. Frame
    // 21 of the image states 21; the first frame of this track must state 0, or
    // a player counts from where the track sits in the record — the first frame
    // of "The Pot" states 20677, and a player starts it at 32:01.
    const served = flacFrames(body, { audioStart });
    assert.equal(served.length, frames);
    assert.deepEqual(
      served.map((frame) => frame.number),
      [...Array(frames).keys()],
      'every frame is numbered from the start of the track',
    );
    assert.equal(served.every((frame) => frame.crcOk), true, 'and every header is one a decoder accepts');

    // The footer covers the frame *including its header* (§9.3), so restating a
    // number without restating the footer leaves a frame no parser will take: it
    // checks the footer of the frame in front of every header it weighs, and one
    // that fails is dropped along with the audio it holds.
    assert.equal(
      served.every((frame) => frame.footerOk),
      true,
      'and every frame is one whose CRC-16 still covers it',
    );

    // Only the numbers moved. The audio of each frame is the image's own bytes.
    assert.deepEqual(
      bodiesOf(body, served, audioStart),
      bodiesOf(IMAGE, flacFrames(IMAGE, { audioStart: from }).slice(0, frames), from),
    );
  });
});

test('a track from late in a long image is shorter than the bytes it was cut from', async () => {
  // Renumbering is a rewrite of every frame header, and a number written in
  // fewer bytes than the image's makes the served stream shorter than the range
  // it came from — the frames here state 200 and up in two bytes and go out
  // stating 0 and up in one. A length taken from the range, as it was before the
  // numbers were restated, would run past the end of the audio it describes.
  const root = tempRoot('funoteka-stream-long-');
  mkdirSync(join(root, 'Album'), { recursive: true });
  const image = flac({ frames: 300, blockSize: 4096, bodyBytes: 64, sampleRate: 44100 });
  writeFileSync(join(root, 'Album', 'long.flac'), image);

  const db = openDb(':memory:');
  try {
    db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(
      root,
      '2026-01-01T00:00:00Z',
    );
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (1, 1, 'Album/long.flac', 'Album', 'long.flac', 'audio', 'flac', ?, 1000)`,
    ).run(image.length);
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source) VALUES (9, 1, 'Album', 'Album', 'folder')`,
    ).run();
    // 18576 ms is sample 819201, inside frame 200; 24148 ms is sample 1064926,
    // which frame 260 starts at.
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
       VALUES (1, 9, 1, 'Late', 1, 18576, 24148, 5572)`,
    ).run();

    const response = await ask(db, 'stream?id=tr-1');
    const body = response.body;
    const frames = 60;

    const { audioStart } = flacHeader(body);
    const served = flacFrames(body, { audioStart });
    assert.equal(served.length, frames);
    assert.deepEqual(
      served.map((frame) => frame.number),
      [...Array(frames).keys()],
      'sixty frames, numbered from zero',
    );
    assert.equal(served.every((frame) => frame.crcOk), true, 'with headers a decoder accepts');

    // Each frame went out a byte shorter than the image's: the header that
    // stated 200 in two bytes states 0 in one.
    assert.equal(
      body.length,
      audioStart + frames * flacFrameSize({ codedBytes: 1 }),
      'and the stream is the length of what is served, not of what was cut',
    );
    assert.equal(response.headers.get('content-length'), String(body.length));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a range on a cue track is answered with the bytes at that offset', async () => {
  // Seeking, for a track that is not a file. The answer is built frame by frame
  // — a header in front of each, a footer behind it — so a range is not a range
  // of the image and cannot be answered by seeking the file: it is an offset
  // into the answer, which this maps back through the frames it is made of.
  await withCollection(async (db) => {
    const whole = (await ask(db, 'stream?id=tr-2')).body;

    // The answer is a rebuilt header in front of twenty-three frames of this
    // image, so it is short — every offset here is inside it.
    const { audioStart } = flacHeader(whole);
    assert.equal(whole.length, audioStart + 23 * FRAME_SIZE);

    const middle = await ask(db, 'stream?id=tr-2', { headers: { range: 'bytes=100-299' } });
    assert.equal(middle.status, 206);
    assert.equal(middle.headers.get('content-range'), `bytes 100-299/${whole.length}`);
    assert.equal(middle.headers.get('content-length'), '200');
    assert.deepEqual(middle.body, whole.subarray(100, 300), 'the answer’s own bytes, from 100');

    // An open range runs to the end of the track, which is where a player who
    // dragged the bar usually asks from.
    const open = await ask(db, 'stream?id=tr-2', { headers: { range: 'bytes=1000-' } });
    assert.equal(open.headers.get('content-range'), `bytes 1000-${whole.length - 1}/${whole.length}`);
    assert.deepEqual(open.body, whole.subarray(1000));

    // The first bytes of the answer are the header rebuilt for the segment,
    // which is in no file anywhere — so a range landing inside it is the one
    // case that cannot be a slice of anything.
    const head = await ask(db, 'stream?id=tr-2', { headers: { range: 'bytes=10-40' } });
    assert.deepEqual(head.body, whole.subarray(10, 41));

    // A range beginning mid-frame: the frame's footer covers the whole frame,
    // so the bytes a seek lands between are the same bytes as in the whole
    // answer — which is only true if the CRC is carried over what was passed
    // over as well as what was written.
    const midFrame = await ask(db, 'stream?id=tr-2', { headers: { range: 'bytes=201-900' } });
    assert.deepEqual(midFrame.body, whole.subarray(201, 901));

    const tail = await ask(db, 'stream?id=tr-2', { headers: { range: 'bytes=-100' } });
    assert.deepEqual(tail.body, whole.subarray(whole.length - 100));
  });
});

test('a range past the end of a cue track is refused as HTTP refuses it', async () => {
  await withCollection(async (db) => {
    const whole = (await ask(db, 'stream?id=tr-2')).body;
    const response = await ask(db, 'stream?id=tr-2', {
      headers: { range: `bytes=${whole.length + 10}-` },
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${whole.length}`);
  });
});

test('an mp3 cue track is the frames, behind the song’s own tags', async () => {
  // mp3 states no total length anywhere a player reads — it counts frames — so
  // a slice needs no header *rebuilt*; what it needs is a header, because the
  // image's own tags sit in front of its first frame and a cut begins at a
  // frame. Without one the saved file could not be named (task:2895). What it
  // must not contain is the encoder's own frame, which states the length of the
  // whole file.
  await withCollection(async (db) => {
    const response = await ask(db, 'stream?id=tr-3');
    const body = response.body;

    // 1000 ms is sample 44100, inside frame 38; 2000 ms is sample 88200, which
    // frame 77 starts at.
    const from = 38 * MP3_FRAME_SIZE;
    const to = 77 * MP3_FRAME_SIZE;

    assert.equal(response.headers.get('content-type'), 'audio/mpeg');

    const tag = id3Tag(body);
    assert.deepEqual(
      tag.frames,
      ['TIT2=Cut from mp3', 'TALB=Album', 'TRCK=3'],
      'the song, and only what the collection knows',
    );
    assert.equal(response.headers.get('content-length'), String(tag.length + (to - from)));
    assert.deepEqual(body.subarray(tag.length), MP3.subarray(from, to), 'the frames, untouched');

    // And it really is a stream of frames rather than a slice that happens to
    // have the right length: thirty-nine of them, which is what a second of
    // 1152-sample frames at 44.1 kHz comes to.
    assert.equal((to - from) / MP3_FRAME_SIZE, 39);
    assert.equal(
      ((to - from) / MP3_FRAME_SIZE) * MP3_FRAME_SAMPLES >= 44100,
      true,
      'and enough of them to cover the second that was asked for',
    );
  });
});

test('an mp4 cue track declines when ffmpeg is not installed, and only it', async () => {
  // The verdict on this format: cut it with ffmpeg, and degrade honestly where
  // there is none. What must not happen is the rest of the library going with
  // it — the same server, the same request shape, still answers everything else.
  await withCollection(async (db) => {
    const refused = JSON.parse((await ask(db, 'stream?id=tr-4&f=json')).body.toString('utf8')) as Answer;
    assert.equal(refused['subsonic-response'].status, 'failed');
    assert.match(refused['subsonic-response'].error?.message ?? '', /ffmpeg/);

    const stillFine = await ask(db, 'stream?id=tr-2');
    assert.equal(stillFine.status, 200, 'a FLAC track does not need ffmpeg and is not refused with it');
  });
});

test('a whole file a browser cannot play is re-encoded, and says so without ffmpeg', async () => {
  // The codec is the only thing that tells these two apart: the same `.m4a`, one
  // holding ALAC and one holding AAC. A client that cannot decode ALAC sits
  // silent through a file that was sent correctly — so it is re-encoded instead,
  // and where there is nothing to re-encode with, that is a refusal a client can
  // read rather than a download it cannot play.
  await withCollection(async (db) => {
    const refused = JSON.parse((await ask(db, 'stream?id=tr-6&f=json')).body.toString('utf8')) as Answer;
    assert.equal(refused['subsonic-response'].status, 'failed');
    assert.match(refused['subsonic-response'].error?.message ?? '', /ffmpeg/);

    const played = await ask(db, 'stream?id=tr-7');
    assert.equal(played.status, 200, 'and the AAC file of the same container is sent as it is');
    assert.equal(played.headers.get('accept-ranges'), 'bytes', 'a file is still a file to range');
    assert.deepEqual(played.body, Buffer.from('an AAC file, honestly'));
  });
});

test('a whole file in a container no browser opens is re-encoded too', async () => {
  // A Monkey's Audio record: no browser opens the container at all, whatever
  // the scan knows about the codec inside it — and a cue image of one is the
  // same question asked of a stretch rather than of the whole file.
  await withCollection(async (db) => {
    const refused = JSON.parse((await ask(db, 'stream?id=tr-8&f=json')).body.toString('utf8')) as Answer;
    assert.equal(refused['subsonic-response'].status, 'failed');
    assert.match(refused['subsonic-response'].error?.message ?? '', /ffmpeg/);
  });
});

test('a re-encoded song already in the cache is served, ranged, and needs no ffmpeg', async () => {
  // What the cache is for. The answer was produced once and kept, so the second
  // listen neither waits for ffmpeg nor needs it to be installed at all — and,
  // being a file of a known length, it can be ranged like any other. This is the
  // whole of what seeking needs on a song nothing here can cut.
  const cache = tempRoot('funoteka-cache-');
  try {
    const answer = flac({ frames: 20, blockSize: 4096, bodyBytes: 64 });
    await withCollection(async (db, root) => {
      const source = join(root, 'Album', 'lossless.m4a');
      // The name is the server's own to work out, and asked of it rather than
      // spelled here: what is under test is that a kept answer is served and
      // ranged without ffmpeg, not how the key is written. The spelling itself
      // is `stream-transcode`'s to guard.
      const plan = planWholeFile({ path: source, ext: 'm4a', target: null, tags: TAGS });
      assert.ok(plan.kind === 'transcode');
      writeFileSync(join(cache, `${keyOf({ source, made: plan.made })}.flac`), answer);

      const whole = await ask(db, 'stream?id=tr-6', {}, { cacheDir: cache });
      assert.equal(whole.status, 200);
      assert.equal(whole.headers.get('content-type'), 'audio/flac');
      assert.equal(whole.headers.get('accept-ranges'), 'bytes', 'a kept answer is a file to range');
      assert.equal(whole.headers.get('content-length'), String(answer.length));
      assert.deepEqual(whole.body, answer);

      const part = await ask(db, 'stream?id=tr-6', { headers: { range: 'bytes=10-19' } }, { cacheDir: cache });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), `bytes 10-19/${answer.length}`);
      assert.deepEqual(part.body, answer.subarray(10, 20));
    });
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('an image that cannot be walked is refused, not served as the whole disc', async () => {
  // A refusal a client can read beats bytes that lie about what they are: this
  // image's frames cannot be found, so nobody can say which of them is this
  // track, and sending the file would play ten seconds under a one-second name.
  await withCollection(async (db) => {
    const response = await ask(db, 'stream?id=tr-5&f=json');
    assert.equal(response.status, 200, 'the API answers its refusals in the body');

    const body = JSON.parse(response.body.toString('utf8')) as Answer;
    assert.equal(body['subsonic-response'].status, 'failed');
    assert.match(body['subsonic-response'].error?.message ?? '', /flac/);
  });
});

test('a song the meta layer does not hold is a refusal, not an empty stream', async () => {
  await withCollection(async (db) => {
    const body = JSON.parse((await ask(db, 'stream?id=tr-999&f=json')).body.toString('utf8')) as Answer;
    assert.equal(body['subsonic-response'].error?.code, 70);
  });
});

test('a frame body that looks like a header is not mistaken for one', async () => {
  // The defence the whole design rests on. A frame body can hold the sync bytes
  // and a header that parses — this fixture plants one that even states the
  // right frame number — and the only thing that rejects it is the CRC it
  // cannot forge. If it were accepted, every frame after it would be found at
  // the wrong place and the track would be served from the wrong second.
  const root = tempRoot('funoteka-stream-decoy-');
  mkdirSync(join(root, 'Album'), { recursive: true });
  const decoy = flac({ frames: 20, blockSize: 4096, bodyBytes: 64, decoy: true });
  writeFileSync(join(root, 'Album', 'decoy.flac'), decoy);
  assert.notEqual(frameAt(0, 1, 1, 0), -1, 'the fixture is built');

  const db = openDb(':memory:');
  try {
    db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(
      root,
      '2026-01-01T00:00:00Z',
    );
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (1, 1, 'Album/decoy.flac', 'Album', 'decoy.flac', 'audio', 'flac', ?, 1000)`,
    ).run(decoy.length);
    db.prepare(
      `INSERT INTO album (id, root_id, rel_path, title, title_source) VALUES (9, 1, 'Album', 'Album', 'folder')`,
    ).run();
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
       VALUES (1, 9, 1, 'Decoy', 1, 500, 1000, 500)`,
    ).run();

    const response = await ask(db, 'stream?id=tr-1');
    const body = response.body;

    // 500 ms is sample 22050, inside frame 5; 1000 ms is sample 44100, which
    // frame 11 starts at. The decoy sits in the body of frame 0, in front of
    // both: a walk that took it for a header would place every frame after it
    // wrong, and these six frames would not be the ones they claim to be.
    const from = IMAGE_AUDIO_START + 5 * FRAME_SIZE;
    const to = IMAGE_AUDIO_START + 11 * FRAME_SIZE;
    const frames = 6;

    const { audioStart } = flacHeader(body);
    assert.equal(body.length, audioStart + (to - from));

    const served = flacFrames(body, { audioStart });
    assert.equal(served.length, frames);
    assert.deepEqual(
      served.map((frame) => frame.number),
      [...Array(frames).keys()],
    );
    assert.deepEqual(
      bodiesOf(body, served, audioStart),
      bodiesOf(decoy, flacFrames(decoy, { audioStart: from }).slice(0, frames), from),
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an .opus file is handed over as the Ogg stream it is', () => {
  // RFC 7845 §9: "The RECOMMENDED mime-type for Ogg Opus files is `audio/ogg`".
  // `audio/opus` is RFC 7587's and describes the RTP payload, not a file in a
  // container — and this server said `audio/opus` here while its own
  // transcoding target for opus said `audio/ogg`, which is two answers to one
  // question (task:2920).
  return withCollection(async (db) => {
    const response = await ask(db, 'stream?id=tr-9');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/ogg');
    assert.deepEqual(response.body, OPUS, 'and the bytes are the file');
  });
});
