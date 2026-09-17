import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync, statSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { classify } from '../src/classify/classify.ts';
import { openDb } from '../src/db/index.ts';
import { scan } from '../src/scan/scan.ts';
import { observed } from '../src/scan/settle.ts';
import { tempRoot } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDb>;

function fixture(tree: Record<string, string>): string {
  const root = tempRoot('funoteka-scan-');
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

test('scan persists roots, folders and files, and reports counters', () => {
  const root = fixture({
    'Green Desert/green.cue': 'cue',
    'Green Desert/cover.JPEG': 'img',
    'Green Desert/Green Desert.m4a': 'audio-bytes',
  });
  const db = openDb(':memory:');

  const counters = scan(db, [root]);

  assert.equal(counters.roots, 1);
  assert.equal(counters.folders, 1);
  assert.equal(counters.files, 3);
  assert.equal(counters.audioFiles, 1);
  assert.equal(counters.byKind.audio, 1);
  assert.equal(counters.byKind.cue, 1);
  assert.equal(counters.byKind.image, 1);
  assert.equal(counters.issues, 0);

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM folder'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 3);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM scan_run'), 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('counters account for every file seen — nothing is lost silently', () => {
  const root = fixture({
    'a/one.flac': '1',
    'a/two.flac': '2',
    'a/three.cue': '3',
    'a/four.nfo': '4',
    'b/five.mp3': '5',
  });
  const db = openDb(':memory:');

  const counters = scan(db, [root]);
  const accounted = Object.values(counters.byKind).reduce((a, b) => a + b, 0);

  assert.equal(accounted, counters.files);
  assert.equal(counters.files, count(db, 'SELECT COUNT(*) AS n FROM file'));

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('anything the walk skipped becomes an issue, never a silent drop', () => {
  // The walker is injected here: the interesting contract is the mapping from
  // skipped entries to issue rows, and producing a real skip on disk (a
  // dangling symlink) needs privileges Windows does not grant by default.
  const db = openDb(':memory:');

  const counters = scan(db, ['/collection'], {
    walk: () => ({
      files: [
        {
          relPath: 'album/track.flac',
          folderRelPath: 'album',
          name: 'track.flac',
          kind: 'audio',
          ext: 'flac',
          size: 1,
          mtimeMs: 1,
        },
      ],
      folders: ['album'],
      skipped: [{ relPath: 'album/dangling.flac', reason: 'symlink (not followed)' }],
      ignored: [],
    }),
  });

  assert.equal(counters.files, 1);
  assert.equal(counters.skipped, 1);
  assert.equal(counters.issues, 1);

  const issue = db.prepare('SELECT kind, rel_path, detail FROM issue').get() as {
    kind: string;
    rel_path: string;
    detail: string;
  };
  assert.equal(issue.rel_path, 'album/dangling.flac');
  assert.equal(issue.detail, 'symlink (not followed)');

  db.close();
});

test('the same relative path in two roots stays two albums', () => {
  // requirements:39 §2 — duplicates across roots are DIFFERENT albums.
  const rootA = fixture({ 'Tool/10000 Days/a.flac': 'a' });
  const rootB = fixture({ 'Tool/10000 Days/a.flac': 'b' });
  const db = openDb(':memory:');

  const counters = scan(db, [rootA, rootB]);

  assert.equal(counters.roots, 2);
  assert.equal(counters.files, 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 2);
  assert.equal(count(db, 'SELECT COUNT(DISTINCT root_id) AS n FROM file'), 2);

  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
  db.close();
});

test('rescanning the same root updates in place instead of duplicating', () => {
  const root = fixture({ 'album/track.flac': 'audio' });
  const db = openDb(':memory:');

  scan(db, [root]);
  const counters = scan(db, [root]);

  assert.equal(counters.files, 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM root'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM scan_run'), 2);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a scan run is closed out with a terminal status', () => {
  const root = fixture({ 'album/track.flac': 'audio' });
  const db = openDb(':memory:');

  const counters = scan(db, [root]);
  const run = db
    .prepare('SELECT status, finished_at, roots_json FROM scan_run WHERE id = ?')
    .get(counters.scanRunId) as { status: string; finished_at: string | null; roots_json: string };

  assert.equal(run.status, 'ok');
  assert.ok(run.finished_at, 'a finished scan must record when it finished');
  assert.deepEqual(JSON.parse(run.roots_json), [root]);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- the incremental ledger ------------------------------------------------
//
// Whether a file moved since the last run is knowable only while the walk is
// happening: scan writes the file row and the ledger from the same observation,
// so comparing them afterwards always agrees. The verdict is therefore taken
// during the walk, against the previous ledger, and stored.

test('the ledger marks a file unchanged only while its size and mtime hold', () => {
  const root = fixture({ 'album/a.flac': 'aaa', 'album/b.flac': 'bbb' });
  const db = openDb(':memory:');

  const first = scan(db, [root]);
  assert.equal(first.changed, 2, 'nothing has been seen before, so everything is new');
  assert.equal(first.unchanged, 0);

  const second = scan(db, [root]);
  assert.equal(second.changed, 0);
  assert.equal(second.unchanged, 2);

  const ledger = db
    .prepare('SELECT rel_path, changed FROM scan_state ORDER BY rel_path')
    .all() as { rel_path: string; changed: number }[];
  assert.deepEqual(
    ledger.map((row) => [row.rel_path, row.changed]),
    [
      ['album/a.flac', 0],
      ['album/b.flac', 0],
    ],
  );

  // `a` is rewritten longer, `b` only has its mtime moved — either is a change.
  writeFileSync(join(root, 'album', 'a.flac'), 'aaa-longer');
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, 'album', 'b.flac'), later, later);

  const third = scan(db, [root]);
  assert.equal(third.changed, 2);
  assert.equal(third.unchanged, 0);

  const seen = db.prepare('SELECT size FROM scan_state WHERE rel_path = ?').get('album/a.flac') as {
    size: number;
  };
  assert.equal(seen.size, 'aaa-longer'.length, 'the ledger holds what was last seen');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('the same content at a new path has never been seen', () => {
  // Identity is the path, so a rename is a new file however familiar its bytes.
  const root = fixture({ 'album/a.flac': 'same-bytes' });
  const db = openDb(':memory:');

  scan(db, [root]);
  rmSync(join(root, 'album', 'a.flac'));
  writeFileSync(join(root, 'album', 'renamed.flac'), 'same-bytes');

  const counters = scan(db, [root]);

  assert.equal(counters.changed, 1, 'renamed.flac is new');
  assert.equal(counters.unchanged, 0);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- a rescan drops what is no longer on disk -------------------------------
//
// Every row below `root` is derived from the filesystem, so a rescan that only
// ever adds and updates leaves a library describing files that are not there.
// The sweep is scoped to the roots walked in the run: a root nobody scanned
// keeps everything it had.

test('a file deleted from disk is dropped, and forgotten by the ledger', () => {
  const root = fixture({ 'album/a.flac': 'a', 'album/b.flac': 'b' });
  const db = openDb(':memory:');

  scan(db, [root]);
  rmSync(join(root, 'album', 'a.flac'));

  const counters = scan(db, [root]);

  assert.equal(counters.files, 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 1);
  assert.equal(
    (db.prepare('SELECT rel_path FROM file').get() as { rel_path: string }).rel_path,
    'album/b.flac',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a folder deleted from disk is dropped with its files', () => {
  const root = fixture({ 'keep/a.flac': 'a', 'gone/b.flac': 'b' });
  const db = openDb(':memory:');

  scan(db, [root]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM folder'), 2);

  rmSync(join(root, 'gone'), { recursive: true, force: true });
  scan(db, [root]);

  assert.deepEqual(
    (db.prepare('SELECT rel_path FROM folder ORDER BY rel_path').all() as { rel_path: string }[]).map(
      (row) => row.rel_path,
    ),
    ['keep'],
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a vanished file lets go of what names it before it goes', () => {
  // `track.file_id` and `cue.audio_file_id` are declared without ON DELETE
  // CASCADE, so a sweep that deletes the file first does not lose a row — it
  // fails the whole run on the foreign key. Both referrers outlive the file:
  // the album's folder is still on disk, and the cue document is a file of its
  // own. Seeded directly, because the rule is with the schema and not with the
  // stage that happens to write tracks.
  const root = fixture({ 'A/one.flac': 'a', 'A/two.flac': 'b', 'A/list.cue': 'cue' });
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);

  const albumId = (db.prepare('SELECT id FROM album').get() as { id: number }).id;
  const idOf = (relPath: string): number =>
    (db.prepare('SELECT id FROM file WHERE rel_path = ?').get(relPath) as { id: number }).id;

  db.prepare('INSERT INTO track (album_id, ordinal, title, file_id) VALUES (?, 1, ?, ?)').run(
    albumId,
    'A Song',
    idOf('A/one.flac'),
  );
  db.prepare('INSERT INTO cue (file_id, audio_file_id) VALUES (?, ?)').run(
    idOf('A/list.cue'),
    idOf('A/one.flac'),
  );

  rmSync(join(root, 'A', 'one.flac'));
  scan(db, [root]);

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 2, 'the audio file is gone');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM track'), 0, 'and the track naming it went with it');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM cue'), 1, 'the cue is a document of its own');
  assert.equal(
    (db.prepare('SELECT audio_file_id FROM cue').get() as { audio_file_id: number | null })
      .audio_file_id,
    null,
    'the binding to the file that is gone is what went stale',
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no dangling references');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a root that was not scanned keeps everything it had', () => {
  const scanned = fixture({ 'a/one.flac': '1' });
  const untouched = fixture({ 'b/two.flac': '2', 'b/three.flac': '3' });
  const db = openDb(':memory:');

  scan(db, [scanned, untouched]);
  scan(db, [scanned]);

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 3);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM folder'), 2);

  rmSync(scanned, { recursive: true, force: true });
  rmSync(untouched, { recursive: true, force: true });
  db.close();
});

test('a file that leaves is forgotten by the ledger, so a return counts as new', () => {
  const root = fixture({ 'album/a.flac': 'bytes' });
  const path = join(root, 'album', 'a.flac');
  const db = openDb(':memory:');

  scan(db, [root]);
  rmSync(path);
  scan(db, [root]);

  assert.equal(
    count(db, "SELECT COUNT(*) AS n FROM scan_state WHERE rel_path = 'album/a.flac'"),
    0,
    'a ledger row outliving its file would make a returning file look unchanged forever',
  );

  writeFileSync(path, 'bytes');
  const counters = scan(db, [root]);

  assert.equal(counters.changed, 1);
  assert.equal(counters.unchanged, 0);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- unobserved is not the same as gone ---------------------------------------
//
// `walkRoot` reports whatever it met but did not walk — an unreadable directory,
// a symlink, a failed stat — as a `skip`, promising that nothing is dropped
// silently. A sweep that reads "not observed this run" as "gone from disk"
// breaks that promise twice: the rows go, and the issue explaining why is filed
// beside the hole they left.

test('a folder the walk could not read is not treated as deleted', () => {
  const root = fixture({ 'album/a.flac': 'a' });
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM album'), 1, 'precondition: one album');

  scan(db, [root], {
    walk: () => ({
      files: [],
      folders: ['album'],
      skipped: [{ relPath: 'album', reason: 'unreadable directory: EACCES' }],
      ignored: [],
    }),
  });
  classify(db);

  assert.equal(
    count(db, 'SELECT COUNT(*) AS n FROM file'),
    1,
    'a folder nobody could read is not an empty folder',
  );
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM album'), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM issue WHERE kind = 'walk_skipped'"), 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a root the walk could not read at all is not emptied', () => {
  // walkRoot degrades an unreadable root to no folders, no files, and one skip
  // at relPath ''. Unchecked, that reads exactly like an empty collection —
  // and the run still reports itself as ok.
  const root = fixture({ 'album/a.flac': 'a', 'album/b.flac': 'b' });
  const db = openDb(':memory:');
  scan(db, [root]);
  classify(db);

  const counters = scan(db, [root], {
    walk: () => ({
      files: [],
      folders: [],
      skipped: [{ relPath: '', reason: 'unreadable directory: EACCES' }],
      ignored: [],
    }),
  });
  classify(db);

  assert.equal(counters.files, 0, 'this run saw nothing, and says so');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 2, 'but nothing may be taken from it');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM folder'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM album'), 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a subtree the walk skipped keeps its rows while its sibling is swept', () => {
  // Protection is scoped to what was skipped, not a blanket amnesty.
  const root = fixture({ 'kept/a.flac': 'a', 'gone/b.flac': 'b' });
  const db = openDb(':memory:');
  scan(db, [root]);

  rmSync(join(root, 'gone'), { recursive: true, force: true });
  scan(db, [root], {
    walk: () => ({
      files: [],
      folders: ['kept'],
      skipped: [{ relPath: 'kept', reason: 'unreadable directory: EACCES' }],
      ignored: [],
    }),
  });

  assert.deepEqual(
    (db.prepare('SELECT rel_path FROM file ORDER BY rel_path').all() as { rel_path: string }[]).map(
      (row) => row.rel_path,
    ),
    ['kept/a.flac'],
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

// --- one directory must never become two roots (task:2673) -------------------
//
// Root identity used to be the raw string the user typed, so `C:/x` and `C:\x`
// — or a trailing separator, or a different case — were two roots. Album
// identity is root-qualified, so a second root doubles the whole library, and
// nothing warned. A root is now stored as the filesystem's own answer.

/** A database as the pre-canonicalisation code would have written it. */
function seedLegacyRoot(db: Db, path: string, relPath: string): number {
  const id = Number(
    db
      .prepare('INSERT INTO root (path, created_at) VALUES (?, ?)')
      .run(path, '2026-01-01T00:00:00.000Z').lastInsertRowid,
  );
  db.prepare('INSERT INTO folder (root_id, rel_path, parent_rel_path) VALUES (?, ?, ?)').run(
    id,
    relPath,
    '',
  );
  db.prepare(
    `INSERT INTO file (root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (?, ?, ?, ?, 'audio', 'flac', 1, 1)`,
  ).run(id, `${relPath}/a.flac`, relPath, 'a.flac');
  // Diagnostics hang off the root too, so collapsing a twin has to carry them
  // across rather than trip the foreign key.
  // A kind nothing else writes and nothing re-derives. The point here is only
  // that a row hanging off the dropped twin is carried to the survivor; a real
  // kind would be cleared and rewritten by the scan, and would say nothing
  // about whether the carry happened.
  db.prepare(
    `INSERT INTO issue (root_id, stage, rel_path, kind, severity, detail)
     VALUES (?, 'scan', ?, 'seeded_diagnostic', 'info', 'seeded before canonicalisation')`,
  ).run(id, `${relPath}/gone.flac`);
  return id;
}

test('a trailing separator does not make a second root', () => {
  const root = fixture({ 'Tool/10000 Days/a.flac': 'a' });
  const db = openDb(':memory:');

  scan(db, [root]);
  const counters = scan(db, [root + sep]);

  assert.equal(counters.roots, 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM root'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a redundant . segment does not make a second root', () => {
  const root = fixture({ 'Tool/10000 Days/a.flac': 'a' });
  const db = openDb(':memory:');

  scan(db, [root]);
  const counters = scan(db, [root + sep + '.']);

  assert.equal(counters.roots, 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM root'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('one root named twice in a single run is walked once', () => {
  const root = fixture({ 'album/a.flac': 'a', 'album/b.flac': 'b' });
  const db = openDb(':memory:');

  const counters = scan(db, [root, root]);

  assert.equal(counters.roots, 1);
  assert.equal(counters.files, 2, 'files must not be counted twice');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test(
  'Windows spellings of one directory — separators and case — are one root',
  { skip: process.platform === 'win32' ? false : 'case folding is a Windows filesystem property' },
  () => {
    const root = fixture({ 'Tool/10000 Days/a.flac': 'a' });
    const db = openDb(':memory:');

    scan(db, [root]);
    scan(db, [root.split(sep).join('/')]);
    const counters = scan(db, [root.toLowerCase()]);

    assert.equal(counters.roots, 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM root'), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 1);

    rmSync(root, { recursive: true, force: true });
    db.close();
  },
);

test('the stored root is the filesystem canonical path, not the typed string', () => {
  const root = fixture({ 'album/a.flac': 'a' });
  const db = openDb(':memory:');

  scan(db, [root + sep + '.']);

  const stored = (db.prepare('SELECT path FROM root').get() as { path: string }).path;
  assert.equal(stored, realpathSync.native(root));

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a legacy root stored under another spelling is healed, not duplicated', () => {
  // A database written before canonicalisation holds one directory twice, once
  // per spelling, with the library double-counted. The next scan folds the
  // twins into one root and says so rather than leaving the mess in place.
  const root = fixture({ 'Tool/10000 Days/a.flac': 'a' });
  const db = openDb(':memory:');

  seedLegacyRoot(db, root + sep, 'Tool/10000 Days');
  seedLegacyRoot(db, root + sep + '.', 'Tool/10000 Days');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM root'), 2, 'precondition: two legacy roots');

  const counters = scan(db, [root]);

  assert.equal(counters.roots, 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM root'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 1, 'the library must not stay doubled');
  assert.equal(
    (db.prepare('SELECT path FROM root').get() as { path: string }).path,
    realpathSync.native(root),
  );

  const kinds = new Set(
    (db.prepare('SELECT kind FROM issue').all() as { kind: string }[]).map((row) => row.kind),
  );
  assert.ok(kinds.has('root_path_canonicalised'), 'the rewrite must be reported');
  assert.ok(kinds.has('root_duplicate_collapsed'), 'the collapse must be reported');
  assert.equal(
    count(db, "SELECT COUNT(*) AS n FROM issue WHERE kind = 'seeded_diagnostic'"),
    2,
    "the dropped twin's own diagnostics must survive the collapse",
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no dangling references');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a root nested inside another is reported, not counted twice in silence', () => {
  // The contract holds two roots apart on purpose: two copies of an album are
  // two albums, and acceptance checks exactly that (requirements:39 §1). A
  // nested root is not two copies — it is one directory read twice, and no
  // counter can see the doubling, because both albums have tracks, so
  // `unaccounted` cannot tell it from a collection that really holds two. The
  // pair is reported and left alone (task:2709).
  const outer = fixture({ 'Album/01.flac': 'a' });
  const inner = join(outer, 'Album');
  const db = openDb(':memory:');

  const counters = scan(db, [outer, inner]);

  assert.equal(counters.roots, 2, 'both roots stay: this is not the duplicate case');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM root'), 2);
  assert.equal(counters.issues, 1, 'and the doubling is not silent');

  const reported = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'root_nested'")
    .get() as { severity: string; detail: string } | undefined;

  assert.ok(reported, 'one finding about the pair');
  assert.equal(reported.severity, 'warn');
  // The inner root is the one read twice, so it is the one named first. A
  // reversed message sends the reader to the directory that is fine.
  assert.ok(
    reported.detail.startsWith(
      `${realpathSync.native(inner)} is inside ${realpathSync.native(outer)}`,
    ),
    `expected the inner root named first, got: ${reported.detail}`,
  );

  // Raised from the configuration, which is the same on the next run, so it has
  // to be replaced rather than added to — the rule `walk_skipped` follows.
  scan(db, [outer, inner]);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM issue WHERE kind = 'root_nested'"), 1);

  rmSync(outer, { recursive: true, force: true });
  db.close();
});

test('a root that swallows one already registered is reported just the same', () => {
  // Order is not the finding. Adding the wider root second doubles the library
  // exactly as the narrow one second does, and a check that looked one way
  // would be blind to half the configurations that produce it.
  const outer = fixture({ 'Album/01.flac': 'a' });
  const inner = join(outer, 'Album');
  const db = openDb(':memory:');

  const counters = scan(db, [inner, outer]);

  assert.equal(counters.roots, 2);
  assert.equal(counters.issues, 1);

  const reported = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'root_nested'")
    .get() as { severity: string; detail: string } | undefined;

  assert.ok(reported, 'the pair is one finding whichever root came first');
  assert.equal(reported.severity, 'warn');
  assert.ok(
    reported.detail.startsWith(
      `${realpathSync.native(inner)} is inside ${realpathSync.native(outer)}`,
    ),
    `the report names the same relationship whichever end found it: ${reported.detail}`,
  );

  rmSync(outer, { recursive: true, force: true });
  db.close();
});

test('a root already stored canonically does not shelter a duplicate beside it', () => {
  // An exact match settles where a new root goes, but it is not a reason to
  // stop looking: the twin sitting next to the canonical row is still the same
  // directory, and leaving it there is the doubling this all exists to stop.
  const root = fixture({ 'Tool/10000 Days/a.flac': 'a' });
  const db = openDb(':memory:');

  seedLegacyRoot(db, root, 'Tool/10000 Days');
  seedLegacyRoot(db, root + sep, 'Tool/10000 Days');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM root'), 2, 'precondition: canonical + twin');

  const counters = scan(db, [root]);

  assert.equal(counters.roots, 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM root'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 1);
  assert.equal(
    (db.prepare('SELECT id FROM root').get() as { id: number }).id,
    1,
    'the canonical row survives; the late twin is the one dropped',
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no dangling references');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a root that is not on disk is still recorded, and the walk reports the miss', () => {
  // realpath cannot answer for a path that is not there. That degrades to the
  // resolved path and lets the walk report the skip, as it did before, rather
  // than aborting the scan.
  const db = openDb(':memory:');
  const missing = join(tmpdir(), `funoteka-absent-${Date.now()}`);

  const counters = scan(db, [missing]);

  assert.equal(counters.roots, 1);
  assert.equal(counters.skipped, 1);
  assert.equal(counters.issues, 1);
  assert.equal(
    (db.prepare('SELECT path FROM root').get() as { path: string }).path,
    resolve(missing),
  );

  db.close();
});

test('an ignored directory holding audio is a finding, not a silence', () => {
  // `#recycle` and `.Trash-1000` hold whatever was deleted, music included. A
  // collection whose trash is skipped without a word is one whose file count the
  // reader cannot reconcile with the filesystem — and the contract makes "no
  // silent loss" absolute, not "no loss that was convenient to walk".
  const root = fixture({
    'album/track.flac': 'audio',
    '#recycle/old.flac': 'audio',
    '#recycle/deeper/older.mp3': 'audio',
  });
  const db = openDb(':memory:');

  const counters = scan(db, [root]);

  assert.equal(counters.files, 1, 'the ignored tree is still not walked into the collection');
  assert.equal(counters.ignored, 1);
  assert.equal(counters.ignoredAudio, 2);
  assert.equal(counters.issues, 2, 'the directory itself, and the root’s count of them');

  const rows = db
    .prepare("SELECT rel_path, severity, detail FROM issue WHERE kind = 'walk_ignored_audio'")
    .all() as { rel_path: string; severity: string; detail: string }[];

  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      {
        rel_path: '#recycle',
        severity: 'warn',
        detail: 'ignored by name, but it holds 2 audio file(s) — they are not in the collection',
      },
    ],
  );

  const aggregate = db
    .prepare("SELECT rel_path, severity, detail FROM issue WHERE kind = 'walk_ignored'")
    .get() as { rel_path: string | null; severity: string; detail: string } | undefined;

  assert.ok(aggregate, 'and the root says how many directories it passed over');
  assert.equal(aggregate.rel_path, null, 'the count belongs to the root, not to one directory');
  assert.equal(aggregate.severity, 'info');
  assert.equal(
    aggregate.detail,
    'ignored 1 directory by name; 2 audio file(s) beneath it are not in the collection',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('an ignored directory holding no audio is still counted in the dump', () => {
  // The ordinary case, and the reason the blacklist exists: a Synology
  // thumbnail tree. It was counted in the CLI and nowhere else, so the count
  // that exists to reconcile `files N` with the filesystem lived on stdout —
  // gone by the time anyone opens the database. One row per root rather than
  // one per directory: a NAS writes hundreds of entries into such a tree, and a
  // row each would bury the report it is meant to complete.
  const root = fixture({ 'album/track.flac': 'audio', 'album/@eaDir/thumb.jpg': 'thumb' });
  const db = openDb(':memory:');

  const counters = scan(db, [root]);

  assert.equal(counters.files, 1);
  assert.equal(counters.ignored, 1);
  assert.equal(counters.ignoredAudio, 0);
  assert.equal(counters.issues, 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM issue WHERE kind = 'walk_ignored_audio'"), 0);

  const aggregate = db
    .prepare("SELECT severity, detail FROM issue WHERE kind = 'walk_ignored'")
    .get() as { severity: string; detail: string } | undefined;

  assert.ok(aggregate, 'the count has to reach the database, not only stdout');
  assert.equal(aggregate.severity, 'info');
  assert.equal(aggregate.detail, 'ignored 1 directory by name; no audio beneath it');

  scan(db, [root]);
  assert.equal(
    count(db, "SELECT COUNT(*) AS n FROM issue WHERE kind = 'walk_ignored'"),
    1,
    'a rerun replaces the count rather than adding another to it',
  );

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a scan that throws before its transaction is not left saying running', () => {
  // The stage prepared its statements before it opened the transaction, and a
  // prepare compiles against the live schema — so a table it cannot find throws
  // there, outside the guard that settles the run. The run row is inserted
  // before that guard too, which is what makes the failure permanent: no
  // rollback reaches a row written before the transaction, and no later stage
  // files it either — `run.ts` records a stage failure against the run id, and
  // the run id is what `scan` returns. A reader of the database saw a scan that
  // had been going since the day it broke.
  const root = fixture({ 'album/track.flac': 'audio' });
  const db = openDb(':memory:');
  db.exec('DROP TABLE folder');

  assert.throws(() => scan(db, [root]), /folder/, 'the failure still reaches the caller');

  const run = db.prepare('SELECT status FROM scan_run ORDER BY id DESC LIMIT 1').get() as {
    status: string;
  };
  assert.equal(run.status, 'failed', 'a scan that threw is not still running');

  const reported = db
    .prepare("SELECT stage, severity, detail FROM issue WHERE kind = 'scan-failed'")
    .get() as { stage: string; severity: string; detail: string } | undefined;

  assert.ok(reported, 'and the failure has a row of its own');
  assert.equal(reported.stage, 'scan');
  assert.equal(reported.severity, 'warn');
  assert.match(reported.detail, /scan threw: .*folder/);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

/** One file as the walk would report it, with the parts the gate reads spelled out. */
function walkedOne(size: number, mtimeMs: number) {
  return {
    files: [
      {
        relPath: 'Album/song.flac',
        folderRelPath: 'Album',
        name: 'song.flac',
        kind: 'audio' as const,
        ext: 'flac',
        size,
        mtimeMs,
      },
    ],
    folders: ['Album'],
    skipped: [],
    ignored: [],
  };
}

test('a file that was still being written does not enter the library', () => {
  // The contract's acceptance (§5) is that a half-written file does **not** enter
  // the library, and until this gate existed only the watcher had anything
  // against it — the path that is off by default, and the one that already waits
  // for silence while the interval path waited for nothing.
  //
  // **The walk is faked rather than the filesystem raced.** What the gate reads
  // is the mtime the walk reports, so a walk reporting a file written this
  // instant *is* a file the disk has not been quiet about — where the
  // alternative is a test that sleeps, or a writer that has to lose a race to be
  // meaningful. The live check through the real CLI is what says the gate fires
  // on a real writer; this is what says the stage acts on it.
  const root = fixture({ 'Album/song.flac': 'twelve bytes' });
  const db = openDb(':memory:');

  const counters = scan(db, [root], { walk: () => walkedOne(4096, Date.now()), settleMs: 40 });

  assert.equal(counters.files, 0, 'met, and deliberately not recorded');
  assert.equal(counters.skipped, 1, 'and said so rather than dropped');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 0, 'so the library does not have it');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM scan_state'), 0, 'and neither does the ledger');

  const issue = db
    .prepare("SELECT detail, severity FROM issue WHERE kind = 'walk_skipped'")
    .get() as { detail: string; severity: string } | undefined;
  assert.match(issue?.detail ?? '', /still being written/, 'and why is legible');

  // The next run meets a file the disk has been quiet about, and takes it.
  const after = scan(db, [root], { walk: () => walkedOne(4096, Date.now() - 60_000), settleMs: 40 });
  assert.equal(after.files, 1, 'a quiet file is recorded');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 1);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a file being rewritten in place keeps the rows the last run gave it', () => {
  // **Held back as *skipped* rather than dropped, and that is the whole trick.**
  // Skipped is what the sweep amnesties, so a file being overwritten does not
  // vanish from the library for one scan and come back — a flicker an operator
  // would be right to read as data loss. A file that was not there before has no
  // rows to keep, which is the case above.
  const root = fixture({ 'Album/song.flac': 'twelve bytes' });
  const db = openDb(':memory:');

  scan(db, [root]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 1);

  scan(db, [root], { walk: () => walkedOne(3, Date.now()), settleMs: 40 });

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM file'), 1, 'the sweep amnestied it');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM scan_run'), 2, 'the run did happen');

  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('a file the disk has been quiet about is taken on the walk’s word', () => {
  // The common case, and it is why the gate costs a settled collection nothing:
  // every file the walk meets there has been quiet for far longer than the
  // window, so nothing is held and nothing is looked at a second time.
  const root = fixture({ 'Album/song.flac': 'twelve bytes' });
  const db = openDb(':memory:');

  const counters = scan(db, [root], { walk: () => walkedOne(4096, Date.now() - 60_000), settleMs: 40 });

  assert.equal(counters.files, 1);
  assert.equal(counters.skipped, 0);

  rmSync(root, { recursive: true, force: true });
  db.close();
});

/** Block this thread the way a walk spends its time: walking, not sleeping on purpose. */
function stall(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('a file written while the walk ran is still inside the window', () => {
  // **The gate has to be asked against the walk's clock, and this is why.** A
  // walk of a real collection takes seconds — the live one is 11 791 files — so
  // the reading taken when it *returns* makes the first file it met the oldest in
  // the run rather than the freshest. A copy that was halfway through that file
  // when the walk passed it is then outside the window by arithmetic: recorded at
  // whatever size it had reached, and never looked at again by this run.
  //
  // The walk is faked because the case is a race, and what is under test is which
  // instant the gate is asked against rather than whether a filesystem can be
  // made to lose one. The file really does grow, though: the walk meets it,
  // spends longer than the window on the rest of the collection, and the copy
  // lands its next bytes in the meantime.
  const root = fixture({ 'Album/song.flac': 'twelve bytes' });
  const db = openDb(':memory:');
  const window = 60;

  const counters = scan(db, [root], {
    settleMs: window,
    walk: () => {
      const seen = observed(statSync(join(root, 'Album/song.flac')));
      // **What the walk reports is a file it met this instant**, which is the
      // report the gate is about — a copy landing on a collection the walk is
      // already inside. Read here rather than taken from the file's own mtime,
      // because the fixture was written before the database was opened and this
      // test must not depend on how long that took.
      const metAt = Date.now();
      // The rest of the collection, which is what a walk spends its time on.
      stall(window * 3);
      // And the copy was still arriving.
      appendFileSync(join(root, 'Album/song.flac'), ' and more');
      return walkedOne(seen.size, metAt);
    },
  });

  assert.equal(counters.files, 0, 'the file moved while the walk ran, so it is not recorded');
  assert.equal(counters.skipped, 1, 'and the run says so rather than dropping it');

  // The next run meets a file that has stopped, and takes it.
  const after = scan(db, [root], { settleMs: window });
  assert.equal(after.files, 1, 'a quiet file is recorded');

  rmSync(root, { recursive: true, force: true });
  db.close();
});
