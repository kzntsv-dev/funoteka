import type { AdminClient } from './tools.ts';

/**
 * The admin API, called over HTTP, by an MCP server that is a process of its own.
 *
 * This is the client the stdio transport uses: an agent starts `funoteka mcp`,
 * and every tool call it makes leaves this process as one authenticated HTTP
 * request to the admin port. That is the design rather than a shortcut — the
 * gate, the audit line, the lockout and the refusal sentences all belong to that
 * port, and a second path into the same work would be a second place for them to
 * be forgotten.
 *
 * The token is a bearer header and never a query parameter, for the reason the
 * admin surface keeps saying: a query string is what ends up in a log line.
 */
export function adminClient(url: string, token: string): AdminClient {
  return async (method, path, body, idempotencyKey) => {
    const response = await fetch(new URL(path, url), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        // **The retry key, which this client used to drop on the floor.** The
        // tool layer hands it over as a fourth argument and an implementation
        // that ignores one is not a type error — so an agent calling over stdio
        // got no idempotency at all while the HTTP transport had it, which is
        // the half that would never have been noticed.
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    return { status: response.status, body: parse(text) };
  };
}

/**
 * A body, parsed if it is JSON.
 *
 * A route that answers with something else — the inventory dump is text — is
 * still an answer, and a client that threw on it would report a working route as
 * a transport failure. What comes back is the text under a name that says so.
 */
function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}
