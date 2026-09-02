// tests/tools/partners.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { BillingoClient } from '../../src/billingo/client.js';
import { partnerTools } from '../../src/tools/partners.js';
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
  const tool = partnerTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};
const textOf = (result: { content: unknown[] }): string =>
  result.content.map((c) => (c as { text?: string }).text ?? '').join('\n');

describe('partner tool surface', () => {
  it('exposes the expected tools in the expected scopes', () => {
    expect([...partnerTools].map((t) => `${t.scope}:${t.name}`).sort()).toEqual([
      'read:billingo_get_partner',
      'read:billingo_list_partners',
      'write:billingo_create_partner',
      'write:billingo_delete_partner',
      'write:billingo_guess_partner',
      'write:billingo_update_partner',
    ]);
  });

  it('classifies guess_partner as a write because it creates a partner on a miss', () => {
    const guess = byName('billingo_guess_partner');
    expect(guess.scope).toBe('write');
    expect(guess.annotations.readOnlyHint).not.toBe(true);
    expect(guess.description.toLowerCase()).toContain('creates');
  });
});

describe('billingo_list_partners', () => {
  it('forwards paging and search, and summarizes the page', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/partners', ({ request }) => {
        url = request.url;
        return HttpResponse.json({
          data: [{ id: 1, name: 'Acme Kft.' }],
          total: 120,
          per_page: 25,
          current_page: 2,
          last_page: 5,
        });
      }),
    );
    const result = await byName('billingo_list_partners').handler(
      { page: 2, per_page: 25, query: 'Acme' },
      ctx,
    );
    expect(url).toContain('page=2');
    expect(url).toContain('per_page=25');
    expect(url).toContain('query=Acme');
    expect(textOf(result)).toContain('Page 2 of 5 (120 results total, 25 per page).');
    expect(textOf(result)).toContain('Acme Kft.');
  });

  it('accepts no arguments at all', () => {
    const schema = z.object(byName('billingo_list_partners').inputSchema);
    expect(schema.parse({})).toEqual({});
  });
});

describe('billingo_get_partner', () => {
  it('fetches /partners/{id} — live despite being absent from the 3.0.15 spec', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/partners/:id', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: 42, name: 'Acme Kft.' });
      }),
    );
    const result = await byName('billingo_get_partner').handler({ id: 42 }, ctx);
    expect(path).toBe('/v3/partners/42');
    expect(textOf(result)).toContain('Acme Kft.');
  });

  it('rejects a non-integer id', () => {
    const schema = z.object(byName('billingo_get_partner').inputSchema);
    expect(() => schema.parse({ id: 'abc' })).toThrow();
  });
});

describe('billingo_create_partner', () => {
  it('posts the partner and returns the created record', async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/partners', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 7, name: 'Acme Kft.' }, { status: 201 });
      }),
    );
    const result = await byName('billingo_create_partner').handler(
      {
        name: 'Acme Kft.',
        address: { country_code: 'HU', post_code: '1011', city: 'Budapest', address: 'Fő utca 1.' },
        emails: ['a@b.hu'],
        taxcode: '12345678-2-42',
      },
      ctx,
    );
    expect(body).toMatchObject({ name: 'Acme Kft.', emails: ['a@b.hu'] });
    expect(textOf(result)).toContain('"id": 7');
  });

  it('requires a name', () => {
    const schema = z.object(byName('billingo_create_partner').inputSchema);
    expect(() => schema.parse({ address: { country_code: 'HU' } })).toThrow();
  });

  it('rejects a malformed email before calling the API', () => {
    const schema = z.object(byName('billingo_create_partner').inputSchema);
    expect(() => schema.parse({ name: 'A', emails: ['not-an-email'] })).toThrow();
  });
});

describe('billingo_update_partner', () => {
  const fullUpdate = {
    id: 42,
    name: 'New name',
    address: { country_code: 'HU', post_code: '1011', city: 'Budapest', address: 'Fő utca 1.' },
  };

  it('puts the full record to /partners/{id}', async () => {
    let path = '';
    let body: unknown = null;
    server.use(
      http.put('https://api.billingo.hu/v3/partners/:id', async ({ request }) => {
        path = new URL(request.url).pathname;
        body = await request.json();
        return HttpResponse.json({ id: 42, name: 'New name' });
      }),
    );
    await byName('billingo_update_partner').handler(fullUpdate, ctx);
    expect(path).toBe('/v3/partners/42');
    expect(body).toMatchObject({ name: 'New name', address: fullUpdate.address });
  });

  it('does not send the id in the body', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.put('https://api.billingo.hu/v3/partners/:id', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 42 });
      }),
    );
    await byName('billingo_update_partner').handler(fullUpdate, ctx);
    expect(body['id']).toBeUndefined();
  });

  it('rejects a body missing the now-required address — PUT is a full replace, not a patch', () => {
    const schema = z.object(byName('billingo_update_partner').inputSchema);
    expect(() => schema.parse({ id: 42, name: 'New name' })).toThrow();
    expect(() => schema.parse({ id: 42, address: fullUpdate.address })).toThrow();
    expect(schema.parse(fullUpdate)).toMatchObject({ name: 'New name' });
  });
});

describe('billingo_guess_partner', () => {
  it('posts to /partners/guess and warns that a miss creates a partner', async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/partners/guess', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 9, name: 'Acme Kft.' });
      }),
    );
    const result = await byName('billingo_guess_partner').handler({ name: 'Acme' }, ctx);
    expect(body).toEqual({ name: 'Acme' });
    expect(textOf(result)).toContain('"id": 9');
  });
});

describe('billingo_delete_partner', () => {
  it('is registered, write-scoped and marked destructive', () => {
    const tool = byName('billingo_delete_partner');
    expect(tool.scope).toBe('write');
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('deletes by id', async () => {
    let path = '';
    server.use(
      http.delete('https://api.billingo.hu/v3/partners/:id', ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const result = await byName('billingo_delete_partner').handler({ id: 42 }, ctx);
    expect(path).toBe('/v3/partners/42');
    // A 204 becomes `null` in BillingoClient; the model must see an explicit success,
    // not the literal text "null" — otherwise it cannot tell success from failure and
    // may retry a delete that already worked.
    expect(textOf(result)).not.toBe('null');
    expect(textOf(result)).toContain('Success');
  });
});
