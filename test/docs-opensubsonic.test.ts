import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openSubsonicExtensions } from '../src/api/extensions.ts';
import { answeredMethods } from '../src/api/router.ts';
import { STUBBED, STUBBED_BYTES } from '../src/api/stubs.ts';

/**
 * `docs/OPENSUBSONIC.md`, held to the build it describes.
 *
 * The page exists for one reader: somebody writing a client, deciding what to
 * test against this server. That reader cannot check the page — they have no
 * reason to doubt it, and a method missing from it is a feature nobody tests
 * and nobody reports. Which is the shape of every silent deletion this project
 * guards against, so the page is guarded the same way the extensions list is:
 * **the names on it are compared to the names in the router**, and the test
 * fails on a page that has fallen behind or run ahead.
 *
 * Three sections carry the claims, and their headings are part of the contract
 * because the section a name is in *is* the claim:
 *
 *   - `Endpoints this build answers` — every method answered from the library.
 *   - `OpenSubsonic extensions` — every name `getOpenSubsonicExtensions` announces,
 *     and the version of it this server speaks.
 *   - `The rest of the surface` — every method answered empty or refused.
 *
 * A method found in the first section and nowhere else is therefore asserted to
 * work; one in the third is asserted *not* to. That is the distinction a client's
 * startup path turns on, and it is the one that rots first: `getUsers` and the
 * `transcoding` extension both moved from the third group to the first, and a
 * page that still called them stubs would tell a client developer to expect
 * nothing from a working method.
 *
 * **A claim is a table row whose first cell is exactly one backticked name.**
 * That is the whole grammar, and it is what keeps the prose out of the check —
 * the page names methods in sentences, in paths and in curl examples, and none
 * of those are claims about the build. A cell like `` `song.explicitStatus` ``
 * names a field rather than a method and does not match either, which is why
 * fields are written that way.
 *
 * **What is not checked is what the rows say.** The words beside a name are
 * prose, and the shapes in the third section (`topSongs.song: []`) are prose
 * too: this test holds the page to *which* methods exist, not to what each one
 * answers. That is the boundary a review reads.
 */

/** The page itself, read from the repository rather than from a copy. */
const PAGE = new URL('../docs/OPENSUBSONIC.md', import.meta.url);

/** The three sections whose contents are claims, spelled as the page spells them. */
const ANSWERS = 'Endpoints this build answers';
const EXTENSIONS = 'OpenSubsonic extensions';
const REST = 'The rest of the surface';

/** One claimed name, and the cells to the right of it as they were written. */
interface Claim {
  name: string;
  cells: string[];
}

/** Section heading → the claims its tables make, in the order they appear. */
function claimed(text: string): Map<string, Claim[]> {
  const found = new Map<string, Claim[]>();
  let section: string | undefined;

  for (const line of text.split('\n')) {
    // Level two, and only level two: the group headings inside a section
    // (`### Playlists`) are how the page is read, not what it claims.
    if (line.startsWith('## ') && !line.startsWith('### ')) {
      section = line.slice(3).trim();
      if (!found.has(section)) found.set(section, []);
      continue;
    }

    const row = /^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|(.*)\|\s*$/.exec(line);
    if (row === null || section === undefined) continue;
    found.get(section)?.push({
      name: row[1]!,
      cells: row[2]!.split('|').map((cell) => cell.trim()),
    });
  }

  return found;
}

/** The claims a section makes, refusing to guess when the heading is not there. */
function under(claims: Map<string, Claim[]>, heading: string): Claim[] {
  const found = claims.get(heading);
  assert.ok(
    found !== undefined,
    `docs/OPENSUBSONIC.md has no section "## ${heading}" — the page's structure is part of what this test asserts`,
  );
  return found;
}

const sorted = (list: readonly string[]): string[] => [...list].sort();

/** The extensions this build announces, each with the versions it speaks of it. */
function extensions(): { name: string; versions: number[] }[] {
  const answer = openSubsonicExtensions() as {
    openSubsonicExtensions: { name: string; versions: number[] }[];
  };
  return answer.openSubsonicExtensions;
}

const stubbed = (): string[] => [...STUBBED.keys(), ...STUBBED_BYTES.keys()];

test('the page lists every endpoint this build answers, and no other', () => {
  const claims = claimed(readFileSync(PAGE, 'utf8'));

  assert.deepEqual(
    sorted(under(claims, ANSWERS).map((claim) => claim.name.toLowerCase())),
    sorted(answeredMethods()),
    'docs/OPENSUBSONIC.md and src/api/router.ts disagree about what this build answers',
  );
});

test('the page lists the extensions the server announces, with their versions', () => {
  const claims = claimed(readFileSync(PAGE, 'utf8'));
  const announced = extensions();

  // Case matters here where it does not for a method: an extension is named to
  // a client in camelCase, and that spelling is the one a client matches on.
  const listed = under(claims, EXTENSIONS);
  assert.deepEqual(
    sorted(listed.map((claim) => claim.name)),
    sorted(announced.map((one) => one.name)),
    'docs/OPENSUBSONIC.md and src/api/extensions.ts disagree about what this build promises',
  );

  // And the version, which is half of the promise: a client that has learned to
  // read `versions` plans against the number, so a page saying `1` beside an
  // extension that has grown to `2` is wrong in the one column a client parses
  // rather than reads.
  for (const claim of listed) {
    const speaks = announced.find((one) => one.name === claim.name);
    assert.equal(
      claim.cells[0],
      speaks?.versions.join(', '),
      `docs/OPENSUBSONIC.md gives ${claim.name} the wrong version(s)`,
    );
  }
});

test('the page keeps the empty half of the surface separate from the filled half', () => {
  const claims = claimed(readFileSync(PAGE, 'utf8'));

  assert.deepEqual(
    sorted(under(claims, REST).map((claim) => claim.name.toLowerCase())),
    sorted(stubbed()),
    'docs/OPENSUBSONIC.md and src/api/stubs.ts disagree about what is answered empty',
  );
});
