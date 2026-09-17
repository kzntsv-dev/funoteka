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
 * because a tree that has one is a built tree, the source is the fallback.
 *
 * ## The base is the caller's, and it is a parameter rather than a default
 *
 * `from` has **no default on purpose.** It had one — `import.meta.url`, which
 * reads as "here" and is evaluated *in this file*: so a caller writing
 * `entryPoint('./cli')` from `src/cli.ts` was asking for a sibling of
 * `src/cli/entry.ts`, and got `src/cli/cli.ts`, which does not exist. The server
 * answered `202` to `POST /scan`, the child died on `MODULE_NOT_FOUND`, and the
 * only trace was in the child's stderr — `issue:91`, and it reached a released
 * image because nothing in the suite ran the command the scanner builds. A
 * required parameter turns that from a silent wrong path into a compile error at
 * the next call site, which is the version of this that cannot happen again.
 *
 * ## And a path that is not there is a throw, not a guess
 *
 * The first version returned the `.ts` spelling whether or not it existed, so a
 * wrong base travelled out of here as a plausible-looking string and failed
 * somewhere else entirely. Now the search either finds a file or says so.
 */
export function entryPoint(relative: string, from: string | URL): string {
  const emitted = fileURLToPath(new URL(`${relative}.js`, from));
  if (existsSync(emitted)) return emitted;

  const source = fileURLToPath(new URL(`${relative}.ts`, from));
  if (existsSync(source)) return source;

  throw new Error(
    `no entry point beside ${fileURLToPath(from)}: neither ${emitted} nor ${source} exists. ` +
      `A relative name is resolved against the base the caller passes, so a base that is not ` +
      `the calling module's own URL looks in the wrong directory.`,
  );
}
