// tests/tools/products.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { BillingoClient } from '../../src/billingo/client.js';
import { productTools } from '../../src/tools/products.js';
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
  const tool = productTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};
const textOf = (result: { content: unknown[] }): string =>
  result.content.map((c) => (c as { text?: string }).text ?? '').join('\n');

describe('product tool surface', () => {
  it('exposes the expected tools in the expected scopes', () => {
    expect([...productTools].map((t) => `${t.scope}:${t.name}`).sort()).toEqual([
      'read:billingo_get_product',
      'read:billingo_get_product_quantity',
      'read:billingo_list_products',
      'write:billingo_create_product',
      'write:billingo_delete_product',
      'write:billingo_update_product',
    ]);
  });
});

describe('billingo_list_products', () => {
  it('pages and summarizes', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/products', () =>
        HttpResponse.json({
          data: [{ id: 1, name: 'Widget' }],
          total: 3,
          per_page: 25,
          current_page: 1,
          last_page: 1,
        }),
      ),
    );
    const result = await byName('billingo_list_products').handler({}, ctx);
    expect(textOf(result)).toContain('Page 1 of 1 (3 results total, 25 per page).');
  });
});

describe('billingo_get_product', () => {
  it('fetches /products/{id}', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/products/:id', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: 5, name: 'Widget' });
      }),
    );
    const result = await byName('billingo_get_product').handler({ id: 5 }, ctx);
    expect(path).toBe('/v3/products/5');
    expect(textOf(result)).toContain('Widget');
  });
});

describe('billingo_get_product_quantity', () => {
  it('hits the inventory path', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/inventory/product/:id/quantity', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ quantity: 12 });
      }),
    );
    await byName('billingo_get_product_quantity').handler({ id: 5 }, ctx);
    expect(path).toBe('/v3/inventory/product/5/quantity');
  });
});

describe('billingo_create_product', () => {
  it('posts the product', async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/products', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 3 }, { status: 201 });
      }),
    );
    await byName('billingo_create_product').handler(
      { name: 'Widget', net_unit_price: 1000, vat: '27%', currency: 'HUF', unit: 'db' },
      ctx,
    );
    expect(body).toMatchObject({ name: 'Widget', vat: '27%', net_unit_price: 1000 });
  });

  it('accepts the Hungarian special VAT codes, not just percentages', () => {
    const schema = z.object(byName('billingo_create_product').inputSchema);
    expect(schema.parse({ name: 'X', vat: 'AAM' }).vat).toBe('AAM');
    expect(schema.parse({ name: 'X', vat: 'TAM' }).vat).toBe('TAM');
    expect(schema.parse({ name: 'X', vat: '25,5%' }).vat).toBe('25,5%');
  });

  it('rejects a VAT value outside the API enum', () => {
    const schema = z.object(byName('billingo_create_product').inputSchema);
    // '25.5%' with a decimal point is wrong — the API writes it with a comma.
    expect(() => schema.parse({ name: 'X', vat: '25.5%' })).toThrow();
    expect(() => schema.parse({ name: 'X', vat: '99%' })).toThrow();
  });

  it('requires a name', () => {
    const schema = z.object(byName('billingo_create_product').inputSchema);
    expect(() => schema.parse({ vat: '27%' })).toThrow();
  });
});

describe('billingo_update_product', () => {
  const fullUpdate = { id: 3, name: 'Widget v2', currency: 'HUF', vat: '27%', unit: 'db' } as const;

  it('puts the full record to /products/{id} without the id in the body', async () => {
    let path = '';
    let body: Record<string, unknown> = {};
    server.use(
      http.put('https://api.billingo.hu/v3/products/:id', async ({ request }) => {
        path = new URL(request.url).pathname;
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 3 });
      }),
    );
    await byName('billingo_update_product').handler(fullUpdate, ctx);
    expect(path).toBe('/v3/products/3');
    expect(body).toEqual({ name: 'Widget v2', currency: 'HUF', vat: '27%', unit: 'db' });
  });

  it('rejects a body missing currency, vat or unit — PUT is a full replace, not a patch', () => {
    const schema = z.object(byName('billingo_update_product').inputSchema);
    expect(() => schema.parse({ id: 3, name: 'Widget v2' })).toThrow();
    expect(() => schema.parse({ id: 3, name: 'Widget v2', currency: 'HUF', vat: '27%' })).toThrow();
    expect(schema.parse(fullUpdate)).toMatchObject({ name: 'Widget v2' });
  });
});

describe('billingo_delete_product', () => {
  it('is registered, write-scoped and marked destructive', () => {
    const tool = byName('billingo_delete_product');
    expect(tool.scope).toBe('write');
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('deletes by id', async () => {
    let path = '';
    server.use(
      http.delete('https://api.billingo.hu/v3/products/:id', ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const result = await byName('billingo_delete_product').handler({ id: 3 }, ctx);
    expect(path).toBe('/v3/products/3');
    // A 204 becomes `null` in BillingoClient; the model must see an explicit success,
    // not the literal text "null" — otherwise it cannot tell success from failure and
    // may retry a delete that already worked.
    expect(textOf(result)).not.toBe('null');
    expect(textOf(result)).toContain('Success');
  });
});
