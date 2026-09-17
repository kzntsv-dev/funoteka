import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../src/db/index.ts';
import { PROBE_METHOD, type Probe } from '../src/probe/ffprobe.ts';
import { scan } from '../src/scan/scan.ts';
import { classify } from '../src/classify/classify.ts';
import { applyTags } from '../src/tags/apply.ts';
import { TAGS_METHOD } from '../src/tags/read.ts';
import { cp1251, flac, id3v1, id3v2, mp4, mpeg, ogg } from './helpers/bytes.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * A stream the frame walk loses almost immediately — the shape of the real
 * `02. 218 Tracks.mp3`, which walked 412 KB of 3.98 MB and returned 17 seconds
 * against a true 165.
 */
function lostStream(): Buffer {
  return Buffer.concat([
    mpeg({ frames: 200, sampleRate: 48000, bitrateKbps: 128 }),
    Buffer.alloc(100_000),
  ]);
}

function probeSays(overrides: Partial<Probe> = {}): Probe {
  return {
    durationMs: 165_000,
    codec: 'mp3',
    sampleRate: 48000,
    channels: 2,
    bitrate: 128_000,
    ok: true,
    err: null,
    ...overrides,
  };
}

type Db = ReturnType<typeof openDb>;

function fixture(tree: Record<string, Buffer>): string {
  const root = tempRoot('funoteka-tags-');
  for (const [rel, bytes] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, bytes);
  }
  return root;
}

/** A `readBytes` that records which files were opened, so re-reads are visible. */
function countingReads(): { readBytes: (absPath: string) => Uint8Array; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    readBytes: (absPath: string) => {
      paths.push(absPath);
      return readFileSync(absPath);
    },
  };
}

// Rows come back as null-prototype objects, which `deepStrictEqual` holds
// against a plain literal — so every read crosses back through a real object
// before being compared.
function tagsOf(db: Db): { name: string; value: string; position: number }[] {
  const rows = db
    .prepare('SELECT name, value, position FROM file_tag ORDER BY name, position')
    .all() as { name: string; value: string; position: number }[];
  return rows.map((row) => ({ name: row.name, value: row.value, position: row.position }));
}

test('a FLAC is read to the end of its metadata chain, not to the end of the file', () => {
  // Measured on this collection before this: its twenty largest FLACs come to
  // 9.7 GB together, and reading them whole took 16.7 seconds against 7
  // milliseconds for the metadata chain alone — 1.4 MB read instead of 9706. A
  // FLAC states where its chain ends and its reader stops at that flag, so what
  // follows the chain is bytes nothing here will look at.
  //
  // The fixture keeps two megabytes of "audio" behind the chain, so the saving
  // under test is a saving of size rather than merely of how the bytes arrived.
  const chain = flac({ tags: { ARTIST: 'Кино', ALBUM: 'A record', TITLE: 'A song' } });
  const root = fixture({ 'A/a.flac': Buffer.concat([chain, Buffer.alloc(2_000_000, 7)]) });

  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);

  const asked: { at: number; length: number }[] = [];
  const readRange = (absPath: string, at: number, length: number): Uint8Array => {
    asked.push({ at, length });
    const all = readFileSync(absPath);
    return all.subarray(at, at + length);
  };

  try {
    applyTags(db, { readRange, probe: () => probeSays({ codec: 'flac' }) });

    assert.ok(asked.length > 0, 'the chain is walked rather than the file read whole');
    const widest = Math.max(...asked.map((one) => one.length));
    assert.equal(widest, chain.length, 'the widest window is exactly the metadata chain');
    assert.ok(
      widest < chain.length + 2_000_000,
      'and the audio behind it was never asked for',
    );
    assert.ok(
      tagsOf(db).some((tag) => tag.name === 'artist' && tag.value === 'Кино'),
      'and the tags are the ones the chain holds',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function issuesOf(db: Db, kind: string): { severity: string; rel_path: string; detail: string }[] {
  const rows = db
    .prepare('SELECT severity, rel_path, detail FROM issue WHERE kind = ? ORDER BY id')
    .all(kind) as { severity: string; rel_path: string; detail: string }[];
  return rows.map((row) => ({
    severity: row.severity,
    rel_path: row.rel_path,
    detail: row.detail,
  }));
}

test('tags reach the meta layer, one row per value', () => {
  const root = fixture({
    'Album/01.flac': flac({ tags: { TITLE: 'Green Desert', ARTIST: 'Tangerine Dream' } }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  const counters = applyTags(db);

  assert.deepEqual(tagsOf(db), [
    { name: 'artist', value: 'Tangerine Dream', position: 0 },
    { name: 'title', value: 'Green Desert', position: 0 },
  ]);
  assert.equal(counters.files, 1);
  assert.equal(counters.tags, 2);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a repeated name keeps every value, numbered', () => {
  // Two ARTIST lines are one collaboration, not one artist written twice.
  const root = fixture({
    'Album/01.flac': flac({ tags: { ARTIST: ['Cock E.S.P.', 'Thirdorgan'] } }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  applyTags(db);

  assert.deepEqual(tagsOf(db), [
    { name: 'artist', value: 'Cock E.S.P.', position: 0 },
    { name: 'artist', value: 'Thirdorgan', position: 1 },
  ]);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('mp3 tags arrive the same way, through the same stage', () => {
  const root = fixture({
    'Album/01.mp3': id3v2([
      { id: 'TIT2', encoding: 3, text: Buffer.from('Green Desert', 'utf8') },
      { id: 'TPE1', encoding: 3, text: Buffer.from('Tangerine Dream', 'utf8') },
    ]),
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  applyTags(db);

  assert.deepEqual(tagsOf(db), [
    { name: 'artist', value: 'Tangerine Dream', position: 0 },
    { name: 'title', value: 'Green Desert', position: 0 },
  ]);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a file whose bytes have not moved is not read again', () => {
  const root = fixture({ 'Album/01.flac': flac({ tags: { TITLE: 'Green Desert' } }) });
  const db = openDb(':memory:');

  scan(db, [root]);
  applyTags(db);

  // The second scan is what settles the ledger: it compares the files against
  // the previous observation and finds nothing moved.
  const second = countingReads();
  scan(db, [root]);
  const counters = applyTags(db, { readBytes: second.readBytes });

  assert.deepEqual(second.paths, [], 'an unchanged file must not be opened again');
  assert.equal(counters.files, 0);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a file with no tags is still not read again, though it wrote no rows', () => {
  // The case a ledger alone cannot express: read, and found nothing. Without a
  // stamp of its own, this file is opened on every scan forever while never
  // producing a row to show for it — and untagged rips are ordinary.
  const root = fixture({ 'Album/01.flac': flac() });
  const db = openDb(':memory:');

  scan(db, [root]);
  const first = applyTags(db);
  assert.equal(first.files, 1, 'the first pass reads it');
  assert.equal(first.tags, 0);

  const second = countingReads();
  scan(db, [root]);
  const counters = applyTags(db, { readBytes: second.readBytes });

  assert.deepEqual(second.paths, []);
  assert.equal(counters.files, 0);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a file that moved is read again, and its old tags do not linger', () => {
  const root = fixture({ 'Album/01.flac': flac({ tags: { TITLE: 'First' } }) });
  const db = openDb(':memory:');

  scan(db, [root]);
  applyTags(db);
  assert.deepEqual(tagsOf(db), [{ name: 'title', value: 'First', position: 0 }]);

  // Rewritten on disk, and longer than before, so the ledger sees it move.
  writeFileSync(join(root, 'Album/01.flac'), flac({ tags: { TITLE: 'Second Name' } }));

  scan(db, [root]);
  applyTags(db);

  // Re-derived, not appended to: a tag removed from the file has to leave.
  assert.deepEqual(tagsOf(db), [{ name: 'title', value: 'Second Name', position: 0 }]);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('an inferred tag encoding is stored on the file and reported as information', () => {
  const root = fixture({
    'Album/01.flac': flac({
      rawComments: [Buffer.concat([Buffer.from('ARTIST=', 'latin1'), cp1251('Аквариум')])],
    }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  const counters = applyTags(db);

  const file = db.prepare('SELECT encoding, encoding_confidence FROM file').get() as {
    encoding: string | null;
    encoding_confidence: number | null;
  };
  assert.equal(file.encoding, 'windows-1251');
  assert.ok((file.encoding_confidence ?? 1) < 1);
  assert.equal(counters.encodings, 1);

  // A long Cyrillic run is a well-founded inference, so it is information
  // rather than a warning — the same threshold the cue stage uses.
  const issues = issuesOf(db, 'tag-encoding-guessed');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'info');
  assert.equal(issues[0]?.rel_path, 'Album/01.flac');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a clean tag is stored as certain and says nothing', () => {
  const root = fixture({ 'Album/01.flac': flac({ tags: { TITLE: 'Green Desert' } }) });
  const db = openDb(':memory:');
  scan(db, [root]);

  const counters = applyTags(db);

  const file = db.prepare('SELECT encoding, encoding_confidence FROM file').get() as {
    encoding: string | null;
    encoding_confidence: number | null;
  };
  assert.equal(file.encoding, 'utf-8');
  assert.equal(file.encoding_confidence, 1);
  assert.equal(counters.encodings, 0);
  assert.deepEqual(issuesOf(db, 'tag-encoding-guessed'), []);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("a FLAC's own duration reaches the probe table, without a process", () => {
  // 2_100_000 samples at 44100 Hz is 47.619 seconds — the same number the
  // parser test pins, arriving here by a different road.
  const root = fixture({
    'Album/01.flac': flac({ sampleRate: 44100, totalSamples: 2_100_000 }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  const counters = applyTags(db);

  const probe = db.prepare('SELECT duration_ms, codec, probe_ok FROM audio_probe').get() as {
    duration_ms: number;
    codec: string | null;
    probe_ok: number;
  };
  assert.equal(probe.duration_ms, 47_619);
  assert.equal(probe.probe_ok, 1);
  assert.equal(probe.codec, 'flac');
  assert.equal(counters.durations, 1);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a duration already measured by ffprobe is not overwritten by the header', () => {
  // Both are true, and while the file is the one the stored answer was measured
  // from, the probe's is the one the cue stage already trusts — quietly
  // replacing it would make a stored answer depend on stage order. The second
  // walk is what makes that the case: a file the ledger reports as unmoved *is*
  // the file the row describes, so the header has nothing to correct.
  const root = fixture({ 'Album/01.flac': flac({ sampleRate: 44100, totalSamples: 441_000 }) });
  const db = openDb(':memory:');
  scan(db, [root]);
  // Seen twice, and found exactly as it was left: `changed = 0`.
  scan(db, [root]);

  const fileId = (db.prepare('SELECT id FROM file').get() as { id: number }).id;
  db.prepare(
    `INSERT INTO audio_probe (file_id, duration_ms, codec, sample_rate, channels, bitrate, probe_ok, probe_err, probe_method)
     VALUES (?, ?, 'flac', 44100, 2, 900000, 1, NULL, ?)`,
  ).run(fileId, 9_999, PROBE_METHOD);

  applyTags(db);

  const probe = db.prepare('SELECT duration_ms FROM audio_probe').get() as { duration_ms: number };
  assert.equal(probe.duration_ms, 9_999);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a reading taken by an older method is taken again', () => {
  // The repair, and the reason `probe_method` exists: a row is an answer about a
  // file *as read by a particular method*, and nothing in the row used to say
  // which one. So a change of method left readings behind that were no longer
  // readings — this collection's `codec` column held `mp4` and `id3v2`, the
  // container's name where a codec belongs, for two thousand files — and the
  // only way back is to read those files again.
  //
  // The mp4 fixture is the case that matters: its container says nothing about
  // the codec inside (AAC and ALAC share it), so the honest answer is no answer.
  const root = fixture({ 'Album/01.m4a': mp4() });
  const db = openDb(':memory:');
  scan(db, [root]);
  // Seen twice and found as it was left, so the ledger is not what brings it in.
  scan(db, [root]);

  const fileId = (db.prepare('SELECT id FROM file').get() as { id: number }).id;
  db.prepare(
    `INSERT INTO audio_probe (file_id, duration_ms, codec, sample_rate, channels, bitrate, probe_ok, probe_err, probe_method)
     VALUES (?, 4000, 'mp4', 44100, 2, 900000, 1, NULL, 0)`,
  ).run(fileId);

  const counters = applyTags(db);

  const probe = db.prepare('SELECT codec, probe_method FROM audio_probe').get() as {
    codec: string | null;
    probe_method: number;
  };
  assert.equal(counters.files, 1, 'the row’s method is a reason to read the file again');
  assert.equal(probe.probe_method, PROBE_METHOD);
  assert.equal(probe.codec, null, 'and the container’s name is not a codec');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a file whose tags were read by an older reader is read again', () => {
  // The same repair as the probe's, one column over, and it is not hypothetical:
  // this is what the Ogg reader landed into. An `.ogg` was read by a reader that
  // did not know the format, so its verdict was "nothing recognised"; the file
  // has not moved since, so the ledger has no reason to bring it back — and the
  // corrected reader would never have reached a single one of the collection's
  // eighty `.ogg` files.
  const root = fixture({
    'PolnaLyubvi/2018-08-27  V/01.ogg': ogg({ tags: { ARTIST: 'PolnaLyubvi', TITLE: 'V' } }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  // Seen twice and found as it was left, so the ledger is not what brings it in.
  scan(db, [root]);

  // An older reading of the same file: recognised nothing and stated no reason.
  db.prepare('UPDATE file SET tags_container = NULL, tags_method = 0').run();

  const counters = applyTags(db);

  const file = db.prepare('SELECT tags_container, tags_method FROM file').get() as {
    tags_container: string | null;
    tags_method: number;
  };
  assert.equal(counters.files, 1, 'the reading’s number is a reason to read the file again');
  assert.equal(file.tags_container, 'ogg', 'and the corrected reader is what reads it');
  assert.equal(file.tags_method, TAGS_METHOD);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('an Ogg file’s tags and duration reach the meta layer', () => {
  // The whole point of the reader, and the only place the stage and it are wired
  // together: three things come out of one pass — the names, the length, and the
  // codec the stream names itself, which is what the delivery layer reads to
  // decide a file plays as it stands rather than being re-encoded.
  const root = fixture({
    'PolnaLyubvi/2018-08-27  V/01. PolnaLyubvi - V.ogg': ogg({
      sampleRate: 44100,
      granule: 44100 * 155,
      tags: { ARTIST: 'PolnaLyubvi', ALBUM: 'V', TITLE: 'Не покидай меня' },
    }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  const counters = applyTags(db);

  const probe = db.prepare('SELECT duration_ms, codec, sample_rate, channels FROM audio_probe').get() as {
    duration_ms: number;
    codec: string;
    sample_rate: number;
    channels: number;
  };
  assert.equal(probe.duration_ms, 155_000);
  assert.equal(probe.codec, 'vorbis');
  assert.equal(probe.sample_rate, 44100);
  assert.equal(probe.channels, 2);
  assert.equal(counters.durations, 1);
  assert.equal(counters.probed, 0, 'nothing here needs a decoder');

  assert.deepEqual(tagsOf(db), [
    { name: 'album', value: 'V', position: 0 },
    { name: 'artist', value: 'PolnaLyubvi', position: 0 },
    { name: 'title', value: 'Не покидай меня', position: 0 },
  ]);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a fresh container duration displaces a stale probe once the file is replaced', () => {
  // `probe_ok = 1` means "succeeded once", not "true now". A file the reader
  // could not measure took ffprobe's number; when the file was replaced by one
  // the reader *can* measure, that fresh answer was dropped on the floor — the
  // seed only ever filled a row whose probe had failed — and the run after that
  // had nothing left to notice with, because a file the walk finds unmoved is
  // not read at all. So a wrong length survived the replacement forever.
  const root = fixture({ 'Album/01.mp3': lostStream() });
  const db = openDb(':memory:');

  scan(db, [root]);
  applyTags(db, { probe: () => probeSays() });

  const first = db.prepare('SELECT duration_ms, duration_source FROM audio_probe').get() as {
    duration_ms: number;
    duration_source: string;
  };
  assert.equal(first.duration_ms, 165_000);
  assert.equal(first.duration_source, 'ffprobe');

  // The same path, now holding bytes whose length the reader states outright.
  writeFileSync(
    join(root, 'Album/01.mp3'),
    mpeg({ frames: 200, sampleRate: 48_000, bitrateKbps: 128 }),
  );
  scan(db, [root]);
  applyTags(db, { probe: () => probeSays() });

  const second = db.prepare('SELECT duration_ms, duration_source FROM audio_probe').get() as {
    duration_ms: number;
    duration_source: string;
  };
  assert.notEqual(second.duration_ms, 165_000, 'the stored length describes bytes that are gone');
  assert.equal(second.duration_source, 'container');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a video renamed .m4a is not reported as a format nothing could read', () => {
  // The reader recognised the file — it walked its boxes and found a picture
  // track — so `tag-format-unknown`, "a format the reader does not recognise: no
  // tags, no duration", was the dump being told the wrong thing about a file
  // whose text it had just declined to read. A video misclassified as audio is a
  // finding, but it is not this one.
  const root = fixture({ 'Album/clip.m4a': mp4({ tracks: ['vide'], tags: { '©nam': 'Not a song' } }) });
  const db = openDb(':memory:');
  scan(db, [root]);

  applyTags(db);

  const reported = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'tag-format-unknown'")
    .get() as { n: number };

  assert.equal(reported.n, 0);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a video the scan called audio is reported as itself', () => {
  // task:2727 — the finding the note above promises existed nowhere. The reader
  // returned `noTags('mp4')`, whose container is not null, so `tag-format-unknown`
  // stayed away; `durationRefused` was false, so no probe was asked for either;
  // and a track was made from the file all the same. A live clip sat in the
  // library under no word at all.
  const root = fixture({ 'Album/clip.m4a': mp4({ tracks: ['vide'], tags: { '©nam': 'Not a song' } }) });
  const db = openDb(':memory:');
  scan(db, [root]);

  applyTags(db);

  const issues = issuesOf(db, 'tag-video-as-audio');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.rel_path, 'Album/clip.m4a');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a file that cannot be read is an issue, not the end of the scan', () => {
  const root = fixture({ 'Album/01.flac': flac({ tags: { TITLE: 'Green Desert' } }) });
  const db = openDb(':memory:');
  scan(db, [root]);

  const counters = applyTags(db, {
    readBytes: () => {
      throw new Error('EACCES: permission denied');
    },
  });

  const issues = issuesOf(db, 'tag-unreadable');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.rel_path, 'Album/01.flac');
  assert.equal(counters.files, 0);
  assert.equal(counters.issues, 1);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a file holding something unreadable yields no tags, and one complaint', () => {
  // Bytes that are neither FLAC nor ID3 are not an error in themselves — a
  // collection holds whatever it holds. But a format nothing here can read is
  // something the scan *did not understand*, and the contract is explicit that
  // a scan may not lose information silently (001_init.sql, `issue`). So it
  // yields no tags, and it does complain.
  const root = fixture({ 'Album/01.flac': Buffer.from('not audio at all, just words', 'utf8') });
  const db = openDb(':memory:');
  scan(db, [root]);

  const counters = applyTags(db);

  assert.deepEqual(tagsOf(db), []);
  assert.equal(counters.files, 1);
  assert.equal(counters.issues, 1);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a format the reader does not know is reported, once per extension', () => {
  // A third of the tested collection is m4a and nothing here reads it. Yielding
  // nothing *silently* is what the contract forbids — "a scan can never lose
  // information silently" — but 309 identical rows would be noise, so the
  // finding is stated once per extension rather than once per file.
  const m4a = Buffer.from('00000020ftypM4A 00000000M4A mp42isom', 'latin1');
  const root = fixture({ 'Album/a.m4a': m4a, 'Album/b.m4a': m4a, 'Album/c.m4a': m4a });
  const db = openDb(':memory:');
  scan(db, [root]);

  const counters = applyTags(db);

  const issues = issuesOf(db, 'tag-format-unknown');
  assert.equal(issues.length, 1, 'one row for the extension, not one per file');
  assert.equal(issues[0]?.severity, 'info');
  assert.match(issues[0]?.detail ?? '', /m4a/);
  assert.match(issues[0]?.detail ?? '', /3/);
  assert.equal(counters.issues, 1);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a format that is understood is not reported, even holding nothing', () => {
  // A FLAC with no Vorbis comments is understood and empty — a different thing
  // from a format nothing can read. Reporting it would cry wolf on every
  // untagged rip, which is most of this collection.
  const root = fixture({ 'Album/a.flac': flac(), 'Album/b.flac': flac() });
  const db = openDb(':memory:');
  scan(db, [root]);

  applyTags(db);

  assert.deepEqual(issuesOf(db, 'tag-format-unknown'), []);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('each unreadable format gets its own row', () => {
  const root = fixture({
    'Album/a.m4a': Buffer.from('00000020ftypM4A 00000000M4A mp42isom', 'latin1'),
    'Album/b.wv': Buffer.from('wvpk00000000', 'latin1'),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  applyTags(db);

  const details = issuesOf(db, 'tag-format-unknown').map((issue) => issue.detail);
  assert.equal(details.length, 2);
  assert.ok(details.some((d) => /m4a/.test(d)));
  assert.ok(details.some((d) => /wv/.test(d)));

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a length the walk lost is asked of ffprobe, and the answer is kept', () => {
  // The whole point of the fallback: the file is not written off and it is not
  // stored short. The walk declines, and a reader that can answer is asked.
  const root = fixture({ 'Album/02. 218 Tracks.mp3': lostStream() });
  const db = openDb(':memory:');
  scan(db, [root]);

  const asked: string[] = [];
  const counters = applyTags(db, {
    probe: (absPath) => {
      asked.push(absPath);
      return probeSays();
    },
  });

  assert.equal(asked.length, 1, 'the one file that could not be answered, and only it');
  assert.ok(asked[0]?.endsWith('218 Tracks.mp3'));
  assert.equal(counters.probed, 1);
  assert.equal(counters.durations, 1);

  const row = db.prepare('SELECT duration_ms, codec, probe_ok FROM audio_probe').get() as {
    duration_ms: number;
    codec: string;
    probe_ok: number;
  };
  assert.equal(row.duration_ms, 165_000, 'not the 17 seconds the walk would have reported');
  assert.equal(row.codec, 'mp3');
  assert.equal(row.probe_ok, 1);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a duration measured from the file itself names the container', () => {
  // The other half of the provenance. A FLAC states its length in STREAMINFO,
  // so the number in the row is the file's own — a different claim from one
  // ffprobe worked out, and the row has to say which of the two it is.
  const root = fixture({ 'Album/one.flac': flac({ totalSamples: 44100 }) });
  const db = openDb(':memory:');
  scan(db, [root]);
  applyTags(db);

  const row = db.prepare('SELECT duration_source FROM audio_probe').get() as {
    duration_source: string;
  };
  assert.equal(row.duration_source, 'container');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("an ffprobe duration is marked as ffprobe's, and said out loud", () => {
  // ffprobe answers only for a file whose own reader refused — and for an mp3
  // that means one stating no frame count, so ffprobe has none to read and
  // derives the length from the size and the bitrate. The number is worth
  // keeping (on the real `02. 218 Tracks.mp3` it lands within a second of the
  // truth) but it is not the file's own statement, and until now the two were
  // stored identically: 165 778 ms in the column is `size * 8 / bitrate` to
  // the millisecond, wearing the same face as a measurement.
  const root = fixture({ 'Album/02. 218 Tracks.mp3': lostStream() });
  const db = openDb(':memory:');
  scan(db, [root]);
  applyTags(db, { probe: () => probeSays() });

  const row = db.prepare('SELECT duration_source FROM audio_probe').get() as {
    duration_source: string;
  };
  assert.equal(row.duration_source, 'ffprobe');

  const issue = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'tag-duration-estimated'")
    .get() as { severity: string; detail: string } | undefined;
  assert.ok(issue, 'a derived length has to be visible as one');
  assert.equal(issue.severity, 'info');
  assert.match(issue.detail, /ffprobe/);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a stream that could be measured is never spawned for', () => {
  // The other half of the bargain. ffprobe costs 221 times what the walk does,
  // so the fallback has to stay a fallback — one spawn per file that refused
  // and none for the files that did not.
  const root = fixture({
    'Album/01.mp3': mpeg({ frames: 100, sampleRate: 48000, bitrateKbps: 128 }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  let spawned = 0;
  const counters = applyTags(db, {
    probe: () => {
      spawned += 1;
      return probeSays();
    },
  });

  assert.equal(spawned, 0);
  assert.equal(counters.probed, 0);
  assert.equal(counters.durations, 1);

  const row = db.prepare('SELECT duration_ms FROM audio_probe').get() as { duration_ms: number };
  assert.equal(row.duration_ms, 2_400);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('when ffprobe cannot say either, the file is named rather than left blank', () => {
  // Both readers failed, so the length is genuinely unknown — which the
  // contract forbids leaving unsaid. The probe row carries the reason, and the
  // file gets an issue so the gap can be found in the dump.
  const root = fixture({ 'Album/02. 218 Tracks.mp3': lostStream() });
  const db = openDb(':memory:');
  scan(db, [root]);

  const counters = applyTags(db, {
    probe: () => probeSays({ durationMs: null, ok: false, err: 'end of file' }),
  });

  assert.equal(counters.probed, 1);
  assert.equal(counters.probeFailures, 1);
  assert.equal(counters.durations, 0);

  const issues = issuesOf(db, 'tag-duration-refused');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.rel_path, 'Album/02. 218 Tracks.mp3');
  assert.equal(issues[0]?.severity, 'warn');
  assert.match(issues[0]?.detail ?? '', /end of file/);

  const row = db.prepare('SELECT duration_ms, probe_ok, probe_err FROM audio_probe').get() as {
    duration_ms: number | null;
    probe_ok: number;
    probe_err: string;
  };
  assert.equal(row.duration_ms, null, 'the short number is not stored as a consolation');
  assert.equal(row.probe_ok, 0);
  assert.equal(row.probe_err, 'end of file');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a non-audio file is never opened', () => {
  const root = fixture({
    'Album/cover.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    'Album/01.flac': flac({ tags: { TITLE: 'Green Desert' } }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  const reads = countingReads();
  const counters = applyTags(db, { readBytes: reads.readBytes });

  assert.equal(counters.files, 1);
  assert.equal(reads.paths.length, 1);
  assert.ok(reads.paths[0]?.endsWith('01.flac'));

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('the format aggregate counts the collection, not the files one run opened', () => {
  // The row is a property of the collection — "this root holds N files of an
  // extension nothing here reads" — and it was counted over the files the stage
  // opened *that* run. A second run opens nothing, so the number was not
  // recomputed at all, and a run that opened one new file reported one file
  // while the rest went uncounted and an older row said something else again.
  // The reader's verdict has to outlive the run for the count to be the
  // collection's (task:2706).
  const m4a = Buffer.from('00000020ftypM4A 00000000M4A mp42isom', 'latin1');
  const root = fixture({ 'Album/a.m4a': m4a, 'Album/b.m4a': m4a });
  const db = openDb(':memory:');

  scan(db, [root]);
  applyTags(db);
  assert.match(issuesOf(db, 'tag-format-unknown')[0]?.detail ?? '', /2 \.m4a/, 'first read');

  // Nothing moved, so nothing is due and no file is opened.
  scan(db, [root]);
  applyTags(db);
  const unchanged = issuesOf(db, 'tag-format-unknown');
  assert.equal(unchanged.length, 1, 'the count survives a run that reads nothing');
  assert.match(unchanged[0]?.detail ?? '', /2 \.m4a/, 'and it is still the collection’s');

  // A third arrives: the collection holds three, and neither an older row nor a
  // count of "the one file this run opened" may survive to argue with that.
  writeFileSync(join(root, 'Album', 'c.m4a'), m4a);
  scan(db, [root]);
  applyTags(db);
  const grown = issuesOf(db, 'tag-format-unknown');
  assert.equal(grown.length, 1, `one finding, not one per run: ${JSON.stringify(grown)}`);
  assert.match(grown[0]?.detail ?? '', /3 \.m4a/);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('an issue about a file the run did not see does not move to that run', () => {
  // The re-stamp at the end of this stage exists so that a file nothing re-read
  // still appears in the dump of the run that stands behind it (task:2726). A
  // file that is *gone* is not one of those: the run did not see it, and its
  // diagnosis is about a path nothing has. Before this, the row rode into every
  // later run — the dump reported a file that was in neither the walk nor
  // `file`, and `unaccounted` said 0/0/0 beside it.
  const root = fixture({
    'Album/01.flac': flac({
      rawComments: [Buffer.concat([Buffer.from('ARTIST=', 'latin1'), cp1251('Аквариум')])],
    }),
    'Album/02.flac': flac({ tags: { TITLE: 'Green Desert' } }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  applyTags(db);
  assert.equal(issuesOf(db, 'tag-encoding-guessed').length, 1, 'the first run files it');

  rmSync(join(root, 'Album/01.flac'));
  scan(db, [root]);
  applyTags(db);

  // Read the way the dump reads: the run it describes, by id.
  const latest = (db.prepare('SELECT MAX(id) AS id FROM scan_run').get() as { id: number }).id;
  const rows = db
    .prepare('SELECT rel_path FROM issue WHERE scan_run_id = ? AND kind = ?')
    .all(latest, 'tag-encoding-guessed') as { rel_path: string }[];

  assert.deepEqual(rows, [], 'the run that never saw the file does not report on it');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a file that is still there, and was not re-read, still reports to this run', () => {
  // The other half, and the reason the re-stamp exists at all: a file the ledger
  // did not call changed is never re-read, and its finding is still true of it.
  // Dropping the re-stamp outright would silence it, which is task:2726 again.
  const root = fixture({
    'Album/01.flac': flac({
      rawComments: [Buffer.concat([Buffer.from('ARTIST=', 'latin1'), cp1251('Аквариум')])],
    }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  applyTags(db);
  scan(db, [root]);
  applyTags(db);

  const latest = (db.prepare('SELECT MAX(id) AS id FROM scan_run').get() as { id: number }).id;
  const rows = (
    db
      .prepare('SELECT rel_path FROM issue WHERE scan_run_id = ? AND kind = ?')
      .all(latest, 'tag-encoding-guessed') as { rel_path: string }[]
  ).map((row) => ({ rel_path: row.rel_path }));

  assert.deepEqual(rows, [{ rel_path: 'Album/01.flac' }], 'the finding is still true of the file');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('the count the stage reports is the count its run carries', () => {
  // The dump totals the issue rows of the run; the report totals what the stages
  // say they filed. When the stage re-stamps rows it did not write this time,
  // only one of those numbers moved — the report said 96 where the dump said 97.
  const root = fixture({
    'Album/01.flac': flac({
      rawComments: [Buffer.concat([Buffer.from('ARTIST=', 'latin1'), cp1251('Аквариум')])],
    }),
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  applyTags(db);
  scan(db, [root]);

  const counters = applyTags(db);
  const latest = (db.prepare('SELECT MAX(id) AS id FROM scan_run').get() as { id: number }).id;
  const carried = (
    db.prepare("SELECT COUNT(*) AS n FROM issue WHERE scan_run_id = ? AND stage = 'tags'").get(latest) as {
      n: number;
    }
  ).n;

  assert.equal(counters.issues, carried, 'what it says it filed and what the run carries are one number');

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a run reads the files of the roots it walked, and no others', () => {
  // A run over one root of two leaves the other root's files in `file` with an
  // older stamp — and the ledger's verdict on them is older too, because
  // `changed` is the walk's flag and a walk that did not happen leaves it as it
  // was. So they read as "moved" and the stage opened them: files under a root
  // this run never visited, reported on as though it had (task:2751).
  const a = fixture({ 'A/01.flac': flac({ tags: { TITLE: 'Green Desert' } }) });
  const b = fixture({ 'B/01.flac': flac({ tags: { TITLE: 'Elsewhere' } }) });
  const db = openDb(':memory:');
  scan(db, [a, b]);
  applyTags(db);

  scan(db, [a]);
  const reads = countingReads();
  const counters = applyTags(db, { readBytes: reads.readBytes });

  assert.deepEqual(reads.paths, [], 'nothing under the unvisited root is opened');
  assert.equal(counters.files, 0);

  db.close();
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test('a file whose read failed is read again on the next run', () => {
  // The comment on `readBytes` promises that a file which cannot be opened is
  // left unstamped on purpose, because a locked file is a transient and the next
  // scan should try again. That promise held only for a file that had never been
  // read: a file read once and then locked keeps the stamp from the successful
  // read, and the walk — which recorded the new bytes before the read was even
  // attempted — settles `changed` to 0, so the file is never read again. The
  // dump keeps showing the old tags as current and the `tag-unreadable` about it
  // stays forever, by then untrue (task:2751 round 4, finding R4-1).
  const root = fixture({ 'Album/01.flac': flac({ tags: { TITLE: 'First' } }) });
  const db = openDb(':memory:');

  scan(db, [root]);
  applyTags(db);
  assert.deepEqual(tagsOf(db), [{ name: 'title', value: 'First', position: 0 }]);

  // The bytes change, and the read fails — a player, a sync client or a backup
  // holding the file is the ordinary way this happens.
  writeFileSync(join(root, 'Album/01.flac'), flac({ tags: { TITLE: 'Second Name' } }));
  scan(db, [root]);
  const failed = applyTags(db, {
    readBytes: () => {
      throw new Error('EBUSY: resource busy or locked');
    },
  });
  assert.equal(failed.issues, 1, 'the failure is reported');

  // The lock is gone. The next run has to try again.
  scan(db, [root]);
  const after = applyTags(db);

  assert.equal(after.files, 1, 'the file is read again once it can be');
  assert.deepEqual(tagsOf(db), [{ name: 'title', value: 'Second Name', position: 0 }]);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a record whose folder names no year takes the one its files state', () => {
  // The folder is what a collector writes, so where it names a year that is the
  // year. Where it does not, the files' own DATE is the only thing that says
  // anything — and the four digits are checked rather than taken, because a
  // DATE is `1988`, or `1988-05-06`, or a timestamp, and `substr` of something
  // else would file a record under a year that appears nowhere in it.
  const root = fixture({
    'Plain/01.mp3': id3v2([
      { id: 'TYER', encoding: 3, text: Buffer.from('1997-05-06', 'utf8') },
    ]),
    'Timeless/01.mp3': id3v2([
      { id: 'TYER', encoding: 3, text: Buffer.from('not a year', 'utf8') },
    ]),
  });

  const db = openDb(':memory:');
  try {
    scan(db, [root]);
    // The year the tags stage fills belongs to a *record*, so the classifier has
    // to have run: it is the stage that makes album rows out of folders.
    classify(db);
    applyTags(db, { probe: () => probeSays(), readBytes: (p) => readFileSync(p) });

    const dated = db.prepare('SELECT year, year_source FROM album WHERE rel_path = ?').get('Plain') as {
      year: number | null;
      year_source: string | null;
    };
    assert.equal(dated.year, 1997);
    assert.equal(dated.year_source, 'tag', 'and the answer says where the number came from');

    const undated = db.prepare('SELECT year FROM album WHERE rel_path = ?').get('Timeless') as {
      year: number | null;
    };
    assert.equal(undated.year, null, 'a DATE that opens with no year is not a year');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a disc keyed on its image takes the year its own file states', () => {
  // A flat multi-disc release keys each disc's album row on the **image**, not
  // on a folder: `…/01. On The Beach.mp3` is that row's `rel_path`, because the
  // folder holds several discs and belongs to none of them. The query above
  // reads a record's files as "the files in this record's folder", so for these
  // rows it matches nothing at all — and two ASOT records sat with no year
  // while every file in them stated `2025-03-28`.
  //
  // The row is the file, so the file is what has to be asked for. Adding it is
  // the whole of the fix: a record keyed on a folder matches this new arm
  // never, since no file's path equals the path of the folder holding it.
  const root = fixture({
    'Flat/01. Disc One.mp3': id3v2([
      { id: 'TYER', encoding: 3, text: Buffer.from('2001-02-03', 'utf8') },
    ]),
    'Flat/01. Disc One.cue': Buffer.from('FILE "01. Disc One.mp3" WAVE\n', 'utf8'),
    'Flat/02. Disc Two.mp3': id3v2([
      { id: 'TYER', encoding: 3, text: Buffer.from('2001-02-03', 'utf8') },
    ]),
    'Flat/02. Disc Two.cue': Buffer.from('FILE "02. Disc Two.mp3" WAVE\n', 'utf8'),
  });

  const db = openDb(':memory:');
  try {
    scan(db, [root]);
    classify(db);
    applyTags(db, { probe: () => probeSays(), readBytes: (p) => readFileSync(p) });

    const discs = db.prepare('SELECT rel_path, year, year_source FROM album ORDER BY rel_path').all() as {
      rel_path: string;
      year: number | null;
      year_source: string | null;
    }[];

    assert.equal(discs.length, 2, 'each disc of a flat release is its own row');
    for (const disc of discs) {
      assert.equal(disc.year, 2001, `${disc.rel_path} takes the year its own file states`);
      assert.equal(disc.year_source, 'tag');
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a v1 block behind a v2 block fills only the names v2 left unstated', () => {
  // The two blocks coexist in the wild and routinely disagree, because the
  // writer stopped maintaining one of them years ago. What must not happen is
  // both being stored: two values of one name are read downstream as two
  // artists, and this project turns two artists into a collaboration — so the
  // album would be filed under a credit nobody recorded, or, with no
  // `albumartist` to settle it, under none at all.
  const v2 = id3v2([
    { id: 'TIT2', encoding: 3, text: Buffer.from('The Real Title', 'utf8') },
    { id: 'TPE1', encoding: 3, text: Buffer.from('The Real Artist', 'utf8') },
  ]);
  const root = fixture({
    'Album/01.mp3': Buffer.concat([
      v2,
      mpeg({ frames: 40, sampleRate: 44100, bitrateKbps: 128 }),
      id3v1({ title: 'An Old Title', artist: 'An Old Artist', album: 'Only The Old Block Album', genre: 17 }),
    ]),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  applyTags(db);

  assert.deepEqual(tagsOf(db), [
    { name: 'album', value: 'Only The Old Block Album', position: 0 },
    { name: 'artist', value: 'The Real Artist', position: 0 },
    { name: 'date', value: '2003', position: 0 },
    { name: 'genre', value: 'Rock', position: 0 },
    { name: 'title', value: 'The Real Title', position: 0 },
  ]);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a field a tag stated and the reader refused is reported, not dropped', () => {
  // Reading a value in order to throw it away is exactly the silence the
  // contract forbids, and only the reader knows it happened.
  const root = fixture({
    'Album/01.mp3': Buffer.concat([
      mpeg({ frames: 40, sampleRate: 44100, bitrateKbps: 128 }),
      id3v1({ title: 'A Song', genre: 200 }),
    ]),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  applyTags(db);

  const issue = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'tag-field-refused'")
    .get() as { severity: string; detail: string } | undefined;
  assert.ok(issue, 'the refusal has to be visible outside the reader');
  assert.equal(issue.severity, 'info', 'the file is not damaged and there is nothing to go and do');
  assert.match(issue.detail, /genre 200 is not in the list/);
  // The rest of the tag is read: one bad field is not a bad tag.
  assert.deepEqual(tagsOf(db), [
    { name: 'date', value: '2003', position: 0 },
    { name: 'title', value: 'A Song', position: 0 },
  ]);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

// The record's documentation — an `.nfo`, an EAC `.log` — is text the meta layer
// had nowhere: the scanner recorded a sidecar's kind and size and never opened
// it, so `file.encoding` was NULL for all 417 of them, while 41 FLAC rips in the
// same library carry their log and cue *inside* the file as tags. The container
// was deciding whether the documentation existed (task:2757).
test('a sidecar is decoded, and its encoding is recorded on its own file row', () => {
  const root = fixture({
    'Album/01.flac': flac({ tags: { ARTIST: 'Кино' } }),
    'Album/rip.log': cp1251('Exact Audio Copy\nТрек  1\n     Название: Песня'),
    'Album/release.nfo': Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Издание', 'utf16le'),
    ]),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  const counters = applyTags(db);

  assert.equal(counters.sidecars, 2, 'both sidecars were read, and the audio file is not counted here');
  const rows = (
    db
      .prepare("SELECT rel_path, encoding FROM file WHERE kind IN ('log', 'nfo') ORDER BY rel_path")
      .all() as { rel_path: string; encoding: string | null }[]
  ).map((row) => ({ rel_path: row.rel_path, encoding: row.encoding }));
  assert.deepEqual(rows, [
    { rel_path: 'Album/release.nfo', encoding: 'utf-16le' },
    { rel_path: 'Album/rip.log', encoding: 'windows-1251' },
  ]);

  // The Cyrillic survives, which is the whole of what the acceptance asks.
  const text = db
    .prepare(
      'SELECT st.text FROM sidecar_text st JOIN file f ON f.id = st.file_id WHERE f.rel_path = ?',
    )
    .get('Album/rip.log') as { text: string };
  assert.match(text.text, /Название: Песня/);

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a sidecar that had to be guessed at says so, and is kept anyway', () => {
  const root = fixture({
    'Album/01.flac': flac({ tags: { ARTIST: 'Кино' } }),
    // No BOM and not valid UTF-8: the encoding is a call rather than a statement.
    'Album/rip.log': cp1251('Exact Audio Copy\nТрек  1\n     Название: Песня про кино'),
  });
  const db = openDb(':memory:');
  scan(db, [root]);

  applyTags(db);

  const issue = db
    .prepare("SELECT detail FROM issue WHERE kind = 'sidecar-encoding-guessed'")
    .get() as { detail: string } | undefined;
  assert.ok(issue, 'the guess is reported rather than left in the encoding column alone');
  assert.match(issue.detail, /windows-1251/);
  assert.equal(
    (db.prepare('SELECT COUNT(*) n FROM sidecar_text').get() as { n: number }).n,
    1,
    'and the text is kept either way — what is uncertain is the reading, not the file',
  );

  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a sidecar that cannot be opened is reported and left for the next run', () => {
  const root = fixture({
    'Album/01.flac': flac({ tags: { ARTIST: 'Кино' } }),
    'Album/rip.log': cp1251('Exact Audio Copy'),
  });
  const db = openDb(':memory:');
  scan(db, [root]);
  // The walk saw it and the row is written; by the time the stage opens it the
  // file is gone, which is the ordinary way a read fails.
  rmSync(join(root, 'Album', 'rip.log'));

  applyTags(db);

  const issue = db
    .prepare("SELECT severity FROM issue WHERE kind = 'sidecar-unreadable'")
    .get() as { severity: string } | undefined;
  assert.ok(issue, 'a document this run could not open is said out loud');
  assert.equal(issue.severity, 'warn');
  assert.equal(
    (db.prepare('SELECT tags_read_run_id r FROM file WHERE rel_path = ?').get('Album/rip.log') as {
      r: number | null;
    }).r,
    null,
    'and it is unstamped, so the next run tries again rather than filing the failure',
  );

  db.close();
  rmSync(root, { recursive: true, force: true });
});
