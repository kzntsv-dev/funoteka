import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { keyOf } from '../src/stream/recode.ts';
import { alreadyIs, planTarget, planWholeFile, stretchOf } from '../src/stream/segment.ts';
import { ask, type Db } from './helpers/api.ts';
import { mpeg } from './helpers/bytes.ts';
import { flac } from './helpers/flac.ts';
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
/**
 * What a client asks for when it cannot play what is there.
 *
 * `stream` answers with bytes, and which bytes is the client's to ask for: the
 * protocol gives it `format`, `maxBitRate` and `timeOffset`, and a client on a
 * slow link or with a codec the file does not use is asking for something other
 * than the file. Taken from the specification (`opensubsonic/open-subsonic-api`)
 * rather than from a client — **the operator's own client asks for none of
 * this** (measured: nought calls naming any of the three, and nought calls to
 * the transcode endpoints), so this is contract work and nothing here can be
 * checked by watching Feishin.
 *
 * **The suite has no ffmpeg on purpose** (`helpers/api.ts` names a binary that
 * is not installed), so a re-encode cannot be run here. What is checked is the
 * *decision*: which bytes the server reaches for, and what it says when it
 * cannot reach them. The frame-level correctness of a re-encode is
 * `stream-recode.test.ts`'s, and `planWholeFile` is a pure function tested
 * directly.
 *
 * **What that costs, and how it is paid.** A re-encode that cannot run cannot be
 * read either — so where the question is *which* re-encode was reached for, the
 * answer is planted in the cache first. `keyOf` derives a kept answer's name
 * from what was asked for, so writing the file the server *should* look for and
 * getting it back says the server worked out the same question; asking it
 * anything else misses and reaches for ffmpeg. That is how a cue track can be
 * told from the whole image it lies in with no ffmpeg in sight, and it is the
 * seam **this suite had no row for at all** until the review found two cue
 * findings no test could see (task:2865).
 */

const FLAC = flac({ frames: 20, blockSize: 4096, bodyBytes: 64, sampleRate: 44100 });
const MP3 = mpeg({ frames: 40, sampleRate: 44100, bitrateKbps: 128 });
/** The image the cue tracks are cut from. Nothing here walks it — see below. */
const IMAGE = flac({ frames: 30, blockSize: 4096, bodyBytes: 64, sampleRate: 44100 });

function collection(): { db: Db; root: string } {
  const root = tempRoot('funoteka-transcode-');
  mkdirSync(join(root, 'Album'), { recursive: true });
  writeFileSync(join(root, 'Album', 'lossless.flac'), FLAC);
  writeFileSync(join(root, 'Album', 'lossy.mp3'), MP3);
  // Apple's codec in the container AAC also uses: no browser decodes it, so the
  // server has to re-encode it whether or not anything was asked for.
  writeFileSync(join(root, 'Album', 'alac.m4a'), Buffer.from('an ALAC file'));

  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(
    root,
    '2026-01-01T00:00:00Z',
  );
  db.prepare(
    `INSERT INTO album (id, root_id, rel_path, title, title_source)
     VALUES (10, 1, 'Album', 'Album', 'folder')`,
  ).run();

  const track = (id: number, name: string, ext: string, codec: string, bitrate: number): void => {
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, 'Album', ?, 'audio', ?, ?, 1000)`,
    ).run(100 + id, `Album/${name}`, name, ext, 4096);
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
       VALUES (?, 10, ?, ?, ?, 60000)`,
    ).run(id, id, name, 100 + id);
    db.prepare(
      `INSERT INTO audio_probe (file_id, codec, sample_rate, channels, bitrate, probe_ok, probe_method)
       VALUES (?, ?, 44100, 2, ?, 1, 1)`,
    ).run(100 + id, codec, bitrate);
  };

  track(1, 'lossless.flac', 'flac', 'flac', 900_000);
  track(2, 'lossy.mp3', 'mp3', 'mp3', 128_000);
  track(3, 'alac.m4a', 'm4a', 'alac', 900_000);

  // An image, and two tracks cut from it. The stand had no cue row at all, which
  // is why the two findings that live exactly here — a cue track asked for in
  // another format, and the answer it shares with its neighbours — were invisible
  // to every test in the project (task:2865).
  writeFileSync(join(root, 'Album', 'image.flac'), IMAGE);
  db.prepare(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (104, 1, 'Album/image.flac', 'Album', 'image.flac', 'audio', 'flac', ?, 1000)`,
  ).run(IMAGE.length);
  db.prepare(
    `INSERT INTO audio_probe (file_id, codec, sample_rate, channels, bitrate, probe_ok, probe_method)
     VALUES (104, 'flac', 44100, 2, 900000, 1, 1)`,
  ).run();

  const cut = (id: number, startMs: number, endMs: number): void => {
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
       VALUES (?, 10, ?, ?, 104, ?, ?, ?)`,
    ).run(id, id, `Cut ${id}`, startMs, endMs, endMs - startMs);
  };
  cut(4, 1000, 3000);
  cut(5, 3000, 5000);

  // The measured repro of the codec finding: an extension that *is* the
  // container `format=aac` names, holding a codec it is not.
  writeFileSync(join(root, 'Album', 'apple.mp4'), Buffer.from('an ALAC file in an mp4'));
  track(6, 'apple.mp4', 'mp4', 'alac', 900_000);

  // A stretch of an image only ffmpeg can cut. It is the one case where two
  // callers that refuse are told apart, and each has to hear its own reason.
  writeFileSync(join(root, 'Album', 'boxed.m4a'), Buffer.from('not really an mp4'));
  track(7, 'boxed.m4a', 'm4a', 'aac', 128_000);
  db.prepare(
    'UPDATE track SET segment_start_ms = 1000, segment_end_ms = 3000, duration_ms = 2000 WHERE id = 7',
  ).run();

  return { db, root };
}

interface Answer {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
    song?: { bitRate?: number; samplingRate?: number; channelCount?: number };
  };
}

const served = (body: Buffer): Answer => JSON.parse(body.toString('utf8')) as Answer;

// --- the file's own numbers, which nothing used to say ---------------------

test('a song is described by the codec inside it, not only by its name', async () => {
  // The protocol puts `bitRate`, `samplingRate` and `channelCount` on every
  // `Child`, and this server sent none of them — the scan reads all three into
  // `audio_probe` and nothing carried them out. They are what a client needs to
  // decide anything about a file, and they are what `maxBitRate` below is
  // answered from.
  const { db, root } = collection();

  const answer = served((await ask(db, 'getSong?id=tr-1&f=json')).body);
  assert.equal(answer['subsonic-response'].song?.bitRate, 900);
  assert.equal(answer['subsonic-response'].song?.samplingRate, 44100);
  assert.equal(answer['subsonic-response'].song?.channelCount, 2);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- format ----------------------------------------------------------------

test('format=raw sends the file itself, whatever is inside it', async () => {
  // The protocol's own escape hatch, since 1.9.0: "you can use the special value
  // raw to disable transcoding". An ALAC file is one no browser decodes, and a
  // client that says `raw` is saying it can.
  const { db, root } = collection();

  const answer = await ask(db, 'stream?id=tr-3&format=raw');

  assert.equal(answer.status, 200);
  assert.deepEqual(Buffer.from(answer.body), Buffer.from('an ALAC file'));

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('format=mp3 on a file that is not mp3 reaches for a re-encode', async () => {
  // With no ffmpeg installed the answer is a refusal that says so — which is the
  // proof that the re-encode was what the server reached for, and not the file.
  const { db, root } = collection();

  const answer = await ask(db, 'stream?id=tr-1&format=mp3&f=json');

  assert.equal(answer.status, 200);
  assert.match(answer.body.toString('utf8'), /failed/);
  assert.notDeepEqual(Buffer.from(answer.body), FLAC, 'and not the flac that was there');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('format=flac on a flac sends the flac', async () => {
  const { db, root } = collection();

  const answer = await ask(db, 'stream?id=tr-1&format=flac');

  assert.deepEqual(Buffer.from(answer.body), FLAC);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a format this server cannot make is refused by name', async () => {
  const { db, root } = collection();

  const answer = served((await ask(db, 'stream?id=tr-1&format=flv&f=json')).body);

  assert.equal(answer['subsonic-response'].status, 'failed');
  assert.match(answer['subsonic-response'].error?.message ?? '', /flv/);
  assert.match(
    answer['subsonic-response'].error?.message ?? '',
    /mp3|opus|flac/,
    'and it says what it can make instead',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- maxBitRate ------------------------------------------------------------

test('a bitrate ceiling on a lossless file reaches for a lossy re-encode', async () => {
  // A FLAC cannot be made smaller without leaving FLAC, so a ceiling is a
  // request for a lossy format — and the protocol names no default one, so the
  // server picks the one every client can play.
  const { db, root } = collection();

  const answer = served((await ask(db, 'stream?id=tr-1&maxBitRate=128&f=json')).body);

  // A refusal at all is the proof: this file is a FLAC, which every client
  // plays, so a ceiling is the only thing that could have sent it down the
  // re-encoding path — and there is no ffmpeg here to walk it with. The message
  // names ffmpeg, which is the reason it failed, and not the format it was
  // reaching for.
  assert.equal(answer['subsonic-response'].status, 'failed', 'no ffmpeg here to do it with');
  assert.match(answer['subsonic-response'].error?.message ?? '', /ffmpeg/i);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a file already under the ceiling is sent as it is', async () => {
  // 128 kbps mp3 against a ceiling of 320: nothing to do, and re-encoding would
  // cost quality for nothing.
  const { db, root } = collection();

  const answer = await ask(db, 'stream?id=tr-2&maxBitRate=320');

  assert.deepEqual(Buffer.from(answer.body), MP3);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('maxBitRate=0 is no ceiling at all, which is what the protocol says', async () => {
  const { db, root } = collection();

  const answer = await ask(db, 'stream?id=tr-1&maxBitRate=0');

  assert.deepEqual(Buffer.from(answer.body), FLAC);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- timeOffset ------------------------------------------------------------

test('timeOffset asks to start further in, which a whole file cannot do', async () => {
  // The `Transcode Offset` extension is this one parameter: "you can now start
  // transcoding at any position in the media, allowing seeking when transcoding
  // on the clients". Starting part-way into a file that is sent as bytes is a
  // *range*, which the client asks for with a Range header — so the parameter
  // only means anything on the re-encoding path, and there it is a refusal here
  // because there is no ffmpeg to re-encode with.
  const { db, root } = collection();

  const answer = served((await ask(db, 'stream?id=tr-3&timeOffset=30&f=json')).body);

  assert.equal(answer['subsonic-response'].status, 'failed');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- the plan itself, which is where the arguments are actually decided ----

test('the re-encode arguments name the codec and the bitrate that were asked for', () => {
  const args = planWholeFile({ path: 'x.flac', ext: 'flac', target: { format: 'mp3', maxBitRate: 128 }, tags: TAGS });

  assert.equal(args.kind, 'transcode');
  assert.ok(args.kind === 'transcode');
  const line = args.args('out.bin').join(' ');
  assert.match(line, /-c:a libmp3lame/, 'the codec the format names');
  assert.match(line, /-b:a 128k/, 'and the ceiling that was asked for');
  assert.equal(args.contentType, 'audio/mpeg');
});

test('a re-encode with no ceiling is the lossless one the server already did', () => {
  const args = planWholeFile({ path: 'x.m4a', ext: 'm4a', target: null, tags: TAGS });

  assert.ok(args.kind === 'transcode');
  const line = args.args('out.bin').join(' ');
  assert.match(line, /-c:a flac/);
  assert.equal(args.contentType, 'audio/flac');
});

test('an mp3 is tagged ID3v2.3, which is the version both generations read', () => {
  // ffmpeg writes 2.4 by default, and 2.4 has a reader problem 2.3 does not: a
  // reader that knows only 2.3 sees every tag except the year — it lives in
  // `TDRC` in 2.4 and in `TYER` in 2.3. Nothing in these tags is said better in
  // 2.4, so the version everybody reads is the one to write.
  const mp3 = planWholeFile({ path: 'x.flac', ext: 'flac', target: { format: 'mp3', maxBitRate: 128 }, tags: TAGS });
  assert.ok(mp3.kind === 'transcode');
  assert.match(mp3.args('out.mp3').join(' '), /-id3v2_version 3/);

  // And only where it means something: the option belongs to the mp3 muxer, and
  // handing it to flac's would be an option that does not exist.
  const flac = planWholeFile({ path: 'x.m4a', ext: 'm4a', target: { format: 'flac', maxBitRate: null }, tags: TAGS });
  assert.ok(flac.kind === 'transcode');
  assert.doesNotMatch(flac.args('out.flac').join(' '), /-id3v2_version/);
});

test('a ceiling on a lossless target is not part of the answer, so not of its name', () => {
  // The ceiling never reaches ffmpeg when the target is lossless — a bitrate cap
  // on FLAC would be a request to throw samples away while still calling the
  // answer lossless — so two clients naming different ceilings for it are asking
  // for the same bytes. Naming them apart would store one answer twice under two
  // names, which is the defect `Plan.made` was introduced for in the first place
  // (task:2865). The channel cap below is the other half of the same question.
  const capped = planWholeFile({
    path: 'x.m4a',
    ext: 'm4a',
    target: { format: 'flac', maxBitRate: 128 },
    tags: TAGS,
  });
  const plain = planWholeFile({
    path: 'x.m4a',
    ext: 'm4a',
    target: { format: 'flac', maxBitRate: null },
    tags: TAGS,
  });

  assert.ok(capped.kind === 'transcode' && plain.kind === 'transcode');
  assert.doesNotMatch(capped.args('out.bin').join(' '), /-b:a/);
  assert.equal(capped.made, plain.made, 'one answer, one name');
});

test('a channel cap reaches ffmpeg, and is part of the answer it makes', () => {
  // The `transcoding` extension's own parameter, and the one limit a lossless
  // target does *not* drop: a client that cannot decode six channels cannot play
  // six channels whatever they arrive wrapped in (task:2896). It changes the
  // bytes, so unlike the ceiling it is part of the name.
  const capped = planWholeFile({
    path: 'x.flac',
    ext: 'flac',
    target: { format: 'mp3', maxBitRate: 128, maxChannels: 2 },
    tags: TAGS,
  });
  const plain = planWholeFile({
    path: 'x.flac',
    ext: 'flac',
    target: { format: 'mp3', maxBitRate: 128, maxChannels: null },
    tags: TAGS,
  });

  assert.ok(capped.kind === 'transcode' && plain.kind === 'transcode');
  assert.match(capped.args('out.bin').join(' '), /-ac 2/);
  assert.notEqual(capped.made, plain.made, 'two different answers');
});

// --- a cue track, which is where the format branch meets the segment's bounds

test('a cue track asked for in another format is answered as the track, not the disc', async () => {
  // The finding both axes made, and the reason this file now has a cue row in
  // its stand. The plan for a segment was built from the *image's* path and the
  // client's offset, and the segment's own bounds never reached it — so one
  // track of a disc asked for as mp3 was a re-encode of the entire image
  // (task:2865).
  //
  // The proof is the cache. There is no ffmpeg here to run a re-encode with, but
  // the answer it *would* produce has a name derived from what was asked for —
  // so planting that name and getting those bytes back says the server worked
  // out the same question. A server that asked for the whole image's answer
  // instead looks for a different file, misses, and reaches for ffmpeg.
  const cache = tempRoot('funoteka-cache-');
  try {
    const { db, root } = collection();
    const source = join(root, 'Album', 'image.flac');
    const answer = Buffer.from('the first track of the disc, and nothing else');
    writeFileSync(
      join(cache, `${keyOf({ source, startMs: 1000, endMs: 3000, made: 'mp3:none:none' })}.mp3`),
      answer,
    );

    const served = await ask(db, 'stream?id=tr-4&format=mp3', {}, { cacheDir: cache });

    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(served.body, answer);

    rmSync(root, { recursive: true, force: true });
    db.close();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('two tracks of one image are two answers, and neither is the other', async () => {
  // The measured consequence of the same seam: the key on this path named the
  // image and not the stretch, so two tracks asked for mp3 collided on one
  // entry — the first one requested became the answer for every other track of
  // that disc, and stayed it for good (task:2865).
  const cache = tempRoot('funoteka-cache-');
  try {
    const { db, root } = collection();
    const source = join(root, 'Album', 'image.flac');
    const first = Buffer.from('the first track');
    const second = Buffer.from('the second track');
    const planted = (startMs: number, endMs: number, bytes: Buffer): void => {
      writeFileSync(
        join(cache, `${keyOf({ source, startMs, endMs, made: 'mp3:none:none' })}.mp3`),
        bytes,
      );
    };
    planted(1000, 3000, first);
    planted(3000, 5000, second);

    const one = await ask(db, 'stream?id=tr-4&format=mp3', {}, { cacheDir: cache });
    const two = await ask(db, 'stream?id=tr-5&format=mp3', {}, { cacheDir: cache });

    assert.deepEqual(one.body, first);
    assert.deepEqual(two.body, second, 'the second track is not answered with the first');

    rmSync(root, { recursive: true, force: true });
    db.close();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('a timeOffset on a cue track is an offset into the track, not into the disc', async () => {
  // `Transcode Offset` says where the answer begins, and for a cue track "the
  // beginning" is the track's own. This used to be read against the image, so
  // half a second into track two was half a second into the *disc* — a different
  // song, transcoded and cached under this one's name (task:2865).
  const cache = tempRoot('funoteka-cache-');
  try {
    const { db, root } = collection();
    const source = join(root, 'Album', 'image.flac');
    const answer = Buffer.from('the first track, from half a second in');
    // The track begins at 1 000 ms, so half a second in is 1 500 ms of the image
    // — and the far end is the track's own 3 000 and not moved by the offset.
    writeFileSync(
      join(cache, `${keyOf({ source, startMs: 1500, endMs: 3000, made: 'mp3:none:none' })}.mp3`),
      answer,
    );

    const served = await ask(db, 'stream?id=tr-4&format=mp3&timeOffset=0.5', {}, { cacheDir: cache });

    assert.equal(served.status, 200);
    assert.deepEqual(served.body, answer);

    rmSync(root, { recursive: true, force: true });
    db.close();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

// --- raw, and an offset that cannot be honoured -----------------------------

test('format=raw with a timeOffset is still raw: nothing is transcoded for it', async () => {
  // The protocol's escape hatch says "disable transcoding", and an offset beside
  // it does not undo that. Nor has the offset anything to move here: a file sent
  // as bytes starts where the client's Range header says it does. What this used
  // to do was re-encode — the one thing `raw` says not to (task:2865).
  const { db, root } = collection();

  const answer = await ask(db, 'stream?id=tr-1&format=raw&timeOffset=3');

  assert.equal(answer.status, 200);
  assert.deepEqual(Buffer.from(answer.body), FLAC, 'the file itself, and not a refusal');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a timeOffset past the end is refused, and never becomes a kept empty answer', async () => {
  // `-t 0.000` is not an error to ffmpeg: it writes a file of no bytes, the
  // server keeps it, and every later client that asks the same question is
  // handed silence — for good, since nothing about the answer looks wrong
  // (task:2865).
  const { db, root } = collection();

  const answer = served((await ask(db, 'stream?id=tr-1&timeOffset=60&f=json')).body);

  assert.equal(answer['subsonic-response'].status, 'failed');
  assert.match(
    answer['subsonic-response'].error?.message ?? '',
    /timeOffset/,
    'and it says the offset is the reason, not ffmpeg',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a request naming a song that is not there is told that, whatever else it asked', async () => {
  // **The order the parameters are read in, and it is the answer's.** A format
  // this server cannot make is worth a sentence about a song that exists; about
  // one that does not, the truer answer is that it does not. `serveSong` is
  // handed the questions rather than the answers so that it can read them after
  // the row is looked up — the order `stream` read its own query in before the
  // extraction, which the standards axis caught the first version changing
  // (task:2896).
  const { db, root } = collection();

  const answer = served((await ask(db, 'stream?id=tr-999&format=banana&f=json')).body);

  assert.equal(answer['subsonic-response'].error?.code, 70, 'no such song, not a complaint about banana');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- alreadyIs, which is where "the file already is what was asked for" lives

test('a file whose container is right and whose codec is not is re-encoded', () => {
  // The measured finding: `format=aac` on a `.mp4` holding Apple's ALAC was
  // answered with the ALAC itself — a codec the client had just said it decodes
  // AAC *instead of*. The container is the one it named; the codec is not
  // (task:2865).
  assert.equal(
    alreadyIs({ format: 'aac', maxBitRate: null }, { ext: 'mp4', codec: 'alac', bitrate: 900_000, channels: 2 }),
    false,
  );
  // And the pair of it, from the standards axis: an `.ogg` holding vorbis is not
  // the `format=opus` answer though its container is right too.
  assert.equal(
    alreadyIs({ format: 'opus', maxBitRate: null }, { ext: 'ogg', codec: 'vorbis', bitrate: 200_000, channels: 2 }),
    false,
  );
});

test('a file already holding the codec asked for is sent as it is', () => {
  // Both questions, and the container is compared as a *kind* and not as a name:
  // `.m4a` is not `mp4` to a client, so the AAC inside it still answers
  // `format=aac` — and re-encoding it would cost quality for nothing.
  assert.equal(
    alreadyIs({ format: 'aac', maxBitRate: null }, { ext: 'm4a', codec: 'aac', bitrate: 128_000, channels: 2 }),
    true,
  );
  assert.equal(
    alreadyIs({ format: 'ogg', maxBitRate: null }, { ext: 'oga', codec: 'vorbis', bitrate: 200_000, channels: 2 }),
    true,
  );
});

test('opus in an ogg is the answer to format=opus, whatever the file is called', () => {
  // The contract axis measured this the other way round: a real `.opus` was
  // re-encoded opus to opus, because the table that said which codec a format
  // *is* had no entry for the one ffmpeg spells the same on both sides.
  assert.equal(
    alreadyIs({ format: 'opus', maxBitRate: null }, { ext: 'opus', codec: 'opus', bitrate: 96_000, channels: 2 }),
    true,
  );
});

test('a file with more channels than the client decodes is not the answer, whatever its format', () => {
  // **Found by the standards axis and not by this suite** (task:2896). The
  // channel cap arrives with the `transcoding` extension; it was threaded into
  // ffmpeg and into the answer's name, and the shortcut that decides whether
  // ffmpeg is reached for at all never asked it. A six-channel FLAC asked for by
  // a client that decodes two is trivially the format that client named — and it
  // is not the stream the decision promised it. One decision, two answers.
  assert.equal(
    alreadyIs(
      { format: 'flac', maxBitRate: null, maxChannels: 2 },
      { ext: 'flac', codec: 'flac', bitrate: 900_000, channels: 6 },
    ),
    false,
  );

  // At the cap and under it the file is what was asked for, and the answer is
  // the file itself.
  assert.equal(
    alreadyIs(
      { format: 'flac', maxBitRate: null, maxChannels: 2 },
      { ext: 'flac', codec: 'flac', bitrate: 900_000, channels: 2 },
    ),
    true,
  );

  // **A count nobody measured does not block, and that is the opposite of the
  // ceiling above** — because `-ac` is not a ceiling to ffmpeg, it is a number
  // of channels to produce. Treating an unmeasured file as "not shown to be
  // within the cap" made a stereo mp3 come out as **5.1** against a client that
  // had said only "no more than six" (measured live, task:2896).
  assert.equal(
    alreadyIs(
      { format: 'flac', maxBitRate: null, maxChannels: 2 },
      { ext: 'flac', codec: 'flac', bitrate: 900_000, channels: null },
    ),
    true,
    'no measurement, no cap to obey — and no channels to invent',
  );
});

test('format=aac on an MP4 holding ALAC reaches for a re-encode, not for the ALAC', async () => {
  // The measured repro, end to end. This file's extension *is* the container
  // `format=aac` names, so asking the container alone said yes — and a client
  // that had just declared it decodes AAC was handed the ALAC it cannot. That is
  // "bytes a client sits silent through", which is the class `playable` exists
  // to prevent (task:2865).
  const { db, root } = collection();

  const answer = served((await ask(db, 'stream?id=tr-6&format=aac&f=json')).body);

  assert.equal(answer['subsonic-response'].status, 'failed', 'no ffmpeg here to do it with');
  assert.match(answer['subsonic-response'].error?.message ?? '', /ffmpeg/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a refusal to re-encode names the promise the caller actually made', async () => {
  // Three callers and two promises meet on one branch. `format=raw` is the
  // protocol's "disable transcoding" and `download` stands on the original media
  // data; a stretch of an MP4 image is the one thing neither can have without
  // ffmpeg, so both refuse. Telling a client that sent `format=raw` about
  // *download's* promise — which is what happened the moment `raw` was routed
  // through the branch that already had a message — is a lie to a client, which
  // is the class of thing this route exists to avoid (found live, task:2865).
  const { db, root } = collection();

  const raw = served((await ask(db, 'stream?id=tr-7&format=raw&f=json')).body);
  assert.equal(raw['subsonic-response'].status, 'failed');
  assert.match(raw['subsonic-response'].error?.message ?? '', /format=raw/);
  assert.doesNotMatch(
    raw['subsonic-response'].error?.message ?? '',
    /download promises/,
    'and not the other caller’s promise',
  );

  const saved = served((await ask(db, 'download?id=tr-7&f=json')).body);
  assert.equal(saved['subsonic-response'].status, 'failed');
  assert.match(saved['subsonic-response'].error?.message ?? '', /download promises/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a stretch only ffmpeg can cut is served when a format is asked for', async () => {
  // The other half of the refusal above: `raw` and `download` close this branch,
  // and nothing else does. A client that named a format is owed the attempt.
  const { db, root } = collection();

  const answer = served((await ask(db, 'stream?id=tr-7&format=mp3&f=json')).body);

  assert.equal(answer['subsonic-response'].status, 'failed', 'no ffmpeg here to do it with');
  assert.match(answer['subsonic-response'].error?.message ?? '', /ffmpeg/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a re-encode asked for as flac and one fallen back to are one answer', () => {
  // `Plan.made` is part of the answer's identity and was written two ways for one
  // identity: `flac` when the server chose, `flac:none` when a client named it.
  // Two names for the same bytes meant the same 68 863 444-byte answer was
  // produced and kept twice — 785 ms and 206 MB for one answer (measured on the
  // live daemon, task:2865).
  const fell = planWholeFile({ path: 'x.m4a', ext: 'm4a', target: null, tags: TAGS });
  const named = planTarget({
    path: 'x.m4a',
    target: { format: 'flac', maxBitRate: null },
    times: null,
    tags: TAGS,
  });

  assert.ok(fell.kind === 'transcode' && named.kind === 'transcode');
  assert.equal(fell.made, named.made, 'one identity has one name');
  assert.deepEqual(fell.args('out.bin'), named.args('out.bin'), 'and the same arguments');

  // While a format that is not the fallback keeps its own name, ceiling and all.
  const ceiling = planTarget({
    path: 'x.m4a',
    target: { format: 'mp3', maxBitRate: 128 },
    times: null,
    tags: TAGS,
  });
  assert.ok(ceiling.kind === 'transcode');
  assert.notEqual(ceiling.made, fell.made);
});

// --- the stretch itself, which is what the cue findings came down to --------

test('a cue track is its own stretch of the image, and an offset moves its near end', () => {
  const cut = { segment_start_ms: 1000, segment_end_ms: 3000, duration_ms: 2000 };

  assert.deepEqual(stretchOf(cut, null), { kind: 'span', startMs: 1000, endMs: 3000 });
  // The far end does not move: `Transcode Offset` says where the answer begins,
  // not how much of it there is.
  assert.deepEqual(stretchOf(cut, 500), { kind: 'span', startMs: 1500, endMs: 3000 });
});

test('the closing track of a disc is bounded by the measurement, not by a cue', () => {
  assert.deepEqual(
    stretchOf({ segment_start_ms: 2000, segment_end_ms: null, duration_ms: 1500 }, null),
    { kind: 'span', startMs: 2000, endMs: 3500 },
  );
});

test('a whole file is not a stretch, and an offset makes it one', () => {
  const song = { segment_start_ms: null, segment_end_ms: null, duration_ms: 60_000 };

  assert.deepEqual(stretchOf(song, null), { kind: 'file' });
  assert.deepEqual(stretchOf(song, 3000), { kind: 'span', startMs: 3000, endMs: 60_000 });
});

test('a stretch nobody can bound is refused rather than made empty', () => {
  // Each of these used to become `-t 0.000`, which ffmpeg does not call an
  // error: an empty file, kept, and served to everyone who asked afterwards.
  const noLength = { segment_start_ms: null, segment_end_ms: null, duration_ms: null };
  assert.equal(stretchOf(noLength, 3000).kind, 'refused', 'nothing to measure the end against');

  const song = { segment_start_ms: null, segment_end_ms: null, duration_ms: 60_000 };
  assert.equal(stretchOf(song, 60_000).kind, 'refused', 'at the end is past it');
  assert.equal(stretchOf(song, 90_000).kind, 'refused');

  const cut = { segment_start_ms: 1000, segment_end_ms: 3000, duration_ms: 2000 };
  assert.equal(stretchOf(cut, 2000).kind, 'refused', 'an offset past the end of the track');
  assert.equal(stretchOf(cut, null).kind, 'span', 'and the track itself is still served');
});

test('a re-encode of a cue track is told where the track begins and ends', () => {
  // What the two cue findings come down to in the arguments: without the times
  // ffmpeg is handed the image and writes the whole disc under one track's name.
  const plan = planTarget({
    path: 'image.flac',
    target: { format: 'mp3', maxBitRate: null },
    times: { startMs: 1000, endMs: 3000 },
    tags: TAGS,
  });

  assert.ok(plan.kind === 'transcode');
  const line = plan.args('out.bin').join(' ');
  assert.match(line, /-ss 1\.000/, 'where the track begins');
  assert.match(line, /-t 2\.000/, 'and how much of it there is');
});
