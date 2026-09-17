import { SERVER_VERSION } from '../api/envelope.ts';
import { IDEMPOTENCY_ARGUMENT, TOOLS, callTool, mutatingTool, type AdminClient } from './tools.ts';

/**
 * The protocol itself: JSON-RPC 2.0, four methods, and no dependencies.
 *
 * MCP over stdio is a line-delimited exchange — one JSON object per line, in
 * both directions — and over HTTP it is a POST carrying one. Neither needs a
 * library: the protocol this server has to speak is `initialize`, `tools/list`
 * and `tools/call`, and a project that carries no dependencies to serve music is
 * not going to carry one to answer three questions.
 *
 * **What is deliberately missing, and would be the next thing.** Prompts,
 * resources, sampling, notifications the server originates, SSE streaming, and
 * sessions. None of them is needed by an agent that wants to operate a music
 * server, and every one of them is a surface with its own security story — this
 * file says so rather than leaving a reader to guess whether it was forgotten.
 */

/**
 * The protocol revision this server speaks.
 *
 * **It answers with its own name, and not the client's.** An earlier version
 * echoed whatever non-empty string the client sent, which reads as agreement
 * with a revision this server has never implemented — and a client that then
 * used a feature of that revision would be talking to a server that had agreed
 * to something it does not do. A client that cannot work with this one says so,
 * which is the outcome worth having.
 */
export const PROTOCOL_VERSION = '2025-06-18';

/** One JSON-RPC message, as it arrives. */
interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface Answer {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * One message in, one message out — or nothing at all, for a notification.
 *
 * Nothing is the correct answer to a notification and it is not the same as an
 * error: `notifications/initialized` is a client telling this server it is
 * ready, and a server that replied would be talking when it was spoken to.
 */
export async function handleMessage(client: AdminClient, message: unknown): Promise<Answer | null> {
  if (message === null || typeof message !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a JSON-RPC message' } };
  }

  const { id = null, method, params = {} } = message as Message;
  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'no method' } };
  }

  // A notification has no id, and nothing comes back for one.
  const notification = (message as Message).id === undefined;

  switch (method) {
    case 'initialize': {
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'funoteka', version: SERVER_VERSION },
        instructions:
          'Operates a funoteka music server. Reads are safe and cheap; funoteka_scan_start reads the disk and runs as a separate process, and funoteka_roots_remove and funoteka_restore change the library. Every call goes through the admin API and is audited there.',
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          // A tool that changes something is offered the retry key; a read has
          // nothing to retry and is not told about one.
          inputSchema: mutatingTool(tool)
            ? {
                ...tool.inputSchema,
                properties: {
                  ...(tool.inputSchema.properties as Record<string, unknown> | undefined),
                  ...IDEMPOTENCY_ARGUMENT,
                },
              }
            : tool.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call needs a name' } };
      }

      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const called = await callTool(client, name, args);

      if (!called.ok) {
        // An unknown tool, a missing argument, or an admin API that is not
        // answering: there is no result to report, so this is a protocol error
        // rather than a tool that answered.
        return { jsonrpc: '2.0', id, error: { code: -32602, message: called.error } };
      }

      return reply(id, {
        content: [{ type: 'text', text: called.text }],
        // **A refusal is content, not an error.** A scan refused because one is
        // already running is an answer from the right tool, and an agent that
        // saw a protocol error would reach for a different tool instead of
        // reading what the server said. `isError` is the protocol's own way of
        // saying "this is an answer, and it is not good news".
        isError: called.refused,
      });
    }

    default:
      // Notifications for methods this server does not implement are dropped, as
      // the specification asks; anything else is a method error.
      if (notification) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `no such method: ${method}` } };
  }
}

function reply(id: string | number | null, result: unknown): Answer {
  return { jsonrpc: '2.0', id, result };
}

/**
 * The stdio loop: read lines, answer lines.
 *
 * **A line that is not JSON is answered, not fatal.** The caller here is an
 * agent's transport, and a server that exited on one malformed line would look
 * to it like a server that died — the failure would be investigated in the wrong
 * place. One error message back, and the loop keeps reading.
 *
 * Nothing is written to stdout except protocol messages: an agent reads that
 * stream as the protocol, and a stray `console.log` (of ours or of anything we
 * import) would be a message it could not parse.
 */
export function serveStdio(
  client: AdminClient,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  let buffer = '';

  const write = (message: Answer): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  /**
   * **One message at a time, in the order they arrived.**
   *
   * JSON-RPC does not require this — every answer carries the id of the question
   * it belongs to, and a client is entitled to match them up however they come
   * back. It is done anyway because the cost is a promise chain and what it buys
   * is that a client which reads its answers in order is not surprised. The
   * first version of this loop fired each message off as it arrived, and a
   * garbled line's answer overtook a `initialize` that was waiting on an HTTP
   * call — legal, and exactly the kind of thing that gets diagnosed in the wrong
   * place.
   */
  let queue: Promise<void> = Promise.resolve();

  return new Promise<void>((resolve) => {
    input.setEncoding?.('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;

      // One message per line, and a partial line waits for the rest of itself —
      // a JSON object split across two chunks is ordinary, not an error.
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (line !== '') {
          queue = queue.then(() => deliver(client, line, write));
        }
        newline = buffer.indexOf('\n');
      }
    });

    input.on('end', () => {
      void queue.then(() => resolve());
    });
  });
}

async function deliver(client: AdminClient, line: string, write: (message: Answer) => void): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `not JSON: ${(err as Error).message}` } });
    return;
  }

  const answer = await handleMessage(client, parsed);
  if (answer !== null) write(answer);
}
