// tests/tools/spendings.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { BillingoClient } from '../../src/billingo/client.js';
import { spendingTools } from '../../src/tools/spendings.js';
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
  const tool = spendingTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};

/**
 * A minimal spending that satisfies SpendingSave's required fields (spec/billingo-3.0.15.json
 * -> components.schemas.SpendingSave.required): currency, total_gross, total_gross_huf,
 * total_vat_amount, total_vat_amount_huf, fulfillment_date, category, payment_method.
 */
const validSpending = {
  category: 'other',
  currency: 'HUF',
  total_gross: 12700,
  total_gross_huf: 12700,
  total_vat_amount: 2700,
  total_vat_amount_huf: 2700,
  fulfillment_date: '2026-01-15',
  payment_method: 'wire_transfer',
};

describe('spending tool surface', () => {
  it('exposes the expected tools in the expected scopes', () => {
    expect([...spendingTools].map((t) => `${t.scope}:${t.name}`).sort()).toEqual([
      'read:billingo_get_spending',
      'read:billingo_list_spendings',
      'write:billingo_create_spending',
      'write:billingo_delete_spending',
      'write:billingo_update_spending',
    ]);
  });
});

describe('billingo_list_spendings', () => {
  it('forwards date filters as query params', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/spendings', ({ request }) => {
        url = request.url;
        return HttpResponse.json({
          data: [],
          total: 0,
          per_page: 25,
          current_page: 1,
          last_page: 1,
        });
      }),
    );
    await byName('billingo_list_spendings').handler(
      { start_date: '2026-01-01', end_date: '2026-01-31' },
      ctx,
    );
    expect(url).toContain('start_date=2026-01-01');
    expect(url).toContain('end_date=2026-01-31');
  });

  it('rejects a date that is not ISO yyyy-mm-dd', () => {
    const schema = z.object(byName('billingo_list_spendings').inputSchema);
    expect(() => schema.parse({ start_date: '01/01/2026' })).toThrow();
    expect(schema.parse({ start_date: '2026-01-01' }).start_date).toBe('2026-01-01');
  });
});

describe('billingo_get_spending', () => {
  it('fetches /spendings/{id}', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/spendings/:id', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: 11, category: 'other' });
      }),
    );
    await byName('billingo_get_spending').handler({ id: 11 }, ctx);
    expect(path).toBe('/v3/spendings/11');
  });
});

describe('billingo_create_spending', () => {
  it('posts the spending', async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/spendings', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 11 }, { status: 201 });
      }),
    );
    await byName('billingo_create_spending').handler(
      { ...validSpending, partner_id: 42, paid_at: '2026-01-20' },
      ctx,
    );
    expect(body).toMatchObject({ partner_id: 42, total_gross: 12700 });
  });

  it('requires the fields the API needs (SpendingSave.required)', () => {
    const schema = z.object(byName('billingo_create_spending').inputSchema);
    expect(() => schema.parse({ category: 'other' })).toThrow();
    expect(schema.parse(validSpending)).toMatchObject({ category: 'other' });
  });

  it('rejects a category outside the enum instead of accepting any string', () => {
    const schema = z.object(byName('billingo_create_spending').inputSchema);
    expect(() => schema.parse({ ...validSpending, category: 'not_a_real_category' })).toThrow();
  });

  it('rejects a payment method outside the enum', () => {
    const schema = z.object(byName('billingo_create_spending').inputSchema);
    expect(() => schema.parse({ ...validSpending, payment_method: 'not_a_real_method' })).toThrow();
  });
});

describe('billingo_update_spending', () => {
  const fullUpdate = { id: 11, ...validSpending, total_gross: 20000 };

  it('puts the full record to /spendings/{id} without the id in the body', async () => {
    let path = '';
    let body: Record<string, unknown> = {};
    server.use(
      http.put('https://api.billingo.hu/v3/spendings/:id', async ({ request }) => {
        path = new URL(request.url).pathname;
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 11 });
      }),
    );
    await byName('billingo_update_spending').handler(fullUpdate, ctx);
    expect(path).toBe('/v3/spendings/11');
    expect(body['id']).toBeUndefined();
    expect(body['total_gross']).toBe(20000);
  });

  it('rejects a body missing SpendingSave.required fields — PUT reuses the create schema', () => {
    const schema = z.object(byName('billingo_update_spending').inputSchema);
    expect(() => schema.parse({ id: 11 })).toThrow();
    expect(() => schema.parse({ id: 11, total_gross: 20000 })).toThrow();
    expect(schema.parse(fullUpdate)).toMatchObject({ total_gross: 20000 });
  });
});

describe('billingo_delete_spending', () => {
  it('is registered, write-scoped and marked destructive', () => {
    const tool = byName('billingo_delete_spending');
    expect(tool.scope).toBe('write');
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('deletes by id', async () => {
    let path = '';
    server.use(
      http.delete('https://api.billingo.hu/v3/spendings/:id', ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const result = await byName('billingo_delete_spending').handler({ id: 11 }, ctx);
    expect(path).toBe('/v3/spendings/11');
    // A 204 becomes `null` in BillingoClient; the model must see an explicit success,
    // not the literal text "null" — otherwise it cannot tell success from failure and
    // may retry a delete that already worked.
    expect(result.content[0]).not.toEqual({ type: 'text', text: 'null' });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Success') as string });
  });
});
