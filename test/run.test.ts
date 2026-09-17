import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { openDb } from '../src/db/index.ts';
import type { Probe } from '../src/probe/ffprobe.ts';
import { runStages, type RunOptions, type RunSummary } from '../src/run.ts';
import { walkRoot, type WalkResult } from '../src/scan/walk.ts';
import { cp1251, flac, mpeg } from './helpers/bytes.ts';
import { tempRoot } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDb>;

function fixture(tree: Record<string, string | Buffer>): string {
  const root = tempRoot('funoteka-run-');
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/**
 * A stream the frame walk loses almost immediately, so the tag stage hands the
 * file to a probe — which is the only call in the chain that a test can make
 * throw without reaching into the database.
 */
const LOST_STREAM = Buffer.concat([
  mpeg({ frames: 200, sampleRate: 48_000, bitrateKbps: 128 }),
  Buffer.alloc(100_000),
]);

const PROBE_ANSWERS: Probe = {
  durationMs: 165_000,
  codec: 'mp3',
  sampleRate: 48_000,
  channels: 2,
  bitrate: 128_000,
  ok: true,
  err: null,
};

function probeReturning(probe: Probe): (absPath: string) => Probe {
  return () => probe;
}

/**
 * The chain, with the half-write gate out of the way.
 *
 * Every test in this file scans a fixture written a moment earlier, and that is
 * precisely the file the gate is entitled to wait the window out for — five
 * seconds a run, on tests that are about what the *stages* make of a walk and
 * not about time. The window is a caller's parameter for that reason
 * (`RunOptions.settleMs`), and the gate has its own tests: `scan-settle.test.ts`
 * for the rule, `scan.test.ts` for the stage acting on it, and the test below
 * that asks for a window because the window is what it is about.
 */
function stages(db: Db, roots: string[], options: RunOptions = {}): RunSummary {
  return runStages(db, roots, { settleMs: 0, ...options });
}

/**
 * What a walk reports when it met `unreadable` and could not enter it: the
 * directory is a skip, and nothing beneath it was seen.
 *
 * Spelled here rather than provoked on disk because the case is a permission
 * the test would have to arrange with `icacls` on Windows and a mode on POSIX —
 * and the thing under test is what the stages make of the report, not whether
 * the operating system can be made to refuse a directory.
 */
function walkSkipping(unreadable: string): (rootPath: string) => WalkResult {
  return (rootPath) => {
    const full = walkRoot(rootPath);
    const below = `${unreadable}/`;
    return {
      files: full.files.filter((file) => !file.relPath.startsWith(below)),
      folders: full.folders.filter((dir) => dir !== unreadable && !dir.startsWith(below)),
      skipped: [...full.skipped, { relPath: unreadable, reason: 'unreadable directory: EPERM' }],
      ignored: full.ignored,
    };
  };
}

/** A reader that records what it was asked to open, so a read is visible. */
function openingPaths(): { readBytes: (absPath: string) => Uint8Array; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    readBytes: (absPath: string) => {
      opened.push(absPath);
      return readFileSync(absPath);
    },
  };
}

/** A FLAC whose tag is CP1251 bytes under no declaration — the reader guesses. */
function cp1251Tagged(): Buffer {
  return flac({ rawComments: [Buffer.concat([cp1251('ARTIST='), cp1251('Аквариум')])] });
}

function lastRunId(db: Db): number {
  return (db.prepare('SELECT MAX(id) AS id FROM scan_run').get() as { id: number }).id;
}

/**
 * A finding the tags stage filed, whatever run filed it.
 *
 * Scoped by no run on purpose: the point of the second test below is that a
 * finding travels between runs, so the run it carries is one of the things
 * being asserted rather than the thing being selected by.
 */
function tagFinding(db: Db): { scan_run_id: number; rel_path: string; kind: string } | undefined {
  return db
    .prepare("SELECT scan_run_id, rel_path, kind FROM issue WHERE stage = 'tags' AND kind = 'tag-encoding-guessed'")
    .get() as { scan_run_id: number; rel_path: string; kind: string } | undefined;
}

/** What the library holds as one file's ARTIST — the value the stages wrote, not the file's. */
function artistOf(db: Db, relPath: string): string | undefined {
  const row = db
    .prepare(
      `SELECT t.value AS value FROM file_tag t JOIN file f ON f.id = t.file_id
        WHERE f.rel_path = ? AND t.name = 'artist'`,
    )
    .get(relPath) as { value: string } | undefined;
  return row?.value;
}

/** A path as the walk spells it: relative to the root, forward-slashed. */
function inRoot(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/');
}

// The amnesty is a directory the walk met and could not enter: its rows survive
// the sweep, and `file.last_seen_run_id` — the stamp that puts a file in the
// tags stage's scope — is moved for them too (`db/sweep.ts`). What that stamp
// does *not* do is decide the read; `scan_state.changed` does, and beneath an
// unreadable directory no walk can refresh it. The two tests below are the two
// states that leaves, and both were measured on the real chain before being
// written down (`concepts/last-seen-run-id`, task:2759).
test('a file under a directory the walk could not enter is read, and reported', () => {
  // The state the walk leaves behind when its last look at the file said
  // "moved" — which is what a file's first sight is, and what a real edit is.
  const root = fixture({
    'A/Album/keep.flac': flac({ tags: { ARTIST: 'Portishead' } }),
    'A/Locked/inner.flac': cp1251Tagged(),
  });
  const db = openDb(':memory:');

  stages(db, [root]); // run 1: the walk sees everything, so `changed` is 1

  const reads = openingPaths();
  stages(db, [root], { walk: walkSkipping('A/Locked'), readBytes: reads.readBytes });

  assert.equal(reads.opened.length, 1, 'exactly one file is due: the one beneath the skip');
  const [opened] = reads.opened;
  assert.ok(opened !== undefined, 'exactly one file is due: the one beneath the skip');
  assert.ok(
    opened.endsWith(join('A', 'Locked', 'inner.flac')),
    `the file under the unreadable directory is the one opened — got ${opened}`,
  );

  // And the reading is true: the file is there, and its tag really is CP1251.
  const finding = tagFinding(db);
  assert.ok(finding, 'the encoding verdict the read produced is filed');
  assert.equal(finding.rel_path, 'A/Locked/inner.flac');
  assert.equal(finding.scan_run_id, lastRunId(db));

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a file under it whose last walk found it unchanged is not read — but is still reported', () => {
  // The other state: a file the walk had settled as unchanged. Nothing has been
  // observed since, so nothing is re-read — and the run still reports what it
  // already knows about the file, because it stands behind it either way.
  const root = fixture({
    'A/Album/keep.flac': flac({ tags: { ARTIST: 'Portishead' } }),
    'A/Locked/inner.flac': cp1251Tagged(),
  });
  const db = openDb(':memory:');

  stages(db, [root]); // run 1: first sight, `changed` is 1, the tag is read
  stages(db, [root]); // run 2: the same files, unchanged, so `changed` settles to 0

  const settled = tagFinding(db);
  assert.ok(settled, 'precondition: run 1 read the file and filed the verdict');
  const readIn = settled.scan_run_id;

  const reads = openingPaths();
  stages(db, [root], { walk: walkSkipping('A/Locked'), readBytes: reads.readBytes });

  assert.deepEqual(reads.opened, [], 'a file whose last walk found it unchanged is not re-read');

  const row = db
    .prepare('SELECT last_seen_run_id AS seen FROM file WHERE rel_path = ?')
    .get('A/Locked/inner.flac') as { seen: number } | undefined;
  assert.ok(row, 'the row survived the sweep, which is what the amnesty is for');
  assert.equal(row.seen, lastRunId(db), 'and it carries this run, which is what puts it in scope');

  // The finding is not re-derived — there was nothing to re-derive it from — but
  // it rides into this run's report, because the run stands behind the file.
  const carried = tagFinding(db);
  assert.ok(carried, 'the verdict of the earlier run is still on file');
  assert.equal(carried.scan_run_id, lastRunId(db), 'and it is this run that reports it');
  assert.notEqual(lastRunId(db), readIn, 'precondition: the reporting run is not the reading one');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// And the third state, which is neither of the two above: a file the walk met
// and this run **deliberately did not record**. Its rows have to survive the
// sweep for the same reason the amnesty's do — an album must not lose a track
// because a copy is in flight — and unlike the amnesty it must **not** come out
// of the sweep carrying this run, because that stamp is the tags stage's scope.
// Handing it over as `kept` was the shape that read it: the walk held the file
// back and the stage opened it anyway, so the tags of half a song landed in
// `file_tag`. The pair to the two tests above, and the difference is one list.
test('a file the half-write gate held is not read, and the album does not flicker', () => {
  const root = fixture({
    'A/Album/keep.flac': flac({ tags: { ARTIST: 'Portishead' } }),
    'A/Album/half.flac': flac({ tags: { ARTIST: 'Portishead' } }),
  });
  const db = openDb(':memory:');

  // Run 1 with the gate out of the way. A fixture written this second is a file
  // inside the window, and what this test is about is the second run.
  stages(db, [root], { settleMs: 0 });
  assert.equal(artistOf(db, 'A/Album/half.flac'), 'Portishead', 'precondition: run 1 read it');

  // A copy lands on top of a song that is already in the library, and the walk
  // meets it mid-copy: the size it reports is not the size on disk and the mtime
  // is this instant. That is the report the gate exists for, and the second look
  // after the window still disagrees — so the file is held, not recorded.
  writeFileSync(join(root, 'A/Album/half.flac'), flac({ tags: { ARTIST: 'HALFWRITTEN' } }));
  // The other file changes too, so the run has work it *should* do: with nothing
  // due, an empty list of reads would be evidence of nothing.
  writeFileSync(join(root, 'A/Album/keep.flac'), flac({ tags: { ARTIST: 'Tangerine Dream' } }));

  const walk = (rootPath: string): WalkResult => {
    const full = walkRoot(rootPath);
    return {
      ...full,
      files: full.files.map((file) =>
        file.relPath === 'A/Album/half.flac'
          ? { ...file, size: file.size + 4096, mtimeMs: Date.now() }
          : file,
      ),
    };
  };

  const reads = openingPaths();
  stages(db, [root], { settleMs: 40, walk, readBytes: reads.readBytes });

  assert.deepEqual(
    reads.opened.map((abs) => inRoot(root, abs)),
    ['A/Album/keep.flac'],
    'the run read what it recorded, and not what it held back',
  );
  assert.equal(
    artistOf(db, 'A/Album/half.flac'),
    'Portishead',
    'the tags of the half-written file are not in the library',
  );
  assert.equal(artistOf(db, 'A/Album/keep.flac'), 'Tangerine Dream', 'and the recorded one was re-read');

  // The stamp is what a stage selects by, so this is the same statement as the
  // reads above — said in the column that decides them.
  const row = db
    .prepare('SELECT last_seen_run_id AS seen FROM file WHERE rel_path = ?')
    .get('A/Album/half.flac') as { seen: number } | undefined;
  assert.ok(row, 'the row survived the sweep: the album does not flicker');
  assert.notEqual(row.seen, lastRunId(db), 'and the run does not claim the file it held back');

  const issue = db
    .prepare("SELECT detail FROM issue WHERE kind = 'walk_skipped'")
    .get() as { detail: string } | undefined;
  assert.match(issue?.detail ?? '', /still being written/, 'and the reason is legible');

  const files = db.prepare('SELECT COUNT(*) AS n FROM file').get() as { n: number };
  assert.equal(files.n, 2, 'both rows are still there');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a stage that throws is written down, not only raised', () => {
  // The chain's own `scan` settles `scan_run.status` when its walk is done,
  // which is right for the walk and wrong for the run: a stage that threw
  // afterwards left the row saying `ok` over a database holding some stages and
  // not others. The dump then showed a healthy run over albums with no tracks,
  // and the only record of the failure was a line on stderr that nobody reading
  // the database ever sees.
  const root = fixture({ 'Album/01.mp3': LOST_STREAM });
  const db = openDb(':memory:');

  assert.throws(
    () =>
      stages(db, [root], {
        probe: () => {
          throw new Error('probe exploded');
        },
      }),
    /probe exploded/,
    'the failure still reaches the caller',
  );

  const run = db.prepare('SELECT status FROM scan_run ORDER BY id DESC LIMIT 1').get() as {
    status: string;
  };
  assert.equal(run.status, 'failed', 'a run one of whose stages threw is not ok');

  const reported = db
    .prepare("SELECT stage, kind, severity, detail FROM issue WHERE kind = 'tags-failed'")
    .get() as { stage: string; kind: string; severity: string; detail: string } | undefined;

  assert.ok(reported, 'and the failure has a row of its own');
  assert.equal(reported.stage, 'tags');
  assert.equal(reported.severity, 'warn');
  assert.match(reported.detail, /probe exploded/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a clean rerun after a failure reaches the state a clean run does', () => {
  // The failure trace may not cost the idempotence the stages already have: a
  // database written by a broken run and then written again by a good one has to
  // end up where a single good run would have left it. Otherwise "run it again"
  // stops being the whole of the recovery.
  const root = fixture({ 'Album/01.mp3': LOST_STREAM, 'Album/cover.jpg': 'img' });

  const broken = openDb(':memory:');
  const clean = openDb(':memory:');

  assert.throws(() =>
    stages(broken, [root], {
      probe: () => {
        throw new Error('probe exploded');
      },
    }),
  );

  const stopgap = broken.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number };
  assert.equal(stopgap.n, 0, 'precondition: the broken run left the album bare');

  stages(clean, [root], { probe: probeReturning(PROBE_ANSWERS) });
  stages(broken, [root], { probe: probeReturning(PROBE_ANSWERS) });

  const derived = (db: Db): unknown => ({
    album: db.prepare('SELECT rel_path, title, title_source FROM album ORDER BY rel_path').all(),
    track: db.prepare('SELECT ordinal, title, title_source, duration_ms FROM track ORDER BY ordinal').all(),
    artist: db.prepare('SELECT name FROM artist ORDER BY name').all(),
    release: db.prepare('SELECT title FROM release ORDER BY id').all(),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(derived(broken))), JSON.parse(JSON.stringify(derived(clean))));

  rmSync(root, { recursive: true, force: true });
  broken.close();
  clean.close();
});
