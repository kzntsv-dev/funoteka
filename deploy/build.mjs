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
 * Two steps, because `tsc` emits TypeScript and the program also reads `.sql`:
 * the schema migrations live beside the code that applies them
 * (`src/db/migrations`, found through `import.meta.dirname`), so they are copied
 * to the same place under `dist`. A build that compiled the code and left the
 * schema behind would produce a package that starts and then cannot open a
 * database.
 *
 * Exit code 0 on a complete build, 1 otherwise. The last thing it does is check
 * that the two things a run needs are where a run looks for them.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

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

/** Every file under `src` that is not TypeScript, at the same relative path. */
function copyAssets(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const from = join(dir, entry.name);
    if (entry.isDirectory()) {
      copyAssets(from);
      continue;
    }
    if (entry.name.endsWith('.ts')) continue;
    const to = join('dist', relative('src', from));
    mkdirSync(join(to, '..'), { recursive: true });
    cpSync(from, to);
  }
}
copyAssets('src');

const entry = join('dist', 'cli.js');
const migrations = join('dist', 'db', 'migrations');
const built = existsSync(migrations) ? readdirSync(migrations).length : 0;
const expected = readdirSync(join('src', 'db', 'migrations')).length;
const size = existsSync(entry) ? statSync(entry).size : 0;

console.log(`dist/cli.js ${size} bytes, ${built}/${expected} migration(s) beside it`);
if (size === 0 || built !== expected) {
  console.error('the build is not complete: the entry point or the schema is missing');
  process.exit(1);
}
