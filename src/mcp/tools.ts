/**
 * The `funoteka_*` tools an agent drives this server with.
 *
 * **Every tool is one admin route, and this file is a table rather than a second
 * implementation.** The contract says MCP *over* the admin API, and that is the
 * whole design: an agent calling `funoteka_scan_start` goes through the same
 * gate, the same audit line, the same idempotency record and the same refusal
 * sentences as an operator with `curl`. A tool layer that reached into the
 * database itself would be a second control surface to secure, a second place
 * behaviour is defined, and a second answer to keep in step with the first.
 *
 * So a tool is a method, a path, and a way of turning its arguments into a body
 * — and the table below is the entire surface. `tools/list` publishes it, which
 * is how an agent finds out what it can do here without being told.
 */

/** What a tool needs in order to be called: the admin API, with a token. */
export interface AdminClient {
  (
    method: string,
    path: string,
    body?: unknown,
    /** The caller's retry key, when it gave one. See `IDEMPOTENCY_ARGUMENT`. */
    idempotencyKey?: string,
  ): Promise<{ status: number; body: unknown }>;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as the protocol wants it. */
  inputSchema: Record<string, unknown>;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** The admin route's body, built from the arguments, or nothing for a read. */
  body?: (args: Record<string, unknown>) => unknown;
}

/**
 * The argument that makes a retry safe, offered on the tools that change
 * something.
 *
 * The HTTP surface takes an `Idempotency-Key` header. A tool call is one JSON
 * object and has nowhere to put a header, so the key is an argument here — and
 * it reaches the same record the header does, which is what keeps this file's
 * opening claim true: the same idempotency record as an operator with `curl`.
 *
 * **What it is for is not symmetry.** Until it existed, a client that lost an
 * answer and repeated the call did the work twice, and the tool where that is
 * not harmless is `funoteka_user_set {"rotate":"apiKey"}`: the second call mints
 * a second key and invalidates the one the first call handed back. The contract
 * asks for idempotent mutations without qualifying the transport (§3), and this
 * was the transport that did not have them.
 *
 * Declared once and spread into every mutating tool by `server.ts`, rather than
 * written into each of them: "which tools mutate" is one rule, and a dozen
 * copies of it would be a dozen things to forget.
 */
export const IDEMPOTENCY_ARGUMENT = {
  idempotencyKey: {
    type: 'string',
    description:
      'Answers a repeated call with the first answer instead of doing the work twice. Send the same value when retrying.',
  },
} as const;

/** Whether a tool changes something, which is when a retry needs a key. */
export function mutatingTool(tool: Tool): boolean {
  return tool.method !== 'GET';
}

const NOBODY = { type: 'object', properties: {}, additionalProperties: false } as const;

/**
 * The tools, in the order an operator would meet them.
 *
 * The descriptions are written for the caller that has none of this server's
 * context — an agent that has just been told to add a shelf has to be told, in
 * the description, that a scan is a separate and slower thing.
 */
export const TOOLS: readonly Tool[] = [
  {
    name: 'funoteka_status',
    description:
      'What this server is and what it is doing: version, uptime, how big the collection is, whether a scan is running, and how the admin surface itself is configured.',
    inputSchema: NOBODY,
    method: 'GET',
    path: '/status',
  },
  {
    name: 'funoteka_stats',
    description: 'The library in numbers: roots, folders, files, songs, albums, artists, playlists, hidden albums, issues, and the size of the meta layer.',
    inputSchema: NOBODY,
    method: 'GET',
    path: '/stats',
  },
  {
    name: 'funoteka_issues',
    description:
      'What the scanner could not understand — every guess, skip, unmatched cue and refused tag — with a count of each kind. This is the only place those findings are visible.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'how many to return, 1–1000 (default 100)' },
        severity: { type: 'string', description: 'only this severity: info, warn or error' },
      },
    },
    method: 'GET',
    path: '/issues',
  },
  {
    name: 'funoteka_logs',
    description: 'The last lines of the file this server narrates to. The read is bounded, so it is safe on a log that has been growing for months.',
    inputSchema: {
      type: 'object',
      properties: { lines: { type: 'number', description: 'how many lines from the end, 1–5000 (default 200)' } },
    },
    method: 'GET',
    path: '/logs',
  },
  {
    name: 'funoteka_config_get',
    description:
      'Every setting, in force and where it came from (default, file, environment, flag). Secrets are reported as set and never as themselves.',
    inputSchema: NOBODY,
    method: 'GET',
    path: '/config',
  },
  {
    name: 'funoteka_config_set',
    description:
      'Write settings into the config file. The answer says whether each value is actually in force — the environment wins over the file — and nothing takes effect until the server is restarted.',
    inputSchema: {
      type: 'object',
      properties: {
        settings: {
          type: 'object',
          description: 'setting name to value, e.g. {"port": 8080, "logRequests": true}. null removes a key.',
        },
      },
      required: ['settings'],
    },
    method: 'POST',
    path: '/config',
    body: (args) => args.settings,
  },
  {
    name: 'funoteka_roots_list',
    description:
      'The directories this server reads, with what came from each and when it was last scanned. A root that has never been scanned is configured but not yet read.',
    inputSchema: NOBODY,
    method: 'GET',
    path: '/roots',
  },
  {
    name: 'funoteka_roots_add',
    description:
      'Configure a directory as something this server reads. The path must be a directory on the machine the *server* runs on. Adding one does not read it — start a scan for that.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'an absolute path as the server sees it' } },
      required: ['path'],
    },
    method: 'POST',
    path: '/roots',
    body: (args) => ({ path: args.path }),
  },
  {
    name: 'funoteka_roots_remove',
    description:
      'Stop reading a directory. Everything derived from it leaves the library with it (the answer says how much), and the files on disk are not touched.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'the root to stop reading' } },
      required: ['path'],
    },
    method: 'DELETE',
    path: '/roots',
    body: (args) => ({ path: args.path }),
  },
  {
    name: 'funoteka_scan_start',
    description:
      'Start reading the configured roots. The scan runs as a process of its own and this answers as soon as it has started — watch it with funoteka_scan_status. "full" reads every file again even if it has not changed; "incremental" trusts size and modification time.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['incremental', 'full'], description: 'default incremental' } },
    },
    method: 'POST',
    path: '/scan',
    body: (args) => (args.mode === undefined ? {} : { mode: args.mode }),
  },
  {
    name: 'funoteka_scan_status',
    description: 'Whether a scan is running now (and its pid), and what the last one did.',
    inputSchema: NOBODY,
    method: 'GET',
    path: '/scan',
  },
  {
    name: 'funoteka_scan_cancel',
    description: 'Stop the scan that is running — or settle the record of one whose process is gone, which is the way out of a run that would otherwise refuse every later scan.',
    inputSchema: NOBODY,
    method: 'POST',
    path: '/scan/cancel',
  },
  {
    name: 'funoteka_scan_history',
    description: 'What the last few scans did, newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'how many runs, 1–200 (default 20)' } },
    },
    method: 'GET',
    path: '/scan/history',
  },
  {
    name: 'funoteka_junk_list',
    description:
      'What the junk filter is keeping out of the default view, with the reason for each, and separately the edits a person made by hand.',
    inputSchema: NOBODY,
    method: 'GET',
    path: '/junk',
  },
  {
    name: 'funoteka_junk_mark',
    description:
      'Decide about a folder by hand, overruling the filter. verdict "junk" keeps it out of every listing; "trust" serves it whatever the rule says. Takes effect at once — no rescan.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'the folder, as the server sees it' },
        verdict: { type: 'string', enum: ['junk', 'trust'] },
        note: { type: 'string', description: 'why, for whoever reads this back in six months' },
      },
      required: ['path', 'verdict'],
    },
    method: 'POST',
    path: '/junk',
    body: (args) => ({ path: args.path, verdict: args.verdict, note: args.note }),
  },
  {
    name: 'funoteka_junk_unmark',
    description: 'Take a hand edit back and let the filter decide that folder again.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    method: 'DELETE',
    path: '/junk',
    body: (args) => ({ path: args.path }),
  },
  {
    name: 'funoteka_playlists_import',
    description: 'Read the collection\'s .m3u files again and import any that are lists of their own.',
    inputSchema: NOBODY,
    method: 'POST',
    path: '/playlists/import',
  },
  {
    name: 'funoteka_export',
    description:
      'Everything a rescan cannot rebuild: playlists, stars, ratings, bookmarks, hand edits and api keys. The document also says what it is not holding.',
    inputSchema: NOBODY,
    method: 'GET',
    path: '/export',
  },
  {
    name: 'funoteka_restore',
    description:
      'Write an export document back into this library, by the files it names rather than by row ids. A merge: what is already here is left alone, and everything that could not be placed is listed.',
    inputSchema: {
      type: 'object',
      properties: { document: { type: 'object', description: 'an object from funoteka_export' } },
      required: ['document'],
    },
    method: 'POST',
    path: '/restore',
    body: (args) => args.document,
  },
  {
    name: 'funoteka_user_get',
    description: 'Who may listen: whether a password and an api key are set and where from, and the keys in the registry. Never the secrets themselves.',
    inputSchema: NOBODY,
    method: 'GET',
    path: '/user',
  },
  {
    name: 'funoteka_user_set',
    description:
      'Change the listener credentials. {"rotate": "apiKey"} mints a key and shows it once — the only moment this surface hands a secret back. Refused if the change would leave nobody able to get in.',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string' },
        password: { type: 'string' },
        apiKey: { type: 'string' },
        rotate: { type: 'string', enum: ['apiKey'] },
      },
    },
    method: 'POST',
    path: '/user',
    body: (args) => {
      const body: Record<string, unknown> = {};
      for (const key of ['user', 'password', 'apiKey', 'rotate']) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      return body;
    },
  },
  {
    name: 'funoteka_restart',
    description:
      'Restart the server: exit and be started again by whatever supervises it. Refused where nothing does, because there a restart would only stop it.',
    inputSchema: NOBODY,
    method: 'POST',
    path: '/restart',
  },
];

export function toolNamed(name: string): Tool | undefined {
  return TOOLS.find((one) => one.name === name);
}

/**
 * The arguments a tool insists on, or nothing when it has them all.
 *
 * **Read from the schema, which is the one place they are declared.** They used
 * to be written twice — in `inputSchema.required` and in a field beside it — and
 * a test existed only to check the two agreed, which is a test standing in for
 * the second copy not existing.
 */
export function missingArguments(tool: Tool, args: Record<string, unknown>): string[] {
  const required = tool.inputSchema.required;
  if (!Array.isArray(required)) return [];
  return (required as string[]).filter((key) => args[key] === undefined);
}

/**
 * The protocol's answer to one `tools/call`.
 *
 * Two things are deliberately *not* errors here. A route that refused — a scan
 * refused because one is running, a root that is not a directory — is a
 * successful tool call whose content says what the server said: an agent that
 * saw an MCP-level error would reach for a different tool, and the truth is that
 * it asked the right one and got an answer. And a status the *transport* could
 * not produce at all (the API is not answering) is the one case that is an
 * error, because there is no answer to pass on.
 */
export async function callTool(
  client: AdminClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; text: string; refused: boolean } | { ok: false; error: string }> {
  const tool = toolNamed(name);
  if (tool === undefined) return { ok: false, error: `no such tool: ${name}` };

  const missing = missingArguments(tool, args);
  if (missing.length > 0) {
    return { ok: false, error: `${name} needs ${missing.join(', ')}` };
  }

  // Pulled out before the arguments become a query or a body: the key is
  // addressed to the transport, and a route that received it as a parameter
  // would be a route that has to know about retries.
  const { idempotencyKey, ...rest } = args;
  const key = typeof idempotencyKey === 'string' && idempotencyKey !== '' ? idempotencyKey : undefined;

  const query = tool.method === 'GET' ? asQuery(tool.path, rest) : tool.path;
  const body = tool.method === 'GET' ? undefined : tool.body?.(rest);

  try {
    const answer = await client(tool.method, query, body, key);
    return {
      ok: true,
      text: JSON.stringify(answer.body),
      refused: answer.status >= 400,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * A `GET` route's arguments, as the query string it reads them from.
 *
 * The admin routes take their filters in the query — `?limit=`, `?severity=` —
 * and one place has to know that, rather than each tool carrying a URL builder.
 */
function asQuery(path: string, args: Record<string, unknown>): string {
  const asked = Object.entries(args).filter(([, value]) => value !== undefined);
  if (asked.length === 0) return path;

  const query = new URLSearchParams(asked.map(([key, value]) => [key, String(value)] as [string, string]));
  return `${path}?${query.toString()}`;
}
