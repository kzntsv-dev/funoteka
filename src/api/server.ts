import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { DatabaseSync } from '../db/index.ts';
import { authenticate, coverSignature } from './auth.ts';
import { keyHolds } from './keys.ts';
import type { ServerConfig } from './config.ts';
import {
  ApiError,
  ERROR,
  failed,
  ok,
  parseFormat,
  render,
  type Envelope,
  type Format,
} from './envelope.ts';
import { health } from './health.ts';
import { binaryRoute, route, type Payload, type RouteContext } from './router.ts';
import { visibilityOf } from './visibility.ts';

/**
 * The API as an HTTP server.
 *
 * Built rather than started: the caller decides when it listens, so a test can
 * put one on a port the kernel picks and a deployment can put one on the port
 * the operator chose, and both are the same server. Nothing here reads the
 * environment or the command line — that is config's business, and keeping it
 * out is what makes this callable from a test at all.
 *
 * A server with nothing to check credentials against is refused here, at the
 * only point where one comes into being. The alternative — answering everyone
 * because no password was configured — is a music library on the open network,
 * and it is the kind of misconfiguration that looks like it worked.
 */
export function createServer(db: DatabaseSync, config: ServerConfig): Server {
  if (config.user === '' || (config.password === '' && config.apiKey === '')) {
    throw new Error(
      'no credentials: set FUNOTEKA_USER with FUNOTEKA_PASSWORD or FUNOTEKA_APIKEY',
    );
  }

  return createHttpServer((request, response) => {
    if (config.logRequests) note(request, response);

    // Every path out of `handle` is accounted for, and this catch is the one
    // that covers the part before its own try: reading a request body can fail
    // when a client hangs up mid-POST, and an unhandled rejection in Node does
    // not end a request — it ends the process. A server that the whole household
    // listens to must not be killable by one phone losing signal.
    handle(db, config, request, response).catch((err: unknown) => {
      // The format is not known here — the failure may have been before the
      // request was read far enough to say — so the refusal is rendered in the
      // protocol's own default, which is what a client that sent no `f` expects.
      refuse(response, 'request', '', 'xml', err);
    });
  });
}

/**
 * The credentials a request may carry, which never reach the log.
 *
 * `p` is the password plainly or `enc:`-hexed, `t` and `s` are the halves of a
 * salted login, `apiKey` is the OpenSubsonic key. `u` is deliberately not here:
 * it names the listener rather than proving them, and a line that does not say
 * who asked answers half of what this line exists for.
 *
 * Masking four names is what makes the rest of the query writable, and that is
 * the whole point — see `note` below.
 */
const SECRET_PARAMETERS: ReadonlySet<string> = new Set(['p', 't', 's', 'apikey']);

/**
 * The methods the protocol requires to be reachable without credentials.
 *
 * One, and the specification is emphatic about it: "Unlike all other APIs
 * `getOpenSubsonicExtensions` **must** be publicly accessible". The reason is
 * the order a client works in — it asks what a server supports *before* it
 * hands that server a password, and a server that answered this with a refusal
 * would leave it choosing between guessing and not asking.
 *
 * It costs the rule above nothing. That rule is that a stranger must not read
 * this server's *surface* — must not learn which methods exist by asking for
 * them — and this method is a fixed list of names about the build, which says
 * nothing about the collection and cannot be made to say anything by the
 * request. Everything else still refuses an unauthenticated caller, and
 * everything else still refuses to admit it exists.
 */
const PUBLIC: ReadonlySet<string> = new Set(['getopensubsonicextensions']);

/**
 * A value a log line can carry without lying about where it ends.
 *
 * Two things a client can do to a decoded value, and both were live before this
 * existed. A newline — `?x=a%0Afunoteka: GET /rest/ping 200 1ms` — writes a
 * *second* line, so a client decides what the log says happened. And an encoded
 * ampersand — `?id=tr:1%26p=hunter2` — forges the parameter that follows it,
 * which is a reader being shown a password that was never sent. Neither leaks a
 * secret; both make the log a thing a stranger has a hand in.
 *
 * So the value is written with control characters and ampersands escaped, and
 * nothing else touched: `tr:109911` and `Кино` stay readable, which is the
 * whole reason the query is written at all.
 */
function readable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f&]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`,
  );
}

/**
 * How much of a query is written.
 *
 * A log line is not the place for five hundred ids: `savePlayQueue` names every
 * song of the queue and a scrobble of an album names all of it. The first few
 * are what tell a reader what the call was, and the rest is a file that grows
 * without ever answering a question the front of it did not.
 */
const LOGGED_QUERY = 240;

/**
 * What a client asked, for the log line.
 *
 * **The parameters are here because their absence produced a wrong conclusion.**
 * This line used to carry the method, the status and the time and nothing else,
 * on the reasoning that every client spells its password in the query — true,
 * and the reason `SECRET_PARAMETERS` masks four names rather than a reason to
 * write none of them. What that cost: "what does this client actually send?"
 * was unanswerable from the log, and unanswerable is not the same as empty. A
 * slice of the log by method frequency showed no `savePlayQueue` and no
 * `getPlayQueue`, and the conclusion drawn from it was that the operator's
 * client does not use the play queue. It uses both, constantly (task:2863).
 *
 * Exported for its own test, which is about the four names above: a password in
 * a log file is a password in every copy of that file.
 */
export function askedOf(url: string): string {
  const at = url.indexOf('?');
  if (at === -1) return '';

  // Built up to the budget and no further. `savePlayQueue` names every song of
  // the queue, and escaping five hundred of them to throw 99% of the result away
  // is work a request pays for on its own thread — 353 µs against 3.5 µs for an
  // ordinary call, and none of the difference reaches the file.
  let query = '';
  for (const [name, value] of new URLSearchParams(url.slice(at + 1))) {
    // Lowered on both sides, and that is not tidiness: the protocol spells its
    // parameters in camelCase and a client is free to spell them any way it
    // likes, so `P=`, `ApiKey=` and `apikey=` all reach the same handler
    // (`auth.ts`) and all have to reach the same mask. An exact comparison here
    // wrote `P=hunter2` into the log in full.
    const shown = `${name}=${SECRET_PARAMETERS.has(name.toLowerCase()) ? '<masked>' : readable(value)}`;
    if (query.length + shown.length + 2 > LOGGED_QUERY) return `${query}…`;

    query += `${query === '' ? '?' : '&'}${shown}`;
  }

  return query;
}

/**
 * The responses whose envelope said `failed`, so that the log can say so too.
 *
 * A refusal is not an HTTP status here — `send` answers 200 whatever happened,
 * because a Subsonic client reads the error out of the body — so a line carrying
 * only the status said nothing about whether the call worked. (The one
 * exception is the method `STATUS_REFUSALS` names, and this mark is on its
 * refusals too: a line can carry a 404 and still say `failed`.) That cost three
 * investigations in one day: a client reporting a server version it could not
 * determine when the truth was a refused key, a client reporting that it could
 * not load an artist beside a log that looked healthy, and a question about
 * whether refusals should be statuses at all (task:2896). One word makes all
 * three readable.
 *
 * A `WeakSet` keyed by the response rather than a header: a header is the
 * client's business and this is the server's, and nothing about the answer
 * should change in order to make it legible.
 */
const refusals = new WeakSet<ServerResponse>();

/**
 * The line itself, so that what a log says about a request can be read without a
 * log — the same reason `askedOf` is exported for its own test.
 */
export function noteLine(line: {
  method: string;
  path: string;
  asked: string;
  status: number;
  failed?: boolean;
  aborted?: boolean;
  ms: number;
}): string {
  return (
    `funoteka: ${line.method} ${line.path}${line.asked} ${line.status}` +
    `${line.failed === true ? ' failed' : ''}${line.aborted === true ? ' aborted' : ''} ` +
    `${line.ms}ms`
  );
}

/**
 * One line per request, when the operator asked for them.
 *
 * Which method a client called, what it asked with, and how the server answered
 * — the three things "why will this phone not sync" is answered from, and the
 * middle one was missing until it cost an answer (see `askedOf`), and the third
 * was half-missing until it cost three (see `refusals`).
 *
 * **A request that never finished is the fourth silence.** A line is written
 * when the response finishes, so a client that hung up mid-answer left nothing
 * at all — and that is exactly the shape of "it says nought bytes in its offline
 * cache" beside a log full of 200s: the download was cut somewhere, and the
 * server's own record of it did not exist. The bytes may have arrived at the
 * socket and gone nowhere, and this cannot tell those apart; what it can say is
 * that the answer was not written out in full.
 */
function note(request: IncomingMessage, response: ServerResponse): void {
  const started = Date.now();
  const asked = askedOf(request.url ?? '');
  const write = (ended: { failed?: boolean; aborted?: boolean }): void => {
    process.stderr.write(
      `${noteLine({
        method: request.method ?? '?',
        path: request.url?.split('?')[0] ?? '?',
        asked,
        status: response.statusCode,
        ...ended,
        ms: Date.now() - started,
      })}\n`,
    );
  };

  response.on('finish', () => write({ failed: refusals.has(response) }));
  // `close` follows `finish` on every answer that was written out, so the guard
  // is what tells the two apart rather than the event.
  response.on('close', () => {
    if (!response.writableFinished) write({ aborted: true });
  });
}

/**
 * One request, from the path to the last byte.
 *
 * Kept async because `stream` is: it hands the response to a file, and the
 * request is not over when the handler returns. Everything here runs before
 * that hand-over, so a refusal is always still a refusal the client can read.
 */
async function handle(
  db: DatabaseSync,
  config: ServerConfig,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // The base is a placeholder: only the path and the query are ever read, and
  // a request line carries those without a scheme or an authority.
  // Before anything is decided, because the browser decides first: a page that
  // is not allowed to read this answer never gets to send the request that
  // would have asked for it.
  if (config.cors) allowCrossOrigin(response);

  const url = new URL(request.url ?? '/', 'http://localhost');

  // Health, and before anything else is decided about this request. It is not
  // the API: it belongs to no method, it carries no credentials, it is answered
  // in no envelope and it negotiates no format — the asker is a supervisor that
  // wants one word about the process, and every rule below is about a client
  // making a call. See `health.ts` for why it is public.
  if (url.pathname === HEALTH_PATH) {
    answerHealth(response, db, request.method);
    return;
  }

  const method = methodName(url.pathname);

  if (method === null) {
    notFound(response);
    return;
  }

  if (request.method === 'OPTIONS') {
    // A preflight asks what may be done, not for a method to be run. Answering
    // it with an envelope would be answering a question nobody asked — and the
    // browser reads the headers and the empty body, not the payload.
    response.writeHead(204);
    response.end();
    return;
  }

  const { query, body } = await parameters(request, url.searchParams);
  const format = parseFormat(query.get('f'));

  // `.view` is the suffix the protocol's own URLs carry and the bare name is
  // what its documentation calls the method. Both are in the wild — clients
  // that predate the shorthand kept using it — and they are one method.
  //
  // `.m3u8` is the same fact with a different tail: the HLS method's URL is
  // `/rest/hls.m3u8`, spelled with a file extension a player recognises rather
  // than with `.view`, and the method it names is `hls`. Left unstripped it is a
  // name nothing matches, and the client that asks for a stream would be told
  // there is no such method — which is exactly what a stub exists to avoid.
  const name = method.replace(/\.view$/, '').replace(/\.m3u8$/, '');

  // Credentials first, and before the method is looked up: a stranger on the
  // network should not be able to read the server's surface by asking for
  // methods and hearing which ones exist. It is also the only place to check
  // them, since a stream never passes through the envelope at all.
  // The one route that hands picture links out also accepts them back without
  // credentials — see `coverSignature`. The name is already lowered here, and
  // this is the only place that decides it.
  // The registered keys are read per request rather than cached at startup: the
  // registry is what a person edits while the server runs, and a key revoked a
  // minute ago must stop working now, not at the next restart. The query is one
  // indexed scan of a table with a handful of rows, and it runs only for a
  // request that presented a key at all.
  const verdict = authenticate(
    query,
    config,
    name.toLowerCase() === 'getcoverart',
    (given) => keyHolds(db, given),
  );
  if (!verdict.ok && !PUBLIC.has(name.toLowerCase())) {
    send(response, failed(verdict.code, verdict.message), format, name);
    return;
  }

  const context = {
    db,
    config,
    query,
    body,
    origin: originOf(request, config),
    visibility: visibilityOf(query, config),
  };
  const binary = binaryRoute(name);

  try {
    if (binary !== undefined) {
      await binary(context, request, response);
      return;
    }
    send(response, await envelope(name, context), format, name);
  } catch (err) {
    refuse(response, method, name, format, err);
  }
}

/**
 * What a page from another origin needs in order to be allowed to call this.
 *
 * The API is a set of endpoints a client app calls, and one of the kinds of
 * client it is meant to be used from is a page: a web player is loaded from its
 * own site and calls the server from there. The browser asks the server first
 * whether that is allowed, and a server that does not answer never hears the
 * request. So `*` — every page may ask, and every page that asks is still
 * refused unless it knows the credentials, which is what the API's own auth is
 * for and is not weakened by this.
 *
 * Two headers are here for reasons that are not obvious. `Range` is allowed
 * because seeking is a range request, and a browser blocks a header it was not
 * told about — a player whose seeking silently fails looks like a broken
 * server. And `Content-Range` and `Accept-Ranges` are *exposed* because
 * JavaScript cannot read a response header it was not granted, and a client
 * that cannot read `Content-Range` cannot tell how long a track is.
 */
function allowCrossOrigin(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, HEAD, OPTIONS');
  response.setHeader('access-control-allow-headers', 'Content-Type, Range');
  response.setHeader(
    'access-control-expose-headers',
    'Content-Range, Accept-Ranges, Content-Length',
  );
  response.setHeader('access-control-max-age', '86400');
}

/**
 * The parameters, whether the client spelled them in the URL or in the body.
 *
 * The protocol allows both and clients use both: a phone would rather not put a
 * password in a URL, and some clients POST everything. So a POST whose body is
 * form-encoded is read and merged, and the body wins where a name appears in
 * both — it is the half of the request that was written for this call.
 *
 * **A name may appear more than once, and that is not a repeat.** The protocol
 * spells a list as the parameter repeated — `createPlaylist` takes one `songId`
 * per song — and the first version of this merged with `set`, which keeps the
 * last value and drops the rest. Nothing called it with a repeated name until
 * playlists did, so a client asking for a playlist of five songs would have got
 * one song: the last one, with nothing on the wire to say four were lost.
 *
 * Every POST body is read even when it is not form-encoded, and that is not
 * tidiness: a request body nobody reads stays in the socket, and the connection
 * cannot be reused for the next call until it is gone. The cap is the other
 * half of the same thought — a Subsonic request is a handful of short
 * parameters, so a body of a megabyte is not a request this server has any
 * question to ask about.
 *
 * The body is handed back as well as merged, and the reason is the one thing it
 * is not: form encoding is not the only thing a body can be. The `transcoding`
 * extension's `ClientInfo` is nested JSON that a query string has no room for,
 * and a route that expects it parses it from here — see `RouteContext.body`.
 */
const MAX_BODY = 1024 * 1024;

async function parameters(
  request: IncomingMessage,
  fromUrl: URLSearchParams,
): Promise<{ query: URLSearchParams; body: string | null }> {
  if (request.method !== 'POST') return { query: fromUrl, body: null };

  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    length += buffer.length;
    if (length > MAX_BODY) {
      request.destroy();
      return { query: fromUrl, body: null };
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  const type = request.headers['content-type'] ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded')) return { query: fromUrl, body: text };

  // The body's values for a name replace the URL's *all at once*, and then keep
  // their own order: a parameter the client put in both places is one parameter
  // written twice, while one it repeated in the body is a list.
  const merged = new URLSearchParams(fromUrl);
  const replacedNames = new Set<string>();
  for (const [name, value] of new URLSearchParams(text)) {
    if (!replacedNames.has(name)) {
      merged.delete(name);
      replacedNames.add(name);
    }
    merged.append(name, value);
  }
  return { query: merged, body: text };
}

/**
 * Where the client reached this server, as the client itself spelled it.
 *
 * A deployed server binds `0.0.0.0`, which is not an address anyone can call
 * back, so an answer that has to name the server must use the authority the
 * request arrived with. `Host` is exactly that, and it is what the client
 * already used to get here; a URL built from the config would name a host it
 * never called.
 *
 * The scheme is `http` because it is the only one this server speaks — it
 * terminates no TLS of its own — and the fallback is for an HTTP/1.0 request
 * that carried no `Host` at all, which is a client talking to us directly and
 * would have nowhere else to be answered from.
 */
function originOf(request: IncomingMessage, config: ServerConfig): string {
  return `http://${request.headers.host ?? `localhost:${config.port}`}`;
}

async function envelope(name: string, context: RouteContext): Promise<Envelope> {
  const handler = route(name);
  if (handler === undefined) {
    // An unknown method is answered as a failed call and not as a missing page.
    // Clients read the error out of the body and would take a 404 as a server
    // too broken to talk to, rather than as a method that does not exist.
    return failed(ERROR.generic, `unknown method: ${name}`);
  }
  // Awaited because a route may answer later — see `Route`. The try around this
  // is the caller's, and it is what keeps a rejected route a refusal a client can
  // read rather than a request that never ends.
  return ok(signedImageLinks(await handler(context), context));
}

/**
 * Every picture link in an answer, signed on its way out.
 *
 * **Here, once, rather than where each link is built.** A URL to a picture is
 * named by a field ending in `ImageUrl`, and there are two builders of one (an
 * artist's, shared by five listings, and `getArtistInfo2`'s three sizes in
 * another module) — a rule that catches every field named that way cannot forget
 * the next one, and threading a secret through six functions to sign four
 * strings is how one of them ends up unsigned.
 *
 * The signature is what lets a client's *image loader* fetch a picture at all:
 * it does not authenticate. Measured on the operator's Symfonium, the artist
 * picture is asked for with no `u`, `t` or `s`, and a server that guards that
 * route like the rest answers a refusal the client can only draw a placeholder
 * over (task:2916).
 *
 * Only our own links are touched: the value has to be on this server's own
 * authority and name `getCoverArt`, so a URL a route built for somewhere else is
 * left exactly as it was.
 */
function signedImageLinks(payload: Payload, context: RouteContext): Payload {
  const sign = (value: unknown, field: string): unknown => {
    if (typeof value === 'string') {
      if (!field.endsWith('ImageUrl')) return value;
      if (!value.startsWith(`${context.origin}${API_PREFIX}getCoverArt`)) return value;

      const link = new URL(value);
      const id = link.searchParams.get('id');
      if (id === null) return value;

      link.searchParams.set('sig', coverSignature(id, context.config));
      return link.toString();
    }
    if (Array.isArray(value)) return value.map((item) => sign(item, field));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([name, inner]) => [name, sign(inner, name)]),
      );
    }
    return value;
  };

  return sign(payload, '') as Payload;
}

function refuse(
  response: ServerResponse,
  method: string,
  route: string,
  format: Format,
  err: unknown,
): void {
  // A stream that already wrote a header owes the client bytes, not an
  // envelope, and there is no way to take a status back. The connection is the
  // only thing left to end.
  if (response.headersSent) {
    response.destroy();
    return;
  }

  // A refusal is an envelope, and an envelope is not a file. `download` sets a
  // name for what it is about to send *before* it knows it can send it — the
  // header has to be in place before `serveBytes` writes the head — so a refusal
  // that arrives afterwards would carry `attachment; filename="…m4a"` beside
  // "this cannot be produced without re-encoding", and a client that trusts the
  // 200 saves the error under the song's name (task:2864).
  response.removeHeader('content-disposition');

  if (err instanceof ApiError) {
    send(response, failed(err.code, err.message), format, route);
    return;
  }

  // A client that hung up is not a fault of this server and is not worth a line
  // on stderr: an aborted request is what a phone losing signal looks like, and
  // reporting it as an internal error would train whoever reads the log to
  // ignore the one message that matters.
  if (err !== null && typeof err === 'object' && 'code' in err && isDisconnect(err)) {
    response.destroy();
    return;
  }

  // The other writer held the file for longer than this server is willing to
  // wait — the stages of a scan, in practice, which hold it for seconds at a
  // time (task:2880).
  //
  // It is not a fault of this server: the meta layer has two writers by design,
  // and the answer can say what happened rather than reading "Internal error",
  // which would send whoever reads it looking for a bug in the API.
  //
  // **The answer says the write did not happen, and it says so on purpose**
  // (task:2884). The protocol has no code for "busy", so this is a generic
  // failure; a generic failure a client is told only to retry is one it may take
  // as having gone through — and a Subsonic client does not retry on its own.
  // Measured on the live daemon: 4 saves in 100 were refused during a scan, and
  // every one of them was simply lost. This message is the only place that loss
  // can be stated, so it states it.
  //
  // **The alternative was considered and rejected.** The other way out is to let
  // the daemon wait longer, and the wait here is synchronous — it blocks the one
  // thread that answers everybody. Measured: `ping` came back after 5133 ms
  // while a single request waited on the lock. Shortening what holds it is the
  // real answer and is task:2880; until that lands, this is what the client is
  // owed.
  if (err instanceof Error && err.message.includes('database is locked')) {
    process.stderr.write(`funoteka: ${method} found the database locked\n`);
    send(
      response,
      failed(
        ERROR.generic,
        'The library is being written by another process — nothing was saved; try again',
      ),
      format,
      route,
    );
    return;
  }

  // Anything else is a fault in this server rather than a request it can
  // refuse, and a throw that escaped a handler would take the whole process
  // down with it. It is said on stderr for whoever runs the server, and
  // answered vaguely, because a stranger is owed no account of our internals.
  process.stderr.write(`funoteka: ${method} failed: ${String(err)}\n`);
  send(response, failed(ERROR.generic, 'Internal error'), format, route);
}

/**
 * The ways a client goes away mid-request, which are not this server's failures.
 *
 * `ECONNRESET` is the socket dying under a read, `ERR_STREAM_PREMATURE_CLOSE`
 * is a body that stopped arriving before its `Content-Length` promised, and
 * `ECANCELED` is Node's own name for the same thing on a destroyed request.
 */
function isDisconnect(err: object): boolean {
  const code = (err as NodeJS.ErrnoException).code ?? '';
  return code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECANCELED';
}

/** Where methods live. Everything outside it is not the API and is not answered as one. */
const API_PREFIX = '/rest/';

/** The one path outside the API this server answers, and it is not a method. */
const HEALTH_PATH = '/health';

/**
 * Answer a liveness probe.
 *
 * `no-store`, because a cached "healthy" is the one answer a health check must
 * never be given: a supervisor asking about a server that has been wedged for an
 * hour must not be handed the answer a proxy wrote down when it was working.
 *
 * HEAD is answered as HEAD — the same status and headers with no body — because
 * that is what `wget --spider` sends, and a probe that cannot ask is a probe that
 * gets written off as a broken server.
 */
function answerHealth(response: ServerResponse, db: DatabaseSync, method: string | undefined): void {
  if (method !== 'GET' && method !== 'HEAD') {
    const body = 'method not allowed\n';
    response.writeHead(405, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      allow: 'GET, HEAD',
    });
    response.end(body);
    return;
  }

  const answer = health(db);
  response.writeHead(answer.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(answer.body),
    'cache-control': 'no-store',
  });
  response.end(method === 'HEAD' ? undefined : answer.body);
}

/**
 * The method name the client asked for, decoded — or null if it did not ask the
 * API at all.
 *
 * Decoding is what makes the name comparable to the protocol's own spellings and
 * makes the error faithful when it is not one of them. A path that is not valid
 * encoding has no decoded form to prefer, so it is taken as it came: refusing
 * the request would hide which name the client got wrong.
 */
function methodName(pathname: string): string | null {
  if (!pathname.startsWith(API_PREFIX)) return null;

  const raw = pathname.slice(API_PREFIX.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The methods whose refusals carry an HTTP status instead of the usual 200.
 *
 * **One method, and deliberately one.** `send` answers 200 for every answer
 * including a refusal, because a Subsonic client reads the error out of the
 * body, and a client that had to handle transport failures as well would have
 * two ways to be told the same thing. Every route keeps that convention, the
 * stubbed byte routes included, and the operator has seen it and kept it.
 *
 * `getTranscodeStream` is the exception its own page asks for: "In case of an
 * error, a standard HTTP error code is returned with a descriptive message",
 * with 400, 401, 404 and 500 declared beside it in the OpenAPI document.
 * Measured before this: all three ways that route can refuse — an id that names
 * no song, a token issued for another song, and a token this server never issued
 * — came back a 200. A client written against that document branches on the
 * status line, read every refusal as success, and would go on to play the
 * envelope as audio (task:2913).
 *
 * The body is the envelope either way. The status is *added*, not substituted:
 * the code and the message a Subsonic client reads are still there.
 */
const STATUS_REFUSALS = new Set(['gettranscodestream']);

/** What the status line says for each kind of refusal, from the OpenAPI document. */
const STATUS_OF_ERROR = new Map<number, number>([
  [ERROR.missingParameter, 400],
  [ERROR.wrongCredentials, 401],
  [ERROR.tokenAuthRefused, 401],
  [ERROR.unsupportedAuthMechanism, 401],
  [ERROR.conflictingAuthMechanisms, 401],
  [ERROR.invalidApiKey, 401],
  [ERROR.notAuthorized, 401],
  [ERROR.notFound, 404],
]);

/**
 * The status line for one answer, given the method it answers.
 *
 * Exported for its own test, the same reason `noteLine` and `askedOf` are: what
 * a status *is* should be readable without a server. Everything but the one
 * method above answers 200, whatever happened — see `send`.
 */
export function statusFor(method: string, envelope: Envelope): number {
  if (envelope.status !== 'failed') return 200;
  if (!STATUS_REFUSALS.has(method.toLowerCase())) return 200;

  const { code } = (envelope.error ?? {}) as { code?: number };
  // Unmapped is a fault rather than something a client can act on, and 500 is
  // both what the document declares for it and what it is.
  return code === undefined ? 500 : (STATUS_OF_ERROR.get(code) ?? 500);
}

function send(
  response: ServerResponse,
  envelope: Envelope,
  format: Format,
  method = '',
): void {
  const { contentType, body } = render(envelope, format);

  // Kept for the log line, which is written when the response finishes. Every
  // refusal goes through here — a route's, an unknown method's, a credential's —
  // so one mark covers all of them.
  if (envelope.status === 'failed') refusals.add(response);

  // 200 for every answer, including a refusal — except the methods
  // `STATUS_REFUSALS` names, whose own specification asks for a status.
  response.writeHead(statusFor(method, envelope), {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function notFound(response: ServerResponse): void {
  const body = 'not found\n';
  response.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}
