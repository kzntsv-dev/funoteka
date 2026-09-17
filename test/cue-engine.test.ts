import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { classify } from '../src/classify/classify.ts';
import { applyCues } from '../src/cue/engine.ts';
import { openDb } from '../src/db/index.ts';
import type { Probe } from '../src/probe/ffprobe.ts';
import { scan } from '../src/scan/scan.ts';
import { tempRoot } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDb>;

const IMAGE_CUE = `PERFORMER "Tangerine Dream"
TITLE "Green Desert"
FILE "Green Desert.m4a" WAVE
TRACK 01 AUDIO
TITLE "Green Desert"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "White Clouds"
INDEX 01 19:24:00
TRACK 03 AUDIO
TITLE "Astral Voyager"
INDEX 01 24:30:00
`;

function fixture(tree: Record<string, string>): string {
  const root = tempRoot('funoteka-engine-');
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function probeReturning(durationMs: number | null): (absPath: string) => Probe {
  return () => ({
    durationMs,
    codec: 'flac',
    sampleRate: 44100,
    channels: 2,
    bitrate: 1000,
    ok: durationMs !== null,
    err: durationMs === null ? 'unreadable' : null,
  });
}

function prepare(tree: Record<string, string>): { db: Db; root: string } {
  const root = fixture(tree);
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  return { db, root };
}

test('a ripper marker is dropped from the track but kept on the cue', () => {
  // The projection decides what may be *shown* as a name; the parse is the
  // record of what was written. Dropping the marker from `track` while
  // `cue_track` keeps it verbatim is what makes the drop cost nothing — and
  // that is only true if it holds, so it is checked rather than argued.
  const { db, root } = prepare({
    'Undertow/Undertow.flac': 'audio',
    'Undertow/Undertow.cue': `TITLE "Undertow"
PERFORMER "Tool"
FILE "Undertow.flac" WAVE
TRACK 01 AUDIO
TITLE "Intolerance"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "(empty)"
INDEX 01 04:00:00
TRACK 03 AUDIO
TITLE "Disgustipated"
INDEX 01 06:00:00
`,
  });

  applyCues(db, { probe: probeReturning(8 * 60_000) });

  const titles = (
    db.prepare('SELECT title FROM track ORDER BY ordinal').all() as { title: string | null }[]
  ).map((row) => row.title);
  assert.deepEqual(titles, ['Intolerance', null, 'Disgustipated'], 'the marker is not a name');

  const stored = (
    db.prepare('SELECT title FROM cue_track ORDER BY ordinal').all() as { title: string | null }[]
  ).map((row) => row.title);
  assert.ok(stored.includes('(empty)'), 'while the parse keeps what the ripper wrote');

  const reported = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'ripper-marker-titles'")
    .get() as { severity: string; detail: string } | undefined;
  assert.ok(reported, 'and the drop is said out loud');
  assert.equal(reported.severity, 'info');
  assert.match(reported.detail, /1 track/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an image and its cue become segments in the meta layer', () => {
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
  });

  const counters = applyCues(db, { probe: probeReturning(2_100_000) });

  assert.equal(counters.cues, 1);
  assert.equal(counters.tracks, 3);
  assert.equal(counters.byShape['image-cue'], 1);

  const rows = db
    .prepare(
      `SELECT ordinal, title, segment_start_ms, segment_end_ms
       FROM track ORDER BY ordinal`,
    )
    .all() as { ordinal: number; title: string; segment_start_ms: number; segment_end_ms: number }[];

  // node:sqlite returns null-prototype rows, and strict deep-equal compares
  // prototypes — so spread into plain objects before comparing.
  const tracks = rows.map((row) => ({ ...row }));

  assert.deepEqual(tracks, [
    { ordinal: 1, title: 'Green Desert', segment_start_ms: 0, segment_end_ms: 19 * 60_000 + 24_000 },
    { ordinal: 2, title: 'White Clouds', segment_start_ms: 19 * 60_000 + 24_000, segment_end_ms: 24 * 60_000 + 30_000 },
    { ordinal: 3, title: 'Astral Voyager', segment_start_ms: 24 * 60_000 + 30_000, segment_end_ms: 2_100_000 },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the duration the cue stage probed says ffprobe measured it', () => {
  // task:2724 — `bca9b3d` added `duration_source` so a length could say whether
  // it is knowledge or a guess, and this stage was missed: its INSERT named
  // eight columns and `duration_source` was not one of them. The column is
  // nullable with no default, so the row said NULL — ffprobe's number with no
  // word on where it came from at all.
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
  });

  applyCues(db, { probe: probeReturning(2_100_000) });

  const row = db.prepare('SELECT duration_ms, duration_source FROM audio_probe').get() as {
    duration_ms: number | null;
    duration_source: string | null;
  };
  assert.equal(row.duration_ms, 2_100_000);
  assert.equal(row.duration_source, 'ffprobe');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a seeded container label does not survive ffprobe replacing the number', () => {
  // The other half of task:2724, and the worse one: a row the tag stage seeded
  // as `'container'` keeps that label through the conflict, so ffprobe's number
  // is written under the name of a statement the file's own bytes make. The
  // label has to follow the number it describes, not the row it landed in.
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
  });

  const file = db
    .prepare('SELECT id FROM file WHERE rel_path = ?')
    .get('Green Desert/Green Desert.m4a') as { id: number };

  db.prepare(
    `INSERT INTO audio_probe (file_id, duration_ms, codec, sample_rate, channels, bitrate, probe_ok, probe_err, duration_source)
     VALUES (?, ?, 'flac', 44100, 2, 1000, 1, NULL, 'container')`,
  ).run(file.id, 240_000);

  applyCues(db, { probe: probeReturning(223_456) });

  const row = db
    .prepare('SELECT duration_ms, duration_source FROM audio_probe WHERE file_id = ?')
    .get(file.id) as { duration_ms: number | null; duration_source: string | null };
  assert.equal(row.duration_ms, 223_456, 'ffprobe answered, so its number is the one kept');
  assert.equal(row.duration_source, 'ffprobe', 'and the label follows the number, not the row');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue that could not be read is not also reported as one nothing found', () => {
  // task:2727 — `readCues` is filled only by cues that parsed, so a cue the
  // stage tried and failed to read could not be told from one sitting in a
  // folder with no album. The reader was told both that the file could not be
  // opened and that nothing had looked at it, and the second is false about a
  // file the stage had just tried.
  const { db, root } = prepare({
    'Album/01.flac': 'audio',
    'Album/bad.cue': 'FILE "01.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n',
  });

  applyCues(db, {
    probe: probeReturning(600_000),
    readBytes: (absPath) => {
      if (absPath.endsWith('bad.cue')) throw new Error('EACCES: permission denied');
      return readFileSync(absPath);
    },
  });

  const counted = (kind: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM issue WHERE kind = ?').get(kind) as { n: number }).n;

  assert.equal(counted('cue-unreadable'), 1, 'the real reason is stated');
  assert.equal(counted('cue-unmatched'), 0, 'and nothing claims the cue was never read');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('every split track points at the one image file', () => {
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
  });

  applyCues(db, { probe: probeReturning(2_100_000) });

  const files = db.prepare('SELECT DISTINCT file_id FROM track').all() as { file_id: number }[];
  assert.equal(files.length, 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the cue and its entries are recorded', () => {
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
  });

  applyCues(db, { probe: probeReturning(2_100_000) });

  const cue = db.prepare('SELECT audio_file_id FROM cue').get() as { audio_file_id: number };
  assert.ok(cue.audio_file_id, 'the cue must be tied to the audio it describes');

  const entries = db
    .prepare('SELECT ordinal, title, index01_ms FROM cue_track ORDER BY ordinal')
    .all() as { ordinal: number; title: string; index01_ms: number }[];
  assert.equal(entries.length, 3);
  assert.equal(entries[0]?.title, 'Green Desert');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the probe result is stored against the file it describes', () => {
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
  });

  applyCues(db, { probe: probeReturning(2_100_000) });

  const probe = db.prepare('SELECT duration_ms, probe_ok, codec FROM audio_probe').get() as {
    duration_ms: number;
    probe_ok: number;
    codec: string;
  };
  assert.equal(probe.duration_ms, 2_100_000);
  assert.equal(probe.probe_ok, 1);
  assert.equal(probe.codec, 'flac');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an unprobeable image is recorded as a failure, not an exception', () => {
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
  });

  const counters = applyCues(db, { probe: probeReturning(null) });

  assert.equal(counters.probeFailures, 1);
  const issue = db.prepare("SELECT kind FROM issue WHERE kind = 'unbounded-last-segment'").get();
  assert.ok(issue, 'the open-ended closing track must be reported');

  const last = db.prepare('SELECT segment_end_ms FROM track ORDER BY ordinal DESC LIMIT 1').get() as {
    segment_end_ms: number | null;
  };
  assert.equal(last.segment_end_ms, null);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('separate files with a cue become whole-file tracks', () => {
  const { db, root } = prepare({
    'Disintegration/01 - Plainsong.flac': 'a',
    'Disintegration/02 - Pictures of You.flac': 'b',
    'Disintegration/album.cue': `PERFORMER "The Cure"
TITLE "Disintegration"
FILE "01 - Plainsong.flac" WAVE
TRACK 01 AUDIO
TITLE "Plainsong"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Pictures of You"
INDEX 01 05:17:00
`,
  });

  const counters = applyCues(db, { probe: probeReturning(null) });

  assert.equal(counters.byShape['tracks-cue'], 1);
  assert.equal(counters.tracks, 2);
  // Nothing was split, so nothing needed probing.
  assert.equal(counters.probed, 0);

  const tracks = (
    db
      .prepare('SELECT title, segment_start_ms, segment_end_ms FROM track ORDER BY ordinal')
      .all() as { title: string; segment_start_ms: number | null; segment_end_ms: number | null }[]
  ).map((row) => ({ ...row }));
  assert.deepEqual(tracks, [
    { title: 'Plainsong', segment_start_ms: null, segment_end_ms: null },
    { title: 'Pictures of You', segment_start_ms: null, segment_end_ms: null },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a folder with no cue still yields its files as tracks', () => {
  const { db, root } = prepare({
    'Opiate/01.flac': 'a',
    'Opiate/02.flac': 'b',
  });

  const counters = applyCues(db, { probe: probeReturning(null) });

  assert.equal(counters.byShape['tracks-only'], 1);
  assert.equal(counters.tracks, 2);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('re-running replaces the tracks instead of doubling them', () => {
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
  });

  applyCues(db, { probe: probeReturning(2_100_000) });
  applyCues(db, { probe: probeReturning(2_100_000) });

  const count = db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number };
  assert.equal(count.n, 3);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a broken cue does not stop the album being scanned', () => {
  const { db, root } = prepare({
    'Album/01.flac': 'a',
    'Album/02.flac': 'b',
    'Album/broken.cue': 'this is not a cue sheet at all\njust some words\n',
  });

  const counters = applyCues(db, { probe: probeReturning(null) });

  assert.equal(counters.tracks, 2);
  assert.equal(counters.byShape['tracks-only'], 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a root the latest scan did not name still reuses its probes', () => {
  // The verdict belongs to the last run that *walked this root*, not to the
  // latest run overall. Naming one root in an invocation says nothing about
  // another, and must not cost it a re-probe.
  const rootA = fixture({ 'A/Green Desert.m4a': 'audio', 'A/green.cue': IMAGE_CUE });
  const rootB = fixture({ 'B/Green Desert.m4a': 'audio', 'B/green.cue': IMAGE_CUE });
  const db = openDb(':memory:');

  const calls = { n: 0 };
  const counted = (absPath: string): Probe => {
    calls.n += 1;
    return probeReturning(2_100_000)(absPath);
  };

  scan(db, [rootA, rootB]);
  classify(db);
  applyCues(db, { probe: counted });
  assert.equal(calls.n, 2, 'precondition: one probe per root');

  // A second full run settles both verdicts to "unchanged". Until a root has
  // been seen twice there is nothing to compare against, so its first verdict
  // is legitimately "changed" — probing it again would be right.
  scan(db, [rootA, rootB]);
  const settled = applyCues(db, { probe: counted });
  assert.equal(settled.probesReused, 2);

  scan(db, [rootA]);
  const counters = applyCues(db, { probe: counted });

  assert.equal(calls.n, 2, 'root B was not walked, so nothing about it changed');
  assert.equal(counters.probesReused, 2);

  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
  db.close();
});

test('an image the ledger reports unchanged is not probed again', () => {
  // ffprobe is the only process this pipeline spawns, and the whole reason the
  // incremental ledger exists: a collection of image+cue rips would otherwise
  // spawn one ffprobe per album on every single run.
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': 'audio',
    'Green Desert/green.cue': IMAGE_CUE,
  });

  const calls = { n: 0 };
  const counted = (absPath: string): Probe => {
    calls.n += 1;
    return probeReturning(2_100_000)(absPath);
  };

  applyCues(db, { probe: counted });
  assert.equal(calls.n, 1, 'the first run has nothing stored to go on');

  // The CLI scans before its stages, and that scan is what stamps the verdict
  // this stage reads. Without it the ledger still describes the first run.
  scan(db, [root]);
  const second = applyCues(db, { probe: counted });

  assert.equal(calls.n, 1, 'the second run must not spawn ffprobe again');
  assert.equal(second.probesReused, 1);
  assert.equal(second.probed, 0);

  // The image changes, so the stored duration is no longer about this file.
  writeFileSync(join(root, 'Green Desert', 'Green Desert.m4a'), 'different-audio');
  scan(db, [root]);

  const third = applyCues(db, { probe: counted });
  assert.equal(calls.n, 2, 'a changed image must be measured again');
  assert.equal(third.probesReused, 0);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

/** A one-track cue naming `file` — enough to exercise the matcher. */
function oneTrackCue(file: string): string {
  return `TITLE "Album"
FILE "${file}" WAVE
TRACK 01 AUDIO
TITLE "A"
INDEX 01 00:00:00
`;
}

/** What a run filed as `cue-unmatched`, keyed by the cue each report is about. */
function unmatched(db: Db): { relPath: string; severity: string; detail: string }[] {
  const rows = db
    .prepare(
      `SELECT rel_path, severity, detail FROM issue
        WHERE kind = 'cue-unmatched' ORDER BY rel_path`,
    )
    .all() as { rel_path: string; severity: string; detail: string }[];
  return rows.map((row) => ({
    relPath: row.rel_path,
    severity: row.severity,
    detail: row.detail,
  }));
}

test('a second cue describing the same audio is reported as info', () => {
  // The shape every EAC image rip arrives in: `FLAC.cue` names the file that is
  // there, `WAV.cue` names the `.wav` that was never kept. The matcher's stem
  // rule reads the second as describing the same audio, so it loses on score,
  // not on evidence — nothing is missing and there is nothing to act on.
  const { db, root } = prepare({
    'Opiate/Opiate.flac': 'audio',
    'Opiate/Opiate FLAC.cue': oneTrackCue('Opiate.flac'),
    'Opiate/Opiate WAV.cue': oneTrackCue('Opiate.wav'),
  });

  const counters = applyCues(db, { probe: probeReturning(600_000) });

  assert.equal(counters.cues, 1, 'the working cue is the one that counts');
  assert.deepEqual(unmatched(db), [
    {
      relPath: 'Opiate/Opiate WAV.cue',
      severity: 'info',
      detail: 'another cue describes this audio; this one was not used',
    },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue naming audio the folder does not hold stays a warning', () => {
  // A working cue next door is the wrong thing to consult: this one names
  // `Nowhere/Other.wav`, a folder and a file that are not here. Whether the
  // *album* was understood says nothing about whether *this* cue describes
  // anything, and a rip this cue describes is exactly the lost one.
  const { db, root } = prepare({
    'Album/track.flac': 'audio',
    'Album/track.cue': oneTrackCue('track.flac'),
    'Album/Gone.cue': oneTrackCue('Nowhere/Other.wav'),
  });

  applyCues(db, { probe: probeReturning(600_000) });

  assert.deepEqual(unmatched(db), [
    {
      relPath: 'Album/Gone.cue',
      severity: 'warn',
      detail: 'cue describes no audio file in this folder',
    },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue naming another file of this folder is a warning', () => {
  // Two files, two cues, one binding: the album is matched once, so `two.cue`
  // is left over even though it names audio sitting right there. That is a real
  // gap in how the folder resolved, not a duplicate describing one file twice.
  const { db, root } = prepare({
    'Album/01.flac': 'audio',
    'Album/02.flac': 'audio',
    'Album/one.cue': oneTrackCue('01.flac'),
    'Album/two.cue': oneTrackCue('02.flac'),
  });

  applyCues(db, { probe: probeReturning(600_000) });

  assert.deepEqual(unmatched(db), [
    {
      relPath: 'Album/two.cue',
      severity: 'warn',
      detail: 'cue names an audio file this album was not matched to',
    },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('two cues naming nothing are both reported, and neither takes the file', () => {
  // One file, two cues, neither naming it. The winner used to be picked by path
  // order — a guess, not a reading — so exactly one of them was reported as a
  // lost rip while the other was quietly bound to the file. With the guess gone
  // there is no winner: neither cue describes anything here, and both say so.
  const { db, root } = prepare({
    'Album/image.flac': 'audio',
    'Album/a.cue': oneTrackCue('one.wav'),
    'Album/b.cue': oneTrackCue('two.wav'),
  });

  applyCues(db, { probe: probeReturning(600_000) });

  assert.deepEqual(unmatched(db), [
    {
      relPath: 'Album/a.cue',
      severity: 'warn',
      detail: 'cue describes no audio file in this folder',
    },
    {
      relPath: 'Album/b.cue',
      severity: 'warn',
      detail: 'cue describes no audio file in this folder',
    },
  ]);

  const tracks = db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number };
  assert.equal(tracks.n, 1, 'and the file is not split by a cue that names it nowhere');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a second run replaces the issues it filed instead of adding a set', () => {
  // A stage derives its report from the present, so running it again over an
  // unchanged collection must leave the table where it was. It did not: the
  // insert carried the run and nothing ever removed an older run's rows, so
  // three scans of one folder left three copies of every issue. The dump scopes
  // by run and hid it, which is why the table's own size is what this checks —
  // it is what any reader who forgets to scope will count.
  const { db, root } = prepare({
    'Opiate/Opiate.flac': 'audio',
    'Opiate/Opiate FLAC.cue': oneTrackCue('Opiate.flac'),
    'Opiate/Opiate WAV.cue': oneTrackCue('Opiate.wav'),
  });

  applyCues(db, { probe: probeReturning(600_000) });
  assert.equal(unmatched(db).length, 1);

  scan(db, [root]);
  applyCues(db, { probe: probeReturning(600_000) });

  assert.equal(
    unmatched(db).length,
    1,
    'a second run describes the present; it does not add to a history',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue naming nothing, with nothing to lose to, is a warning', () => {
  // Two candidates and a cue that names neither: no cue was read here, and the
  // `sole-audio` guess cannot even run with two files to choose between.
  const { db, root } = prepare({
    'Album/01.flac': 'audio',
    'Album/02.flac': 'audio',
    'Album/album.cue': oneTrackCue('missing.wav'),
  });

  applyCues(db, { probe: probeReturning(600_000) });

  assert.deepEqual(unmatched(db), [
    {
      relPath: 'Album/album.cue',
      severity: 'warn',
      detail: 'cue describes no audio file in this folder',
    },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue whose FILE tags name nothing here does not describe the folder', () => {
  // The matcher used to end in a fallback: when nothing landed, but the folder
  // held exactly one audio file, the cue was taken as describing it anyway.
  // `leftover.cue` is the shape that makes that fallback fatal — a cue for a
  // rip that is not here, sitting above an album whose one file carries its own
  // TITLE. The file was cut into the stranger's three segments, named with the
  // stranger's three titles, and `title_source` said `cue` — the value the
  // migration reserves for a cue that *describes* these files. The album's real
  // track was gone and no issue, counter or field said so.
  const { db, root } = prepare({
    'Album/Only Song.flac': 'audio',
    'leftover.cue': `TITLE "Leftover Record"
PERFORMER "Someone Else"
FILE "Missing/track.wav" WAVE
TRACK 01 AUDIO
TITLE "Wrong One"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Wrong Two"
INDEX 01 01:00:00
TRACK 03 AUDIO
TITLE "Wrong Three"
INDEX 01 02:00:00
`,
  });

  // The file's own TITLE — the knowledge the guess used to displace.
  db.prepare(
    `INSERT INTO file_tag (file_id, name, value, position)
     SELECT id, 'title', 'Only Song', 0 FROM file WHERE rel_path = 'Album/Only Song.flac'`,
  ).run();

  applyCues(db, { probe: probeReturning(1000) });

  const tracks = (
    db
      .prepare(
        `SELECT ordinal, title, title_source, segment_start_ms, segment_end_ms
         FROM track ORDER BY ordinal`,
      )
      .all() as {
      ordinal: number;
      title: string | null;
      title_source: string | null;
      segment_start_ms: number | null;
      segment_end_ms: number | null;
    }[]
  ).map((row) => ({ ...row }));

  assert.deepEqual(
    tracks,
    [
      {
        ordinal: 1,
        title: 'Only Song',
        title_source: 'tag',
        segment_start_ms: null,
        segment_end_ms: null,
      },
    ],
    'the file names itself; a cue that names nothing here does not name it',
  );

  const album = db.prepare("SELECT title, title_source FROM album WHERE rel_path = 'Album'").get() as {
    title: string;
    title_source: string | null;
  };
  assert.equal(album.title_source, 'folder', 'and the stranger does not name the album either');
  assert.equal(album.title, 'Album');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test("a tag naming the rip's site does not name the release", () => {
  // Four Kino boxes carry `lossless-galaxy.ru` in their ALBUM tag — the site
  // the rip came from, not the record. Written as knowledge it named the box
  // after a web host, and every disc projection read `disc 1 of
  // lossless-galaxy.ru`. The finding is the one `-Kroogi.com` glued to a folder
  // name already is: it describes the download.
  const { db, root } = prepare({
    '1988 ● Группа крови (MKK881CD, 3CD)/CD1 ● Альбом/01.flac': 'audio',
    '1988 ● Группа крови (MKK881CD, 3CD)/CD2 ● Live `87/01.flac': 'audio',
  });

  db.prepare(
    `INSERT INTO file_tag (file_id, name, value, position)
     SELECT id, 'album', 'lossless-galaxy.ru', 0 FROM file`,
  ).run();

  applyCues(db, { probe: probeReturning(600_000) });

  const release = db.prepare('SELECT title, title_source FROM release').get() as {
    title: string;
    title_source: string | null;
  };
  assert.notEqual(release.title, 'lossless-galaxy.ru', 'a host is not a record');
  assert.equal(release.title_source, 'folder');

  const reported = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'title-tag-declined'")
    .get() as { severity: string; detail: string } | undefined;
  assert.ok(reported, 'and the refusal is said out loud, once for the box');
  assert.equal(reported.severity, 'info');
  assert.match(reported.detail, /lossless-galaxy\.ru/);

  const restatements = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'title-tag-declined'")
    .get() as { n: number };
  assert.equal(restatements.n, 1, 'one box, one report — not one per disc');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a tag does not rename a release its cue has named', () => {
  // The other half of the rule `006_tags.sql` states — "a tag overrides the
  // folder and never overrides a cue". Only the cue pass implemented it: it skips
  // a record a tag has named, and the tag pass skipped nothing. The two therefore
  // agreed because of the order they happen to run in, which holds for a record
  // seen for the first time and not for one a previous run left named by its cue.
  //
  // The cue-sourced release is set up directly. Reaching it naturally needs two
  // runs with the file edited in between, and what is under test is which source
  // wins, not how the first one came to be there.
  const { db, root } = prepare({
    '1988 ● Группа крови (MKK881CD, 3CD)/CD1 ● Альбом/01.flac': 'audio',
    '1988 ● Группа крови (MKK881CD, 3CD)/CD2 ● Live `87/01.flac': 'audio',
  });

  applyCues(db, { probe: probeReturning(600_000) });
  db.prepare("UPDATE release SET title = 'Named by its cue', title_source = 'cue'").run();

  db.prepare(
    `INSERT INTO file_tag (file_id, name, value, position)
     SELECT id, 'album', 'Named by a tag', 0 FROM file`,
  ).run();
  applyCues(db, { probe: probeReturning(600_000) });

  const release = db.prepare('SELECT title, title_source FROM release').get() as {
    title: string;
    title_source: string | null;
  };
  assert.equal(release.title, 'Named by its cue', 'the cue keeps the name it gave');
  assert.equal(release.title_source, 'cue', 'and the source that says so');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test("a cue naming the rip's site does not name the album", () => {
  // task:2725 — the refusal was wired to one of the three paths that name a
  // record. A cue writing the host into TITLE sailed past it and named the
  // album `lossless-galaxy.ru` under `title_source = 'cue'`, the value that
  // speaks with the most authority — a wrong word written as knowledge, and not
  // a word said about it.
  const { db, root } = prepare({
    '1988 ● Группа крови/01.flac': 'audio',
    '1988 ● Группа крови/album.cue': `TITLE "lossless-galaxy.ru"
FILE "01.flac" WAVE
TRACK 01 AUDIO
TITLE "Группа крови"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Закрой за мной дверь"
INDEX 01 04:00:00
`,
  });

  applyCues(db, { probe: probeReturning(600_000) });

  const album = db
    .prepare("SELECT title, title_source FROM album WHERE rel_path = '1988 ● Группа крови'")
    .get() as { title: string; title_source: string | null };
  assert.notEqual(album.title, 'lossless-galaxy.ru', 'a host is not a record');
  assert.equal(album.title_source, 'folder', 'so the folder name stands, as it does for a tag');

  const reported = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'title-cue-declined'")
    .get() as { severity: string; detail: string } | undefined;
  assert.ok(reported, 'and the refusal is said out loud');
  assert.equal(reported.severity, 'info');
  assert.match(reported.detail, /lossless-galaxy\.ru/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test("a cue naming the rip's site does not name the release either", () => {
  // The third path. A box whose cues agree on the host is the one case the
  // agreement check cannot tell from a name — every disc says the same thing —
  // and it is where the finding was first seen, in the ALBUM tag.
  const siteCue = `TITLE "lossless-galaxy.ru"
FILE "01.flac" WAVE
TRACK 01 AUDIO
TITLE "One"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Two"
INDEX 01 04:00:00
`;
  const { db, root } = prepare({
    '1988 ● Группа крови (MKK881CD, 3CD)/CD1 ● Альбом/01.flac': 'audio',
    '1988 ● Группа крови (MKK881CD, 3CD)/CD1 ● Альбом/disc.cue': siteCue,
    '1988 ● Группа крови (MKK881CD, 3CD)/CD2 ● Live `87/01.flac': 'audio',
    '1988 ● Группа крови (MKK881CD, 3CD)/CD2 ● Live `87/disc.cue': siteCue,
  });

  applyCues(db, { probe: probeReturning(600_000) });

  const release = db.prepare('SELECT title, title_source FROM release').get() as {
    title: string;
    title_source: string | null;
  };
  assert.notEqual(release.title, 'lossless-galaxy.ru', 'a host is not a record');
  assert.equal(release.title_source, 'folder');

  const reported = db
    .prepare("SELECT detail FROM issue WHERE kind = 'release-title-declined'")
    .get() as { detail: string } | undefined;
  assert.ok(reported, 'the refusal is recorded rather than left to vanish');
  assert.match(reported.detail, /lossless-galaxy\.ru/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test("a tag naming the rip's site does not name a plain album either", () => {
  const { db, root } = prepare({ '1988 ● Группа крови/01.flac': 'audio' });

  db.prepare(
    `INSERT INTO file_tag (file_id, name, value, position)
     SELECT id, 'album', 'kroogi.com', 0 FROM file`,
  ).run();

  applyCues(db, { probe: probeReturning(600_000) });

  const album = db.prepare("SELECT title, title_source FROM album WHERE rel_path = '1988 ● Группа крови'").get() as {
    title: string;
    title_source: string | null;
  };
  assert.notEqual(album.title, 'kroogi.com');
  assert.equal(album.title_source, 'folder');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a parent cue that names none of the albums beneath it is reported once', () => {
  // It is a candidate for every album under it, so the per-album loop can only
  // restate one cue's situation once per album — which is the repetition the
  // `ownCuePaths` filter exists to prevent, and the reason it ended up saying
  // nothing at all. Whether a cue described anything is a question about the
  // cue, and the root is where it can be asked.
  const { db, root } = prepare({
    'A/01.flac': 'audio',
    'B/01.flac': 'audio',
    'B/02.flac': 'audio',
    'whole.cue': oneTrackCue('nope.flac'),
  });

  applyCues(db, { probe: probeReturning(600_000) });

  assert.deepEqual(unmatched(db), [
    {
      relPath: 'whole.cue',
      severity: 'warn',
      detail: 'cue sits above these albums and names none of their audio',
    },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue in a folder with no album is reported, not skipped in silence', () => {
  // The stage walks albums, and a folder holding a cue but no audio is not one.
  // Nothing read this cue, nothing bonded it, and nothing said so — the one
  // shape of cue that left no trace anywhere in the meta layer.
  const { db, root } = prepare({
    'Album/01.flac': 'audio',
    'OnlyCue/alone.cue': oneTrackCue('missing.flac'),
  });

  applyCues(db, { probe: probeReturning(600_000) });

  assert.deepEqual(unmatched(db), [
    {
      relPath: 'OnlyCue/alone.cue',
      severity: 'warn',
      detail: 'cue is in a folder with no album; nothing read it',
    },
  ]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('files that disagree about ALBUM do not name the album by sort order', () => {
  // Both answers are the files'. Taking whichever sorted first is the confident
  // guess `albumArtistOf` already refuses to make for the credit — a rule, not a
  // convenience — and here it was made in silence.
  const { db, root } = prepare({ 'Album/01.flac': 'audio', 'Album/02.flac': 'audio' });

  db.prepare(
    `INSERT INTO file_tag (file_id, name, value, position)
     SELECT id, 'album',
            CASE WHEN rel_path = 'Album/01.flac' THEN 'First Title' ELSE 'Second Title' END,
            0
       FROM file`,
  ).run();

  applyCues(db, { probe: probeReturning(600_000) });

  const album = db.prepare("SELECT title, title_source FROM album WHERE rel_path = 'Album'").get() as {
    title: string;
    title_source: string | null;
  };
  assert.equal(album.title, 'Album', 'the folder name stands');
  assert.equal(album.title_source, 'folder');

  const reported = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'title-tag-ambiguous'")
    .get() as { severity: string; detail: string } | undefined;

  assert.ok(reported, 'and the disagreement is said out loud');
  assert.equal(reported.severity, 'info');
  assert.match(reported.detail, /First Title/);
  assert.match(reported.detail, /Second Title/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('files that agree about ALBUM still name the album', () => {
  // The other half of the rule above, so the refusal cannot be tightened into
  // silence: agreement is what a tag is for.
  const { db, root } = prepare({ 'Album/01.flac': 'audio', 'Album/02.flac': 'audio' });

  db.prepare(
    `INSERT INTO file_tag (file_id, name, value, position)
     SELECT id, 'album', 'Both Agree', 0 FROM file`,
  ).run();

  applyCues(db, { probe: probeReturning(600_000) });

  const album = db.prepare("SELECT title, title_source FROM album WHERE rel_path = 'Album'").get() as {
    title: string;
    title_source: string | null;
  };
  assert.equal(album.title, 'Both Agree');
  assert.equal(album.title_source, 'tag');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a track keeps its id when the cue is applied again', () => {
  // Everything a client keeps between sessions — a playlist, a star, a play
  // count — points at a track by id, and this stage used to delete every row of
  // the album and write them back, so each run renumbered the lot. The symptom
  // is silent: after a rescan the client shows an empty playlist and nothing
  // says why.
  //
  // Two albums, not one, and that is the whole reason the fixture is not
  // smaller: on an empty table SQLite hands the first row `1` again, so a
  // single-album collection renumbers back to the ids it started with and a
  // delete-and-rewrite would pass this test.
  const cue = (title: string, first: string, second: string): string =>
    `TITLE "${title}"
PERFORMER "Tool"
FILE "${title}.flac" WAVE
TRACK 01 AUDIO
TITLE "${first}"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "${second}"
INDEX 01 04:00:00
`;
  const { db, root } = prepare({
    'Undertow/Undertow.flac': 'audio',
    'Undertow/Undertow.cue': cue('Undertow', 'Intolerance', 'Prison Sex'),
    'Lateralus/Lateralus.flac': 'audio',
    'Lateralus/Lateralus.cue': cue('Lateralus', 'The Grudge', 'Schism'),
  });

  applyCues(db, { probe: probeReturning(8 * 60_000) });
  const before = db.prepare('SELECT id, ordinal, title FROM track ORDER BY id').all();

  applyCues(db, { probe: probeReturning(8 * 60_000) });
  const after = db.prepare('SELECT id, ordinal, title FROM track ORDER BY id').all();

  assert.equal(before.length, 4, 'two albums of two tracks');
  assert.deepEqual(after, before, 'the same cue gives the same tracks the same ids');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a track the cue no longer names is swept, and the rest keep their ids', () => {
  // The other half of the same bargain: writing where the row already is means
  // nothing is removed by the write, so what a shortened cue drops has to be
  // removed on purpose. Both are checked together because either alone is a
  // worse answer than the delete-and-rewrite it replaces — keeping the ids of
  // tracks that should be gone, or dropping the ids of tracks that remain.
  const cue = (titles: string[]): string =>
    `TITLE "Undertow"
PERFORMER "Tool"
FILE "Undertow.flac" WAVE
${titles
  .map(
    (title, at) =>
      `TRACK 0${at + 1} AUDIO\nTITLE "${title}"\nINDEX 01 ${String(at * 4).padStart(2, '0')}:00:00\n`,
  )
  .join('')}`;

  const { db, root } = prepare({
    'Undertow/Undertow.flac': 'audio',
    'Undertow/Undertow.cue': cue(['Intolerance', 'Prison Sex', 'Disgustipated']),
    'Lateralus/Lateralus.flac': 'audio',
    'Lateralus/Lateralus.cue': `TITLE "Lateralus"
PERFORMER "Tool"
FILE "Lateralus.flac" WAVE
TRACK 01 AUDIO
TITLE "The Grudge"
INDEX 01 00:00:00
`,
  });

  applyCues(db, { probe: probeReturning(8 * 60_000) });
  const before = db
    .prepare("SELECT id, title FROM track WHERE album_id = (SELECT id FROM album WHERE title = 'Undertow') ORDER BY ordinal")
    .all() as { id: number; title: string }[];
  assert.deepEqual(
    before.map((row) => row.title),
    ['Intolerance', 'Prison Sex', 'Disgustipated'],
  );

  // The record loses its last track, which is what a re-rip of a shortened
  // edition looks like.
  writeFileSync(join(root, 'Undertow/Undertow.cue'), cue(['Intolerance', 'Prison Sex']));
  applyCues(db, { probe: probeReturning(8 * 60_000) });

  const after = db
    .prepare("SELECT id, title FROM track WHERE album_id = (SELECT id FROM album WHERE title = 'Undertow') ORDER BY ordinal")
    .all() as { id: number; title: string }[];
  assert.deepEqual(
    after.map((row) => row.title),
    ['Intolerance', 'Prison Sex'],
    'the track the cue dropped is gone',
  );
  assert.deepEqual(after, before.slice(0, 2), 'and the two that remain are the same two rows');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue line nothing could read is filed, once, with the line number', () => {
  // Part of the same promise the `cue-unreadable` report keeps: a cue is read
  // on every pass and the stage is expected to say what it could not use. A
  // `FILE` written without quotes takes its file reference with it and leaves
  // the TRACKs after it counted against the file before (task:2756, finding 2).
  const { db, root } = prepare({
    'Green Desert/Green Desert.m4a': Buffer.from('audio').toString(),
    'Green Desert/green.cue': `TITLE "Green Desert"
PERFORMER "Tangerine Dream"
FILE Green Desert.m4a WAVE
ExactAudioCopy v0.99 prebeta 3
TRACK 01 AUDIO
TITLE "Green Desert"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "White Clouds"
INDEX 01 19:24:00
`,
  });

  applyCues(db, { probe: probeReturning(2_100_000) });

  const rows = db
    .prepare(
      "SELECT rel_path, severity, detail FROM issue WHERE kind = 'cue-unrecognized-line'",
    )
    .all() as { rel_path: string; severity: string; detail: string }[];

  assert.equal(rows.length, 1, 'one report for the cue, not one per album that read it');
  const [row] = rows;
  assert.equal(row?.rel_path, 'Green Desert/green.cue');
  assert.equal(row?.severity, 'warn', 'a FILE that will not read is not merely noise');
  assert.match(row?.detail ?? '', /line 3 "FILE Green Desert\.m4a WAVE"/);
  assert.match(row?.detail ?? '', /line 4 "ExactAudioCopy/);

  // The report is about a cue the stage did read, and it is not the reason a
  // cue was never read — that one already exists and does not apply here.
  const unreadable = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'cue-unreadable'")
    .get() as { n: number };
  assert.equal(unreadable.n, 0, 'the cue opened; only its FILE line did not read');

  // And the loss the report is about is real, not merely reported: with the file
  // reference gone the cue names no audio, so the album it describes is not the
  // album it was matched to. Two reports, and both are true.
  const unmatched = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'cue-unmatched'")
    .get() as { n: number };
  assert.equal(unmatched.n, 1, 'the cue no longer names the audio it describes');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a cue whose every line reads files nothing, and is named as read', () => {
  // The counter has to be quiet on a cue this project understands, or it fires
  // on the whole library and stops meaning anything.
  const { db, root } = prepare({
    'Undertow/Undertow.flac': 'audio',
    'Undertow/Undertow.cue': `CATALOG 075678263424
REM DATE 1993
TITLE "Undertow"
FILE "Undertow.flac" WAVE
TRACK 01 AUDIO
FLAGS DCP
ISRC USRC17607839
TITLE "Intolerance"
INDEX 01 00:00:00
`,
  });

  applyCues(db, { probe: probeReturning(8 * 60_000) });

  const strays = db
    .prepare("SELECT COUNT(*) AS n FROM issue WHERE kind = 'cue-unrecognized-line'")
    .get() as { n: number };
  assert.equal(strays.n, 0);

  rmSync(root, { recursive: true, force: true });
  db.close();
});
