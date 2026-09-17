import type { AddressInfo } from 'node:net';

import type { ServerConfig } from '../../src/api/config.ts';
import { createServer } from '../../src/api/server.ts';
import { openDb } from '../../src/db/index.ts';

/**
 * The HTTP side of the API, for the tests that need a server rather than a
 * function.
 *
 * Shared once three suites wanted it: every route that answers in bytes — and
 * every route that refuses — is only really tested through a socket, and three
 * copies of the same forty lines would drift into three different ideas of what
 * a request is.
 */

export type Db = ReturnType<typeof openDb>;

/**
 * Credentials, a port the kernel picks, and an ffmpeg that is not installed —
 * the last so that the degradation the MP4 segments promise is a property of
 * every test rather than of one.
 */
export const CONFIG: ServerConfig = {
  dbPath: ':memory:',
  host: '127.0.0.1',
  port: 0,
  user: 'demo',
  password: 'sesame',
  apiKey: '',
  ffmpeg: 'funoteka-no-such-ffmpeg',
  // A directory that need not exist: a test that re-encodes makes its own, and
  // the ones that assert a refusal never get as far as writing.
  cacheDir: '/tmp/funoteka-cache-test',
  // A test writes no log of its own: the process it runs in already has a
  // terminal, and a suite that opened files would leave them behind.
  logFile: '',
  logRequests: false,
  cors: false,
  showJunk: false,
};

/** One answer, with its body already read. */
export interface Served {
  status: number;
  headers: Headers;
  body: Buffer;
}

/**
 * One authenticated request, against a server up only for the length of it.
 *
 * The body is read *before* the server is closed, and that ordering is the
 * whole reason this answers with a value rather than with the `Response`. A
 * response whose body is still in flight holds its connection open, and
 * `server.close()` waits for it — so returning the live response and closing in
 * a `finally` left every caller reading the body of a socket the server was
 * already waiting to be rid of. It cost each of those tests three seconds, and
 * from the outside it looked exactly like the server being slow.
 *
 * **A path that begins with `/` is not a method and is sent as written**, with
 * no credentials on it. That is the health route and whatever else a later
 * surface exposes outside `/rest/`: those are asked by a supervisor rather than
 * by a client, and a helper that quietly added `u` and `p` to them would let a
 * test asserting "this answers without credentials" pass while proving the
 * opposite.
 */
export async function ask(
  db: Db,
  path: string,
  init: RequestInit = {},
  config: Partial<ServerConfig> = {},
): Promise<Served> {
  const server = createServer(db, { ...CONFIG, ...config });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(
      path.startsWith('/')
        ? `http://127.0.0.1:${port}${path}`
        : `http://127.0.0.1:${port}/rest/${path}${separator}u=demo&p=sesame`,
      init,
    );
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
