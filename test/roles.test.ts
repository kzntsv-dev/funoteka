import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignRoles, discNumber, isDiscName } from '../src/classify/roles.ts';
import type { FolderNode } from '../src/classify/tree.ts';
import type { WalkedFile } from '../src/scan/walk.ts';

function audioFiles(relPath: string, count: number): WalkedFile[] {
  return Array.from({ length: count }, (_, i) => ({
    relPath: `${relPath}/t${i}.flac`,
    folderRelPath: relPath,
    name: `t${i}.flac`,
    kind: 'audio' as const,
    ext: 'flac',
    size: 1,
    mtimeMs: 1,
  }));
}

function node(name: string, children: FolderNode[] = [], audio = 0): FolderNode {
  return { relPath: name, name, files: audioFiles(name, audio), children, role: null };
}

test('disc folder names are recognised', () => {
  for (const name of ['CD1', 'CD 1', 'cd2', 'CD01', 'Disc 1', 'Disc 10', 'DISK 3', 'd1', 'D2']) {
    assert.equal(isDiscName(name), true, `expected "${name}" to be a disc`);
  }
  for (const name of ['CD', 'Disco', 'CDX', 'Discography', 'd', '1971 - d1', 'album']) {
    assert.equal(isDiscName(name), false, `expected "${name}" not to be a disc`);
  }
});

test('a disc folder may carry its album name after the number', () => {
  // Maschina Records lays a Kino box out as `CD1 ● Группа крови` — the number
  // leads, but the folder is not *only* a number, and an anchored read saw
  // those nine boxes as ordinary category folders.
  for (const name of ['CD1 ● Альбом', 'CD3 ● Live `82', 'CD 2 ● Диск', 'Disc 1 [JP]']) {
    assert.equal(isDiscName(name), true, `expected "${name}" to be a disc`);
  }
});

test('a box name with a catalogue suffix is not a disc', () => {
  // `\b` is what keeps this apart: nothing separates `3` from `CD` in `3CD)`,
  // so the marker never starts mid-word and the box folder stays a box.
  for (const name of [
    '1982 ● 45 (Каталог Maschina Records, MKK821CD, 3CD)',
    '2021 ● Кинохроники 2021~1982 (MASHCD-099, 2CD)',
  ]) {
    assert.equal(isDiscName(name), false, `expected "${name}" not to be a disc`);
  }
});

test('disc numbers come out of the name', () => {
  assert.equal(discNumber('CD1'), 1);
  assert.equal(discNumber('CD 12'), 12);
  assert.equal(discNumber('Disc 03'), 3);
  assert.equal(discNumber('d2'), 2);
  assert.equal(discNumber('Opiate'), null);
});

test('a disc states its number even behind an album name', () => {
  // A stated marker outranks position, exactly as it does for a flat pair: a
  // box missing its `CD1` must still number its second disc 2.
  assert.equal(discNumber('CD1 ● Альбом'), 1);
  assert.equal(discNumber('CD3 ● Live `82'), 3);
  assert.equal(discNumber('1982 ● 45 (MKK821CD, 3CD)'), null);
});

test('a folder holding audio is an album', () => {
  const album = node('Opiate', [], 6);
  assert.equal(assignRoles(album), 'album');
  assert.equal(album.role, 'album');
});

test('a folder holding only albums is a category', () => {
  const category = node('Trance', [node('Ibiza 2026', [], 39)]);
  assert.equal(assignRoles(category), 'category');
  assert.equal(category.children[0]?.role, 'album');
});

test('a folder holding nothing playable is empty', () => {
  const junk = node('scans', [node('notes')]);
  assert.equal(assignRoles(junk), 'empty');
  assert.equal(junk.children[0]?.role, 'empty');
});

test('several CD folders make their parent a box and themselves discs', () => {
  // The Disintegration case: box-CD12 versus the standalone album.
  const box = node('Disintegration', [node('CD1', [], 12), node('CD2', [], 12), node('CD3', [], 12)]);

  assert.equal(assignRoles(box), 'box');
  assert.deepEqual(
    box.children.map((c) => c.role),
    ['disc', 'disc', 'disc'],
  );
});

test('a box whose discs carry a name after the number is still a box', () => {
  const box = node('1988 ● Группа крови (MKK881CD, 3CD)', [
    node('CD1 ● Группа крови', [], 10),
    node('CD2 ● Бонусы', [], 8),
    node('CD3 ● Live', [], 6),
  ]);

  assert.equal(assignRoles(box), 'box');
  assert.deepEqual(
    box.children.map((c) => c.role),
    ['disc', 'disc', 'disc'],
  );
});

test('a box that says how many discs it holds is a box without a disc marker', () => {
  // `The Cure - Assemblage - 1991 (12CD FLAC)` lays its twelve out as
  // `01 - Three Imaginary Boys (1979)`, `02 - Boys Don't Cry (1980)`, … — none
  // of them a disc marker, so the structural rule above sees twelve albums in a
  // folder and calls it a category. The box then does not exist as a record,
  // and each disc is shown as its own with the box's name appended to it.
  //
  // The count is the evidence, and it is the collector's own: the name says how
  // many discs there are. It is checked rather than trusted, because the cost
  // of a wrong box is one this project has already paid — every record inside
  // collapses into a disc of it.
  const box = node('The Cure - Assemblage - 1991 (2CD FLAC)', [
    node('01 - Three Imaginary Boys (1979)', [], 13),
    node("02 - Boys Don't Cry (1980)", [], 12),
  ]);

  assert.equal(assignRoles(box), 'box');
  assert.deepEqual(
    box.children.map((c) => c.role),
    ['disc', 'disc'],
  );
});

test('a folder that holds a different number of records than it claims is not a box', () => {
  // The count is a claim, and a claim the folder does not keep is no evidence
  // at all. Without this the rule would be "the name mentions CDs", which is
  // the shelf case: eight rips under a folder that happens to say `2CD`.
  const shelf = node('Slipknot AAC 320 (2CD FLAC)', [
    node('1999 - Slipknot', [], 14),
    node('2001 - Iowa', [], 14),
    node('2004 - Vol. 3', [], 14),
  ]);

  assert.equal(assignRoles(shelf), 'category');
  assert.deepEqual(
    shelf.children.map((c) => c.role),
    ['album', 'album', 'album'],
  );
});

test('a catalogue number is not a disc count', () => {
  // `MKK821CD` names a pressing, not a box — but read loosely, as the digits of
  // the run before `CD`, it says twenty-one. The folder below holds twenty-one
  // albums on purpose: a count that could be read out of a catalogue number
  // would turn it into a box of twenty-one discs, which is the failure the
  // number has to stand on its own to prevent.
  const shelf = node(
    '1982 ● 45 (MKK821CD)',
    Array.from({ length: 21 }, (_, i) => node(`Album ${i}`, [], 4)),
  );

  assert.equal(assignRoles(shelf), 'category');
});

test('a single CD folder is not a box', () => {
  // One disc does not make a release; calling it one would split real albums.
  const parent = node('Opiate', [node('CD1', [], 6)], 0);

  assert.equal(assignRoles(parent), 'category');
  assert.equal(parent.children[0]?.role, 'album');
});

test('empty CD folders do not make a box', () => {
  // Disc detection keys on audio actually being there, not on the name alone.
  const parent = node('Opiate', [node('CD1'), node('CD2')]);
  assert.equal(assignRoles(parent), 'empty');
});

test('a folder with audio is an album even when it also has subfolders', () => {
  const album = node('Opiate', [node('bonus', [], 2)], 6);
  assert.equal(assignRoles(album), 'album');
});

test('classifying the same tree twice gives the same answer', () => {
  const box = node('Disintegration', [node('CD1', [], 3), node('CD2', [], 3)]);
  assignRoles(box);
  const first = box.children.map((c) => c.role);
  assignRoles(box);
  assert.deepEqual(
    box.children.map((c) => c.role),
    first,
  );
});

test('a catalogue number is not a disc number', () => {
  // Melodiya numbers its series `MEL CD <series> <number>`: `MEL CD 60 00842`
  // is the 842nd release of the 60 series. Read as a marker it made all twenty
  // CDs of a series folder into one box of twenty discs (task:2713), and gave
  // every one of them `disc_number = 60` on top (task:2715).
  const catalogue = '(01) (2005) Dixie-balls. Tequila (Музыка для парков) (MEL CD 60 00842)';

  assert.equal(discNumber(catalogue), null);
  assert.equal(isDiscName(catalogue), false);
});

test('a disc number still reads when a name follows it', () => {
  // The guard above must not cost the layouts that are discs. A number is a
  // disc number when it stands on its own, and a name after it changes nothing.
  assert.equal(discNumber('CD 2 - Disk Union Bonus'), 2);
  assert.equal(discNumber('The Wall [Disc 1]'), 1);
  assert.equal(discNumber('The Wall [1994 Remaster](Disc 2)'), 2);
  assert.equal(discNumber('Disc 1 [JP]'), 1);
});

test('a series of independent CDs is a category, not a box', () => {
  // The failing sample: twenty CDs by twenty different artists, each with its
  // own catalogue number. Nothing about them says one release, and §3 of
  // requirements:39 makes the distinction the classifier's job.
  const series = node('Серия «Подлинная история отечественной легкой музыки»', [
    node('(01) (2005) Dixie-balls. Tequila (Музыка для парков) (MEL CD 60 00842)', [], 14),
    node('(02) (2005) Это печаль не твоя (MEL CD 60 00893)', [], 14),
  ]);

  assert.equal(assignRoles(series), 'category');
  assert.deepEqual(
    series.children.map((c) => c.role),
    ['album', 'album'],
  );
});

test('a catalogue number beside a real disc marker does not hide it', () => {
  // The guard has to reject the catalogue token, not the name that carries it.
  // `DISC_MARKER` is read with `exec`, which takes the first match the
  // lookahead lets through, so a disc written after the catalogue number is
  // still found — and one written before it is read directly.
  assert.equal(discNumber('(MEL CD 60 00842) Album [Disc 2]'), 2);
  assert.equal(discNumber('Album [Disc 2] (MEL CD 60 00842)'), 2);
});
