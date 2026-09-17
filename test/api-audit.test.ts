import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { auditLog, auditPath } from '../src/api/audit.ts';
import { tempRoot } from './helpers/tmp.ts';

/**
 * The audit file, tested by writing one.
 *
 * It is the record of what was done to a server, and the two properties that
 * matter are not about formatting: that a line written before the answer is
 * already on disk when the answer is given, and that a file that cannot be
 * written is *reported* rather than thrown — the mutation it describes has
 * already happened by the time this runs, and a failure here must not describe
 * it as not having happened.
 */

test('a line is appended, as it was given', () => {
  const path = join(tempRoot('funoteka-audit-'), 'meta.db.audit.jsonl');
  const write = auditLog(path);

  assert.equal(write({ at: '2026-09-16T00:00:00.000Z', method: 'POST', path: '/restart', address: '10.0.0.1', status: 200 }), true);

  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    at: '2026-09-16T00:00:00.000Z',
    method: 'POST',
    path: '/restart',
    address: '10.0.0.1',
    status: 200,
  });
});

test('the file grows rather than being restarted, and reads back line by line', () => {
  // A restart must not cost the record of why it happened — and a server that
  // truncated its own history on every start would keep exactly the runs nobody
  // needs to ask about.
  const path = join(tempRoot('funoteka-audit-'), 'meta.db.audit.jsonl');
  const write = auditLog(path);

  write({ at: 'x', method: 'POST', path: '/config', address: 'a', status: 200 });
  write({ at: 'y', method: 'POST', path: '/restart', address: 'a', status: 200 });

  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[1] ?? '') as { path: string }).path, '/restart', 'and the last one is last');
});

test('a file that cannot be written is answered false, and said on stderr', () => {
  // Not thrown: the caller decides, and the caller is a route that has already
  // changed something. What it must not do is claim the record exists.
  const said: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    said.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let written: boolean;
  try {
    written = auditLog(join(tempRoot('funoteka-audit-'), 'no', 'such', 'place.jsonl'))({
      at: 'x',
      method: 'POST',
      path: '/config',
      address: 'a',
      status: 200,
    });
  } finally {
    process.stderr.write = real;
  }

  assert.equal(written, false);
  assert.match(said.join(''), /could not write/);
});

test('the audit file sits beside the meta layer, named after it', () => {
  // One directory per deployment, and the answer to "where is this deployment's
  // data" is one path rather than a list.
  assert.equal(auditPath('/data/funoteka.db'), '/data/funoteka.db.audit.jsonl');
});

test('a file that was already there is added to, not replaced', () => {
  const path = join(tempRoot('funoteka-audit-'), 'meta.db.audit.jsonl');
  writeFileSync(path, '{"at":"earlier"}\n');

  auditLog(path)({ at: 'later', method: 'POST', path: '/config', address: 'a', status: 200 });

  assert.match(readFileSync(path, 'utf8'), /earlier/);
});
