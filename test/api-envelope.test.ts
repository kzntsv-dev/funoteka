import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { API_VERSION, failed, ok, parseFormat, render, SERVER_TYPE, SERVER_VERSION } from '../src/api/envelope.ts';

/**
 * The envelope's own fields, which no route is about.
 *
 * OpenSubsonic requires three of them of **every** answer — `type`,
 * `serverVersion` and `openSubsonic` — and this server sent none, which is not
 * a missing nicety: `openSubsonic` is how a client learns that the extension
 * list is worth asking for at all, and `serverVersion` is how it learns to ask
 * again after a deployment. A server that answered `getOpenSubsonicExtensions`
 * without them had called a client to a door the client could not see
 * (task:2866).
 */

test('every answer says what this server is, and that it speaks OpenSubsonic', () => {
  for (const envelope of [ok(), ok({ song: { id: 'tr-1' } }), failed(0, 'nope')]) {
    assert.equal(envelope.type, SERVER_TYPE);
    assert.equal(envelope.serverVersion, SERVER_VERSION);
    assert.equal(envelope.openSubsonic, true);
  }
});

test('the server version is the package version, and cannot drift from it', () => {
  // Read from the file rather than imported: `resolveJsonModule` is off, and the
  // point of the test is to compare against `package.json` as it is on disk
  // rather than against a copy of it a build step would have made.
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { name: string; version: string };

  assert.equal(SERVER_TYPE, manifest.name, 'and the name is the package name');
  assert.equal(SERVER_VERSION, manifest.version);
  assert.notEqual(SERVER_VERSION, API_VERSION, 'which is not the API version');
});

test('the identity fields travel in both formats', () => {
  // A field is an attribute in XML and a key in JSON, and a client reading one
  // of them must not be told less than a client reading the other.
  const json = JSON.parse(render(ok(), parseFormat('json')).body) as {
    'subsonic-response': Record<string, unknown>;
  };
  assert.equal(json['subsonic-response'].openSubsonic, true);
  assert.equal(json['subsonic-response'].serverVersion, SERVER_VERSION);

  const xml = render(ok(), parseFormat(null)).body;
  assert.match(xml, /type="funoteka"/);
  assert.match(xml, /serverVersion="0\.1\.0"/);
  assert.match(xml, /openSubsonic="true"/);
});
