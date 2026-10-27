// tests/server/output-schemas.test.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BillingoClient } from '../../src/billingo/client.js';
import { createServer } from '../../src/server.js';
import { allTools } from '../../src/tools/index.js';

/**
 * Fixtures are real Billingo responses recorded on a sandbox account on 2026-10-14, with
 * every name, tax number, address, account number, e-mail and public link replaced by a
 * fake value. They keep the real shape: field names, nulls, nesting, number types.
 */
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'live');
const fixture = (name: string): { status: number; body: unknown } =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as {
    status: number;
    body: unknown;
  };

const BASE = 'https://api.billingo.hu/v3';
const api = setupServer();
beforeAll(() => {
  api.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  api.resetHandlers();
});
afterAll(() => {
  api.close();
});

/** A real SDK client: it validates structuredContent against each tool's outputSchema. */
async function connect(allowWrite = false) {
  const billingo = new BillingoClient({ apiKey: 'k', sleep: async () => {} });
  const server = createServer({ client: billingo, allowWrite });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const serve = (path: string, name: string) =>
  http.get(`${BASE}${path}`, () => {
    const { status, body } = fixture(name);
    return HttpResponse.json(body as Record<string, unknown>, { status });
  });

// Recorded on the same sandbox run; inlined because it holds no identifying data.
const ONLINE_SZAMLA = {
  transaction_id: '',
  status: 'no_online_szamla_settings',
  messages: [
    {
      validation_result_code: '',
      validation_error_code: '',
      human_readable_message: 'NAV Online Számla összeköttetés nincs beállítva.',
    },
  ],
};

/** Every read tool with an output schema, the call that exercises it, and its fixture. */
const CASES: { tool: string; args: Record<string, unknown>; path: string; fixture?: string }[] = [
  {
    tool: 'billingo_list_bank_accounts',
    args: {},
    path: '/bank-accounts',
    fixture: 'bank_accounts',
  },
  {
    tool: 'billingo_get_bank_account',
    args: { id: 1 },
    path: '/bank-accounts/1',
    fixture: 'bank_account',
  },
  {
    tool: 'billingo_list_document_blocks',
    args: {},
    path: '/document-blocks',
    fixture: 'document_blocks',
  },
  { tool: 'billingo_list_documents', args: {}, path: '/documents', fixture: 'documents' },
  { tool: 'billingo_get_document', args: { id: 1 }, path: '/documents/1', fixture: 'document' },
  {
    tool: 'billingo_get_document_public_url',
    args: { id: 1 },
    path: '/documents/1/public-url',
    fixture: 'public_url',
  },
  {
    tool: 'billingo_get_online_szamla_status',
    args: { id: 1 },
    path: '/documents/1/online-szamla',
  },
  {
    tool: 'billingo_get_document_payments',
    args: { id: 1 },
    path: '/documents/1/payments',
    fixture: 'payments',
  },
  {
    tool: 'billingo_get_document_reminders',
    args: { id: 1 },
    path: '/documents/1/reminders',
    fixture: 'reminders',
  },
  { tool: 'billingo_get_organization', args: {}, path: '/organization', fixture: 'organization' },
  {
    tool: 'billingo_get_conversion_rate',
    args: { from: 'EUR', to: 'HUF' },
    path: '/currencies',
    fixture: 'conversion_rate',
  },
  { tool: 'billingo_list_partners', args: {}, path: '/partners', fixture: 'partners' },
  { tool: 'billingo_get_partner', args: { id: 1 }, path: '/partners/1', fixture: 'partner' },
  { tool: 'billingo_list_products', args: {}, path: '/products', fixture: 'products' },
  { tool: 'billingo_get_product', args: { id: 1 }, path: '/products/1', fixture: 'product' },
  { tool: 'billingo_list_spendings', args: {}, path: '/spendings', fixture: 'spendings' },
  { tool: 'billingo_get_spending', args: { id: 1 }, path: '/spendings/1', fixture: 'spending' },
];

/** Read tools whose success is a file or an unverified shape, so they publish no schema. */
const WITHOUT_SCHEMA = [
  'billingo_check_tax_number',
  'billingo_download_document',
  'billingo_export_documents',
  'billingo_get_product_quantity',
  'billingo_pos_print',
];

function jsonBlock(result: CallToolResult): { error: Record<string, unknown> } {
  const block = result.content[1];
  if (block?.type !== 'text') throw new Error('no JSON error block');
  return JSON.parse(block.text) as { error: Record<string, unknown> };
}

function hasClosedObject(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const record = schema as Record<string, unknown>;
  if (record['additionalProperties'] === false) return true;
  return Object.values(record).some((value) => hasClosedObject(value));
}

describe('which tools publish an outputSchema', () => {
  it('every read tool is either in CASES or deliberately without a schema', () => {
    const reads = allTools.filter((t) => t.scope === 'read').map((t) => t.name);
    expect([...CASES.map((c) => c.tool), ...WITHOUT_SCHEMA].sort()).toEqual(reads.sort());
  });

  it('lists the 17 schemas over a real MCP connection, and none for the other 5', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const withSchema = tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name);
    expect(withSchema.sort()).toEqual(CASES.map((c) => c.tool).sort());
    for (const name of WITHOUT_SCHEMA) {
      expect(tools.find((t) => t.name === name)?.outputSchema, name).toBeUndefined();
    }
  });

  it('never closes an object — a field Billingo adds later must not fail validation', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools.filter((t) => t.outputSchema !== undefined)) {
      expect(hasClosedObject(tool.outputSchema), tool.name).toBe(false);
    }
  });
});

describe('recorded responses pass the published schemas', () => {
  for (const c of CASES) {
    it(c.tool, async () => {
      api.use(
        c.fixture === undefined
          ? http.get(`${BASE}${c.path}`, () => HttpResponse.json(ONLINE_SZAMLA))
          : serve(c.path, c.fixture),
      );
      const client = await connect();
      // The server validates structuredContent against the schema and answers a mismatch
      // with an isError result, so a passing call proves the recorded shape fits.
      const result = (await client.callTool({ name: c.tool, arguments: c.args })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
    });
  }

  it('wraps the bare payments array as { payments } and keeps the array in the text', async () => {
    api.use(serve('/documents/1/payments', 'payments'));
    const client = await connect();
    const result = (await client.callTool({
      name: 'billingo_get_document_payments',
      arguments: { id: 1 },
    })) as CallToolResult;
    const payments = fixture('payments').body;
    expect(result.structuredContent).toEqual({ payments });
    const text = result.content[0];
    expect(text?.type === 'text' && JSON.parse(text.text)).toEqual(payments);
  });
});

describe('errors from tools with an outputSchema', () => {
  it('arrive as a tool error, not a protocol error, with a JSON block to branch on', async () => {
    api.use(serve('/documents/vendor/missing', 'document_vendor_missing'));
    const client = await connect();
    const result = (await client.callTool({
      name: 'billingo_get_document',
      arguments: { vendor_id: 'missing' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(jsonBlock(result).error).toMatchObject({
      code: 'not_found',
      status: 404,
      retryable: false,
    });
  });

  it('report a foreign or unknown id as forbidden, which is what Billingo answers live', async () => {
    api.use(serve('/products/1', 'not_found'));
    const client = await connect();
    const result = (await client.callTool({
      name: 'billingo_get_product',
      arguments: { id: 1 },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(jsonBlock(result).error).toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('carry the 422 field list', async () => {
    api.use(
      http.get(`${BASE}/spendings`, () =>
        HttpResponse.json(
          {
            message: 'Validation Failed',
            errors: [{ field: 'page', message: 'The page must be at least 1.' }],
          },
          { status: 422 },
        ),
      ),
    );
    const client = await connect();
    const result = (await client.callTool({
      name: 'billingo_list_spendings',
      arguments: {},
    })) as CallToolResult;
    expect(jsonBlock(result).error).toMatchObject({
      code: 'validation_failed',
      fields: [{ field: 'page', message: 'The page must be at least 1.' }],
    });
  });

  it('mark a 429 retryable', async () => {
    api.use(
      http.get(`${BASE}/partners`, () =>
        HttpResponse.json({ error: { message: 'Too Many Attempts.' } }, { status: 429 }),
      ),
    );
    const client = await connect();
    const result = (await client.callTool({
      name: 'billingo_list_partners',
      arguments: {},
    })) as CallToolResult;
    expect(jsonBlock(result).error).toMatchObject({ code: 'rate_limited', retryable: true });
  });
});

describe('fixtures', () => {
  it('hold only the fake identity values', () => {
    for (const file of readdirSync(FIXTURES)) {
      const text = readFileSync(join(FIXTURES, file), 'utf8');
      const taxNumbers = text.match(/\b\d{8}-\d-\d{2}\b/g) ?? [];
      expect(
        taxNumbers.every((t) => t === '12345678-2-42'),
        file,
      ).toBe(true);
      expect(text.match(/@[\w.-]+/g)?.every((d) => d === '@example.com') ?? true, file).toBe(true);
      // The only account number and IBAN allowed are the IBAN registry's published example
      // for Hungary, which the existing bank-account tests also use.
      const accounts = text.match(/\b\d{8}-\d{8}(-\d{8})?\b/g) ?? [];
      expect(
        accounts.every((a) => a === '11773016-11111018-00000000'),
        `${file} account numbers`,
      ).toBe(true);
      const ibans = text.match(/\bHU\d{26}\b/g) ?? [];
      expect(
        ibans.every((i) => i === 'HU42117730161111101800000000'),
        `${file} IBANs`,
      ).toBe(true);
    }
  });
});

describe('structuredContent scope', () => {
  it('is not added to tools without an outputSchema, such as the write tools', async () => {
    api.use(
      http.post(`${BASE}/partners`, () => HttpResponse.json({ id: 9, name: 'Example Kft.' })),
    );
    const client = await connect(true);
    const result = (await client.callTool({
      name: 'billingo_create_partner',
      arguments: {
        name: 'Example Kft.',
        address: {
          country_code: 'HU',
          post_code: '1011',
          city: 'Budapest',
          address: 'Példa utca 1.',
        },
      },
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('is not added to check_tax_number, whose shape a sandbox cannot show', async () => {
    api.use(
      http.get(`${BASE}/utils/check-tax-number/:n`, () =>
        HttpResponse.json({ result: { name: 'x' } }),
      ),
    );
    const client = await connect();
    const result = (await client.callTool({
      name: 'billingo_check_tax_number',
      arguments: { tax_number: '12345678-2-42' },
    })) as CallToolResult;
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('schemas are no stricter than the PHP backend', () => {
  it('accept [] for an empty nested object, numeric strings and 0/1 booleans', async () => {
    const { body } = fixture('document') as { body: Record<string, unknown> };
    api.use(
      http.get(`${BASE}/documents/1`, () =>
        HttpResponse.json({
          ...body,
          partner: [],
          summary: [],
          gross_total: '100.5',
          cancelled: 0,
        }),
      ),
    );
    const client = await connect();
    const result = (await client.callTool({
      name: 'billingo_get_document',
      arguments: { id: 1 },
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
  });

  it('answer an empty payments body with an empty list, not a validation error', async () => {
    api.use(
      http.get(`${BASE}/documents/1/payments`, () => new HttpResponse(null, { status: 204 })),
    );
    const client = await connect();
    const result = (await client.callTool({
      name: 'billingo_get_document_payments',
      arguments: { id: 1 },
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ payments: [] });
  });

  it('answer an empty body with {} when the schema allows it', async () => {
    api.use(
      http.get(`${BASE}/documents/1/reminders`, () => new HttpResponse(null, { status: 204 })),
    );
    const client = await connect();
    const result = (await client.callTool({
      name: 'billingo_get_document_reminders',
      arguments: { id: 1 },
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({});
  });
});

describe('retry advice on server errors', () => {
  const fail = () => HttpResponse.json({ error: { message: 'Internal error' } }, { status: 500 });

  it('is retryable for a read', async () => {
    api.use(http.get(`${BASE}/documents/1`, fail));
    const client = await connect();
    const result = (await client.callTool({
      name: 'billingo_get_document',
      arguments: { id: 1 },
    })) as CallToolResult;
    expect(jsonBlock(result).error).toMatchObject({ code: 'server_error', retryable: true });
  });

  it('is not retryable for an invoice create, whose outcome is unknown', async () => {
    api.use(http.post(`${BASE}/documents`, fail));
    const client = await connect(true);
    const result = (await client.callTool({
      name: 'billingo_create_document',
      arguments: {
        partner_id: 1,
        block_id: 1,
        type: 'invoice',
        fulfillment_date: '2026-10-14',
        due_date: '2026-10-14',
        payment_method: 'wire_transfer',
        language: 'hu',
        currency: 'HUF',
        items: [
          { name: 'x', unit_price: 1, unit_price_type: 'net', quantity: 1, unit: 'db', vat: '27%' },
        ],
      },
    })) as CallToolResult;
    expect(jsonBlock(result).error).toMatchObject({
      code: 'server_error',
      retryable: false,
      outcome_unknown: true,
    });
  });
});
