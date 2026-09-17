import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { walkRoot } from '../src/scan/walk.ts';
import { tempRoot } from './helpers/tmp.ts';

/** Build a throwaway directory tree; returns its absolute path. */
function fixture(tree: Record<string, string>): string {
  const root = tempRoot('funoteka-walk-');
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

test('walks files and folders beneath a root', () => {
  const root = fixture({
    'Green Desert/cover.JPEG': 'img',
    'Green Desert/green.cue': 'cue',
    'Green Desert/Tangerine Dream - Green Desert.m4a': 'audio',
    'Tool/Opiate/CD1/01.flac': 'audio',
    'Tool/Opiate/CD1/02.flac': 'audio',
  });

  const { files, folders } = walkRoot(root);

  assert.deepEqual(
    files.map((f) => f.relPath).sort(),
    [
      'Green Desert/Tangerine Dream - Green Desert.m4a',
      'Green Desert/cover.JPEG',
      'Green Desert/green.cue',
      'Tool/Opiate/CD1/01.flac',
      'Tool/Opiate/CD1/02.flac',
    ],
  );
  // Folders are relative to the root, which itself is '' and not listed.
  assert.deepEqual(folders, ['Green Desert', 'Tool', 'Tool/Opiate', 'Tool/Opiate/CD1']);

  rmSync(root, { recursive: true, force: true });
});

test('relative paths use forward slashes regardless of platform', () => {
  // The meta layer is portable between Windows and Linux, so paths stored in it
  // must not depend on the separator the host happens to use.
  const root = fixture({ 'a/b/c.flac': 'x' });
  const { files, folders } = walkRoot(root);

  assert.equal(files[0]?.relPath, 'a/b/c.flac');
  assert.ok(folders.includes('a/b'));
  assert.ok(!files.some((f) => f.relPath.includes('\\')));

  rmSync(root, { recursive: true, force: true });
});

test('records size, mtime, kind and folder for each file', () => {
  const root = fixture({ 'album/cover.jpg': 'twelve bytes' });
  const { files } = walkRoot(root);
  const f = files[0];

  assert.equal(f?.name, 'cover.jpg');
  assert.equal(f?.kind, 'image');
  assert.equal(f?.ext, 'jpg');
  assert.equal(f?.size, 12);
  assert.equal(f?.folderRelPath, 'album');
  assert.ok((f?.mtimeMs ?? 0) > 0);

  rmSync(root, { recursive: true, force: true });
});

test('skips NAS bookkeeping directories instead of walking them', () => {
  // A Synology collection carries @eaDir thumbnail trees next to the audio;
  // walking them would invent tens of thousands of phantom files.
  const root = fixture({
    'album/track.flac': 'audio',
    'album/@eaDir/track.flac/thumb.jpg': 'thumb',
    '@eaDir/junk.txt': 'junk',
    '#recycle/old.flac': 'audio',
  });

  const { files, folders } = walkRoot(root);
  const paths = files.map((f) => f.relPath);

  assert.deepEqual(paths, ['album/track.flac']);
  assert.ok(!folders.some((d) => d.includes('@eaDir')));
  assert.ok(!folders.some((d) => d.includes('#recycle')));

  rmSync(root, { recursive: true, force: true });
});

test('output order is deterministic', () => {
  const root = fixture({ 'b/x.flac': '1', 'a/y.flac': '2', 'c/z.flac': '3' });
  const first = walkRoot(root).files.map((f) => f.relPath);
  const second = walkRoot(root).files.map((f) => f.relPath);

  assert.deepEqual(first, second);
  assert.deepEqual(first, [...first].sort());

  rmSync(root, { recursive: true, force: true });
});

test('an empty root yields nothing and does not throw', () => {
  const root = tempRoot('funoteka-walk-');
  const { files, folders } = walkRoot(root);

  assert.deepEqual(files, []);
  assert.deepEqual(folders, []);

  rmSync(root, { recursive: true, force: true });
});

test('an ignored directory is reported, and counted as far as it goes', () => {
  // The blacklist is a guess made from a name, and the walk used to act on it in
  // silence — `@eaDir` and `#recycle` were dropped where they stood, so the file
  // count quietly disagreed with the filesystem and nothing said so. The name
  // still decides, because a Synology thumbnail tree must not become a phantom
  // album per track; what changed is that the guess is now visible, and that a
  // directory holding music is told apart from one holding thumbnails.
  const root = fixture({
    'album/track.flac': 'audio',
    'album/@eaDir/track.flac/thumb.jpg': 'thumb',
    '@eaDir/junk.txt': 'junk',
    '#recycle/old.flac': 'audio',
    '#recycle/deeper/older.mp3': 'audio',
  });

  const { files, ignored } = walkRoot(root);

  assert.deepEqual(files.map((f) => f.relPath), ['album/track.flac']);
  assert.deepEqual(ignored, [
    { relPath: '#recycle', audio: 2, other: 0 },
    { relPath: '@eaDir', audio: 0, other: 1 },
    { relPath: 'album/@eaDir', audio: 0, other: 1 },
  ]);

  rmSync(root, { recursive: true, force: true });
});
