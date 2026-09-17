#!/usr/bin/env node
/**
 * The publishability gate: what must not be in a copy that leaves this machine.
 *
 *   node deploy/check-publishable.mjs [dir] [--shapes-only]   # default: the current directory
 *
 * **Run it on the curated copy, not on the development tree.** The development
 * tree keeps its meta deliberately — `.mappa/`, `AGENTS.md`, `.pi/` are tracked
 * there, and the private host lives in `.mappa/config.yaml` on purpose. A gate
 * run against the tree is red every day, and a gate that is red every day is a
 * gate nobody reads. The copy is the artefact; the copy is what is checked.
 *
 * Two questions, and both are about the copy:
 *
 *   1. **private VALUES — zero hits.** By value, not by name: `.mappa` in a
 *      `.gitignore` line is not a leak and must not be reported as one, while a
 *      hostname, a machine name or the collection's own path is a leak wherever
 *      it appears.
 *   2. **meta files in the tree — none**, at any depth, not only at the top.
 *
 * **Which values, and why the list is split in two.** Shapes are named here and
 * are safe to publish: a Windows drive letter, a workstation prefix, the name of
 * a registry product. The *identifiers* of this estate — the private git host,
 * its registry, the leading characters of an administrative token, the operator,
 * the LAN the live server sits on, the NAS marker — are **not** in this file:
 * this file travels to the public repository, and a gate that publishes what it
 * forbids is worse than no gate. They arrive by environment instead:
 *
 *   FUNOTEKA_PRIVATE_VALUES='git.example.site,some-handle'  node deploy/check-publishable.mjs .
 *
 * CI supplies them from a repository secret, so the public workflow carries the
 * check and not the values.
 *
 * **The identifiers are required, not optional.** Without them the gate knows
 * three shapes and nothing else, and a green verdict would mean far less than it
 * looks like it means — so it exits 2 and says so. `--shapes-only` is the
 * explicit way to ask for the reduced check, and it is a way to say "I know this
 * is weaker", not a default.
 *
 * **One file is exempt from the shape scan and not from the rest:** this one,
 * wherever a copy of this repository keeps it (`deploy/check-publishable.mjs`)
 * and whichever copy is the one running. It names the shapes it forbids, so it
 * matches itself, and a gate that reports itself as a leak is a gate that gets
 * switched off. The exemption is by that path and by this file's own resolved
 * path, so it holds whoever runs it and from wherever — and it covers the built-in
 * shapes only: anything arriving through `FUNOTEKA_PRIVATE_VALUES` is checked here
 * too, which is what keeps this file honest about the only values that would
 * matter if they appeared in it.
 *
 * Exit code: 0 clean, 1 findings, 2 misused (bad directory, or identifiers
 * missing without `--shapes-only`). A gate that cannot fail would be a report,
 * and a green report is not a check.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const shapesOnly = argv.includes('--shapes-only');
const target = resolve(argv.find((argument) => !argument.startsWith('--')) ?? '.');

try {
  if (!statSync(target).isDirectory()) throw new Error('not a directory');
} catch (error) {
  console.error(`cannot read ${target}: ${error.message}`);
  process.exit(2);
}

/**
 * Shapes: generic markers, safe to name in public, and each one a leak wherever
 * it appears.
 *
 * **A private IPv4 range is deliberately NOT one of them.** `10.0.0.0/8` is
 * what every page about an address allowlist says, including this project's own
 * documentation and its tests — a rule against private ranges flags the
 * documentation for documenting the feature, and 57 such lines is how a gate
 * gets switched off. `music/` is absent for the same reason: `/music` is the
 * container's mount point and is public by design.
 *
 * So what stays here is what is generic, and what names *this* estate goes to
 * `FUNOTEKA_PRIVATE_VALUES` — including the LAN the live server sits on, which
 * is an identifier of this estate and not a shape.
 */
const SHAPES = [
  { pattern: /\bZ:\\/, why: 'the collection drive' },
  { pattern: /DESKTOP-/, why: 'a workstation name' },
  { pattern: /verdaccio/, why: 'a private registry' },
];

/**
 * Identifiers of this estate, supplied from outside (see the header). Each is
 * matched literally after escaping, **unanchored and case-sensitive**: an
 * unanchored substring is the strict reading — a value inside a longer word is
 * still the value — and the price of that strictness is that the values must be
 * specific. A one- or two-character value would match half the tree, so short
 * ones are reported as a warning rather than quietly trusted.
 */
const supplied = (() => {
  const raw = process.env.FUNOTEKA_PRIVATE_VALUES ?? '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map((value) => ({ pattern: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), why: 'supplied as private' }));
})();

if (supplied.length === 0 && !shapesOnly) {
  console.error('the estate identifiers were not supplied — set FUNOTEKA_PRIVATE_VALUES, or pass --shapes-only');
  console.error('  (--shapes-only checks three generic shapes and no hostname, handle or token, and says so in its verdict)');
  process.exit(2);
}
for (const { pattern } of supplied) {
  const value = pattern.source.replace(/\\(.)/g, '$1');
  if (value.length < 4) console.warn(`  warning: supplied value ${JSON.stringify(value)} is very short — expect false positives`);
}

/**
 * Meta that belongs to the development tree, by name or by directory anywhere in
 * the tree. `README.ru.md` is here because the public README is English and the
 * Russian one is a development note that is not in the allowlist. `.env` and
 * `funoteka.json` are not meta, they are somebody's machine — a copy made from a
 * working checkout would otherwise carry credentials or a port — so the report
 * heading says "meta and machine-local files" rather than calling them meta.
 */
const META_FILES = ['AGENTS.md', 'CLAUDE.md', '.mappa-manifest.json', 'README.ru.md', '.env', 'funoteka.json'];
const META_DIRS = ['.mappa', '.pi', '.wiki', '.tasks'];

/** A file this large is read in one piece; past the cap it is named, not read. */
const MAX_BYTES = 16 * 1024 * 1024;

const selfPath = realpathSync(import.meta.filename);
const selfRelative = 'deploy/check-publishable.mjs';

const rules = [
  ...SHAPES.map(({ pattern, why }) => ({ pattern, why, selfExempt: true })),
  ...supplied.map(({ pattern, why }) => ({ pattern, why, selfExempt: false })),
];
const hits = rules.map(() => []);
const skipped = { large: 0, other: 0 };
const meta = new Set();

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield path;
      if (entry.name === '.git' || entry.name === 'node_modules' || META_DIRS.includes(entry.name)) continue;
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

/**
 * Both readings of a file, because a private value does not care how the bytes
 * were encoded: UTF-8 lossy (which is what a PNG's text chunk or a PDF reads as)
 * and, when there are NUL bytes, UTF-16 as well — a `.env`-shaped file saved by
 * a Windows editor is UTF-16 and would otherwise be skipped as "binary".
 */
function textsOf(path) {
  const bytes = readFileSync(path);
  const texts = [bytes.toString('utf8')];
  if (bytes.includes(0)) texts.push(bytes.toString('utf16le'));
  return texts;
}

const targetPrefix = target.endsWith(sep) ? target : target + sep;
let files = 0;

try {
  for (const path of walk(target)) {
    const relativePath = relative(target, path).split(sep).join('/');
    const parts = relativePath.split('/');
    const metaDir = parts.findIndex((part) => META_DIRS.includes(part));
    if (metaDir >= 0) meta.add(parts.slice(0, metaDir + 1).join('/'));
    else if (META_FILES.includes(basename(relativePath))) meta.add(relativePath);

    if (metaDir >= 0 || !statSync(path).isFile()) continue;

    const stats = statSync(path);
    if (stats.size > MAX_BYTES) {
      skipped.large += 1;
      continue;
    }
    if (realpathSync(path) === selfPath || relativePath === selfRelative) {
      // Scanned only for the supplied identifiers; see the header.
      const text = readFileSync(path, 'utf8');
      text.split('\n').forEach((line, index) => {
        rules.forEach((rule, position) => {
          if (rule.selfExempt) return;
          const match = rule.pattern.exec(line);
          if (match) hits[position].push(`${relativePath}:${index + 1}: ${line.slice(Math.max(0, match.index - 40), match.index + 60)}`);
        });
      });
      files += 1;
      continue;
    }

    files += 1;
    for (const text of textsOf(path)) {
      text.split('\n').forEach((line, index) => {
        rules.forEach((rule, position) => {
          const match = rule.pattern.exec(line);
          if (match) hits[position].push(`${relativePath}:${index + 1}: ${line.slice(Math.max(0, match.index - 40), match.index + 60)}`);
        });
      });
    }
  }
} catch (error) {
  console.error(`the walk stopped: ${error.message}`);
  process.exit(2);
}

const shown = relative(process.cwd(), target) || basename(target);
console.log(`funoteka publishability gate — ${shown === '' ? basename(target) : shown}`);
console.log(`  ${files} text file(s) read`);
if (skipped.large > 0) console.log(`  ${skipped.large} file(s) skipped: larger than ${MAX_BYTES} bytes`);
console.log(
  supplied.length === 0
    ? '  identifiers: SHAPES ONLY — requested with --shapes-only, not a full check'
    : `  identifiers: ${supplied.length} supplied via FUNOTEKA_PRIVATE_VALUES`,
);
console.log();

let findings = 0;
console.log('private values (by value, not by meta name):');
for (const [position, rule] of rules.entries()) {
  const found = hits[position];
  if (found.length === 0) continue;
  findings += 1;
  console.log(`  ✗ ${rule.pattern} — ${rule.why}: ${found.length} line(s)`);
  for (const line of found.slice(0, 5)) console.log(`      ${line}`);
  if (found.length > 5) console.log(`      … and ${found.length - 5} more`);
}
if (findings === 0) console.log('  ✓ zero hits');

console.log('\nmeta and machine-local files in the tree:');
if (meta.size === 0) console.log('  ✓ none');
else {
  findings += meta.size;
  for (const name of [...meta].sort()) console.log(`  ✗ ${name}`);
}

console.log(`\nverdict: ${findings === 0 ? 'publishable' : `NOT publishable — ${findings} finding(s)`}`);
process.exit(findings === 0 ? 0 : 1);
