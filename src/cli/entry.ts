import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A sibling entry point, named as *this* build spells it.
 *
 * Two places spawn this program as a child: the scanner the admin surface starts
 * (`POST /scan` and the interval timer), and the daemon's own start. Both used to
 * name `cli.ts`, which is right in the repository — Node strips the types itself —
 * and wrong in the compiled build the npm package ships, where the file is
 * `cli.js` and no `cli.ts` exists. The package would install, answer `--help`, and
 * then fail to scan or to daemonise, which is the kind of breakage that looks
 * like a missing feature rather than a missing file.
 *
 * Asking the filesystem instead of inferring the answer from the caller's own
 * extension makes it checkable rather than assumed: the emitted file is preferred
 * because a tree that has one is a built tree, the source is the fallback, and
 * neither existing names the source — so the failure reads as "the build did not
 * run" rather than as a `.js` that was never going to be there.
 */
export function entryPoint(relative: string, from: string | URL = import.meta.url): string {
  const emitted = fileURLToPath(new URL(`${relative}.js`, from));
  if (existsSync(emitted)) return emitted;
  return fileURLToPath(new URL(`${relative}.ts`, from));
}
