import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeFile } from '../src/probe/ffprobe.ts';
import { tempRoot } from './helpers/tmp.ts';

function available(bin: string): boolean {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const TOOLS = available('ffprobe') && available('ffmpeg');
const skipWithoutTools = TOOLS ? false : 'ffmpeg/ffprobe are not installed';

test('a real audio file is probed for its duration and format', { skip: skipWithoutTools }, () => {
  const dir = tempRoot('funoteka-probe-');
  const file = join(dir, 'tone.wav');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '1', file], {
    stdio: 'ignore',
  });

  const probe = probeFile(file);

  assert.equal(probe.ok, true);
  assert.equal(probe.err, null);
  // Encoders pad, so allow a little slack rather than demanding 2000 exactly.
  assert.ok(
    probe.durationMs !== null && Math.abs(probe.durationMs - 2000) < 100,
    `expected ~2000ms, got ${probe.durationMs}`,
  );
  assert.equal(probe.channels, 1);
  assert.ok(probe.codec?.startsWith('pcm'), `unexpected codec ${probe.codec}`);

  rmSync(dir, { recursive: true, force: true });
});

test('a file ffprobe cannot read fails without throwing', () => {
  const dir = tempRoot('funoteka-probe-');
  const file = join(dir, 'notaudio.flac');
  writeFileSync(file, 'this is plainly not a FLAC stream');

  const probe = probeFile(file);

  assert.equal(probe.ok, false);
  assert.ok(probe.err, 'a failed probe has to say why');
  assert.equal(probe.durationMs, null);

  rmSync(dir, { recursive: true, force: true });
});

test('a file that is not there fails without throwing', () => {
  const probe = probeFile(join(tmpdir(), 'funoteka-does-not-exist.flac'));

  assert.equal(probe.ok, false);
  assert.ok(probe.err);
});

test('a missing ffprobe binary degrades instead of aborting the scan', () => {
  // ffprobe is optional: without it the library still scans, the closing track
  // of a cue split just has no end. This is the graceful-degradation path.
  const probe = probeFile('anything.flac', { ffprobePath: 'ffprobe-does-not-exist-anywhere' });

  assert.equal(probe.ok, false);
  assert.ok(probe.err);
});
