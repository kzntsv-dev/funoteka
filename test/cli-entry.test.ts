import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { entryPoint } from '../src/cli/entry.ts';
import { tempRoot } from './helpers/tmp.ts';

test('the source is named where there is no build', () => {
  // The repository is this case: `src/cli.ts` exists, `src/cli.js` does not, and
  // a child spawned as `cli.js` would not start. This is what every run of
  // `serve --daemon` and every admin `POST /scan` depends on.
  const root = tempRoot('funoteka-entry-');
  writeFileSync(join(root, 'cli.ts'), '');

  assert.equal(entryPoint('./cli', pathToFileURL(join(root, 'caller.ts')).href), join(root, 'cli.ts'));
});

test('the emitted file wins where there is one — this is the compiled build', () => {
  // The npm package is this case, and the reason the function takes the file
  // system's word for it: `dist/cli.ts` does not exist, and a child named after
  // the source cannot run from under `node_modules` at all.
  const root = tempRoot('funoteka-entry-');
  writeFileSync(join(root, 'cli.ts'), '');
  writeFileSync(join(root, 'cli.js'), '');

  assert.equal(entryPoint('./cli', pathToFileURL(join(root, 'caller.js')).href), join(root, 'cli.js'));
});

test('with neither file the answer still names the source', () => {
  // A broken build, and the failure belongs to the spawn — it says which file it
  // could not run. Naming the source keeps that message pointed at the build
  // that did not happen, not at a `.js` nobody ever promised.
  const root = tempRoot('funoteka-entry-');

  assert.equal(entryPoint('./cli', pathToFileURL(join(root, 'caller.ts')).href), join(root, 'cli.ts'));
});

test('the answer is a path on disk, not a URL', () => {
  const root = tempRoot('funoteka-entry-');
  writeFileSync(join(root, 'cli.ts'), '');

  // `spawn` takes a path; a `file://` URL passed as one is a file named
  // `file:` on Windows and a plausible-looking failure everywhere else.
  const resolved = entryPoint('./cli', pathToFileURL(join(root, 'caller.ts')).href);
  assert.ok(!resolved.startsWith('file:'), resolved);
});
