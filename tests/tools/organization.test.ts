// tests/tools/organization.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { BillingoClient } from '../../src/billingo/client.js';
import { organizationTools } from '../../src/tools/organization.js';
import type { AnyToolDefinition } from '../../src/tools/registry.js';

const server = setupServer();
// The client is constructed after server.listen() (not at module scope) because
// BillingoClient captures `globalThis.fetch` at construction time; building it too
// early would bypass MSW's interception and leak real requests to api.billingo.hu.
let ctx: { client: BillingoClient };
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  ctx = { client: new BillingoClient({ apiKey: 'k', sleep: async () => {} }) };
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});
const byName = (name: string): AnyToolDefinition => {
  const tool = organizationTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};

describe('organization tools', () => {
  it('exposes exactly the three expected read tools', () => {
    expect(organizationTools.map((t) => t.name).sort()).toEqual([
      'billingo_check_tax_number',
      'billingo_get_conversion_rate',
      'billingo_get_organization',
    ]);
    expect(organizationTools.every((t) => t.scope === 'read')).toBe(true);
    expect(organizationTools.every((t) => t.annotations.readOnlyHint === true)).toBe(true);
  });

  it('get_organization returns the organization data', async () => {
    // This is the real live response shape (spec: OrganizationData), verified 2026-07-17.
    // It is NOT a company profile — there is no name, id or address here.
    server.use(
      http.get('https://api.billingo.hu/v3/organization', () =>
        HttpResponse.json({
          tax_code: '12345678-2-42',
          subscription: { plan: 'innovator' },
          has_nav_connection: true,
        }),
      ),
    );
    const result = await byName('billingo_get_organization').handler({}, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('12345678-2-42') as string,
    });
  });

  it('check_tax_number passes the tax number in the path', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/utils/check-tax-number/:taxNumber', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ valid: true, name: 'Acme Kft.' });
      }),
    );
    await byName('billingo_check_tax_number').handler({ tax_number: '12345678' }, ctx);
    expect(path).toBe('/v3/utils/check-tax-number/12345678');
  });

  it('check_tax_number URL-encodes a tax number containing slashes', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/utils/check-tax-number/*', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ valid: false });
      }),
    );
    await byName('billingo_check_tax_number').handler({ tax_number: 'a/b' }, ctx);
    expect(path).toBe('/v3/utils/check-tax-number/a%2Fb');
  });

  it('check_tax_number rejects an empty tax number before calling the API', () => {
    const schema = z.object(byName('billingo_check_tax_number').inputSchema);
    expect(() => schema.parse({ tax_number: '' })).toThrow();
  });

  it('get_conversion_rate sends the currency pair as query params', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/currencies', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ value: 402.5 });
      }),
    );
    await byName('billingo_get_conversion_rate').handler({ from: 'EUR', to: 'HUF' }, ctx);
    expect(url).toContain('from=EUR');
    expect(url).toContain('to=HUF');
  });

  it('get_conversion_rate omits the date query param when not given', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/currencies', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ value: 402.5 });
      }),
    );
    await byName('billingo_get_conversion_rate').handler({ from: 'EUR', to: 'HUF' }, ctx);
    expect(url).not.toContain('date=');
  });

  // Per spec/billingo-3.0.15.json paths./currencies.get.parameters, `date` is an
  // optional query param (format: date) — this is what makes a backdated conversion
  // rate lookup possible instead of always getting today's rate.
  it('get_conversion_rate forwards an explicit date as the rate-as-of query param', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/currencies', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ value: 398.2 });
      }),
    );
    await byName('billingo_get_conversion_rate').handler(
      { from: 'EUR', to: 'HUF', date: '2026-01-15' },
      ctx,
    );
    expect(url).toContain('date=2026-01-15');
  });

  it('get_conversion_rate rejects a date that is not ISO format', () => {
    const schema = z.object(byName('billingo_get_conversion_rate').inputSchema);
    expect(() => schema.parse({ from: 'EUR', to: 'HUF', date: '01/15/2026' })).toThrow();
  });

  it('get_conversion_rate rejects a currency outside the API enum', () => {
    const schema = z.object(byName('billingo_get_conversion_rate').inputSchema);
    expect(() => schema.parse({ from: 'XXX', to: 'HUF' })).toThrow();
    expect(schema.parse({ from: 'EUR', to: 'HUF' })).toEqual({ from: 'EUR', to: 'HUF' });
  });
});
