// tests/server/server.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BillingoClient } from '../../src/billingo/client.js';
import { createServer } from '../../src/server.js';
import { allTools } from '../../src/tools/index.js';

const api = setupServer();
beforeAll(() => {
  api.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  api.resetHandlers();
});
afterAll(() => {
  api.close();
});

/** Connects a real MCP client to the server over an in-memory transport pair. */
async function connect(allowWrite: boolean) {
  const billingo = new BillingoClient({ apiKey: 'k', sleep: async () => {} });
  const server = createServer({ client: billingo, allowWrite });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

describe('tool registry totals', () => {
  it('registers exactly 49 tools, 22 read and 27 write', () => {
    expect(allTools).toHaveLength(49);
    expect(allTools.filter((t) => t.scope === 'read')).toHaveLength(22);
    expect(allTools.filter((t) => t.scope === 'write')).toHaveLength(27);
  });

  it('gives every tool a unique billingo_-prefixed name', () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('billingo_'))).toBe(true);
  });

  it("gives every tool a non-trivial description — it is the model's only documentation", () => {
    for (const tool of allTools) {
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(30);
      expect(tool.title.length, `${tool.name} title`).toBeGreaterThan(0);
    }
  });

  it('marks every read tool readOnlyHint and no write tool readOnlyHint', () => {
    for (const tool of allTools) {
      if (tool.scope === 'read') expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
      else expect(tool.annotations.readOnlyHint, tool.name).not.toBe(true);
    }
  });
});

describe('scope filtering over a real MCP connection', () => {
  it('exposes only the 22 read tools by default', async () => {
    const { client } = await connect(false);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(22);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('hides every write tool by name when writes are not allowed', async () => {
    const { client } = await connect(false);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const write of allTools.filter((t) => t.scope === 'write')) {
      expect(names.has(write.name), `${write.name} must be hidden`).toBe(false);
    }
    // The tools most likely to cause real damage, named explicitly.
    expect(names.has('billingo_create_document')).toBe(false);
    expect(names.has('billingo_cancel_document')).toBe(false);
    expect(names.has('billingo_send_document')).toBe(false);
    expect(names.has('billingo_guess_partner')).toBe(false);
  });

  it('exposes all 49 tools when writes are allowed', async () => {
    const { client } = await connect(true);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(49);
    expect(tools.map((t) => t.name)).toContain('billingo_create_document');
  });

  it('refuses to call a write tool that was never registered', async () => {
    // The pinned SDK (1.29.0) turns "tool not found" into a normal CallToolResult with
    // isError: true (McpServer#createToolError), not a rejected/thrown JSON-RPC error —
    // so this asserts on the result shape, not a rejection.
    const { client } = await connect(false);
    const result = await client.callTool({
      name: 'billingo_cancel_document',
      arguments: { id: 1 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not found');
  });

  it('actually calls the API through a registered read tool', async () => {
    api.use(
      http.get('https://api.billingo.hu/v3/organization', () =>
        HttpResponse.json({ id: 1, name: 'Acme Kft.' }),
      ),
    );
    const { client } = await connect(false);
    const result = await client.callTool({ name: 'billingo_get_organization', arguments: {} });
    expect(JSON.stringify(result.content)).toContain('Acme Kft.');
  });

  it('surfaces an API error to the client as a tool error, not a transport crash', async () => {
    api.use(
      http.get('https://api.billingo.hu/v3/organization', () =>
        HttpResponse.json({ error: { message: 'Unauthenticated.' } }, { status: 401 }),
      ),
    );
    const { client } = await connect(false);
    const result = await client.callTool({ name: 'billingo_get_organization', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Unauthenticated.');
  });

  it('propagates a non-Billingo error rather than swallowing it as an API error', async () => {
    // Malformed JSON on a 200 makes BillingoClient#requestJson throw a raw SyntaxError,
    // not a BillingoError — this exercises runTool's rethrow branch in src/server.ts,
    // as opposed to the BillingoApiError branch the 401 test above covers.
    api.use(
      http.get(
        'https://api.billingo.hu/v3/organization',
        () => new HttpResponse('not json', { status: 200 }),
      ),
    );
    const { client } = await connect(false);
    const result = await client.callTool({ name: 'billingo_get_organization', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('rejects invalid arguments before any API call is made', async () => {
    // No MSW handler registered: if a request escapes, onUnhandledRequest:'error' fails the test.
    const { client } = await connect(false);
    const result = await client.callTool({
      name: 'billingo_get_partner',
      arguments: { id: 'not-a-number' },
    });
    expect(result.isError).toBe(true);
  });
});
