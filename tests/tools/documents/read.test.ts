// tests/tools/documents/read.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { BillingoClient } from '../../../src/billingo/client.js';
import { documentReadTools } from '../../../src/tools/documents/read.js';
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
  const tool = documentReadTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};
const textOf = (result: { content: unknown[] }): string =>
  result.content.map((c) => (c as { text?: string }).text ?? '').join('\n');

describe('document read tool surface', () => {
  it('exposes exactly the eight expected read tools', () => {
    expect([...documentReadTools].map((t) => t.name).sort()).toEqual([
      'billingo_download_document',
      'billingo_get_document',
      'billingo_get_document_payments',
      'billingo_get_document_public_url',
      'billingo_get_document_reminders',
      'billingo_get_online_szamla_status',
      'billingo_list_documents',
      'billingo_pos_print',
    ]);
    expect(documentReadTools.every((t) => t.scope === 'read')).toBe(true);
    expect(documentReadTools.every((t) => t.annotations.readOnlyHint === true)).toBe(true);
  });
});

describe('billingo_list_documents', () => {
  it('forwards every filter as a query param and summarizes the page', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents', ({ request }) => {
        url = request.url;
        return HttpResponse.json({
          data: [{ id: 1, invoice_number: 'WS-2026-1' }],
          total: 42,
          per_page: 25,
          current_page: 1,
          last_page: 2,
        });
      }),
    );
    const result = await byName('billingo_list_documents').handler(
      {
        page: 1,
        type: 'invoice',
        start_date: '2026-01-01',
        end_date: '2026-01-31',
        partner_id: 5,
        payment_status: 'paid',
        payment_method: 'bankcard',
        block_id: 3,
        query: 'Acme',
      },
      ctx,
    );
    expect(url).toContain('type=invoice');
    expect(url).toContain('start_date=2026-01-01');
    expect(url).toContain('end_date=2026-01-31');
    expect(url).toContain('partner_id=5');
    expect(url).toContain('payment_status=paid');
    expect(url).toContain('payment_method=bankcard');
    expect(url).toContain('block_id=3');
    expect(url).toContain('query=Acme');
    expect(textOf(result)).toContain('Page 1 of 2 (42 results total, 25 per page).');
  });

  it('accepts no arguments at all', () => {
    const schema = z.object(byName('billingo_list_documents').inputSchema);
    expect(schema.parse({})).toEqual({});
  });

  it('restricts `type` to what the /documents list endpoint actually accepts', () => {
    // The list endpoint's `type` filter is its own narrow { enum: ["invoice", "receipt"] },
    // not the 17-value DocumentType enum used elsewhere in the API (e.g. by document
    // creation). "proforma" is a valid DocumentType but not a valid filter value here.
    const schema = z.object(byName('billingo_list_documents').inputSchema);
    expect(() => schema.parse({ type: 'not_a_type' })).toThrow();
    expect(() => schema.parse({ type: 'proforma' })).toThrow();
    expect(schema.parse({ type: 'invoice' }).type).toBe('invoice');
    expect(schema.parse({ type: 'receipt' }).type).toBe('receipt');
  });

  it('restricts `payment_status` to the real PaymentStatus enum', () => {
    const schema = z.object(byName('billingo_list_documents').inputSchema);
    expect(() => schema.parse({ payment_status: 'unpaid' })).toThrow();
    expect(schema.parse({ payment_status: 'outstanding' }).payment_status).toBe('outstanding');
  });
});

describe('billingo_get_document', () => {
  it('fetches by id', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: 12, invoice_number: 'WS-2026-1' });
      }),
    );
    await byName('billingo_get_document').handler({ id: 12 }, ctx);
    expect(path).toBe('/v3/documents/12');
  });

  it('fetches by vendor_id via the vendor path instead', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents/vendor/:vendorId', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: 12 });
      }),
    );
    await byName('billingo_get_document').handler({ vendor_id: 'ORDER-99' }, ctx);
    expect(path).toBe('/v3/documents/vendor/ORDER-99');
  });

  it('rejects being given neither id nor vendor_id', () => {
    const tool = byName('billingo_get_document');
    const schema = z.object(tool.inputSchema);
    // Both are individually optional, so the guard lives in the handler.
    expect(schema.parse({})).toEqual({});
  });

  it('returns an error result when given neither id nor vendor_id', async () => {
    const result = await byName('billingo_get_document').handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('id');
    expect(textOf(result)).toContain('vendor_id');
  });
});

describe('billingo_download_document', () => {
  it('returns the public URL by default, without fetching the PDF', async () => {
    let downloadCalls = 0;
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/public-url', () =>
        HttpResponse.json({ public_url: 'https://app.billingo.hu/s/abc123' }),
      ),
      http.get('https://api.billingo.hu/v3/documents/:id/download', () => {
        downloadCalls += 1;
        return HttpResponse.arrayBuffer(new Uint8Array([37, 80, 68, 70]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
        });
      }),
    );
    const result = await byName('billingo_download_document').handler({ id: 12 }, ctx);
    expect(downloadCalls).toBe(0);
    expect(textOf(result)).toContain('https://app.billingo.hu/s/abc123');
  });

  it('returns base64 PDF bytes only when explicitly asked', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/download', () =>
        HttpResponse.arrayBuffer(new Uint8Array([37, 80, 68, 70]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
        }),
      ),
    );
    const result = await byName('billingo_download_document').handler(
      { id: 12, format: 'base64' },
      ctx,
    );
    const resource = result.content.find((c) => (c as { type: string }).type === 'resource');
    expect(resource).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'application/pdf',
        blob: Buffer.from([37, 80, 68, 70]).toString('base64'),
      },
    });
  });

  it('explains itself when the PDF is still generating (HTTP 202, per spec — not 400)', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/download', () =>
        HttpResponse.json(
          {
            message: 'Document PDF has not generated yet. You should try to download again later.',
          },
          { status: 202 },
        ),
      ),
    );
    // maxRetries 0 so the test does not wait through the retry ladder.
    const fastCtx = {
      client: new BillingoClient({ apiKey: 'k', maxRetries: 0, sleep: async () => {} }),
    };
    const result = await byName('billingo_download_document').handler(
      { id: 12, format: 'base64' },
      fastCtx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not generated yet');
  });

  it('retries transparently through a 202 "not ready yet" and never returns the JSON error body as PDF bytes', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/download', () => {
        calls += 1;
        if (calls < 2) {
          return HttpResponse.json(
            {
              message:
                'Document PDF has not generated yet. You should try to download again later.',
            },
            { status: 202 },
          );
        }
        return HttpResponse.arrayBuffer(new Uint8Array([37, 80, 68, 70]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
        });
      }),
    );
    const fastCtx = { client: new BillingoClient({ apiKey: 'k', sleep: async () => {} }) };
    const result = await byName('billingo_download_document').handler(
      { id: 12, format: 'base64' },
      fastCtx,
    );
    expect(calls).toBe(2);
    const resource = result.content.find((c) => (c as { type: string }).type === 'resource');
    expect(resource).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'application/pdf',
        blob: Buffer.from([37, 80, 68, 70]).toString('base64'),
      },
    });
  });

  it('returns a clear error result, not base64 JSON, once retries for a persistently not-ready PDF are exhausted', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/download', () => {
        calls += 1;
        return HttpResponse.json(
          {
            message: 'Document PDF has not generated yet. You should try to download again later.',
          },
          { status: 202 },
        );
      }),
    );
    const fastCtx = {
      client: new BillingoClient({ apiKey: 'k', maxRetries: 2, sleep: async () => {} }),
    };
    const result = await byName('billingo_download_document').handler(
      { id: 12, format: 'base64' },
      fastCtx,
    );
    expect(calls).toBe(3); // initial attempt + 2 retries
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not generated yet');
    const resource = result.content.find((c) => (c as { type: string }).type === 'resource');
    expect(resource).toBeUndefined();
  });

  it('rethrows other errors from the download endpoint unchanged', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/download', () =>
        HttpResponse.json({ error: { message: 'Server exploded' } }, { status: 500 }),
      ),
    );
    const fastCtx = {
      client: new BillingoClient({ apiKey: 'k', maxRetries: 0, sleep: async () => {} }),
    };
    await expect(
      byName('billingo_download_document').handler({ id: 12, format: 'base64' }, fastCtx),
    ).rejects.toThrow('Server exploded');
  });
});

describe('billingo_get_document_public_url', () => {
  it('fetches the public URL directly', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/public-url', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ public_url: 'https://app.billingo.hu/s/abc123' });
      }),
    );
    const result = await byName('billingo_get_document_public_url').handler({ id: 12 }, ctx);
    expect(path).toBe('/v3/documents/12/public-url');
    expect(textOf(result)).toContain('https://app.billingo.hu/s/abc123');
  });
});

describe('billingo_get_online_szamla_status', () => {
  it('returns the NAV status verbatim, without narrowing the status string', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/online-szamla', () =>
        HttpResponse.json({
          transaction_id: 'TX123',
          status: 'DONE',
          messages: [
            {
              validation_result_code: 'INFO',
              validation_error_code: null,
              human_readable_message: 'OK',
            },
          ],
        }),
      ),
    );
    const result = await byName('billingo_get_online_szamla_status').handler({ id: 12 }, ctx);
    expect(textOf(result)).toContain('TX123');
    expect(textOf(result)).toContain('DONE');
  });
});

describe('billingo_get_document_payments and reminders', () => {
  it('fetches the payment history', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/payments', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json([{ paid_at: '2026-01-20', price: 12700 }]);
      }),
    );
    await byName('billingo_get_document_payments').handler({ id: 12 }, ctx);
    expect(path).toBe('/v3/documents/12/payments');
  });

  it('fetches the reminder events', async () => {
    let path = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/reminders', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({
          sent_reminders: [],
          upcoming_reminders: [],
          sent_postal_mail: [],
        });
      }),
    );
    await byName('billingo_get_document_reminders').handler({ id: 12 }, ctx);
    expect(path).toBe('/v3/documents/12/reminders');
  });
});

describe('billingo_pos_print', () => {
  it('requires the `size` query parameter, since the spec marks it required (58 or 80mm)', () => {
    const schema = z.object(byName('billingo_pos_print').inputSchema);
    expect(() => schema.parse({ id: 12 })).toThrow();
    expect(() => schema.parse({ id: 12, size: 70 })).toThrow();
    expect(schema.parse({ id: 12, size: 58 }).size).toBe(58);
  });

  it('fetches the PDF binary from /print/pos with the size query param and returns it as base64', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/print/pos', ({ request }) => {
        url = request.url;
        return HttpResponse.arrayBuffer(new Uint8Array([37, 80, 68, 70]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
        });
      }),
    );
    const result = await byName('billingo_pos_print').handler({ id: 12, size: 80 }, ctx);
    expect(url).toContain('/documents/12/print/pos');
    expect(url).toContain('size=80');
    const resource = result.content.find((c) => (c as { type: string }).type === 'resource');
    expect(resource).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'application/pdf',
        blob: Buffer.from([37, 80, 68, 70]).toString('base64'),
      },
    });
  });

  it('does not special-case a 202 on POS print — the spec only documents that status for /download', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/documents/:id/print/pos', () =>
        HttpResponse.arrayBuffer(new Uint8Array([37, 80, 68, 70]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
          status: 202,
        }),
      ),
    );
    const result = await byName('billingo_pos_print').handler({ id: 12, size: 80 }, ctx);
    const resource = result.content.find((c) => (c as { type: string }).type === 'resource');
    expect(resource).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'application/pdf',
        blob: Buffer.from([37, 80, 68, 70]).toString('base64'),
      },
    });
  });
});
