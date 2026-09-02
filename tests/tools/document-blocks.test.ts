// tests/tools/document-blocks.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { BillingoClient } from '../../src/billingo/client.js';
import { documentBlockTools } from '../../src/tools/document-blocks.js';
import type { AnyToolDefinition } from '../../src/tools/registry.js';

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

// Built in beforeAll, NOT at module level: BillingoClient captures globalThis.fetch in
// its constructor, so constructing it before server.listen() bypasses MSW and lets the
// test hit the real Billingo API.
let ctx: { client: BillingoClient };
beforeAll(() => {
  ctx = { client: new BillingoClient({ apiKey: 'k', sleep: () => Promise.resolve() }) };
});
const byName = (name: string): AnyToolDefinition => {
  const tool = documentBlockTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};
const textOf = (result: { content: unknown[] }): string =>
  result.content.map((c) => (c as { text?: string }).text ?? '').join('\n');

describe('document block tools', () => {
  it('exposes a read list and a write create', () => {
    expect([...documentBlockTools].map((t) => `${t.scope}:${t.name}`).sort()).toEqual([
      'read:billingo_list_document_blocks',
      'write:billingo_create_document_block',
    ]);
  });

  it('lists blocks with a page summary', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/document-blocks', () =>
        HttpResponse.json({
          data: [{ id: 1, name: 'Default' }],
          total: 1,
          per_page: 25,
          current_page: 1,
          last_page: 1,
        }),
      ),
    );
    const result = await byName('billingo_list_document_blocks').handler({}, ctx);
    expect(textOf(result)).toContain('Page 1 of 1 (1 results total, 25 per page).');
    expect(textOf(result)).toContain('Default');
  });

  it('creates a block', async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/document-blocks', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 4 }, { status: 201 });
      }),
    );
    await byName('billingo_create_document_block').handler({ name: 'Webshop', prefix: 'WS' }, ctx);
    expect(body).toMatchObject({ name: 'Webshop', prefix: 'WS' });
  });
});
