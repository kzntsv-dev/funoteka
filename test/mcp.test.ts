import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { PROTOCOL_VERSION, handleMessage, serveStdio } from '../src/mcp/server.ts';
import { TOOLS, callTool, type AdminClient } from '../src/mcp/tools.ts';

/**
 * The MCP surface, asked the way a client asks it.
 *
 * The messages here are the ones an agent actually sends — the same JSON-RPC
 * shapes — because the whole of what this layer does is turn them into admin
 * requests and turn the answers back. A test that called the tool functions
 * directly would prove the table is wired to itself.
 */

/** A client that records what it was asked and answers whatever it is told to. */
function recorder(answer: { status: number; body: unknown } = { status: 200, body: { ok: true } }): {
  client: AdminClient;
  calls: { method: string; path: string; body?: unknown }[];
} {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    client: async (method, path, body) => {
      calls.push({ method, path, body });
      return answer;
    },
  };
}

/** One message in, and the answer's `result` — the shape almost every test wants. */
async function ask(client: AdminClient, message: unknown): Promise<Record<string, unknown>> {
  const answer = await handleMessage(client, message);
  assert.notEqual(answer, null, 'this message is not a notification');
  assert.equal(answer?.error, undefined, JSON.stringify(answer?.error));
  return (answer?.result ?? {}) as Record<string, unknown>;
}

test('the tools are named, described and schematised, and no two share a name', () => {
  // `tools/list` is how an agent finds out what it can do here, and an
  // undescribed tool is one it will not call.
  const names = TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'two tools with one name is a surface with a hole in it');
  assert.ok(names.every((name) => name.startsWith('funoteka_')), 'and they are the contract\u2019s funoteka_*');

  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 30, `${tool.name} says what it does`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} takes an object`);
    // Read from the schema, which is the only place they are declared now: they
    // used to be written twice and this loop was what checked the copies agreed.
    const required = (tool.inputSchema.required ?? []) as string[];
    for (const key of required) {
      const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
      assert.ok(properties?.[key] !== undefined, `${tool.name} declares the ${key} it needs`);
    }
  }
});

test('initialize answers in the version the client asked for', async () => {
  const { client } = recorder();

  const named = await ask(client, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(
    named.protocolVersion,
    PROTOCOL_VERSION,
    'the server signs its own revision and not the client’s — see the note in server.ts',
  );

  const silent = await ask(client, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  assert.equal(silent.protocolVersion, PROTOCOL_VERSION, 'and its own when the client names none');

  const info = silent.serverInfo as { name: string; version: string };
  assert.equal(info.name, 'funoteka');
  assert.equal(typeof info.version, 'string');
  assert.equal((silent.capabilities as { tools: unknown }).tools !== undefined, true);
});

test('a tool call becomes one admin request, with the arguments where the route wants them', async () => {
  const { client, calls } = recorder();

  await ask(client, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'funoteka_roots_add', arguments: { path: 'D:/Music' } },
  });
  assert.deepEqual(calls[0], { method: 'POST', path: '/roots', body: { path: 'D:/Music' } });

  // A read's arguments are the query string, because that is where the admin
  // routes read them from.
  await ask(client, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'funoteka_issues', arguments: { limit: 5, severity: 'warn' } },
  });
  assert.equal(calls[1]?.method, 'GET');
  assert.match(calls[1]?.path ?? '', /^\/issues\?limit=5&severity=warn$/);
  assert.equal(calls[1]?.body, undefined, 'and a read carries no body');

  // A tool that takes nothing asks for nothing.
  await ask(client, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'funoteka_status' } });
  assert.deepEqual(calls[2], { method: 'GET', path: '/status', body: undefined });
});

test('a server that refuses is content, and a missing argument is an error', async () => {
  // **The distinction an agent acts on.** A scan refused because one is running
  // is an answer from the right tool — an agent that saw a protocol error would
  // reach for a different tool instead of reading what the server said.
  const { client } = recorder({
    status: 409,
    body: { error: 'a scan is already running (pid 9)' },
  });

  const refused = await handleMessage(client, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'funoteka_scan_start' },
  });
  const result = refused?.result as { content: { text: string }[]; isError: boolean };
  assert.equal(result.isError, true, 'not good news, and still an answer');
  assert.match(result.content[0]?.text ?? '', /already running/);

  const missing = await handleMessage(client, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'funoteka_roots_add', arguments: {} },
  });
  assert.equal(missing?.error?.code, -32602);
  assert.match(missing?.error?.message ?? '', /needs path/, 'and it names what is missing');

  const unknown = await handleMessage(client, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'funoteka_sing' },
  });
  assert.match(unknown?.error?.message ?? '', /no such tool/);
});

test('a notification is answered with nothing at all', async () => {
  // The protocol's own silence: a server that replied to a notification would be
  // talking when it was spoken to.
  const { client } = recorder();

  assert.equal(await handleMessage(client, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handleMessage(client, { jsonrpc: '2.0', method: 'notifications/something-new' }), null);

  const named = await handleMessage(client, { jsonrpc: '2.0', id: 1, method: 'no/such/method' });
  assert.equal(named?.error?.code, -32601, 'but a request for an unknown method is answered as one');
});

test('the stdio transport reads lines, survives rubbish, and waits for the rest of a line', async () => {
  // Three things a line protocol has to get right, and all three are ordinary:
  // a message split across two chunks of a pipe, a blank line, and something
  // that is not JSON — which must be answered rather than fatal, because a
  // server that exited would look to the agent like a server that died.
  const input = new PassThrough();
  const output = new PassThrough();
  const { client, calls } = recorder();

  const lines: string[] = [];
  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line.trim() !== '') lines.push(line);
  });

  const serving = serveStdio(client, input, output);

  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}');
  input.write('\n\n');
  input.write('{not json}\n');
  // The same request, in two pieces, which is what a pipe does with a long one.
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/');
  input.write('call","params":{"name":"funoteka_stats"}}\n');

  await until('three answers', () => lines.length >= 3);
  input.end();
  await serving;

  assert.equal(JSON.parse(lines[0] ?? '').id, 1);
  assert.equal(JSON.parse(lines[1] ?? '').error.code, -32700, 'the rubbish is answered as rubbish');
  assert.equal(JSON.parse(lines[2] ?? '').id, 2, 'and the split message is one message');
  assert.deepEqual(calls, [{ method: 'GET', path: '/stats', body: undefined }]);
});

test('an admin API that is not answering is the one thing that is an error', async () => {
  // There is no answer to pass on, so there is nothing to report as content.
  const broken: AdminClient = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:4534');
  };

  const called = await callTool(broken, 'funoteka_status', {});

  assert.equal(called.ok, false);
  assert.match(called.ok === false ? called.error : '', /ECONNREFUSED/);
});

/** Wait for something to become true, or give up saying what never happened. */
async function until(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
