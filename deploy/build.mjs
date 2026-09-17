#!/usr/bin/env node
/**
 * The build, for the npm package and for nothing else.
 *
 *   node deploy/build.mjs
 *
 * **The repository runs its own TypeScript and needs no build.** `node
 * src/cli.ts` is the program, `npm test` is the suite, and TypeScript is a
 * dev-time tool — that is a property of this project worth keeping, and this
 * script does not take it away.
 *
 * The *package* is the one place it cannot hold. Node refuses to strip types
 * from any file under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),
 * and there is no flag that lifts it — checked on v24.19.0: the default, both
 * `--experimental-strip-types` and `--experimental-transform-types`, and the two
 * together all refuse. So a package whose `bin` names a `.ts` file installs and
 * then cannot start, which is what `npx -y funoteka mcp` would have done. The
 * published artifact therefore carries what `tsc` emits, and this is how it is
 * made.
 *
 * Two steps, because `tsc` emits TypeScript and the program also reads files
 * that are not: the schema migrations live beside the code that applies them
 * (`src/db/migrations`, found through `import.meta.dirname`). Every such file is
 * copied to the same place under `dist` — every one, not the migrations
 * specifically, so that a `.json` added tomorrow travels without anyone
 * remembering to extend this script — and then the copy is *checked* rather than
 * assumed. A build that compiled the code and left an asset behind would produce
 * a package that starts and then fails somewhere deeper, which is the kind of
 * failure that reads as a bug in the program.
 *
 * Exit code 0 on a complete build, 1 otherwise.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';

/** Every file under `src` that is not TypeScript, as a path relative to `src`. */
function assets(dir = 'src') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const from = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...assets(from));
      continue;
    }
    if (entry.name.endsWith('.ts')) continue;
    found.push(relative('src', from));
  }
  return found.sort();
}

const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error('no TypeScript in node_modules — run `npm ci` first');
  process.exit(1);
}

rmSync('dist', { recursive: true, force: true });

const compiled = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
if (compiled.status !== 0) {
  console.error(`tsc exited with ${compiled.status}`);
  process.exit(1);
}

const carried = assets();
for (const one of carried) {
  const to = join('dist', one);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join('src', one), to);
}

const entry = join('dist', 'cli.js');
const entrySize = existsSync(entry) ? statSync(entry).size : 0;
const missing = carried.filter((one) => !existsSync(join('dist', one)));
const schema = carried.filter((one) => one.endsWith('.sql'));

console.log(`dist/cli.js ${entrySize} bytes, ${carried.length - missing.length}/${carried.length} asset(s) beside it`);
if (entrySize === 0 || missing.length > 0) {
  for (const one of missing) console.error(`  not in dist: ${one}`);
  console.error('the build is not complete: the entry point or a file the program reads is missing');
  process.exit(1);
}
if (schema.length === 0) {
  console.error('no schema migrations under src — a package without them could not open a database');
  process.exit(1);
}
