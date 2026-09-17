/**
 * The Subsonic response envelope, and the two ways it is rendered.
 *
 * Every answer the API gives — a method's payload or an error — travels inside
 * one `subsonic-response` object, and the client decides whether the call
 * worked by reading `status` out of that object rather than by reading the HTTP
 * status line. So the envelope is the one shape every route agrees on, and the
 * one place a route can be wrong about the protocol while being right about its
 * own data. It gets a module of its own for that reason.
 *
 * Rendering is generic, and deliberately so. In the protocol's XML a field is
 * an attribute when it holds a value and a child element when it holds a record,
 * which makes the two formats one answer seen twice — so a route hands over a
 * plain object and neither chooses a format nor knows one is being chosen.
 */

/** The protocol version this server speaks. Clients refuse a server they outrank. */
export const API_VERSION = '1.16.1';

/**
 * What this server is called, and which of its own versions this is.
 *
 * **Both are required of every answer, and neither is about the answer.**
 * `type` is how a client adapts to what a server calling itself Subsonic
 * actually supports; `serverVersion` is how it knows *to ask again which
 * extensions exist* after a deployment — the spec is explicit that this is what
 * the field is for. `version` above is the API version and answers a third
 * question, so it stands in for neither.
 *
 * Pinned to `package.json` by a test rather than read from it at import: a
 * constant that cannot drift silently is worth more here than a file read in a
 * module every route depends on.
 */
export const SERVER_TYPE = 'funoteka';
export const SERVER_VERSION = '0.1.2';

/**
 * The fields every answer carries, whatever the answer is.
 *
 * `openSubsonic` is the one that matters most and the least obvious: it is how
 * a client learns that the extension list is worth asking for at all, and a
 * server that answers `getOpenSubsonicExtensions` without it has called a
 * client to a door the client cannot see.
 */
function identity(): Record<string, unknown> {
  return { type: SERVER_TYPE, serverVersion: SERVER_VERSION, openSubsonic: true };
}

/** The one element every answer hangs from, in either format. */
const ROOT = 'subsonic-response';

const NAMESPACE = 'http://subsonic.org/restapi';

/**
 * The protocol's own error codes.
 *
 * Transcribed complete rather than trimmed to the ones routes use today: a code
 * is a promise to the client about what went wrong, and the surest way to keep
 * that promise is to pick from the standard's list instead of inventing a
 * number that means something else to somebody's client.
 */
export const ERROR = {
  generic: 0,
  missingParameter: 10,
  clientTooOld: 20,
  serverTooOld: 30,
  wrongCredentials: 40,
  tokenAuthRefused: 41,
  unsupportedAuthMechanism: 42,
  conflictingAuthMechanisms: 43,
  invalidApiKey: 44,
  notAuthorized: 50,
  trialOver: 60,
  notFound: 70,
} as const;

/** `f` — the format the client asked for. XML is the protocol's default. */
export type Format = 'json' | 'xml';

export interface Envelope {
  status: 'ok' | 'failed';
  version: string;
  [field: string]: unknown;
}

export function ok(payload: Record<string, unknown> = {}): Envelope {
  return { status: 'ok', version: API_VERSION, ...identity(), ...payload };
}

export function failed(code: number, message: string): Envelope {
  return { status: 'failed', version: API_VERSION, ...identity(), error: { code, message } };
}

/**
 * A refusal a route decided on, on its way out.
 *
 * A route answers with the fields of a successful call, so the one thing it
 * cannot do is answer with a failure — and a route is exactly where the reason
 * for a failure is known: which parameter was missing, which id names nothing.
 * Throwing carries the code and the message from where the reason is to the one
 * place that renders envelopes.
 */
export class ApiError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** Anything but an explicit `f=json` is XML, which is what the protocol defaults to. */
export function parseFormat(value: string | null): Format {
  return value === 'json' ? 'json' : 'xml';
}

/**
 * The envelope, rendered.
 *
 * Both formats wrap it in `subsonic-response` — that name is how a client finds
 * the answer at all, in either — and only the XML carries a namespace, because
 * a namespace is an XML device and the JSON form has nowhere to put one.
 */
export function render(envelope: Envelope, format: Format): { contentType: string; body: string } {
  return format === 'json'
    ? {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ [ROOT]: envelope }),
      }
    : { contentType: 'application/xml; charset=utf-8', body: toXml(envelope) };
}

function toXml(envelope: Envelope): string {
  const fields: [string, unknown][] = [['xmlns', NAMESPACE], ...Object.entries(envelope)];
  return element(ROOT, fields);
}

type Fields = [string, unknown][];

function element(name: string, fields: Fields): string {
  const attributes = scalarFields(fields)
    .map(([field, value]) => ` ${field}="${escape(String(value))}"`)
    .join('');

  const children = recordFields(fields)
    .map(([field, value]) =>
      // An array is the same field repeated. A record standing alone is one
      // such field. A bare value in an array has no field to carry it, so the
      // element holds the value itself — which is how a protocol that writes
      // lyrics as element text is written.
      asArray(value)
        .map((item) =>
          isRecord(item)
            ? element(field, Object.entries(item))
            : `<${field}>${escape(String(item))}</${field}>`,
        )
        .join(''),
    )
    .join('');

  return children === ''
    ? `<${name}${attributes}/>`
    : `<${name}${attributes}>${children}</${name}>`;
}

/** The fields that hold a value, in the order they were given. Absent ones are dropped. */
function scalarFields(fields: Fields): Fields {
  return fields.filter(([, value]) => !isRecord(value) && !Array.isArray(value) && value != null);
}

function recordFields(fields: Fields): Fields {
  return fields.filter(([, value]) => (isRecord(value) || Array.isArray(value)) && value != null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * `&` first, or the ampersands an escape introduces would be escaped again.
 *
 * This is not decoration: the error message quotes the method name the client
 * asked for, and that name comes off the wire. Unescaped, it would be a way to
 * put arbitrary elements into a document the client parses as XML.
 */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
