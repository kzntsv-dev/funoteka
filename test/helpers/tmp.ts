import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

/**
 * A throwaway directory for one test, and the promise that it goes away.
 *
 * Every suite here makes one the same way — `mkdtempSync(join(tmpdir(), …))` —
 * and most remove it on the last line of the test body. **That line is not
 * reached when an assertion above it throws**, so a red test is a directory left
 * in the system temp for good: 617 of them had collected from the failures of
 * one week by the time anybody counted (task:2922). Cleanup that happens only on
 * the happy path is not cleanup.
 *
 * The guarantee is the hook and not the last line. `after` runs when this file's
 * tests are done, whatever they did, and removes everything the file made. A
 * test that removes its own directory sooner is welcome to: that is prompt, and
 * this is certain.
 *
 * Registered at import, so it belongs to the *file* that imported it — the test
 * runner gives every file a process of its own, and `after` called at the top
 * level of a file runs once that file is finished, red or green.
 */
const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

/** A directory under the system temp, with `prefix` in its name, removed at the end of the file. */
export function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
