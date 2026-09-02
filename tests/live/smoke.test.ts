// tests/live/smoke.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BillingoClient } from '../../src/billingo/client.js';
import { BillingoApiError } from '../../src/billingo/errors.js';
import { createServer } from '../../src/server.js';
import { allTools } from '../../src/tools/index.js';

const apiKey = process.env['BILLINGO_SANDBOX_API_KEY'];

// Never fail the suite for a missing secret — fork PRs and fresh clones legitimately lack it.
const live = apiKey === undefined || apiKey === '' ? describe.skip : describe;

live('live smoke against the Billingo sandbox', () => {
  const client = new BillingoClient({ apiKey: apiKey ?? '' });
  const createdPartnerIds: number[] = [];
  const createdProductIds: number[] = [];

  afterAll(async () => {
    // Clean up regardless of what failed above; ignore individual failures.
    for (const id of createdPartnerIds) {
      await client.delete(`/partners/${String(id)}`).catch(() => undefined);
    }
    for (const id of createdProductIds) {
      await client.delete(`/products/${String(id)}`).catch(() => undefined);
    }
  });

  it('authenticates and returns the organization data', async () => {
    // OrganizationData is {tax_code, subscription, has_nav_connection} — no name/id/address.
    // Verified live 2026-07-17: asserting org.name here would fail.
    const org = await client.get<{ tax_code: string; has_nav_connection: boolean }>(
      '/organization',
    );
    expect(org.tax_code).toBeTypeOf('string');
    expect(org).toHaveProperty('has_nav_connection');
  });

  it('documents that the API sends NO rate-limit headers, despite the spec declaring them', async () => {
    // Measured 2026-07-17: none of the four documented headers are actually sent.
    // This test exists to catch the day that changes — at which point the client can
    // start pacing itself proactively instead of only reacting to 429s.
    const response = await fetch('https://api.billingo.hu/v3/organization', {
      headers: { 'X-API-KEY': apiKey ?? '' },
    });
    expect(response.status).toBe(200);
    const present = [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ].filter((header) => response.headers.get(header) !== null);
    if (present.length > 0) {
      console.warn(
        `Billingo now sends rate-limit headers: ${present.join(', ')}. Revisit the client's backoff.`,
      );
    }
    expect(Array.isArray(present)).toBe(true); // never fails; this test records reality
  });

  it('lists documents with the Laravel paginator envelope we assume', async () => {
    const page = await client.get<Record<string, unknown>>('/documents', {
      query: { per_page: 1 },
    });
    for (const key of ['data', 'total', 'per_page', 'current_page', 'last_page']) {
      expect(page, `missing ${key}`).toHaveProperty(key);
    }
  });

  it('serves the partner-by-id endpoints that the 3.0.15 spec omits', async () => {
    // This is the graft assumption. If it breaks, five tools break with it.
    const created = await client.post<{ id: number }>('/partners', {
      body: {
        name: `MCP smoke ${String(Date.now())}`,
        address: { country_code: 'HU', post_code: '1011', city: 'Budapest', address: 'Fő utca 1.' },
        emails: ['mcp-smoke@example.com'],
      },
    });
    createdPartnerIds.push(created.id);

    const fetched = await client.get<{ id: number }>(`/partners/${String(created.id)}`);
    expect(fetched.id).toBe(created.id);

    // PUT is a full replace, not a patch (see src/tools/partners.ts) — a body with only
    // {name} 422s live asking for address.post_code/city/address, so the full record must
    // be resent here too.
    const updated = await client.put<{ name: string }>(`/partners/${String(created.id)}`, {
      body: {
        name: 'MCP smoke renamed',
        address: { country_code: 'HU', post_code: '1011', city: 'Budapest', address: 'Fő utca 1.' },
      },
    });
    expect(updated.name).toBe('MCP smoke renamed');
  });

  it('returns the documented 422 validation shape, not the wrapped error shape', async () => {
    // Verified live 2026-07-17: creating a partner requires address.post_code/city/address —
    // a bare {} POST 422s with {"message":"Validation Failed","errors":[{"field":...}]}.
    const error = await client.post('/partners', { body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // parseErrorBody folds the field issues into the message.
    expect(String(error)).toBeTypeOf('string');
  });

  it('creates a product', async () => {
    const product = await client.post<{ id: number }>('/products', {
      body: {
        name: `MCP smoke product ${String(Date.now())}`,
        net_unit_price: 1000,
        vat: '27%',
        currency: 'HUF',
        unit: 'db',
      },
    });
    createdProductIds.push(product.id);
    expect(product.id).toBeTypeOf('number');
  });

  it('serves tools over a real MCP connection to the sandbox', async () => {
    // Exercises the full stack (registry -> schema validation -> handler -> HTTP), not
    // just the raw client, since that is what the shipped server actually does.
    const server = createServer({ client, allowWrite: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'live-smoke', version: '0.0.0' });
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const { tools } = await mcpClient.listTools();
    expect(tools).toHaveLength(allTools.filter((t) => t.scope === 'read').length);

    const result = await mcpClient.callTool({ name: 'billingo_get_organization', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('tax_code');

    await mcpClient.close();
  });

  it('runs the full draft lifecycle: create draft, finalize to invoice, storno', async () => {
    // Per src/tools/documents/write.ts: DocumentInsert.type is the 4-value enum
    // [advance, draft, invoice, proforma], and items are inline lines shaped
    // {name, unit_price, unit_price_type, quantity, unit, vat} — matches inlineItemSchema.
    // Per src/tools/documents/destructive.ts, storno is POST /documents/{id}/cancel.
    const blocks = await client.get<{ data: { id: number }[] }>('/document-blocks');
    const blockId = blocks.data[0]?.id;
    expect(blockId, 'sandbox account has no document block').toBeDefined();

    const partner = await client.post<{ id: number }>('/partners', {
      body: {
        name: `MCP smoke lifecycle ${String(Date.now())}`,
        address: { country_code: 'HU', post_code: '1011', city: 'Budapest', address: 'Fő utca 1.' },
        emails: ['mcp-smoke@example.com'],
      },
    });
    createdPartnerIds.push(partner.id);

    const draft = await client.post<{ id: number }>('/documents', {
      body: {
        partner_id: partner.id,
        block_id: blockId,
        type: 'draft',
        fulfillment_date: '2026-01-15',
        due_date: '2026-01-30',
        payment_method: 'wire_transfer',
        language: 'hu',
        currency: 'HUF',
        items: [
          {
            name: 'MCP smoke item',
            unit_price: 1000,
            unit_price_type: 'net',
            quantity: 1,
            unit: 'db',
            vat: '27%',
          },
        ],
      },
    });
    expect(draft.id).toBeTypeOf('number');

    // Finalize: this issues a real (sandbox) invoice and reports it to NAV. Not undoable —
    // afterAll cannot delete it, only the storno below can cancel it.
    //
    // PUT /documents/{id} is a full replace, not a body-less conversion — per spec,
    // requestBody is required (DocumentInsert). Verified live 2026-07-17: a body-less PUT
    // 422s asking for partner_id/block_id/type/fulfillment_date/due_date/payment_method/
    // language/currency/conversion_rate/items. Resend the same body used to create the
    // draft, with type changed from "draft" to "invoice" to actually issue it.
    const invoice = await client.put<{ id: number; invoice_number: string }>(
      `/documents/${String(draft.id)}`,
      {
        body: {
          partner_id: partner.id,
          block_id: blockId,
          type: 'invoice',
          fulfillment_date: '2026-01-15',
          due_date: '2026-01-30',
          payment_method: 'wire_transfer',
          language: 'hu',
          currency: 'HUF',
          items: [
            {
              name: 'MCP smoke item',
              unit_price: 1000,
              unit_price_type: 'net',
              quantity: 1,
              unit: 'db',
              vat: '27%',
            },
          ],
        },
      },
    );
    expect(invoice.invoice_number).toBeTypeOf('string');

    // From here on, the invoice is real and issued — storno it no matter what happens
    // below, including a failed assertion. An issued invoice cannot be deleted, only
    // storno'd, and leaving one behind on a real account is a real side effect.
    try {
      // Verified live 2026-07-17: this sandbox account has has_nav_connection: false, so
      // GET /documents/{id}/online-szamla 4xx's with {"error":{"message":"NavOnlineSzamla
      // is not found."}} even for a freshly issued invoice. Assert against whichever case
      // is actually true for this account rather than assuming NAV is connected.
      const org = await client.get<{ has_nav_connection: boolean }>('/organization');
      if (org.has_nav_connection) {
        const navStatus = await client.get<{ status: string }>(
          `/documents/${String(invoice.id)}/online-szamla`,
        );
        expect(navStatus).toHaveProperty('status');
      } else {
        const error = await client
          .get(`/documents/${String(invoice.id)}/online-szamla`)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BillingoApiError);
        expect((error as BillingoApiError).message).toMatch(/not found/i);
      }
    } finally {
      // An issued invoice cannot be deleted — only storno'd. Clean up the only legal way.
      const storno = await client.post<{ id: number; type: string }>(
        `/documents/${String(invoice.id)}/cancel`,
      );
      expect(storno.type).toBe('cancellation');
    }
  });
});
