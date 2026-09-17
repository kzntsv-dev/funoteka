import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTree } from '../src/classify/tree.ts';
import type { FileKind } from '../src/scan/kinds.ts';
import type { WalkedFile } from '../src/scan/walk.ts';

function file(folderRelPath: string, name: string, kind: FileKind = 'audio'): WalkedFile {
  return {
    relPath: folderRelPath === '' ? name : `${folderRelPath}/${name}`,
    folderRelPath,
    name,
    kind,
    ext: name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
    size: 1,
    mtimeMs: 1,
  };
}

test('nests folders along their relative paths', () => {
  const tree = buildTree(
    ['Tool', 'Tool/Opiate', 'Tool/Opiate/CD1', 'Tool/Opiate/CD2'],
    [file('Tool/Opiate/CD1', '01.flac'), file('Tool/Opiate/CD2', '01.flac')],
  );

  assert.equal(tree.relPath, '');
  assert.equal(tree.name, '');
  assert.deepEqual(
    tree.children.map((c) => c.relPath),
    ['Tool'],
  );
  const opiate = tree.children[0]?.children[0];
  assert.equal(opiate?.name, 'Opiate');
  assert.deepEqual(
    opiate?.children.map((c) => c.relPath),
    ['Tool/Opiate/CD1', 'Tool/Opiate/CD2'],
  );
});

test('attaches each file to the folder that holds it', () => {
  const tree = buildTree(
    ['Green Desert'],
    [file('Green Desert', 'green.cue', 'cue'), file('Green Desert', 'cover.JPEG', 'image')],
  );

  const album = tree.children[0];
  assert.deepEqual(
    album?.files.map((f) => f.name).sort(),
    ['cover.JPEG', 'green.cue'],
  );
  // The virtual root holds nothing of its own when the album is a real folder.
  assert.deepEqual(tree.files, []);
});

test('files sitting directly in the root attach to the root', () => {
  // Scanning a folder that IS the album is normal — the root is then the album.
  const tree = buildTree([], [file('', 'green.cue', 'cue')]);

  assert.equal(tree.relPath, '');
  assert.deepEqual(
    tree.files.map((f) => f.name),
    ['green.cue'],
  );
});

test('a file whose folder was never listed still lands somewhere', () => {
  // Defensive: an inconsistent walk must not silently drop a file.
  const tree = buildTree([], [file('Some Album', 'track.flac')]);

  const album = tree.children.find((c) => c.relPath === 'Some Album');
  assert.ok(album, 'the missing folder should be synthesised');
  assert.equal(album?.files[0]?.name, 'track.flac');
});

test('children are ordered deterministically', () => {
  const tree = buildTree(['b', 'a', 'c'], []);
  assert.deepEqual(
    tree.children.map((c) => c.relPath),
    ['a', 'b', 'c'],
  );
});
