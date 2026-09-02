// tests/tools/bank-accounts.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { BillingoClient } from '../../src/billingo/client.js';
import { bankAccountTools } from '../../src/tools/bank-accounts.js';
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
  const tool = bankAccountTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};

describe('bank account tool surface', () => {
  it('exposes the expected tools in the expected scopes', () => {
    expect([...bankAccountTools].map((t) => `${t.scope}:${t.name}`).sort()).toEqual([
      'read:billingo_get_bank_account',
      'read:billingo_list_bank_accounts',
      'write:billingo_create_bank_account',
      'write:billingo_delete_bank_account',
      'write:billingo_update_bank_account',
    ]);
  });
});

describe('billingo_list_bank_accounts', () => {
  it('forwards paging and summarizes the page', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/bank-accounts', ({ request }) => {
        url = request.url;
        return HttpResponse.json({
          data: [{ id: 2, name: 'OTP HUF' }],
          total: 1,
          per_page: 25,
          current_page: 1,
          last_page: 1,
        });
      }),
    );
    await byName('billingo_list_bank_accounts').handler({ page: 1, per_page: 25 }, ctx);
    expect(url).toContain('page=1');
    expect(url).toContain('per_page=25');
  });
});

describe('billingo_create_bank_account', () => {
  it('posts the account', async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/bank-accounts', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 2 }, { status: 201 });
      }),
    );
    await byName('billingo_create_bank_account').handler(
      {
        name: 'OTP HUF',
        account_number: '11773016-11111018',
        account_number_iban: 'HU42117730161111101800000000',
        currency: 'HUF',
      },
      ctx,
    );
    expect(body).toMatchObject({ name: 'OTP HUF', currency: 'HUF' });
  });

  it('requires a name, an account number, and a currency from the enum', () => {
    const schema = z.object(byName('billingo_create_bank_account').inputSchema);
    expect(() => schema.parse({ account_number: '123' })).toThrow();
    expect(() => schema.parse({ name: 'X', currency: 'XXX' })).toThrow();
    expect(() => schema.parse({ name: 'X', currency: 'HUF' })).toThrow();
  });
});

describe('billingo_get_bank_account', () => {
  it('fetches by id', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/bank-accounts/:id', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: 2, name: 'OTP HUF' });
      }),
    );
    await byName('billingo_get_bank_account').handler({ id: 2 }, ctx);
    expect(path).toBe('/v3/bank-accounts/2');
  });
});

describe('billingo_update_bank_account', () => {
  const fullUpdate = {
    id: 2,
    name: 'New name',
    account_number: '11773016-11111018',
    currency: 'HUF',
  } as const;

  it('puts the full record to /bank-accounts/{id} without the id in the body', async () => {
    let path = '';
    let body: Record<string, unknown> = {};
    server.use(
      http.put('https://api.billingo.hu/v3/bank-accounts/:id', async ({ request }) => {
        path = new URL(request.url).pathname;
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 2, name: 'New name' });
      }),
    );
    await byName('billingo_update_bank_account').handler(fullUpdate, ctx);
    expect(path).toBe('/v3/bank-accounts/2');
    expect(body['id']).toBeUndefined();
    expect(body['name']).toBe('New name');
    expect(body['account_number']).toBe('11773016-11111018');
  });

  it('rejects a body missing account_number or currency — PUT is a full replace, not a patch', () => {
    const schema = z.object(byName('billingo_update_bank_account').inputSchema);
    expect(() => schema.parse({ id: 2 })).toThrow();
    expect(() => schema.parse({ id: 2, name: 'New name' })).toThrow();
    expect(schema.parse(fullUpdate)).toMatchObject({ name: 'New name' });
  });
});

describe('billingo_delete_bank_account', () => {
  it('is registered, write-scoped and marked destructive', () => {
    const tool = byName('billingo_delete_bank_account');
    expect(tool.scope).toBe('write');
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('deletes by id', async () => {
    let path = '';
    server.use(
      http.delete('https://api.billingo.hu/v3/bank-accounts/:id', ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const result = await byName('billingo_delete_bank_account').handler({ id: 2 }, ctx);
    expect(path).toBe('/v3/bank-accounts/2');
    // A 204 becomes `null` in BillingoClient; the model must see an explicit success,
    // not the literal text "null" — otherwise it cannot tell success from failure and
    // may retry a delete that already worked.
    expect(result.content[0]).not.toEqual({ type: 'text', text: 'null' });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Success') as string });
  });
});
