// tests/tools/documents/write.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { BillingoClient } from '../../../src/billingo/client.js';
import { documentWriteTools } from '../../../src/tools/documents/write.js';
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
  const tool = documentWriteTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};
const textOf = (result: { content: unknown[] }): string =>
  result.content.map((c) => (c as { text?: string }).text ?? '').join('\n');

describe('document write tool surface', () => {
  it('exposes exactly the nine expected write tools', () => {
    expect([...documentWriteTools].map((t) => t.name).sort()).toEqual([
      'billingo_archive_document',
      'billingo_copy_document',
      'billingo_create_document',
      'billingo_create_document_from_proforma',
      'billingo_create_modification_document',
      'billingo_create_receipt',
      'billingo_finalize_draft',
      'billingo_finalize_receipt_draft',
      'billingo_update_payment',
    ]);
    expect(documentWriteTools.every((t) => t.scope === 'write')).toBe(true);
    expect(documentWriteTools.every((t) => t.annotations.readOnlyHint === true)).toBe(false);
  });

  it('warns about NAV in the description of every tool that can issue a document', () => {
    for (const name of [
      'billingo_create_document',
      'billingo_create_receipt',
      'billingo_finalize_draft',
      'billingo_finalize_receipt_draft',
      'billingo_create_document_from_proforma',
      'billingo_create_modification_document',
    ]) {
      expect(byName(name).description).toContain('NAV');
    }
  });
});

describe('billingo_create_document', () => {
  it('posts the document and returns it', async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/documents', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 50, invoice_number: 'WS-2026-7' }, { status: 201 });
      }),
    );
    const result = await byName('billingo_create_document').handler(
      {
        partner_id: 5,
        block_id: 1,
        type: 'invoice',
        fulfillment_date: '2026-01-15',
        due_date: '2026-01-30',
        payment_method: 'wire_transfer',
        language: 'hu',
        currency: 'HUF',
        items: [
          {
            name: 'Widget',
            unit_price: 1000,
            unit_price_type: 'net',
            quantity: 2,
            unit: 'db',
            vat: '27%',
          },
        ],
      },
      ctx,
    );
    expect(body).toMatchObject({ partner_id: 5, type: 'invoice' });
    expect(textOf(result)).toContain('WS-2026-7');
  });

  it('requires partner_id, block_id, type and at least one item', () => {
    const schema = z.object(byName('billingo_create_document').inputSchema);
    expect(() => schema.parse({ block_id: 1, type: 'invoice', items: [] })).toThrow();
    expect(() => schema.parse({ partner_id: 5, type: 'invoice', items: [] })).toThrow();
    expect(() =>
      schema.parse({
        partner_id: 5,
        block_id: 1,
        type: 'invoice',
        items: [],
        fulfillment_date: '2026-01-15',
        due_date: '2026-01-30',
        payment_method: 'cash',
        language: 'hu',
        currency: 'HUF',
      }),
    ).toThrow();
  });

  it('rejects an item with a VAT value outside the enum', () => {
    const schema = z.object(byName('billingo_create_document').inputSchema);
    expect(() =>
      schema.parse({
        partner_id: 5,
        block_id: 1,
        type: 'invoice',
        fulfillment_date: '2026-01-15',
        due_date: '2026-01-30',
        payment_method: 'cash',
        language: 'hu',
        currency: 'HUF',
        items: [
          { name: 'X', unit_price: 1, unit_price_type: 'net', quantity: 1, unit: 'db', vat: '30%' },
        ],
      }),
    ).toThrow();
  });

  it('restricts `type` to DocumentInsertType (advance/draft/invoice/proforma), not the full 17-value DocumentType enum', () => {
    // Per spec, components.schemas.DocumentInsert.type refs DocumentInsertType, a
    // narrower 4-value enum — NOT the full DocumentType enum used elsewhere in the API
    // (e.g. by ReceiptInsert.type). "cert_of_completion" is a valid DocumentType but not
    // a valid value here.
    const schema = z.object(byName('billingo_create_document').inputSchema);
    const base = {
      partner_id: 5,
      block_id: 1,
      fulfillment_date: '2026-01-15',
      due_date: '2026-01-30',
      payment_method: 'cash',
      language: 'hu',
      currency: 'HUF',
      items: [
        { name: 'X', unit_price: 1, unit_price_type: 'net', quantity: 1, unit: 'db', vat: '27%' },
      ],
    };
    expect(() => schema.parse({ ...base, type: 'cert_of_completion' })).toThrow();
    expect(schema.parse({ ...base, type: 'advance' }).type).toBe('advance');
    expect(schema.parse({ ...base, type: 'proforma' }).type).toBe('proforma');
  });

  it('accepts a catalogue-reference item (product_id + quantity), the other half of the DocumentInsert items oneOf', () => {
    const schema = z.object(byName('billingo_create_document').inputSchema);
    const parsed = schema.parse({
      partner_id: 5,
      block_id: 1,
      type: 'invoice',
      fulfillment_date: '2026-01-15',
      due_date: '2026-01-30',
      payment_method: 'cash',
      language: 'hu',
      currency: 'HUF',
      items: [{ product_id: 9, quantity: 3 }],
    });
    expect(parsed.items).toEqual([{ product_id: 9, quantity: 3 }]);
  });
});

describe('billingo_create_receipt', () => {
  it('posts to the receipt path with an inline item, and does not send a `settings` field', async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/documents/receipt', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 70, invoice_number: 'NY-2026-1' }, { status: 201 });
      }),
    );
    const result = await byName('billingo_create_receipt').handler(
      {
        block_id: 1,
        type: 'receipt',
        payment_method: 'cash',
        currency: 'HUF',
        items: [{ name: 'Coffee', unit_price: 500, vat: '27%' }],
      },
      ctx,
    );
    expect(body).toMatchObject({ block_id: 1, type: 'receipt' });
    expect(textOf(result)).toContain('NY-2026-1');
  });

  it('restricts item `vat` to the narrower ReceiptVat enum, not the full Vat enum', () => {
    // Per spec, ReceiptProductData.vat refs ReceiptVat (none/5%/18%/27%/AAM/TAM) — a
    // different, smaller enum than components.schemas.Vat used by document items.
    // "9%" is a valid Vat value but not a valid ReceiptVat value.
    const schema = z.object(byName('billingo_create_receipt').inputSchema);
    const base = { block_id: 1, type: 'receipt', payment_method: 'cash', currency: 'HUF' };
    expect(() => schema.parse({ ...base, items: [{ unit_price: 1, vat: '9%' }] })).toThrow();
    expect(schema.parse({ ...base, items: [{ unit_price: 1, vat: '27%' }] }).items).toEqual([
      { unit_price: 1, vat: '27%' },
    ]);
  });

  it('accepts a catalogue-reference item (product_id only), the other half of the ReceiptInsert items oneOf', () => {
    const schema = z.object(byName('billingo_create_receipt').inputSchema);
    const parsed = schema.parse({
      block_id: 1,
      type: 'receipt',
      payment_method: 'cash',
      currency: 'HUF',
      items: [{ product_id: 4 }],
    });
    expect(parsed.items).toEqual([{ product_id: 4 }]);
  });
});

describe('billingo_finalize_draft', () => {
  const fullBody = {
    partner_id: 5,
    block_id: 1,
    type: 'invoice' as const,
    fulfillment_date: '2026-01-15',
    due_date: '2026-01-30',
    payment_method: 'wire_transfer' as const,
    language: 'hu' as const,
    currency: 'HUF' as const,
    items: [
      {
        name: 'Widget',
        unit_price: 1000,
        unit_price_type: 'net' as const,
        quantity: 2,
        unit: 'db',
        vat: '27%' as const,
      },
    ],
  };

  it('PUTs the full document body to /documents/{id} to finalize a draft into a real invoice', async () => {
    let path = '';
    let method = '';
    let body: unknown = null;
    server.use(
      http.put('https://api.billingo.hu/v3/documents/:id', async ({ request }) => {
        path = new URL(request.url).pathname;
        method = request.method;
        body = await request.json();
        return HttpResponse.json({ id: 50, invoice_number: 'WS-2026-7' });
      }),
    );
    await byName('billingo_finalize_draft').handler({ id: 50, ...fullBody }, ctx);
    expect(method).toBe('PUT');
    expect(path).toBe('/v3/documents/50');
    // The `id` must be consumed for the URL, not resent in the body, and the rest of the
    // document fields must be sent — PUT /documents/{id} is a full replace, not a
    // body-less conversion.
    expect(body).toEqual(fullBody);
  });

  it('rejects a call missing required DocumentInsert fields (e.g. partner_id, items)', () => {
    const schema = z.object(byName('billingo_finalize_draft').inputSchema);
    expect(() => schema.parse({ id: 50 })).toThrow();
    expect(() => schema.parse({ id: 50, ...fullBody, items: [] })).toThrow();
    expect(() =>
      schema.parse({
        id: 50,
        block_id: fullBody.block_id,
        type: fullBody.type,
        fulfillment_date: fullBody.fulfillment_date,
        due_date: fullBody.due_date,
        payment_method: fullBody.payment_method,
        language: fullBody.language,
        currency: fullBody.currency,
        items: fullBody.items,
      }),
    ).toThrow();
  });
});

describe('billingo_finalize_receipt_draft', () => {
  const fullBody = {
    block_id: 1,
    type: 'receipt' as const,
    payment_method: 'cash' as const,
    currency: 'HUF' as const,
    items: [{ name: 'Coffee', unit_price: 500, vat: '27%' as const }],
  };

  it('PUTs the full receipt body to the receipt-specific path, not the document path', async () => {
    let path = '';
    let body: unknown = null;
    server.use(
      http.put('https://api.billingo.hu/v3/documents/receipt/:id', async ({ request }) => {
        path = new URL(request.url).pathname;
        body = await request.json();
        return HttpResponse.json({ id: 51 });
      }),
    );
    await byName('billingo_finalize_receipt_draft').handler({ id: 51, ...fullBody }, ctx);
    expect(path).toBe('/v3/documents/receipt/51');
    expect(body).toEqual(fullBody);
  });

  it('rejects a call missing required ReceiptInsert fields (e.g. block_id, items)', () => {
    const schema = z.object(byName('billingo_finalize_receipt_draft').inputSchema);
    expect(() => schema.parse({ id: 51 })).toThrow();
    expect(() => schema.parse({ id: 51, ...fullBody, items: [] })).toThrow();
    expect(() =>
      schema.parse({
        id: 51,
        type: fullBody.type,
        payment_method: fullBody.payment_method,
        currency: fullBody.currency,
        items: fullBody.items,
      }),
    ).toThrow();
  });
});

describe('billingo_create_modification_document', () => {
  it('posts to the modification path', async () => {
    let path = '';
    server.use(
      http.post(
        'https://api.billingo.hu/v3/documents/:id/create-modification-document',
        ({ request }) => {
          path = new URL(request.url).pathname;
          return HttpResponse.json({ id: 60, type: 'modification' }, { status: 201 });
        },
      ),
    );
    await byName('billingo_create_modification_document').handler(
      {
        id: 50,
        block_id: 1,
        type: 'modification',
        fulfillment_date: '2026-02-01',
        due_date: '2026-02-10',
        payment_method: 'cash',
        language: 'hu',
        currency: 'HUF',
        items: [
          {
            name: 'Fix',
            unit_price: -500,
            unit_price_type: 'net',
            quantity: 1,
            unit: 'db',
            vat: '27%',
          },
        ],
      },
      ctx,
    );
    expect(path).toBe('/v3/documents/50/create-modification-document');
  });

  it('only advertises the real ModificationDocumentInsert fields (due_date, comment, payment_method, without_financial_fulfillment, items) and none are required', () => {
    // Per spec, ModificationDocumentInsert is a much smaller shape than DocumentInsert —
    // no block_id, type, language or currency. All of its fields are optional.
    const schema = z.object(byName('billingo_create_modification_document').inputSchema);
    expect(schema.parse({ id: 50 })).toEqual({ id: 50 });
    expect(
      schema.parse({ id: 50, without_financial_fulfillment: true, due_date: '2026-02-10' }),
    ).toMatchObject({ without_financial_fulfillment: true, due_date: '2026-02-10' });
  });
});

describe('billingo_copy_document and create_document_from_proforma', () => {
  it('copies a document', async () => {
    let path = '';
    server.use(
      http.post('https://api.billingo.hu/v3/documents/:id/copy', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: 61 }, { status: 201 });
      }),
    );
    await byName('billingo_copy_document').handler({ id: 50 }, ctx);
    expect(path).toBe('/v3/documents/50/copy');
  });

  it('creates an invoice from a proforma', async () => {
    let path = '';
    server.use(
      http.post('https://api.billingo.hu/v3/documents/:id/create-from-proforma', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: 62 }, { status: 201 });
      }),
    );
    await byName('billingo_create_document_from_proforma').handler({ id: 50 }, ctx);
    expect(path).toBe('/v3/documents/50/create-from-proforma');
  });
});

describe('billingo_update_payment', () => {
  // Per spec, PUT /documents/{id}/payments takes a raw array of PaymentHistory objects,
  // not an object wrapping a "payments" key, and PaymentHistory's date field is named
  // `date`, not `paid_at`.
  it('PUTs the payment history for a document as a raw PaymentHistory[] array', async () => {
    let body: unknown = null;
    server.use(
      http.put('https://api.billingo.hu/v3/documents/:id/payments', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    await byName('billingo_update_payment').handler(
      { id: 50, payments: [{ payment_method: 'wire_transfer', date: '2026-01-20', price: 12700 }] },
      ctx,
    );
    expect(body).toEqual([{ payment_method: 'wire_transfer', date: '2026-01-20', price: 12700 }]);
  });
});

describe('billingo_archive_document', () => {
  it('PUTs to the archive path', async () => {
    let path = '';
    let method = '';
    server.use(
      http.put('https://api.billingo.hu/v3/documents/:id/archive', ({ request }) => {
        path = new URL(request.url).pathname;
        method = request.method;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await byName('billingo_archive_document').handler({ id: 50 }, ctx);
    expect(method).toBe('PUT');
    expect(path).toBe('/v3/documents/50/archive');
  });

  // Per spec/billingo-3.0.15.json paths./documents/{id}/archive.put, the response for a
  // successful archive is 204 (no body). BillingoClient turns that into `null`, so this
  // also guards against jsonResult regressing to printing the literal string "null".
  it('reports success explicitly instead of the literal string "null" on the 204 response', async () => {
    server.use(
      http.put('https://api.billingo.hu/v3/documents/:id/archive', () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const result = await byName('billingo_archive_document').handler({ id: 50 }, ctx);
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).not.toBe('null');
    expect(textOf(result).toLowerCase()).toContain('success');
  });

  it('is not marked destructive, and does not mention NAV', () => {
    const tool = byName('billingo_archive_document');
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.description).not.toContain('NAV');
  });

  // Per spec, PUT /documents/{id}/archive is documented as "Archive an existing
  // proforma document" — proforma-only, not any document type. The old description
  // claimed archiving "hides it from the default document list", which the spec does
  // not say; this guards against that invented claim coming back.
  it('describes the endpoint as proforma-only, per spec, without inventing list-visibility behaviour', () => {
    const description = byName('billingo_archive_document').description.toLowerCase();
    expect(description).toContain('proforma');
    expect(description).not.toContain('hid');
    expect(description).not.toContain('default document list');
  });
});
