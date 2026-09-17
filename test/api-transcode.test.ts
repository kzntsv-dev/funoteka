import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { keyOf } from '../src/stream/recode.ts';
import { ask, type Db } from './helpers/api.ts';
import { mpeg } from './helpers/bytes.ts';
import { flac } from './helpers/flac.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The `transcoding` extension: what the server would do with a song, and then
 * the stream it said it would send.
 *
 * The specification is `opensubsonic/open-subsonic-api`, and the client this was
 * built for is Symfonium — named by the operator, a phone that goes to the
 * background and comes back. Neither is watchable from here, so what is checked
 * is the *decision*: which stream the server says it would send, what it says
 * when it will not send one, and — where the question is which bytes it reaches
 * for — the answer is planted in the cache first. `keyOf` derives a kept
 * answer's name from what was asked for, so writing the file the server *should*
 * look for and getting it back says the server worked out the same question.
 *
 * **The suite has no ffmpeg on purpose** (`helpers/api.ts` names a binary that is
 * not installed), which is what makes that trick the only way to see the
 * decision: a re-encode cannot be run, and it cannot be read either.
 *
 * The two things the operator decided are checked first, because they are the
 * ones a reasonable implementation gets wrong: `hls` is never promised, and the
 * decision agrees with what `stream` would actually do.
 */

const FLAC = flac({ frames: 20, blockSize: 4096, bodyBytes: 64, sampleRate: 44100 });
const MP3 = mpeg({ frames: 40, sampleRate: 44100, bitrateKbps: 128 });
/** The image two of the tracks below are cut from. */
const IMAGE = flac({ frames: 30, blockSize: 4096, bodyBytes: 64, sampleRate: 44100 });

interface Collection {
  db: Db;
  root: string;
  at: (name: string) => string;
}

function collection(): Collection {
  const root = tempRoot('funoteka-decision-');
  mkdirSync(join(root, 'Album'), { recursive: true });
  writeFileSync(join(root, 'Album', 'lossless.flac'), FLAC);
  writeFileSync(join(root, 'Album', 'lossy.mp3'), MP3);
  writeFileSync(join(root, 'Album', 'monkey.ape'), Buffer.from('MAC '));
  writeFileSync(join(root, 'Album', 'boxed.m4a'), Buffer.from('not really an mp4'));
  writeFileSync(join(root, 'Album', 'six.flac'), FLAC);
  writeFileSync(join(root, 'Album', 'image.flac'), IMAGE);
  writeFileSync(join(root, 'Album', 'unknown.m4a'), Buffer.from('nobody read this one'));

  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(
    root,
    '2026-01-01T00:00:00Z',
  );
  db.prepare(
    `INSERT INTO album (id, root_id, rel_path, title, title_source)
     VALUES (10, 1, 'Album', 'Album', 'folder')`,
  ).run();

  const file = (id: number, name: string, ext: string): void => {
    db.prepare(
      `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
       VALUES (?, 1, ?, 'Album', ?, 'audio', ?, 4096, 1000)`,
    ).run(100 + id, `Album/${name}`, name, ext);
  };

  const track = (
    id: number,
    name: string,
    ext: string,
    codec: string,
    bitrate: number | null,
    channels: number | null = 2,
  ): void => {
    file(id, name, ext);
    db.prepare(
      `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
       VALUES (?, 10, ?, ?, ?, 60000)`,
    ).run(id, id, name, 100 + id);
    db.prepare(
      `INSERT INTO audio_probe (file_id, codec, sample_rate, channels, bitrate, probe_ok, probe_method)
       VALUES (?, ?, 44100, ?, ?, 1, 1)`,
    ).run(100 + id, codec, channels, bitrate);
  };

  // A file every client can be handed as it is, and the one the cache tests ask
  // for in another format.
  track(1, 'lossless.flac', 'flac', 'flac', 900_000);
  // Already mp3 at 128: what `stream` answers from the file itself rather than
  // by re-encoding.
  track(2, 'lossy.mp3', 'mp3', 'mp3', 128_000);
  // A codec no browser decodes and this server re-encodes whatever is asked —
  // the case where a client that *can* play the file is still not handed it.
  track(3, 'monkey.ape', 'ape', 'ape', 900_000);
  // Six channels, which a client that decodes two has to have downmixed.
  track(8, 'six.flac', 'flac', 'flac', 900_000, 6);
  // A file nothing measured the bitrate of — which is nearly all of them
  // (measured on the live library: 3005 of 3173). What is left is the file's
  // size and its measured length, and the two are what the decision falls back on.
  track(9, 'unmeasured.flac', 'flac', 'flac', null);
  db.prepare('UPDATE file SET size = 1000000 WHERE id = 109').run();
  // A song whose channel count nobody measured, which is 2153 files of the live
  // collection — every mp3 and every m4a among them.
  writeFileSync(join(root, 'Album', 'unmeasured.mp3'), MP3);
  track(10, 'unmeasured.mp3', 'mp3', 'mp3', null, null);

  // An image, and two tracks cut from it: one whose frames are the image's own
  // and one that only ffmpeg can cut out.
  db.prepare(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (104, 1, 'Album/image.flac', 'Album', 'image.flac', 'audio', 'flac', ?, 1000)`,
  ).run(IMAGE.length);
  db.prepare(
    `INSERT INTO audio_probe (file_id, codec, sample_rate, channels, bitrate, probe_ok, probe_method)
     VALUES (104, 'flac', 44100, 2, 900000, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
     VALUES (4, 10, 4, 'Cut 4', 104, 1000, 3000, 2000)`,
  ).run();

  db.prepare(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (105, 1, 'Album/boxed.m4a', 'Album', 'boxed.m4a', 'audio', 'm4a', 4096, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO audio_probe (file_id, codec, sample_rate, channels, bitrate, probe_ok, probe_method)
     VALUES (105, 'aac', 44100, 2, 128000, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO track (id, album_id, ordinal, title, file_id, segment_start_ms, segment_end_ms, duration_ms)
     VALUES (5, 10, 5, 'Cut 5', 105, 1000, 3000, 2000)`,
  ).run();

  // A `.m4a` whose codec nothing has read: the container says nothing about what
  // is inside it, and there is no ffprobe here to ask.
  db.prepare(
    `INSERT INTO file (id, root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (106, 1, 'Album/unknown.m4a', 'Album', 'unknown.m4a', 'audio', 'm4a', 4096, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO track (id, album_id, ordinal, title, file_id, duration_ms)
     VALUES (6, 10, 6, 'unknown.m4a', 106, 60000)`,
  ).run();

  return { db, root, at: (name: string) => join(root, 'Album', name) };
}

/** One song's answer, as the protocol's envelope. */
interface Answer {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
    transcodeDecision?: Decision;
  };
}

interface StreamDetails {
  protocol: string;
  container: string;
  codec: string;
  audioChannels?: number;
  audioBitrate?: number;
  audioSamplerate?: number;
}

interface Decision {
  canDirectPlay: boolean;
  canTranscode: boolean;
  transcodeReason?: string[];
  errorReason?: string;
  transcodeParams?: string;
  sourceStream: StreamDetails;
  transcodeStream?: StreamDetails;
}

function served(body: Buffer): Answer {
  return JSON.parse(body.toString('utf8')) as Answer;
}

/** A client's capabilities, with only what a test cares about written out. */
function client(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'Symfonium', platform: 'Android', ...over };
}

/** One decision, asked for the way the specification says to ask. */
async function decide(
  db: Db,
  id: string,
  capabilities: Record<string, unknown>,
): Promise<Decision | undefined> {
  const body = await ask(
    db,
    `getTranscodeDecision?mediaId=${id}&mediaType=song&f=json`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(capabilities),
    },
  );
  return served(body.body)['subsonic-response'].transcodeDecision;
}

/** A client that plays FLAC as it is and will take anything else as mp3. */
const PLAYS_FLAC = {
  directPlayProfiles: [
    { containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'], maxAudioChannels: 2 },
  ],
  transcodingProfiles: [{ container: 'mp3', audioCodec: 'mp3', protocol: 'http' }],
};

// --- what the answer says ---------------------------------------------------

test('a client that can play the file is told so, and what it would be given otherwise', async () => {
  const { db, root } = collection();

  const decision = await decide(db, 'tr-1', client(PLAYS_FLAC));

  assert.ok(decision !== undefined);
  assert.equal(decision.canDirectPlay, true, 'a FLAC profile and a FLAC file');
  assert.equal(decision.canTranscode, true);
  assert.equal(decision.transcodeReason, undefined, 'nothing to explain about a file that plays');
  assert.ok((decision.transcodeParams ?? '').length > 0, 'a decision that can transcode carries its token');

  // The source, in the protocol's own words: the container of an `.flac` is
  // `flac` and that of an `.m4a` is `mp4`, and the numbers are the probe's.
  assert.deepEqual(decision.sourceStream, {
    protocol: 'http',
    container: 'flac',
    codec: 'flac',
    audioChannels: 2,
    audioBitrate: 900_000,
    audioSamplerate: 44100,
  });

  // And what would be made of it: mp3 at 128, which is what the client's own
  // profile names.
  assert.equal(decision.transcodeStream?.container, 'mp3');
  assert.equal(decision.transcodeStream?.codec, 'mp3');
  assert.equal(decision.transcodeStream?.protocol, 'http');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a file that one profile accepts has nothing to explain, whatever the others said', async () => {
  // **Found live, on the operator's own client.** `transcodeReason` is "reasons
  // why transcoding is necessary" — and a client carries several profiles, of
  // which all but one refuse any given file. Listing those refusals beside
  // `canDirectPlay: true` tells a client two things at once, and the list is the
  // half it would act on: it would transcode a file it was just told it could
  // play. Symfonium's three profiles answered a FLAC file exactly that way.
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-1',
    client({
      directPlayProfiles: [
        { containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'] },
        { containers: ['m4a', 'mp4'], audioCodecs: ['aac', 'alac'], protocols: ['http'] },
        { containers: ['mp3'], audioCodecs: ['mp3'], protocols: ['http'] },
      ],
      transcodingProfiles: [{ container: 'mp3', audioCodec: 'mp3', protocol: 'http' }],
    }),
  );

  assert.ok(decision !== undefined);
  assert.equal(decision.canDirectPlay, true);
  assert.equal(decision.transcodeReason, undefined, 'nothing is necessary, so nothing is explained');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a client that got what it asked for is not handed an error', async () => {
  // **Found by the contract axis, which read the field's documentation.**
  // `errorReason` is "a description of an error that occurred" — and a client
  // whose direct-play profile works, which named no transcoding profiles, has
  // been granted exactly what it asked for. An error beside `canDirectPlay: true`
  // is the same false statement this module already refuses to make with
  // `transcodeReason`.
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-1',
    client({
      directPlayProfiles: [{ containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'] }],
    }),
  );

  assert.ok(decision !== undefined);
  assert.equal(decision.canDirectPlay, true);
  assert.equal(decision.canTranscode, false, 'it named nothing to transcode into, and needs nothing');
  assert.equal(decision.errorReason, undefined, 'nothing went wrong');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the reasons are one per profile, in the order the client sent them', async () => {
  // The specification's shape — "the server should return 1 string per direct
  // play profile" — and the reason for it is that the *position* is the profile:
  // a reader holding a sentence and a list of capabilities has nothing else to
  // correlate the two by. The first version pushed only the refusals, so index
  // *i* stopped being profile *i* as soon as one of them accepted, and it pushed
  // the server's own reason once for however many profiles there were (found by
  // the contract axis).
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-3',
    client({
      directPlayProfiles: [
        // Accepts the file, and is still not handed it: `stream` re-encodes what
        // no browser reads, so the reason that applies to *this* profile is the
        // server's.
        { containers: ['ape'], audioCodecs: ['ape'], protocols: ['http'] },
        // Names a container this file is not in.
        { containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'] },
        // Names the container it *is* in, and a codec it does not hold.
        { containers: ['ape'], audioCodecs: ['mp3'], protocols: ['http'] },
      ],
      transcodingProfiles: [{ container: 'flac', audioCodec: 'flac', protocol: 'http' }],
    }),
  );

  assert.ok(decision !== undefined);
  assert.equal(decision.canDirectPlay, false);
  assert.equal(decision.transcodeReason?.length, 3, 'three profiles, three strings');
  assert.match(String(decision.transcodeReason?.[0]), /ServerReencodesUnplayable/);
  assert.match(String(decision.transcodeReason?.[1]), /ContainerNotSupported/);
  assert.match(String(decision.transcodeReason?.[2]), /AudioCodecNotSupported/);

  // And a client that sent no profiles at all gets nothing to read: there is no
  // profile to explain, and `canDirectPlay: false` is the whole of the answer.
  const silent = await decide(
    db,
    'tr-3',
    client({ directPlayProfiles: [], transcodingProfiles: [{ container: 'flac', audioCodec: 'flac', protocol: 'http' }] }),
  );
  assert.equal(silent?.canDirectPlay, false);
  assert.equal(silent?.transcodeReason, undefined);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('every direct-play profile that refuses the file says why', async () => {
  // The specification: `transcodeReason` is "server specific made for logging
  // purpose", and the server "should return 1 string per direct play profile" —
  // so a client is owed one sentence per profile it sent, not one for the file.
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-1',
    client({
      directPlayProfiles: [
        // HLS is a transport this server does not speak at all.
        { containers: ['flac'], audioCodecs: ['flac'], protocols: ['hls'] },
        // A container this file is not in.
        { containers: ['ogg'], audioCodecs: ['flac'], protocols: ['http'] },
        // A codec this file does not hold.
        { containers: ['flac'], audioCodecs: ['opus'], protocols: ['http'] },
      ],
      transcodingProfiles: [{ container: 'mp3', audioCodec: 'mp3', protocol: 'http' }],
    }),
  );

  assert.ok(decision !== undefined);
  assert.equal(decision.canDirectPlay, false);
  assert.equal(decision.transcodeReason?.length, 3, 'one string per profile, and there were three');
  assert.match(String(decision.transcodeReason?.[0]), /ProtocolNotSupported/);
  assert.match(String(decision.transcodeReason?.[1]), /ContainerNotSupported/);
  assert.match(String(decision.transcodeReason?.[2]), /AudioCodecNotSupported/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a client whose profiles are all hls is told so, not promised a stream', async () => {
  // **The volume decision of task:2896, and the one the operator made in as many
  // words**: this server produces no HLS, `requirements:47` puts `hls` among the
  // stubs, and a profile over a transport that does not exist must be skipped —
  // answering `canTranscode: true` and a `transcodeParams` that leads to an error
  // would be a promise with nothing behind it.
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-3',
    client({
      directPlayProfiles: [{ containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'] }],
      transcodingProfiles: [
        { container: 'flac', audioCodec: 'flac', protocol: 'hls' },
        { container: 'mp4', audioCodec: 'aac', protocol: 'hls' },
      ],
    }),
  );

  assert.ok(decision !== undefined);
  assert.equal(decision.canTranscode, false, 'hls is not produced, so it is not offered');
  assert.equal(decision.transcodeParams, undefined, 'no token, because there is no stream to ask for');
  assert.equal(decision.transcodeStream, undefined);
  assert.match(String(decision.errorReason), /http/, 'and the refusal says what would have worked');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a stream this server can make is offered even where the client named hls first', async () => {
  // The list is a priority list, and the specification says to evaluate it in
  // order — so a client that prefers HLS and can live with mp3 is given mp3
  // rather than a refusal. Only a list with nothing this server makes in it is
  // a refusal.
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-1',
    client({
      directPlayProfiles: [],
      transcodingProfiles: [
        { container: 'flac', audioCodec: 'flac', protocol: 'hls' },
        { container: 'mp3', audioCodec: 'mp3', protocol: 'http' },
      ],
    }),
  );

  assert.ok(decision !== undefined);
  assert.equal(decision.canTranscode, true);
  assert.equal(decision.transcodeStream?.codec, 'mp3');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a file the server will re-encode is not called direct playable, whoever can play it', async () => {
  // **The half of `canDirectPlay` that is about the server.** A client whose
  // profile accepts Monkey's Audio is telling the truth about itself — and
  // `stream` would still re-encode this file, because no browser reads ape. A
  // `canDirectPlay: true` a client acts on by asking for the song would then be
  // answered with a different format from the one it was promised (task:2896).
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-3',
    client({
      directPlayProfiles: [{ containers: ['ape'], audioCodecs: ['ape'], protocols: ['http'] }],
      transcodingProfiles: [{ container: 'flac', audioCodec: 'flac', protocol: 'http' }],
    }),
  );

  assert.ok(decision !== undefined);
  assert.equal(decision.canDirectPlay, false);
  assert.match(String(decision.transcodeReason?.[0]), /ServerReencodesUnplayable/);
  assert.equal(decision.canTranscode, true);
  // A lossless file re-encoded losslessly: the client asked for flac and gets it.
  assert.equal(decision.transcodeStream?.container, 'flac');
  // No ceiling was named and FLAC has none, so none is reported.
  assert.equal(decision.transcodeStream?.audioBitrate, undefined);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a stretch of an image is playable where its frames are the image\'s own', async () => {
  // A cue track of a FLAC image is cut out by hand — the frames are restated,
  // nothing is decoded — so it is direct playable like any other FLAC.
  const { db, root } = collection();

  const cut = await decide(db, 'tr-4', client(PLAYS_FLAC));

  assert.ok(cut !== undefined);
  assert.equal(cut.canDirectPlay, true, 'a FLAC stretch is FLAC');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a stretch only ffmpeg can cut is refused to the client that could play it', async () => {
  // The same track of an image whose frames cannot be restated. The client here
  // *can* decode what is inside — AAC in an MP4 — and is still not handed the
  // track, because the only way this server produces it is by decoding and
  // writing it again. That is the server's half of `canDirectPlay`, and it is
  // asked of `stream`'s own predicate rather than of a second opinion about
  // segments.
  const { db, root } = collection();

  const boxed = await decide(
    db,
    'tr-5',
    client({
      directPlayProfiles: [{ containers: ['mp4'], audioCodecs: ['aac'], protocols: ['http'] }],
      transcodingProfiles: [{ container: 'mp3', audioCodec: 'mp3', protocol: 'http' }],
    }),
  );

  assert.ok(boxed !== undefined);
  assert.equal(boxed.canDirectPlay, false);
  assert.match(String(boxed.transcodeReason?.[0]), /ServerReencodesSegmentOf: mp4/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- the client's own limits ------------------------------------------------

test('a required limitation the file breaches blocks direct play, an optional one does not', async () => {
  // "Whether this limitation **must** be met" — and a limitation that must not
  // be met is not a condition at all. It is the only reading under which the
  // field does anything.
  const { db, root } = collection();

  const profiles = (required: boolean): Record<string, unknown> => ({
    directPlayProfiles: [{ containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'] }],
    transcodingProfiles: [{ container: 'mp3', audioCodec: 'mp3', protocol: 'http' }],
    codecProfiles: [
      {
        type: 'AudioCodec',
        name: 'flac',
        limitations: [
          { name: 'audioSamplerate', comparison: 'LessThanEqual', values: ['40000'], required },
        ],
      },
    ],
  });

  const blocked = await decide(db, 'tr-1', client(profiles(true)));
  const allowed = await decide(db, 'tr-1', client(profiles(false)));

  assert.ok(blocked !== undefined && allowed !== undefined);
  assert.equal(blocked.canDirectPlay, false, '44100 is over a required ceiling of 40000');
  assert.match(String(blocked.transcodeReason?.[0]), /LimitationNotMet: audioSamplerate/);
  assert.equal(allowed.canDirectPlay, true, 'the same breach, not required');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a limitation nothing measured is not a breach', async () => {
  // The measured shape of this collection: `bitrate` is null for 3005 files of
  // 3173 and `sample_rate`/`channels` for 2153. Calling every one of those unfit
  // for direct play would answer "you must transcode" about two files in three,
  // to a phone on a battery — a bigger lie than the one it avoids, and about
  // music that needs nothing done to it.
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-1',
    client({
      directPlayProfiles: [{ containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'] }],
      transcodingProfiles: [{ container: 'mp3', audioCodec: 'mp3', protocol: 'http' }],
      codecProfiles: [
        {
          type: 'AudioCodec',
          name: 'flac',
          limitations: [
            // Read by nothing in this server, so it cannot be shown to fail.
            { name: 'audioBitdepth', comparison: 'LessThanEqual', values: ['16'], required: true },
          ],
        },
      ],
    }),
  );

  assert.ok(decision !== undefined);
  assert.equal(decision.canDirectPlay, true);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a file above the bitrate the client can handle is not direct played', async () => {
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-1',
    client({ ...PLAYS_FLAC, maxAudioBitrate: 320_000 }),
  );

  assert.ok(decision !== undefined);
  assert.equal(decision.canDirectPlay, false, 'a 900 kbps file against a 320 kbps client');
  assert.match(String(decision.transcodeReason?.[0]), /AudioBitrateNotSupported/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a bitrate nothing measured is worked out from the file itself', async () => {
  // The fallback, and the reason there is one: `audioBitrate` is what a client
  // on a slow link is really asking about, and this collection's probe has a
  // reading for one file in six. Size and length are the two things the scan
  // always has, and their quotient is an average — which is all it claims to be.
  const { db, root } = collection();

  const whole = await decide(db, 'tr-9', client(PLAYS_FLAC));

  assert.ok(whole !== undefined);
  assert.equal(whole.sourceStream.audioBitrate, 133_333, 'a megabyte over a minute');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue track has no bitrate, because its size is the disc\'s', async () => {
  // The row of a cue track carries the *image's* size beside the track's own
  // length, and the image's reading is not taken either here. Dividing one by
  // the other would give a disc's bytes over a track's seconds — a number
  // inflated by the number of tracks on the record — so where nothing measured
  // the image, the track is given no number at all rather than a wrong one.
  const { db, root } = collection();
  db.prepare('UPDATE audio_probe SET bitrate = NULL WHERE file_id = 104').run();

  const cut = await decide(db, 'tr-4', client(PLAYS_FLAC));

  assert.ok(cut !== undefined);
  assert.equal(cut.sourceStream.audioBitrate, undefined);
  assert.equal(cut.sourceStream.audioSamplerate, 44100, 'the rest of the reading is still the image\'s');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- the request itself -----------------------------------------------------

test('a decision needs the client\'s capabilities, and says so when they are absent', async () => {
  const { db, root } = collection();

  const nothing = await ask(db, 'getTranscodeDecision?mediaId=tr-1&mediaType=song&f=json', {
    method: 'POST',
  });
  const junk = await ask(db, 'getTranscodeDecision?mediaId=tr-1&mediaType=song&f=json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json at all',
  });

  assert.equal(nothing.status, 200);
  assert.equal(served(nothing.body)['subsonic-response'].error?.code, 10, 'a missing parameter');
  assert.match(String(served(junk.body)['subsonic-response'].error?.message), /not JSON/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('mediaType is required, and this server has only one of its two values', async () => {
  const { db, root } = collection();

  const missing = await ask(db, 'getTranscodeDecision?mediaId=tr-1&f=json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(client(PLAYS_FLAC)),
  });
  const podcast = await ask(db, 'getTranscodeDecision?mediaId=tr-1&mediaType=podcast&f=json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(client(PLAYS_FLAC)),
  });

  assert.equal(served(missing.body)['subsonic-response'].error?.code, 10);
  assert.equal(served(podcast.body)['subsonic-response'].error?.code, 70, 'no such media');
  assert.match(String(served(podcast.body)['subsonic-response'].error?.message), /podcast/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a file whose codec nothing can read is refused rather than described by its container', async () => {
  // `StreamDetails.codec` is `Req. Yes`, and this is the one case where that
  // cannot be honoured. Answering with the container's name is exactly the
  // defect migration 015 was written to undo — `codec` filled with `mp4` for two
  // thousand files, every one a wrong answer that looked like a right one.
  const { db, root } = collection();

  const answer = await ask(db, 'getTranscodeDecision?mediaId=tr-6&mediaType=song&f=json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(client(PLAYS_FLAC)),
  });

  const body = served(answer.body)['subsonic-response'];
  assert.equal(body.status, 'failed');
  assert.equal(body.transcodeDecision, undefined, 'no decision is better than one made up');
  assert.match(String(body.error?.message), /could not read the audio/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- the stream, which has to be the one that was promised ------------------

/**
 * One decision, and the answer it names planted in the cache.
 *
 * The name is derived by `keyOf` from what was asked for — the source, the
 * stretch and `made` — so a server that works the question out the same way
 * finds the file, and one that works it out differently misses and reaches for
 * an ffmpeg that is not installed. That miss is the assertion.
 */
async function planted(
  db: Db,
  cache: string,
  id: string,
  capabilities: Record<string, unknown>,
  source: string,
  made: string,
  extension: string,
  answer: Buffer,
  stretch: { startMs: number; endMs: number } | null = null,
): Promise<{ token: string; decision: Decision }> {
  const decided = await decide(db, id, client(capabilities));
  assert.ok(decided?.transcodeParams, 'a token to plant an answer for');
  const named = keyOf({ source, ...(stretch ?? {}), made });
  writeFileSync(join(cache, `${named}.${extension}`), answer);
  return { token: decided.transcodeParams, decision: decided };
}

test('the stream a decision promised is the stream that is produced', async () => {
  // **The seam this extension is**: two calls that must not disagree about what
  // was decided. The client asks what to do, and later asks for it — and the
  // only thing carried between them is `transcodeParams`. If the second call
  // worked the question out differently, the answer planted here is missed and
  // the server reaches for an ffmpeg that is not installed.
  const cache = tempRoot('funoteka-decision-cache-');
  try {
    const { db, root } = collection();
    const answer = Buffer.from('what a 128 kbps mp3 of this song would be');
    const { token } = await planted(
      db,
      cache,
      'tr-1',
      { ...PLAYS_FLAC, maxTranscodingAudioBitrate: 128_000 },
      join(root, 'Album', 'lossless.flac'),
      'mp3:128:none',
      'mp3',
      answer,
    );

    const stream = await ask(
      db,
      `getTranscodeStream?mediaId=tr-1&mediaType=song&transcodeParams=${token}`,
      {},
      { cacheDir: cache },
    );

    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(stream.body, answer);

    rmSync(root, { recursive: true, force: true });
    db.close();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('a channel cap the client named reaches the answer', async () => {
  // The one thing this extension carries that a `stream` query string cannot.
  // Six channels against a client that decodes two is a different stream from
  // the same song uncapped, and it has a different name in the cache.
  const cache = tempRoot('funoteka-decision-cache-');
  try {
    const { db, root } = collection();
    const answer = Buffer.from('six channels of FLAC, folded down to two');
    const { token, decision } = await planted(
      db,
      cache,
      'tr-8',
      {
        directPlayProfiles: [
          { containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'], maxAudioChannels: 2 },
        ],
        transcodingProfiles: [
          { container: 'mp3', audioCodec: 'mp3', protocol: 'http', maxAudioChannels: 2 },
        ],
        maxTranscodingAudioBitrate: 128_000,
      },
      join(root, 'Album', 'six.flac'),
      'mp3:128:2',
      'mp3',
      answer,
    );

    assert.equal(decision.canDirectPlay, false, 'six channels against a client that decodes two');
    assert.equal(decision.transcodeStream?.audioChannels, 2, 'and the answer says what it will be');

    const stream = await ask(
      db,
      `getTranscodeStream?mediaId=tr-8&mediaType=song&transcodeParams=${token}`,
      {},
      { cacheDir: cache },
    );
    assert.deepEqual(stream.body, answer);

    rmSync(root, { recursive: true, force: true });
    db.close();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('a cap the decision promised is not bypassed by the file already being that format', async () => {
  // **The finding of the standards axis, end to end.** A six-channel FLAC and a
  // client that decodes two: the decision folds it down and says so. But the
  // shortcut in `serveSong` — "the file already is what was asked for" — asked
  // only about the container and the codec, so the token led straight back to
  // the six channels on disk. The answer for the *capped* question is planted
  // under its own name here, and the file itself is the other candidate: which
  // one comes back is the whole of the test.
  const cache = tempRoot('funoteka-decision-cache-');
  try {
    const { db, root } = collection();
    const answer = Buffer.from('six channels of FLAC, folded down to two');
    const { token, decision } = await planted(
      db,
      cache,
      'tr-8',
      {
        directPlayProfiles: [
          { containers: ['flac'], audioCodecs: ['flac'], protocols: ['http'], maxAudioChannels: 2 },
        ],
        transcodingProfiles: [
          { container: 'flac', audioCodec: 'flac', protocol: 'http', maxAudioChannels: 2 },
        ],
      },
      join(root, 'Album', 'six.flac'),
      'flac:none:2',
      'flac',
      answer,
    );

    assert.equal(decision.canDirectPlay, false, 'six channels against a client that decodes two');
    assert.equal(decision.transcodeStream?.audioChannels, 2);

    const stream = await ask(
      db,
      `getTranscodeStream?mediaId=tr-8&mediaType=song&transcodeParams=${token}`,
      {},
      { cacheDir: cache },
    );

    assert.deepEqual(stream.body, answer, 'the folded-down answer, not the six channels on disk');

    rmSync(root, { recursive: true, force: true });
    db.close();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('a channel cap no recording can reach is dropped, so the token stays readable', async () => {
  // **Also the standards axis.** The writer passed the client's cap on unclamped
  // while the reader refused anything at or above its own bound — so a client
  // naming 33 channels was issued a token its own server then rejected, with
  // "ask getTranscodeDecision for one" as the advice, which hands back the same
  // token. A cap nothing can reach is not a cap, exactly as a ceiling beyond any
  // stream is not a ceiling; the two ends of the token now hold the same bound.
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-8',
    client({
      directPlayProfiles: [],
      transcodingProfiles: [
        { container: 'mp3', audioCodec: 'mp3', protocol: 'http', maxAudioChannels: 33 },
      ],
    }),
  );

  assert.ok(decision?.transcodeParams);
  assert.equal(decision.transcodeStream?.audioChannels, 6, 'dropped, not clamped to the bound');

  const answer = await ask(
    db,
    `getTranscodeStream?mediaId=tr-8&mediaType=song&transcodeParams=${decision.transcodeParams}&f=json`,
  );
  const message = String(served(answer.body)['subsonic-response'].error?.message ?? '');
  assert.doesNotMatch(
    message,
    /not one this server issued/,
    'a token this server issued has to be one it reads',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cap no measurement can justify is not passed, and nothing is invented', async () => {
  // **Measured live, on the operator's own Symfonium.** A stereo mp3 whose
  // channel count nobody had measured, against a profile saying "no more than
  // six", came out as **5.1** — four channels invented. `-ac 6` is not a ceiling
  // to ffmpeg, it is a number of channels to *produce*, so an unjustified cap
  // does not obey the client, it obeys a number the client never asked for.
  // (The bytes are the same either way — 52 MB against 51 — because a FLAC of a
  // decoded mp3 is that size; what the cap cost was the audio.)
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-10',
    client({
      directPlayProfiles: [],
      transcodingProfiles: [
        { container: 'flac', audioCodec: 'flac', protocol: 'http', maxAudioChannels: 6 },
      ],
    }),
  );

  assert.ok(decision?.transcodeParams);
  assert.equal(
    decision.transcodeStream?.audioChannels,
    undefined,
    'nothing is promised about a count nobody measured',
  );
  const token = JSON.parse(
    Buffer.from(decision.transcodeParams, 'base64url').toString('utf8'),
  ) as number[];
  assert.equal(token[4], 0, 'and the token carries no cap for ffmpeg to obey');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a file the cap does not change is served as itself', async () => {
  // The other half of treating the cap as a limit rather than a target: an mp3
  // asked for as mp3 by a client that capped the channels is the file, sent as
  // it is. Nothing is decoded, no channels are invented, and no second entry
  // appears in the cache under a name that means the same bytes.
  const { db, root } = collection();

  const decision = await decide(
    db,
    'tr-10',
    client({
      directPlayProfiles: [],
      transcodingProfiles: [
        { container: 'mp3', audioCodec: 'mp3', protocol: 'http', maxAudioChannels: 2 },
      ],
    }),
  );
  assert.ok(decision?.transcodeParams);

  const stream = await ask(
    db,
    `getTranscodeStream?mediaId=tr-10&mediaType=song&transcodeParams=${decision.transcodeParams}`,
  );

  assert.equal(stream.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(stream.body, MP3, 'the file itself — a transcode would have failed here');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an offset is an offset into the track, and the answer is the track moved', async () => {
  // `offset` is this extension's own spelling of `stream`'s `timeOffset`, and it
  // means the same thing: the near end of the stretch moves, the far one does
  // not. Proved the way the stream suite proves it — the answer for the moved
  // stretch is planted, and only a server that worked out the same stretch finds
  // it.
  const cache = tempRoot('funoteka-decision-cache-');
  try {
    const { db, root } = collection();
    const answer = Buffer.from('the last second and a half of track four');
    const { token } = await planted(
      db,
      cache,
      'tr-4',
      { ...PLAYS_FLAC, maxTranscodingAudioBitrate: 128_000 },
      join(root, 'Album', 'image.flac'),
      'mp3:128:none',
      'mp3',
      answer,
      // The track is 1000–3000 ms of the image, and half a second in moves its
      // near end to 1500 and leaves the far one where it was.
      { startMs: 1500, endMs: 3000 },
    );

    const stream = await ask(
      db,
      `getTranscodeStream?mediaId=tr-4&mediaType=song&offset=0.5&transcodeParams=${token}`,
      {},
      { cacheDir: cache },
    );

    assert.deepEqual(stream.body, answer, 'the token named the track, the offset moved it');

    rmSync(root, { recursive: true, force: true });
    db.close();
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('a token issued for one song is refused for another', async () => {
  // `getTranscodeStream` is given the `mediaId` as well as the token, and the two
  // disagreeing has to be a refusal: a client that mixed up two tokens would
  // otherwise be sent one song in another song's place, with nothing on the wire
  // to say so.
  const { db, root } = collection();

  const decision = await decide(db, 'tr-1', client(PLAYS_FLAC));
  assert.ok(decision?.transcodeParams);

  const answer = await ask(
    db,
    `getTranscodeStream?mediaId=tr-2&mediaType=song&transcodeParams=${decision.transcodeParams}&f=json`,
  );

  assert.equal(served(answer.body)['subsonic-response'].status, 'failed');
  assert.match(String(served(answer.body)['subsonic-response'].error?.message), /another song/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a token this server did not issue is refused, whatever it names', async () => {
  // The token is not signed, and it does not have to be — see `transcode.ts`.
  // What stands in a signature's place is that every field is parsed strictly
  // against what this server would have issued, so the test of that is a token
  // naming something nothing here makes.
  const { db, root } = collection();

  const forged = Buffer.from(JSON.stringify([1, 1, 'exe', 0, 0]), 'utf8').toString('base64url');
  const version = Buffer.from(JSON.stringify([99, 1, 'mp3', 0, 0]), 'utf8').toString('base64url');
  const junk = 'not a token at all';

  for (const [token, why] of [
    [forged, /makes no exe/],
    [version, /version 99/],
    [junk, /not readable/],
  ] as [string, RegExp][]) {
    const answer = await ask(
      db,
      `getTranscodeStream?mediaId=tr-1&mediaType=song&transcodeParams=${token}&f=json`,
    );
    assert.equal(served(answer.body)['subsonic-response'].status, 'failed', `${token}: refused`);
    assert.match(String(served(answer.body)['subsonic-response'].error?.message), why);
  }

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a refusal of getTranscodeStream is an HTTP status, not a 200', async () => {
  // Its own page says so outright — "In case of an error, a standard HTTP error
  // code is returned with a descriptive message" — and the OpenAPI document
  // declares 400, 401, 404 and 500 for it. Every one of those refusals came
  // back a 200 like the rest of the surface, so a client that branches on the
  // status line read "this token is not one this server issued" as success and
  // would go on to play the XML envelope as audio (task:2913).
  const { db, root } = collection();

  const noSong = await ask(db, 'getTranscodeStream?mediaId=tr-999&mediaType=song&transcodeParams=nope&f=json');
  assert.equal(noSong.status, 404, 'an id that names no song');

  const noToken = await ask(db, 'getTranscodeStream?mediaId=tr-1&mediaType=song&f=json');
  assert.equal(noToken.status, 400, 'the parameter the decision was supposed to carry');

  const junk = await ask(db, 'getTranscodeStream?mediaId=tr-1&mediaType=song&transcodeParams=nope&f=json');
  assert.equal(junk.status, 500, 'a token this server never issued');

  const noCreds = await ask(
    db,
    'getTranscodeStream?mediaId=tr-1&mediaType=song&transcodeParams=nope&f=json',
    {},
    { password: 'not-sesame' },
  );
  assert.equal(noCreds.status, 401, 'credentials are a status of their own, not a generic fault');

  // The body is still the envelope, so the reason is not lost to the status
  // line — the code and the message are what a client reads either way.
  const envelope = JSON.parse(junk.body.toString())['subsonic-response'];
  assert.equal(envelope.status, 'failed');
  assert.match(envelope.error.message, /transcodeParams is not one this server issued/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('every other route still answers its refusals in the body', async () => {
  // Making this one method differ must not make the rest differ with it. The
  // convention is the project's and the operator has seen it and kept it: a
  // Subsonic client reads `status` out of the body, and a byte route that also
  // varied its status line would be two ways to be told the same thing.
  const { db, root } = collection();

  const bytes = await ask(db, 'stream?id=tr-999&f=json');
  assert.equal(bytes.status, 200, 'a byte route refuses the way it always has');
  assert.equal(JSON.parse(bytes.body.toString())['subsonic-response'].status, 'failed');

  const json = await ask(db, 'getSong?id=tr-999&f=json');
  assert.equal(json.status, 200, 'and so does every other route');

  rmSync(root, { recursive: true, force: true });
  db.close();
});
