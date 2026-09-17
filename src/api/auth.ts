import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from './config.ts';
import { ERROR } from './envelope.ts';

/**
 * Who is asking, and may they.
 *
 * One user, as the contract says: a library on your own hardware has one keeper,
 * and a user table would be a way for a second password to exist without anyone
 * deciding it should. What the protocol offers is three ways to present that one
 * password, and all three are here because clients differ in which they send —
 * the plaintext (or `enc:`-encoded) password, the salted token, and the
 * OpenSubsonic API key.
 *
 * The refusal never says which half was wrong. A server that told the two apart
 * would let anyone holding a password learn the collection's usernames, one
 * guess at a time.
 */
export type AuthVerdict = { ok: true } | { ok: false; code: number; message: string };

export function authenticate(
  query: URLSearchParams,
  config: ServerConfig,
  signedRoute = false,
  registered: (given: string) => boolean = () => false,
): AuthVerdict {
  const user = query.get('u');
  const token = query.get('t');
  const salt = query.get('s');
  const password = query.get('p');
  const apiKey = query.get('apiKey');

  // **A signed link is a credential of its own**, and it is checked first
  // because such a request carries no user at all — see `coverSignature`. Only
  // the routes that hand links out accept one, and the caller says which.
  //
  // A signature that is *there* and does not hold is a refusal, not an absence:
  // a client that sent one meant to be let in, and telling it that `u` is
  // missing describes a request it did not make.
  if (signedRoute && signatureOffered(query)) {
    return signatureHolds(query, config) ? { ok: true } : refused();
  }

  // **A key is the whole credential, and it comes alone.** The extension's own
  // words: "When an API key is provided, the client **must not** provide a `u`
  // parameter; passing in `u` **must** be treated as an error 43" — and the same
  // for the other mechanisms, which is what a conflicting set of parameters is.
  //
  // This server had it exactly the other way round: `u` was demanded before
  // anything else, so the *only* form the specification allows was the one form
  // that could not work, and the form it forbids was the one that did. Found by
  // the operator bringing Symfonium up, which sent `apiKey` alone and was told
  // that `u` was missing — and reported it as a server whose version it could
  // not determine, since a refusal and an answer were one HTTP status here.
  // That last part is no longer true of every route: `getTranscodeStream`
  // answers a refusal with a status of its own, because its own page asks for
  // one (`STATUS_REFUSALS` in `server.ts`, task:2913).
  if (apiKey !== null) {
    const alongside = [token !== null || salt !== null, password !== null].filter(
      (yes) => yes,
    ).length;
    if (user !== null || alongside > 0) {
      return conflicting('apiKey arrives on its own — not with u, p, t or s');
    }

    // Two places a key may live, and both are checked. The environment's is the
    // bootstrap credential and is checked first — it is the way in that survives
    // a database; the registered ones are what a person can take back while the
    // server runs (`keys.ts`). Neither is a fallback for the other.
    const fromEnvironment = config.apiKey !== '' && sameSecret(apiKey, config.apiKey);
    return fromEnvironment || registered(apiKey) ? { ok: true } : refused();
  }

  if (user === null) return missing('u');

  // A token is two parameters and counts as one way in, so that a client which
  // sent `t`, `s` and `p` is seen as having offered two rather than three. The
  // key is not counted here: it never reaches this far.
  const offered = [token !== null || salt !== null, password !== null].filter((yes) => yes).length;

  if (offered > 1) return conflicting('Send one of p, or t with s — not both');
  if (offered === 0) return missing('p, t with s, or apiKey');

  // The user is checked before the secret, and both refusals are the same one:
  // a caller who guessed the user right learns nothing from the answer.
  if (!sameSecret(user, config.user)) return refused();

  if (password !== null) {
    const offered = password.startsWith('enc:') ? decodeHex(password.slice(4)) : password;
    if (offered === null) return refused();
    return config.password !== '' && sameSecret(offered, config.password) ? { ok: true } : refused();
  }

  // The token path. Half of it is not a partial credential, it is a request that
  // did not finish arriving, which is a different failure from a wrong one.
  if (token === null) return missing('t');
  if (salt === null) return missing('s');

  const expected = createHash('md5').update(`${config.password}${salt}`).digest('hex');
  return config.password !== '' && sameSecret(token.toLowerCase(), expected) ? { ok: true } : refused();
}

function missing(name: string): AuthVerdict {
  return { ok: false, code: ERROR.missingParameter, message: `Required parameter is missing: ${name}` };
}

/** Two ways in at once, which the protocol gives a code of its own. */
function conflicting(message: string): AuthVerdict {
  return { ok: false, code: ERROR.conflictingAuthMechanisms, message };
}

/**
 * The secret every picture link is signed with, and what revocation means here.
 *
 * The server's own key, or its password where no key is configured — one of the
 * two is always set, because a server with neither cannot be built at all.
 * **Changing it revokes every link ever handed out**, which is the whole of what
 * revoking a link needs to be: nothing is stored, so there is nothing else to
 * take back.
 */
function signingSecret(config: ServerConfig): string {
  return config.apiKey === '' ? config.password : config.apiKey;
}

/**
 * The signature a client may present instead of credentials on `getCoverArt`.
 *
 * **The reason is measured, not assumed.** An image loader does not
 * authenticate: the operator's Symfonium asks for an artist's picture with no
 * `u`, `t` or `s` at all, so a server that guards that route the way it guards
 * every other answers a refusal — and the client can only draw a placeholder
 * over it. Navidrome arrived at the same answer for the same symptom and hands
 * out a signed URL for artist art.
 *
 * It is signed over the id **and the route it is for**, so a link handed out for
 * a picture cannot be replayed against another door: the id alone would let a
 * signed cover link ask `getArtist` for the same id without credentials.
 */
export function coverSignature(id: string, config: ServerConfig): string {
  return createHmac('sha256', signingSecret(config)).update(`cover:${id}`).digest('base64url');
}

/** Whether the request brought a signature at all, which is not whether it fits. */
function signatureOffered(query: URLSearchParams): boolean {
  const given = query.get('sig');
  return given !== null && given !== '';
}

/** Whether a request carries a signature this server issued for its own id. */
function signatureHolds(query: URLSearchParams, config: ServerConfig): boolean {
  const id = query.get('id');
  const given = query.get('sig');
  if (id === null || given === null || given === '') return false;

  return sameSecret(given, coverSignature(id, config));
}

function refused(): AuthVerdict {
  return { ok: false, code: ERROR.wrongCredentials, message: 'Wrong username or password' };
}

/**
 * Whether two secrets are the same, in a time that does not say how nearly.
 *
 * Both sides are hashed first so that the comparison is between two buffers of
 * one length whatever was sent: `timingSafeEqual` refuses different lengths, and
 * an early return on a length a stranger controls is the comparison leaking by
 * another name. The hashing also means a password is never the thing compared.
 */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(hash(given), hash(expected));
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** The password `enc:` carries, or null when what follows is not hex at all. */
function decodeHex(value: string): string | null {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) return null;
  return Buffer.from(value, 'hex').toString('utf8');
}
