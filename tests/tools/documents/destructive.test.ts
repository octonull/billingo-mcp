// tests/tools/documents/destructive.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { BillingoClient } from '../../../src/billingo/client.js';
import { documentDestructiveTools } from '../../../src/tools/documents/destructive.js';
import type { AnyToolDefinition } from '../../../src/tools/registry.js';

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
  const tool = documentDestructiveTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};

describe('destructive document tool surface', () => {
  it('exposes exactly the four expected tools, all write-scoped', () => {
    expect([...documentDestructiveTools].map((t) => t.name).sort()).toEqual([
      'billingo_cancel_document',
      'billingo_delete_document',
      'billingo_delete_payment',
      'billingo_send_document',
    ]);
    expect(documentDestructiveTools.every((t) => t.scope === 'write')).toBe(true);
  });

  it('marks every tool destructive — this is the hint clients gate confirmation on', () => {
    for (const tool of documentDestructiveTools) {
      expect(tool.annotations.destructiveHint).toBe(true);
      expect(tool.annotations.readOnlyHint).not.toBe(true);
    }
  });

  it('states the irreversibility of a storno in its description', () => {
    const description = byName('billingo_cancel_document').description;
    expect(description).toContain('NAV');
    expect(description.toLowerCase()).toContain('cannot be undone');
  });

  it('warns that send_document emails the customer', () => {
    expect(byName('billingo_send_document').description.toLowerCase()).toContain('email');
  });
});

describe('billingo_cancel_document', () => {
  it('posts to the cancel path and returns the storno document', async () => {
    let path = '';
    server.use(
      http.post('https://api.billingo.hu/v3/documents/:id/cancel', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: 99, type: 'cancellation' }, { status: 201 });
      }),
    );
    const result = await byName('billingo_cancel_document').handler({ id: 50 }, ctx);
    expect(path).toBe('/v3/documents/50/cancel');
    expect(result.isError).toBeUndefined();
  });
});

describe('billingo_send_document', () => {
  it('posts the recipient list', async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/documents/:id/send', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    await byName('billingo_send_document').handler({ id: 50, emails: ['a@b.hu'] }, ctx);
    expect(body).toMatchObject({ emails: ['a@b.hu'] });
  });
});

describe('billingo_delete_document and delete_payment', () => {
  it('deletes a document', async () => {
    let method = '';
    let path = '';
    server.use(
      http.delete('https://api.billingo.hu/v3/documents/:id', ({ request }) => {
        method = request.method;
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const result = await byName('billingo_delete_document').handler({ id: 50 }, ctx);
    expect(method).toBe('DELETE');
    expect(path).toBe('/v3/documents/50');
    // A 204 becomes `null` in BillingoClient; the model must see an explicit success,
    // not the literal text "null" — otherwise it cannot tell success from failure and
    // may retry a delete that already worked.
    expect(result.content[0]).not.toEqual({ type: 'text', text: 'null' });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Success') as string });
  });

  it('deletes the payment history of a document', async () => {
    let path = '';
    server.use(
      http.delete('https://api.billingo.hu/v3/documents/:id/payments', ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await byName('billingo_delete_payment').handler({ id: 50 }, ctx);
    expect(path).toBe('/v3/documents/50/payments');
  });
});
