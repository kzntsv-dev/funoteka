import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logToFile } from '../src/api/log-file.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The log file, tested by writing to the real streams.
 *
 * There is nothing to stub here: what the module does is make `process.stdout`
 * go to two places, and a fake stream would prove that a fake stream works.
 *
 * **Every test puts the streams back.** This module mutates two globals, and a
 * test that left them tapped would send the rest of the suite's output into a
 * directory the suite then deletes.
 */

/** Wait for the file to contain this, or give up saying what never arrived. */
async function untilIn(path: string, needle: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(path, 'utf8').includes(needle)) return;
    } catch {
      // Not there yet, which is what waiting is for.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${path} never came to contain ${JSON.stringify(needle)}`);
}

test('what the process narrates lands in the file as well as on the stream', async () => {
  const path = join(tempRoot('funoteka-log-'), 'funoteka.log');
  const stop = logToFile(path);

  try {
    process.stdout.write('funoteka: serving\n');
    process.stderr.write('funoteka: something went wrong\n');

    await untilIn(path, 'funoteka: serving');
    await untilIn(path, 'funoteka: something went wrong');
  } finally {
    stop();
  }
});

test('the file is appended to, not started over', async () => {
  // A restart must not cost the reason the last one happened, and a server that
  // truncated its log on every start would keep exactly the runs nobody needs.
  const path = join(tempRoot('funoteka-log-'), 'funoteka.log');
  const first = logToFile(path);
  process.stdout.write('the run before\n');
  await untilIn(path, 'the run before');
  first();

  const second = logToFile(path);
  try {
    process.stdout.write('the run after\n');
    await untilIn(path, 'the run after');
    const text = readFileSync(path, 'utf8');
    assert.match(text, /the run before/, 'and the earlier run is still in it');
  } finally {
    second();
  }
});

test('stopping it puts the streams back the way they were', async () => {
  const path = join(tempRoot('funoteka-log-'), 'funoteka.log');
  const stop = logToFile(path);
  process.stdout.write('before the stop\n');
  await untilIn(path, 'before the stop');

  stop();
  process.stdout.write('after the stop\n');
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.doesNotMatch(readFileSync(path, 'utf8'), /after the stop/);
});

test('a log file that cannot be opened is a line on stderr, not a refusal to serve', async () => {
  // The path is the thing that is wrong, and the operator finds out at once.
  // What must not happen is the server declining to run because its diagnostic
  // went somewhere impossible: that trades the product for a note about it.
  const said: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    said.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let stop: () => void;
  try {
    stop = logToFile(join(tempRoot('funoteka-log-'), 'no', 'such', 'place', 'funoteka.log'));
  } finally {
    process.stderr.write = real;
  }

  assert.match(said.join(''), /no log file at/);
  assert.doesNotThrow(() => {
    process.stdout.write('and the server carries on\n');
    stop();
  });
});
