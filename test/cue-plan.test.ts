import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planAlbum } from '../src/cue/plan.ts';
import { parseCue } from '../src/cue/parse.ts';
import type { WalkedFile } from '../src/scan/walk.ts';

function track(name: string): WalkedFile {
  return {
    relPath: `album/${name}`,
    folderRelPath: 'album',
    name,
    kind: 'audio',
    ext: name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
    size: 1000,
    mtimeMs: 1,
  };
}

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
TRACK 04 AUDIO
TITLE "Indian Summer"
INDEX 01 31:36:00
`;

// EAC writes `TITLE "(empty)"` for a division of the disc that carries no name —
// Undertow's tracks 10..68, the silence before its hidden track. The division is
// real (it has an INDEX 01, so it is part of the disc's structure), but the
// string is the ripper's marker and not a name: a client showing `(empty)` is
// showing the marker, not a title.

const PLACEHOLDER_CUE = `TITLE "Undertow"
PERFORMER "Tool"
FILE "Undertow.flac" WAVE
TRACK 01 AUDIO
TITLE "Intolerance"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "(empty)"
INDEX 01 04:00:00
TRACK 03 AUDIO
TITLE "(silence)"
INDEX 01 05:00:00
TRACK 04 AUDIO
TITLE "Disgustipated"
INDEX 01 06:00:00
`;

test('a ripper placeholder is not a track name', () => {
  const plan = planAlbum([track('Undertow.flac')], parseCue(PLACEHOLDER_CUE), {
    durationMs: () => 8 * 60_000,
  });

  assert.deepEqual(
    plan.tracks.map((t) => t.title),
    ['Intolerance', null, null, 'Disgustipated'],
  );
  // The divisions are the disc's structure and they stay. Only the marker goes.
  assert.equal(plan.tracks.length, 4);
  assert.deepEqual(
    plan.tracks.map((t) => t.segmentStartMs),
    [0, 4 * 60_000, 5 * 60_000, 6 * 60_000],
  );

  // Dropping is a decision the projection makes, and a dump showing `(untitled)`
  // where the cue said `(empty)` has no way to say why unless it is reported.
  const reported = plan.issues.find((issue) => issue.kind === 'ripper-marker-titles');
  assert.ok(reported, 'the drop has to be visible outside the track table');
  assert.equal(reported.severity, 'info', 'a normalisation is not a problem to act on');
  assert.match(reported.detail, /2 track/);
});

test('a marker is recognised whatever its case', () => {
  const cue = `TITLE "X"
FILE "x.flac" WAVE
TRACK 01 AUDIO
TITLE "(EMPTY)"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "A Real Name"
INDEX 01 01:00:00
`;
  const plan = planAlbum([track('x.flac')], parseCue(cue), { durationMs: () => 120_000 });

  assert.deepEqual(
    plan.tracks.map((t) => t.title),
    [null, 'A Real Name'],
  );
});

test('a placeholder is matched whole, never as a fragment', () => {
  // `Empty Spaces` is a Pink Floyd song and `(empty) (part two)` is a name
  // somebody wrote. A containment rule would erase both, which costs a real
  // title — and the failure mode of a *missing* placeholder is only a word left
  // visible, so the list stays short and the match stays whole.
  const cue = `TITLE "X"
FILE "x.flac" WAVE
TRACK 01 AUDIO
TITLE "Empty Spaces"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "(empty) (part two)"
INDEX 01 01:00:00
`;
  const plan = planAlbum([track('x.flac')], parseCue(cue), { durationMs: () => 120_000 });

  assert.deepEqual(
    plan.tracks.map((t) => t.title),
    ['Empty Spaces', '(empty) (part two)'],
  );
});

test('a placeholder standing in a file title is dropped too', () => {
  // The same marker reaches the meta layer from a tag, and the rule belongs
  // where a title becomes a track's name rather than at one of its sources.
  const files = [track('01.mp3'), track('02.mp3')];
  const plan = planAlbum(files, null, {
    titleOf: (file) => (file.name === '01.mp3' ? '(empty)' : 'A Real Name'),
  });

  assert.deepEqual(
    plan.tracks.map((t) => t.title),
    [null, 'A Real Name'],
  );
});

test('one image plus a cue splits into one segment per cue track', () => {
  const plan = planAlbum([track('Green Desert.m4a')], parseCue(IMAGE_CUE));

  assert.equal(plan.shape, 'image-cue');
  assert.equal(plan.tracks.length, 4);
  assert.deepEqual(
    plan.tracks.map((t) => [t.ordinal, t.segmentStartMs, t.segmentEndMs]),
    [
      [1, 0, 19 * 60_000 + 24_000],
      [2, 19 * 60_000 + 24_000, 24 * 60_000 + 30_000],
      [3, 24 * 60_000 + 30_000, 31 * 60_000 + 36_000],
      [4, 31 * 60_000 + 36_000, null],
    ],
  );
});

test('the last segment ends at the real duration of the image', () => {
  // A cue cannot bound its own final track — there is no following index. Only
  // the audio knows, which is why probing exists at all.
  const plan = planAlbum([track('Green Desert.m4a')], parseCue(IMAGE_CUE), {
    durationMs: () => 2_100_000,
  });

  assert.equal(plan.tracks[3]?.segmentEndMs, 2_100_000);
  assert.equal(plan.issues.length, 0);
});

test('an unprobeable image leaves the last segment open and says so', () => {
  const plan = planAlbum([track('Green Desert.m4a')], parseCue(IMAGE_CUE), {
    durationMs: () => null,
  });

  assert.equal(plan.tracks[3]?.segmentEndMs, null);
  assert.ok(
    plan.issues.some((i) => i.kind === 'unbounded-last-segment'),
    'the open end must be reported, not silently left null',
  );
});

test('every split track points at the same image file', () => {
  const plan = planAlbum([track('Green Desert.m4a')], parseCue(IMAGE_CUE));

  assert.deepEqual(
    [...new Set(plan.tracks.map((t) => t.file.name))],
    ['Green Desert.m4a'],
  );
});

test('a per-track performer wins, the album performer fills the gaps', () => {
  const cue = parseCue(`PERFORMER "Various Artists"
TITLE "Ibiza 2026"
FILE "mix.mp3" MP3
TRACK 01 AUDIO
TITLE "No Mercy"
PERFORMER "Armin van Buuren & Adam Beyer"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Here In My Arms"
INDEX 01 04:39:73
`);

  const plan = planAlbum([track('mix.mp3')], cue);

  assert.equal(plan.tracks[0]?.performer, 'Armin van Buuren & Adam Beyer');
  assert.equal(plan.tracks[1]?.performer, 'Various Artists');
});

test('separate audio files with a cue become the tracks themselves', () => {
  const cue = parseCue(`PERFORMER "The Cure"
TITLE "Disintegration"
FILE "01 - Plainsong.flac" WAVE
TRACK 01 AUDIO
TITLE "Plainsong"
INDEX 01 00:00:00
FILE "02 - Pictures of You.flac" WAVE
TRACK 02 AUDIO
TITLE "Pictures of You"
INDEX 01 05:17:00
`);

  const plan = planAlbum([track('01 - Plainsong.flac'), track('02 - Pictures of You.flac')], cue);

  assert.equal(plan.shape, 'tracks-cue');
  assert.equal(plan.tracks.length, 2);
  assert.deepEqual(
    plan.tracks.map((t) => [t.title, t.file.name, t.segmentStartMs, t.segmentEndMs]),
    [
      ['Plainsong', '01 - Plainsong.flac', null, null],
      ['Pictures of You', '02 - Pictures of You.flac', null, null],
    ],
  );
});

test('files and cue tracks that disagree in number are reported', () => {
  const cue = parseCue(`TITLE "Box"
FILE "a.flac" WAVE
TRACK 01 AUDIO
TITLE "One"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Two"
INDEX 01 03:00:00
TRACK 03 AUDIO
TITLE "Three"
INDEX 01 06:00:00
`);

  const plan = planAlbum([track('a.flac'), track('b.flac')], cue);

  assert.equal(plan.shape, 'tracks-cue');
  assert.ok(plan.issues.some((i) => i.kind === 'track-count-mismatch'));
});

test('a cue that does not describe these files contributes no names', () => {
  // Real case: a flat folder holding three ASOT discs, each with its own cue.
  // Identity makes it one album, but no single cue covers it — borrowing disc
  // 1's titles would label discs 2 and 3 with the wrong songs.
  const cue = parseCue(`PERFORMER "Various Artists"
TITLE "A State Of Trance: Ibiza 2026"
FILE "01. Pulse.mp3" MP3
TRACK 01 AUDIO
TITLE "No Mercy"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Here In My Arms"
INDEX 01 04:39:73
TRACK 03 AUDIO
TITLE "Lost Vagueness"
INDEX 01 08:50:40
`);

  const plan = planAlbum([track('01. Pulse.mp3'), track('02. Frequency.mp3')], cue);

  assert.equal(plan.shape, 'tracks-cue');
  assert.ok(plan.issues.some((i) => i.kind === 'track-count-mismatch'));
  // None of the cue's names was borrowed — and the files, which nothing else
  // describes, are then named after themselves, exactly as they would be with
  // no cue in the folder at all.
  assert.deepEqual(
    plan.tracks.map((t) => [t.title, t.titleSource]),
    [
      ['Pulse', 'name'],
      ['Frequency', 'name'],
    ],
  );
  assert.deepEqual(
    plan.tracks.map((t) => t.performer),
    [null, null],
  );
});

test('a cue that names one file does not name the others beside it', () => {
  // task:2723 — the counts line up (two tracks, two files), so counting said
  // the cue described this folder and laid its titles out positionally. But the
  // cue's own FILE tag names `img.flac` and nothing else; `bonus.flac` was
  // handed the stranger's second title under `title_source = 'cue'` — the same
  // false knowledge as task:2712, arriving by the other door.
  const cue = parseCue(`TITLE "Album"
FILE "img.flac" WAVE
TRACK 01 AUDIO
TITLE "Cue One"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Cue Two"
INDEX 01 03:00:00
`);

  const plan = planAlbum([track('bonus.flac'), track('img.flac')], cue);

  assert.equal(plan.shape, 'tracks-cue');
  assert.deepEqual(
    plan.tracks.map((t) => [t.title, t.titleSource, t.file.name]),
    [
      ['bonus', 'name', 'bonus.flac'],
      ['img', 'name', 'img.flac'],
    ],
  );
  // The reader is told why the cue's words are missing, rather than finding a
  // folder that quietly lost them.
  assert.ok(plan.issues.some((i) => i.kind === 'cue-describes-other-files'));
});

test('a pregap is swallowed by the end of the preceding track', () => {
  // Decided, not accidental: segments run INDEX 01 to INDEX 01, so the seconds
  // between INDEX 00 and INDEX 01 fall at the tail of the track before. Cutting
  // at INDEX 00 instead would put silence at the head of every track.
  const cue = parseCue(`TITLE "Pregap"
FILE "image.flac" WAVE
TRACK 01 AUDIO
TITLE "One"
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Two"
INDEX 00 05:15:00
INDEX 01 05:17:00
`);

  const plan = planAlbum([track('image.flac')], cue, { durationMs: () => 600_000 });

  assert.equal(plan.tracks[0]?.segmentStartMs, 0);
  assert.equal(plan.tracks[0]?.segmentEndMs, 5 * 60_000 + 17_000, 'track one ends where track two begins');
  assert.equal(plan.tracks[1]?.segmentStartMs, 5 * 60_000 + 17_000);
});

test('the whole image is not emitted as an extra track', () => {
  // "split + whole": the N segments are the tracks, the whole is the file row
  // they all point at. Duplicating it as a track would list every cue album
  // twice.
  const plan = planAlbum([track('Green Desert.m4a')], parseCue(IMAGE_CUE), {
    durationMs: () => 2_100_000,
  });

  assert.equal(plan.tracks.length, 4);
  assert.ok(
    plan.tracks.every((t) => t.segmentStartMs !== null && t.segmentEndMs !== null),
    'every track of a split is a segment, none is the whole file',
  );
});

test('a folder with no cue is just its audio files, in order', () => {
  const plan = planAlbum([track('b.flac'), track('a.flac')], null);

  assert.equal(plan.shape, 'tracks-only');
  assert.deepEqual(
    plan.tracks.map((t) => [t.ordinal, t.file.name]),
    [
      [1, 'a.flac'],
      [2, 'b.flac'],
    ],
  );
  // The file name is the last source there is, and `a.flac` does state one.
  assert.deepEqual(
    plan.tracks.map((t) => [t.title, t.titleSource]),
    [
      ['a', 'name'],
      ['b', 'name'],
    ],
  );
});

test('nothing describes these files, so their own names do', () => {
  // The Kroogi shape: nine untagged files, a folder name that states the credit
  // and the release group, and no cue anywhere. Before the name was a source
  // these were all `(untitled)`.
  const files = [
    track('01-aquarium_-_back_to_archangelsk-kroogi.mp3'),
    track('02-aquarium_-_red_river-kroogi.mp3'),
  ];
  const plan = planAlbum(files, null, { albumName: 'Aquarium_-_Archangelsk-2011-Kroogi.com' });

  assert.equal(plan.shape, 'tracks-only');
  assert.deepEqual(
    plan.tracks.map((t) => [t.title, t.titleSource]),
    [
      ['back to archangelsk', 'name'],
      ['red river', 'name'],
    ],
  );
});

test('a tag outranks the file name, which is the last word', () => {
  const files = [
    track('01-aquarium_-_back_to_archangelsk-kroogi.mp3'),
    track('02-aquarium_-_red_river-kroogi.mp3'),
  ];
  const plan = planAlbum(files, null, {
    albumName: 'Aquarium_-_Archangelsk-2011-Kroogi.com',
    titleOf: (file) => (file.name.startsWith('01') ? 'Back to Archangel' : null),
  });

  assert.deepEqual(
    plan.tracks.map((t) => [t.title, t.titleSource]),
    [
      ['Back to Archangel', 'tag'],
      ['red river', 'name'],
    ],
  );
});

test('a cue names the tracks, and no file is asked to name itself', () => {
  const cue = parseCue(`PERFORMER "The Cure"
TITLE "Disintegration"
FILE "01 - Plainsong.flac" WAVE
TRACK 01 AUDIO
TITLE "Plainsong"
INDEX 01 00:00:00
FILE "02 - Pictures of You.flac" WAVE
TRACK 02 AUDIO
TITLE "Pictures of You"
INDEX 01 05:17:00
`);

  const plan = planAlbum(
    [track('01 - Plainsong.flac'), track('02 - Pictures of You.flac')],
    cue,
    {
      titleOf: () => {
        throw new Error('a track the cue named must not be asked of the file');
      },
      albumName: 'Disintegration',
    },
  );

  assert.deepEqual(
    plan.tracks.map((t) => [t.title, t.titleSource]),
    [
      ['Plainsong', 'cue'],
      ['Pictures of You', 'cue'],
    ],
  );
});

test('a cue that names no track leaves the file to name itself', () => {
  // A TRACK with no TITLE is silence, not a refusal — and the file name is a
  // better answer to silence than an empty cell.
  const cue = parseCue(`TITLE "A Real Song"
FILE "01. A Real Song.flac" WAVE
TRACK 01 AUDIO
INDEX 01 00:00:00
`);

  const plan = planAlbum([track('01. A Real Song.flac')], cue);

  assert.equal(plan.shape, 'tracks-cue');
  assert.deepEqual(
    plan.tracks.map((t) => [t.title, t.titleSource]),
    [['A Real Song', 'name']],
  );
});

test('a marker in the cue is an answer, and it ends the chain there', () => {
  // The ripper wrote a marker where a name should be. That is not silence, so
  // nothing below it — no tag, no file name — is asked to fill the hole.
  const cue = parseCue(`TITLE "Undertow"
FILE "01. Intolerance.flac" WAVE
TRACK 01 AUDIO
TITLE "(empty)"
INDEX 01 00:00:00
`);

  const plan = planAlbum([track('01. Intolerance.flac')], cue, {
    titleOf: () => 'From a tag',
    albumName: 'Undertow',
  });

  assert.deepEqual(
    plan.tracks.map((t) => [t.title, t.titleSource]),
    [[null, null]],
  );
});

test('an image is never named after the file it lives in', () => {
  // One file covers the whole album, so its name describes the file rather than
  // track 7 — the same reason an image takes no tag title either.
  const untitled = parseCue(`TITLE "Green Desert"
FILE "Green Desert.m4a" WAVE
TRACK 01 AUDIO
INDEX 01 00:00:00
TRACK 02 AUDIO
INDEX 01 19:24:00
`);

  const plan = planAlbum([track('Green Desert.m4a')], untitled, {
    albumName: 'Green Desert',
    titleOf: () => 'From a tag',
  });

  assert.equal(plan.shape, 'image-cue');
  assert.deepEqual(
    plan.tracks.map((t) => [t.title, t.titleSource]),
    [
      [null, null],
      [null, null],
    ],
  );

  const named = planAlbum([track('Green Desert.m4a')], parseCue(IMAGE_CUE));
  assert.deepEqual(
    named.tracks.map((t) => [t.title, t.titleSource]),
    [
      ['Green Desert', 'cue'],
      ['White Clouds', 'cue'],
      ['Astral Voyager', 'cue'],
      ['Indian Summer', 'cue'],
    ],
  );
});

test('a single audio file with one cue track is a plain track, not a split', () => {
  const cue = parseCue(`TITLE "Single"
FILE "one.flac" WAVE
TRACK 01 AUDIO
TITLE "Only"
INDEX 01 00:00:00
`);

  const plan = planAlbum([track('one.flac')], cue);

  assert.equal(plan.shape, 'tracks-cue');
  assert.equal(plan.tracks.length, 1);
  assert.equal(plan.tracks[0]?.segmentStartMs, null);
});

test('data tracks in a mixed-mode cue are not turned into music', () => {
  const cue = parseCue(`TITLE "Mixed"
FILE "disc.bin" BINARY
TRACK 01 MODE1/2358
INDEX 01 00:00:00
TRACK 02 AUDIO
TITLE "Real Song"
INDEX 01 00:04:00
`);

  const plan = planAlbum([track('disc.flac')], cue);

  assert.equal(plan.tracks.length, 1);
  assert.equal(plan.tracks[0]?.title, 'Real Song');
});
