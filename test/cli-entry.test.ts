import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
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

test('with neither file it throws, naming both places it looked', () => {
  // **This used to return the source's name whether or not it existed**, and
  // that is how `issue:91` reached a released image: a base pointing at the wrong
  // directory produced a plausible-looking string, the server answered `202`, and
  // the child died on `MODULE_NOT_FOUND` in a log nobody was reading. A path that
  // is not there is a failure of the thing that asked for it, and it belongs
  // here — where the caller still knows which base it passed.
  const root = tempRoot('funoteka-entry-');

  assert.throws(
    () => entryPoint('./cli', pathToFileURL(join(root, 'caller.ts')).href),
    (err: Error) => {
      assert.match(err.message, /no entry point beside/);
      assert.ok(err.message.includes(join(root, 'cli.js')), 'says which emitted file it wanted');
      assert.ok(err.message.includes(join(root, 'cli.ts')), 'and which source');
      return true;
    },
  );
});

test('the name is relative to the caller, and this is what that punishes', () => {
  // **The bug, spelled as the mistake that caused it.** `entryPoint` used to
  // default its base to `import.meta.url` — evaluated in `entry.ts`, so a caller
  // in `src/cli.ts` asking for `./cli` was asking for a sibling of
  // `src/cli/entry.ts` and got `src/cli/cli.ts`. Here the wrong base is passed on
  // purpose, and the only correct answer is a refusal: if this test ever returns
  // a string, the server is one `POST /scan` away from a dead child again.
  const besideTheHelper = new URL('../src/cli/entry.ts', import.meta.url);

  assert.throws(
    () => entryPoint('./cli', besideTheHelper),
    /no entry point beside/,
    'a base that is not the caller’s own URL must not be answered with a path',
  );
});

test('the two spawn sites name files that exist in this tree', () => {
  // What nothing checked, and why `issue:91` got out: the suite tested
  // `entryPoint` with bases it made up, and never the pair each caller actually
  // uses. These are those pairs — `src/cli.ts` asks for `./cli`, and
  // `src/cli/daemon.ts` for `../cli` — resolved from the callers' own URLs.
  const cliTs = new URL('../src/cli.ts', import.meta.url);
  const daemonTs = new URL('../src/cli/daemon.ts', import.meta.url);

  const fromServer = entryPoint('./cli', cliTs);
  const fromDaemon = entryPoint('../cli', daemonTs);

  assert.ok(existsSync(fromServer), `${fromServer} must exist — it is what POST /scan spawns`);
  assert.equal(fromServer, fromDaemon, 'both spawn the same file, named from two directories');
});

test('the answer is a path on disk, not a URL', () => {
  const root = tempRoot('funoteka-entry-');
  writeFileSync(join(root, 'cli.ts'), '');

  // `spawn` takes a path; a `file://` URL passed as one is a file named
  // `file:` on Windows and a plausible-looking failure everywhere else.
  const resolved = entryPoint('./cli', pathToFileURL(join(root, 'caller.ts')).href);
  assert.ok(!resolved.startsWith('file:'), resolved);
});
