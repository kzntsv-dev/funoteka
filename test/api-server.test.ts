import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import type { ServerConfig } from '../src/api/config.ts';
import { API_VERSION, ERROR, ok, SERVER_TYPE, SERVER_VERSION } from '../src/api/envelope.ts';
import { askedOf, createServer, noteLine, statusFor } from '../src/api/server.ts';
import { openDb } from '../src/db/index.ts';

type Db = ReturnType<typeof openDb>;

const CONFIG: ServerConfig = {
  dbPath: ':memory:',
  port: 0,
  host: '127.0.0.1',
  user: 'funoteka',
  password: 'secret',
  apiKey: '',
  ffmpeg: 'ffmpeg',
    cacheDir: '/tmp/funoteka-cache-test',
  logFile: '',
  logRequests: false,
  // On, as a deployed server has it: the browser clients are pages, and a test
  // server that refused them would be testing a server nobody runs.
  cors: true,
  showJunk: false,
};

/**
 * A meta layer holding `audio` audio files and one cover, in one album folder.
 *
 * Written straight into the tables rather than scanned: the API answers about
 * the meta layer, not about a filesystem, and a test that went through the
 * scanner would be asserting the scanner's behaviour before it could say
 * anything about the API's.
 */
function metaWith(audio: number): Db {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO root (id, path, created_at) VALUES (1, ?, ?)').run(
    'C:\\music',
    '2026-01-01T00:00:00Z',
  );

  const insert = db.prepare(
    `INSERT INTO file (root_id, rel_path, folder_rel_path, name, kind, ext, size, mtime_ms)
     VALUES (1, ?, ?, ?, ?, ?, 1000, 1000)`,
  );
  for (let n = 1; n <= audio; n += 1) {
    insert.run(`Album/${String(n).padStart(2, '0')}.flac`, 'Album', `${n}.flac`, 'audio', 'flac');
  }
  insert.run('Album/cover.jpg', 'Album', 'cover.jpg', 'image', 'jpg');

  return db;
}

/**
 * Answer one request against a server built for this test, and take the server
 * down again whatever the handler does.
 *
 * The port is chosen by the kernel (`listen(0)`), so two tests running at once
 * cannot collide over a fixed number nobody owns.
 *
 * Credentials ride along with every request, as they do from every real client:
 * what these tests are about is the answers, and a refusal would answer none of
 * their questions. What happens without credentials is auth's own business.
 */
async function get(db: Db, path: string): Promise<Response> {
  const separator = path.includes('?') ? '&' : '?';
  return request(db, `${path}${separator}u=${CONFIG.user}&p=${CONFIG.password}`);
}

/**
 * The same request carrying nothing at all.
 *
 * One method may be answered this way, and the point of asking twice — here and
 * through `get` — is that "public" has to mean *that method* and not that the
 * check was loosened: everything else still refuses a stranger, which is what
 * the credential check is for.
 */
async function getAnonymously(db: Db, path: string): Promise<Response> {
  return request(db, path);
}

/** One request against a server up only for the length of it. */
async function request(db: Db, url: string): Promise<Response> {
  const server = createServer(db, CONFIG);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}${url}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

/** The answer, as JSON — the envelope is the only thing these tests read. */
async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

test('ping answers in a Subsonic envelope, and `.view` is the same endpoint', async () => {
  // Both spellings are in the wild: the bare method name is the OpenSubsonic
  // form, and `.view` is the one the protocol shipped with, kept by clients that
  // predate the rest. A server that answered only one of them would look broken
  // to half the clients it is meant to serve.
  const db = metaWith(1);

  for (const path of ['/rest/ping', '/rest/ping.view']) {
    const response = await get(db, `${path}?f=json`);
    assert.equal(response.status, 200);

    const body = await json(response);
    // The envelope as the module that builds it says it is: what this test is
    // about is that the answer is an envelope and that both spellings give the
    // same one — not which fields the envelope has grown since.
    assert.deepEqual(body, { 'subsonic-response': ok() });
  }
  db.close();
});

test('getOpenSubsonicExtensions answers without credentials, and only it does', async () => {
  // The protocol is emphatic — "Unlike all other APIs `getOpenSubsonicExtensions`
  // **must** be publicly accessible" — because of the order a client works in:
  // it asks what a server supports *before* it hands that server a password.
  // Everything else keeps the rule the check exists for, that a stranger may not
  // read this server's surface by asking which methods exist (task:2866).
  const db = metaWith(1);

  const open = await getAnonymously(db, '/rest/getOpenSubsonicExtensions?f=json');
  assert.equal(open.status, 200);
  assert.equal((await json(open))['subsonic-response'].status, 'ok');

  // Nothing else is public, and both ways of failing to authenticate are shut:
  // asking with no credentials at all is a missing parameter, and asking with
  // the wrong ones is a refusal. Neither is the wideness this method introduced.
  const none = await json(await getAnonymously(db, '/rest/ping?f=json'));
  assert.equal(none['subsonic-response'].status, 'failed');
  assert.equal(none['subsonic-response'].error?.code, ERROR.missingParameter);

  const wrong = await json(await request(db, '/rest/ping?u=nobody&p=nope&f=json'));
  assert.equal(wrong['subsonic-response'].error?.code, ERROR.wrongCredentials);

  db.close();
});

test('the extensions announced are the five that are built, and no more', async () => {
  const db = metaWith(1);

  const body = await json(await get(db, '/rest/getOpenSubsonicExtensions?f=json'));
  const listed = body['subsonic-response'].openSubsonicExtensions as {
    name: string;
    versions: number[];
  }[];

  assert.deepEqual(
    listed.map((one) => one.name).sort(),
    ['apiKeyAuthentication', 'indexBasedQueue', 'playbackReport', 'transcodeOffset', 'transcoding'],
    'transcoding was absent while its endpoints were not built, and arrives with them (task:2896)',
  );
  for (const one of listed) {
    assert.deepEqual(one.versions, [1], `${one.name} is at the version the spec describes`);
  }

  db.close();
});

test('every extension announced has the endpoint that carries it', async () => {
  // **A promise here has no way back.** Nothing in the protocol lets a client
  // ask again after a call fails, and nothing tells it the server overstated —
  // so a name in this list that no method backs is a lie the client cannot
  // detect. Each announced name is therefore held against a method that must
  // not answer "unknown method", and this map is the thing to extend when the
  // next extension is built.
  const backed: Record<string, string[]> = {
    indexBasedQueue: ['/rest/getPlayQueueByIndex?f=json'],
    playbackReport: ['/rest/reportPlayback?f=json'],
    // Not an endpoint of its own: this extension is the `timeOffset` parameter
    // on the method that already sends the bytes.
    transcodeOffset: ['/rest/stream?id=tr-1&f=json'],
    // Two endpoints, and both are listed: an extension that carries two methods
    // is two promises, and a map holding one of them would guard half of what is
    // announced (task:2896).
    transcoding: ['/rest/getTranscodeDecision?f=json', '/rest/getTranscodeStream?f=json'],
    // Not an endpoint of its own either: this extension is the `apiKey`
    // parameter on every method, plus the pair of promises about managing the
    // keys — which the CLI keeps and which is not something a client can call.
    // What is checked here is therefore the same thing `transcodeOffset` is
    // held to: the method that carries the parameter exists.
    apiKeyAuthentication: ['/rest/ping?f=json'],
  };

  const db = metaWith(1);
  const body = await json(await get(db, '/rest/getOpenSubsonicExtensions?f=json'));
  const listed = body['subsonic-response'].openSubsonicExtensions as { name: string }[];
  assert.ok(listed.length > 0, 'the list is not empty, so this test is about something');

  for (const { name } of listed) {
    const paths = backed[name];
    assert.ok(paths !== undefined, `${name} is announced and this map has no endpoint for it`);

    // Asked without the parameters it wants, on purpose: what is being checked
    // is that the method *exists*, and a refusal naming a missing parameter is
    // the answer of a method that does.
    for (const path of paths) {
      const answer = await json(await get(db, path));
      assert.doesNotMatch(
        String(answer['subsonic-response'].error?.message ?? ''),
        /unknown method/,
        `${name} is announced, so ${path} has to exist`,
      );
    }
  }

  db.close();
});

test('getLicense answers with a valid license', async () => {
  const db = metaWith(1);
  const response = await get(db, '/rest/getLicense?f=json');

  const body = await json(response);
  assert.deepEqual(body['subsonic-response'].license, { valid: true });
  assert.equal(body['subsonic-response'].status, 'ok');
  db.close();
});

test('getScanStatus counts the audio files the meta layer holds', async () => {
  // "Files scanned" is audio: the cover sitting beside the tracks is a file the
  // scan met, but it is not a file the client will ever be told about, and a
  // count that included it would describe a library larger than the one the
  // client can see.
  const db = metaWith(3);
  const response = await get(db, '/rest/getScanStatus?f=json');

  const body = await json(response);
  assert.deepEqual(body['subsonic-response'].scanStatus, { scanning: false, count: 3 });
  db.close();
});

test('an unknown method is an API error, not an HTTP one', async () => {
  // Subsonic clients read the error out of the body and would treat a 404 as a
  // broken server rather than as a method that does not exist. The protocol says
  // 200 with a `failed` envelope, and every client is written to that.
  //
  // **The example keeps moving, and that is the point of saying so.** It began
  // as `getGenres`, which became a route; then `getPodcasts`, which is now a
  // stub that answers empty by form; and it is a made-up name today, because
  // the contract's «Заглушки» answered the whole of the rest of the surface
  // (task:2868). What is left for this test is the property rather than a
  // method: a name nobody registered is refused in the body and not in the
  // status line.
  const db = metaWith(0);
  const response = await get(db, '/rest/getFrobnicator?f=json');

  assert.equal(response.status, 200, 'the transport succeeded; the method did not');

  const body = await json(response);
  const envelope = body['subsonic-response'];
  assert.equal(envelope.status, 'failed');
  assert.equal(envelope.version, '1.16.1');
  assert.equal(envelope.error.code, 0);
  assert.match(envelope.error.message, /getFrobnicator/);
  db.close();
});

test('f=xml renders the same answer as XML, and xml is the default', async () => {
  // XML is the protocol's own default format, so a client that sends no `f` at
  // all has to be answered in it. The two formats are one answer rendered two
  // ways: the same run has to come out of both, or the format becomes a second
  // place for the API to be wrong.
  const db = metaWith(2);

  const jsonAnswer = await json(await get(db, '/rest/getScanStatus?f=json'));

  const xml = await get(db, '/rest/getScanStatus');
  assert.equal(xml.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(
    await xml.text(),
    '<subsonic-response xmlns="http://subsonic.org/restapi" ' +
      `status="ok" version="${API_VERSION}" type="${SERVER_TYPE}" ` +
      `serverVersion="${SERVER_VERSION}" openSubsonic="true">` +
      '<scanStatus scanning="false" count="2"/>' +
      '</subsonic-response>',
  );

  assert.deepEqual(jsonAnswer['subsonic-response'].scanStatus, { scanning: false, count: 2 });
  db.close();
});

test('a value that carries markup is escaped, not injected', async () => {
  // The error message quotes what the client asked for, and what the client asks
  // for is a string off the wire. Unescaped, a method name would be a way to put
  // arbitrary elements into a document the client parses as XML.
  const db = metaWith(0);
  const response = await get(db, '/rest/%3Cscript%3E?f=xml');

  const body = await response.text();
  assert.match(body, /&lt;script&gt;/);
  assert.doesNotMatch(body, /<script>/);
  db.close();
});

test('a client may send its parameters in the body instead of the URL', async () => {
  // The protocol allows either, and clients use both: a phone that has to spell
  // out a password and an api key would rather not put them in a URL, and some
  // clients POST everything. A server that read only the query string would
  // answer "missing parameter" to a request that carried the parameter.
  const db = metaWith(2);

  const server = createServer(db, CONFIG);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;

    const posted = await fetch(`http://127.0.0.1:${port}/rest/getScanStatus`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ u: CONFIG.user, p: CONFIG.password, f: 'json' }),
    });
    const body = await json(posted);

    assert.equal(body['subsonic-response'].status, 'ok');
    assert.deepEqual(body['subsonic-response'].scanStatus, { scanning: false, count: 2 });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
  db.close();
});

test('a value in the body replaces the one in the URL, on both sides of the question', async () => {
  // Two sources for one name is one parameter written twice, and the body is
  // the half written for this call — so it wins outright rather than joining
  // what the URL said. Both directions are checked because either alone can be
  // passed by a merge that simply prefers one source: read the URL first and
  // the body never wins, read the body first and the URL never does.
  //
  // `getUser` is the method that makes the difference visible: the name it is
  // asked about is either this server's one account or a refusal, so which
  // source was read is the answer itself.
  const db = metaWith(2);
  const server = createServer(db, CONFIG);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const ask = async (url: string, username: string): Promise<Record<string, any>> =>
      json(
        await fetch(`http://127.0.0.1:${port}/rest/getUser?${url}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ u: CONFIG.user, p: CONFIG.password, f: 'json', username }),
        }),
      );

    // The URL names this account and the body names another: the body is what
    // this call was written for.
    const fromBody = await ask(`u=${CONFIG.user}&p=${CONFIG.password}&username=${CONFIG.user}`, 'nobody');
    assert.equal(fromBody['subsonic-response'].status, 'failed');
    assert.equal(fromBody['subsonic-response'].error?.code, 70);

    // And the other way round, which is the same rule read from the other end.
    const fromUrl = await ask('username=nobody', CONFIG.user);
    assert.equal(fromUrl['subsonic-response'].status, 'ok');
    assert.equal(fromUrl['subsonic-response'].user?.username, CONFIG.user);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
  db.close();
});

test('a client that hangs up mid-request does not take the server with it', async () => {
  // Node ends the process on an unhandled rejection, so a body that stops
  // arriving — a phone losing signal, a proxy timing out — is not a lost
  // request: it is the whole library going down for everyone.
  const db = metaWith(1);

  const server = createServer(db, CONFIG);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const net = await import('node:net');

    await new Promise<void>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'POST /rest/getScanStatus HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${port}\r\n` +
            'Content-Type: application/x-www-form-urlencoded\r\n' +
            'Content-Length: 400\r\n\r\n' +
            'u=demo&p=sesame',
        );
        // Fourteen bytes of a body that promised four hundred, and then gone.
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 100);
      });
      socket.on('error', () => resolve());
    });

    // The proof is that this still answers.
    const after = await fetch(`http://127.0.0.1:${port}/rest/ping?f=json&u=${CONFIG.user}&p=${CONFIG.password}`);
    const body = await json(after);
    assert.equal(body['subsonic-response'].status, 'ok');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
  db.close();
});

test('a path outside /rest is not the API', async () => {
  // The server is meant to be reachable from a phone on the same network, so it
  // has to have an answer for everything it is not — and "not found" is the
  // honest one, rather than an API envelope claiming a method failed.
  const db = metaWith(0);
  const response = await get(db, '/');

  assert.equal(response.status, 404);
  db.close();
});

test('a page from another origin is allowed to call the API, seeking included', async () => {
  // The browser clients this server is meant to be used from are pages: a web
  // player is loaded from its own site and calls the server from there. Without
  // these headers the browser refuses before the request is made — and without
  // `Range` among the allowed headers, seeking fails in a way that looks like
  // the server being broken.
  const db = metaWith(1);
  const server = createServer(db, CONFIG);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/rest/ping?f=json&u=${CONFIG.user}&p=${CONFIG.password}`, {
      headers: { origin: 'https://substreamer.app' },
    });

    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type, Range');
    assert.match(response.headers.get('access-control-expose-headers') ?? '', /Content-Range/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
  db.close();
});

test('a preflight is answered as a question about permission, not as a method', async () => {
  // The browser asks before it asks. An OPTIONS answered with an envelope would
  // be answering a question nobody asked, and the client would take the
  // permission it needed as absent.
  const db = metaWith(1);
  const server = createServer(db, CONFIG);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/rest/stream`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://substreamer.app',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'range',
      },
    });

    assert.equal(response.status, 204);
    assert.equal((await response.text()), '');
    assert.match(response.headers.get('access-control-allow-methods') ?? '', /GET/);
    assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
  db.close();
});

test('a server that would rather not be called from a page says so by not saying anything', async () => {
  const db = metaWith(1);
  const server = createServer(db, { ...CONFIG, cors: false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/rest/ping?f=json&u=${CONFIG.user}&p=${CONFIG.password}`, {
      headers: { origin: 'https://substreamer.app' },
    });

    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal((await json(response))['subsonic-response'].status, 'ok', 'and it still serves');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
  db.close();
});

test('the log line carries what was asked, and not the credentials that asked it', () => {
  // The parameters are in the line because their absence produced a wrong
  // conclusion: a slice of the log by method frequency showed no
  // `savePlayQueue` and no `getPlayQueue`, and the answer drawn from it was that
  // the operator's client does not use the play queue. It uses both, constantly
  // (task:2863).
  const line = askedOf(
    '/rest/savePlayQueue?id=tr-1&id=tr-2&current=tr-1&u=demo&p=hunter2&c=Feishin',
  );

  assert.ok(line.startsWith('?id=tr-1&id=tr-2'), 'what the client queued');
  assert.ok(line.includes('current=tr-1'));
  assert.ok(line.includes('c=Feishin'), 'and which client it was');
  assert.ok(!line.includes('hunter2'), 'a password in the log is a password in every copy of it');
  assert.ok(line.includes('p=<masked>'), 'and the mask says a password was there');
});

test('the mask holds whatever case the client spelled', () => {
  // The protocol writes `apiKey`; a client is free to write `apikey`, `ApiKey`
  // or `P`, and all of them reach the same handler in `auth.ts`. An exact
  // comparison here wrote `P=hunter2` into the log in full.
  assert.equal(
    askedOf('/rest/ping?u=demo&P=hunter2&ApiKey=xyz&s=abc'),
    '?u=demo&P=<masked>&ApiKey=<masked>&s=<masked>',
  );
});

test('a value cannot write a line of its own, or forge the parameter after it', () => {
  // Two things a client can do to a decoded value, and the log used to print
  // both verbatim: `%0A` writes a *second* line, so a stranger decides what the
  // log says happened, and `%26` starts a parameter that was never sent.
  const line = askedOf('/rest/ping?id=tr-1%26p=hunter2&x=a%0Afunoteka:%20GET%20/rest/ping%20200%201ms');

  assert.ok(!line.includes('\n'), 'no second line');
  assert.ok(!/&p=hunter2/u.test(line), 'no forged parameter');
  assert.ok(line.includes('%26p=hunter2'), 'the ampersand is escaped and visible as what it was');
  assert.ok(line.includes('%0A'), 'and so is the newline');
  assert.ok(line.includes('id=tr-1'), 'while the parts a reader wants stay readable');
});

test('a log line says when the answer was a refusal, which no status says', () => {
  // A refusal is an envelope in a 200 (`send`), so a line carrying only the
  // status said nothing about whether the call worked — a client reported a
  // server version it could not determine when the truth was a refused key, and
  // another reported that it could not load an artist beside a healthy-looking
  // log (task:2896).
  const line = (failed: boolean): string =>
    noteLine({
      method: 'GET',
      path: '/rest/getArtist',
      asked: '?id=ar-9',
      status: 200,
      failed,
      ms: 75,
    });

  assert.equal(line(false), 'funoteka: GET /rest/getArtist?id=ar-9 200 75ms');
  assert.equal(line(true), 'funoteka: GET /rest/getArtist?id=ar-9 200 failed 75ms');

  // And the fourth silence: a client that hung up mid-answer left no line at
  // all, which is the shape of "nought bytes in its offline cache" beside a log
  // full of 200s.
  assert.equal(
    noteLine({
      method: 'GET',
      path: '/rest/getTranscodeStream',
      asked: '?mediaId=tr-1',
      status: 200,
      aborted: true,
      ms: 17728,
    }),
    'funoteka: GET /rest/getTranscodeStream?mediaId=tr-1 200 aborted 17728ms',
  );
});

test('every way in is masked, and a long list is cut from the front', () => {
  assert.equal(
    askedOf('/rest/ping?u=demo&t=abc&s=def&apiKey=xyz'),
    '?u=demo&t=<masked>&s=<masked>&apiKey=<masked>',
    'the username names the listener; the three secrets are what prove them',
  );

  // `savePlayQueue` names every song of the queue, and a log line is not the
  // place for five hundred ids — but the *first* few are what say what the call
  // was, so the cut is at the end.
  const long = askedOf(
    `/rest/savePlayQueue?${Array.from({ length: 200 }, (_, i) => `id=tr-${i}`).join('&')}`,
  );
  assert.ok(long.length < 300, `a queue of five hundred is not a log line: ${long.length}`);
  assert.ok(long.endsWith('…'), 'and the line says it was cut');
  assert.ok(long.startsWith('?id=tr-0&id=tr-1&'), 'from the front');
});

test('a status is a fact about a method, and every other method still says 200', () => {
  // `statusFor` is the one place that decides, and it was exported with a claim
  // that a test used it — which no test did. This is that test, and what it
  // holds is the shape of the exception: one method, four kinds of refusal
  // mapped from the code, and **everything else still an envelope in a 200**.
  // An exception whose edges nobody states is an exception that becomes the
  // rule (found by the review umbrella, task:2926).
  const failed = (code: number): ReturnType<typeof ok> => ({
    ...ok(),
    status: 'failed',
    error: { code, message: 'refused' },
  });

  // The one method the specification asks this of.
  assert.equal(statusFor('getTranscodeStream', failed(ERROR.missingParameter)), 400);
  assert.equal(statusFor('getTranscodeStream', failed(ERROR.notFound)), 404);
  assert.equal(statusFor('getTranscodeStream', failed(ERROR.wrongCredentials)), 401);
  assert.equal(statusFor('getTranscodeStream', failed(ERROR.invalidApiKey)), 401);
  // A code the map does not know is a fault rather than something a client can
  // act on, and 500 is what the document declares for it.
  assert.equal(statusFor('getTranscodeStream', failed(ERROR.generic)), 500);
  // The comparison is case-insensitive, because a client is free to spell the
  // method any way it likes and `askedOf` masks parameters for the same reason.
  // The `.view` suffix is *not* here to test: it is stripped before this is
  // called, which the call site in `handle` is the right place to know.
  assert.equal(statusFor('GetTranscodeStream', failed(ERROR.notFound)), 404);

  // And the rule it is an exception to.
  assert.equal(statusFor('stream', failed(ERROR.notFound)), 200);
  assert.equal(statusFor('getSong', failed(ERROR.missingParameter)), 200);
  assert.equal(statusFor('', failed(ERROR.generic)), 200);
  // A call that worked is a 200 whatever the method.
  assert.equal(statusFor('getTranscodeStream', ok()), 200);
});
