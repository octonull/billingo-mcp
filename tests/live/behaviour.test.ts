// tests/live/behaviour.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BillingoClient } from '../../src/billingo/client.js';
import { BillingoApiError } from '../../src/billingo/errors.js';
import { createServer } from '../../src/server.js';

/**
 * Pins the API behaviours the tool schemas and descriptions rely on. Each test states
 * one behaviour; if Billingo changes it, the test names the tool that needs revisiting.
 * Same rules as smoke.test.ts: needs BILLINGO_SANDBOX_API_KEY, skips cleanly without it,
 * runs sequentially, cleans up what it can (issued invoices can only be cancelled).
 */
const apiKey = process.env['BILLINGO_SANDBOX_API_KEY'];
const live = apiKey === undefined || apiKey === '' ? describe.skip : describe;

const today = new Date().toISOString().slice(0, 10);
const address = { country_code: 'HU', post_code: '1011', city: 'Budapest', address: 'Fő utca 1.' };
/** Europe/Budapest wall-clock time, the zone the last_modified_date filter is read in. */
function budapestStamp(date: Date): string {
  const parts = new Map(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.get(type) ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

live('live: API behaviours the tools depend on', () => {
  const client = new BillingoClient({ apiKey: apiKey ?? '' });
  const partnerIds: number[] = [];
  const productIds: number[] = [];
  const bankAccountIds: number[] = [];
  const spendingIds: number[] = [];
  let blockId = 0;
  let partnerId = 0;

  const invoice = (extra: Record<string, unknown> = {}) =>
    client.post<{ id: number; correction_type: string }>('/documents', {
      body: {
        partner_id: partnerId,
        block_id: blockId,
        type: 'invoice',
        fulfillment_date: today,
        due_date: today,
        payment_method: 'wire_transfer',
        language: 'hu',
        currency: 'HUF',
        items: [
          {
            name: 'live check',
            unit_price: 1000,
            unit_price_type: 'net',
            quantity: 1,
            unit: 'db',
            vat: '27%',
          },
        ],
        ...extra,
      },
    });
  const statusOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 200,
      (e: unknown) => (e instanceof BillingoApiError ? e.status : -1),
    );

  beforeAll(async () => {
    const blocks = await client.get<{ data: { id: number }[] }>('/document-blocks');
    blockId = blocks.data[0]?.id ?? 0;
    const partner = await client.post<{ id: number }>('/partners', {
      body: { name: `live behaviour ${String(Date.now())}`, address },
    });
    partnerId = partner.id;
    partnerIds.push(partner.id);
  });

  afterAll(async () => {
    const del = (path: string) => client.delete(path).catch(() => undefined);
    for (const id of spendingIds) await del(`/spendings/${String(id)}`);
    for (const id of productIds) await del(`/products/${String(id)}`);
    for (const id of bankAccountIds) await del(`/bank-accounts/${String(id)}`);
    for (const id of partnerIds) await del(`/partners/${String(id)}`);
  });

  it('billingo_update_payment: PUT /payments replaces the whole list', async () => {
    const doc = await invoice();
    const path = `/documents/${String(doc.id)}/payments`;
    await client.put(path, {
      body: [
        { date: today, price: 500, payment_method: 'wire_transfer' },
        { date: today, price: 770, payment_method: 'cash' },
      ],
    });
    await client.put(path, {
      body: [{ date: today, price: 500, payment_method: 'wire_transfer' }],
    });
    expect(await client.get<unknown[]>(path)).toHaveLength(1);
    await client.post(`/documents/${String(doc.id)}/cancel`).catch(() => undefined);
  });

  it('billingo_cancel_document: an invoice with a modification cannot be cancelled', async () => {
    const doc = await invoice();
    const modification = await client.post<{ id: number }>(
      `/documents/${String(doc.id)}/create-modification-document`,
      {
        body: {
          items: [
            {
              name: 'correction',
              unit_price: -100,
              unit_price_type: 'net',
              quantity: 1,
              unit: 'db',
              vat: '27%',
            },
          ],
        },
      },
    );
    expect(await statusOf(client.post(`/documents/${String(doc.id)}/cancel`))).toBe(400);
    expect(await statusOf(client.post(`/documents/${String(modification.id)}/cancel`))).toBe(400);
  });

  it('billingo_cancel_document: cancelling a paid invoice clears its payment status', async () => {
    const doc = await invoice();
    await client.put(`/documents/${String(doc.id)}/payments`, {
      body: [{ date: today, price: 1270, payment_method: 'wire_transfer' }],
    });
    await client.post(`/documents/${String(doc.id)}/cancel`, {
      body: { cancellation_reason: 'live behaviour check' },
    });
    const after = await client.get<{ cancelled: boolean; payment_status: string }>(
      `/documents/${String(doc.id)}`,
    );
    expect(after).toMatchObject({ cancelled: true, payment_status: 'none' });
  });

  it('create tools: a duplicate vendor_id is refused with 400', async () => {
    const vendorId = `live-${String(Date.now())}`;
    const first = await invoice({ vendor_id: vendorId });
    expect(await statusOf(invoice({ vendor_id: vendorId }))).toBe(400);
    const found = await client.get<{ id: number }>(`/documents/vendor/${vendorId}`);
    expect(found.id).toBe(first.id);
    await client.post(`/documents/${String(first.id)}/cancel`).catch(() => undefined);
  });

  it('billingo_list_documents: last_modified_date takes "YYYY-MM-DD HH:MM:SS" in Budapest time', async () => {
    const before = budapestStamp(new Date(Date.now() - 60_000));
    const doc = await invoice();
    const later = budapestStamp(new Date(Date.now() + 120_000));
    const ids = async (value: string) =>
      (
        await client.get<{ data: { id: number }[] }>('/documents', {
          query: { last_modified_date: value, per_page: 100 },
        })
      ).data.map((d) => d.id);
    expect(await ids(before)).toContain(doc.id);
    expect(await ids(later)).not.toContain(doc.id);
    expect(await statusOf(client.get('/documents', { query: { last_modified_date: today } }))).toBe(
      422,
    );
    expect(
      await statusOf(
        client.get('/documents', { query: { last_modified_date: before.replace(' ', 'T') } }),
      ),
    ).toBe(422);
    // Recording a payment moves the document into a later window.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const mark = budapestStamp(new Date());
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await client.put(`/documents/${String(doc.id)}/payments`, {
      body: [{ date: today, price: 1270, payment_method: 'wire_transfer' }],
    });
    expect(await ids(mark)).toContain(doc.id);
    await client.post(`/documents/${String(doc.id)}/cancel`).catch(() => undefined);
  });

  it('update tools: a partner PUT clears the optional fields it leaves out', async () => {
    const partner = await client.post<{ id: number }>('/partners', {
      body: {
        name: 'live clear check',
        address,
        emails: ['clear@example.com'],
        phone: '+36301234567',
        iban: 'HU42117730161111101800000000',
      },
    });
    partnerIds.push(partner.id);
    await client.put(`/partners/${String(partner.id)}`, {
      body: { name: 'live clear check', address },
    });
    const after = await client.get<{ emails: string[]; phone: string; iban: string }>(
      `/partners/${String(partner.id)}`,
    );
    expect(after.emails).toEqual([]);
    expect(after.phone).toBe('');
    expect(after.iban).toBe('');
  });

  it('update tools: a product PUT needs a price and clears the optional fields it leaves out', async () => {
    const product = await client.post<{ id: number }>('/products', {
      body: {
        name: 'live clear check',
        net_unit_price: 1000,
        vat: '27%',
        currency: 'HUF',
        unit: 'db',
        comment: 'keep',
      },
    });
    productIds.push(product.id);
    const path = `/products/${String(product.id)}`;
    expect(
      await statusOf(
        client.put(path, { body: { name: 'x', vat: '27%', currency: 'HUF', unit: 'db' } }),
      ),
    ).toBe(422);
    await client.put(path, {
      body: {
        name: 'live clear check',
        net_unit_price: 1000,
        vat: '27%',
        currency: 'HUF',
        unit: 'db',
      },
    });
    expect((await client.get<{ comment: string }>(path)).comment).toBe('');
  });

  it('update tools: a bank account PUT clears the IBAN and SWIFT it leaves out', async () => {
    const created = await client.post<{ id?: number } | null>('/bank-accounts', {
      body: {
        name: 'live clear check',
        account_number: '11773016-11111018-00000000',
        account_number_iban: 'HU42117730161111101800000000',
        swift: 'OTPVHUHB',
        currency: 'HUF',
      },
    });
    // The create answers 201 with an empty body, so find the account by name.
    const list = await client.get<{ data: { id: number; name: string }[] }>('/bank-accounts', {
      query: { per_page: 100 },
    });
    const id = created?.id ?? list.data.find((a) => a.name === 'live clear check')?.id;
    expect(id).toBeTypeOf('number');
    bankAccountIds.push(id ?? 0);
    const path = `/bank-accounts/${String(id)}`;
    await client.put(path, {
      body: {
        name: 'live clear check',
        account_number: '11773016-11111018-00000000',
        currency: 'HUF',
      },
    });
    const after = await client.get<{ account_number_iban: string; swift: string }>(path);
    expect(after).toMatchObject({ account_number_iban: '', swift: '' });
  });

  it('billingo_create_spending: conversion_rate, invoice_number, invoice_date and due_date are required', async () => {
    const base = {
      category: 'other',
      currency: 'HUF',
      total_gross: 1270,
      total_gross_huf: 1270,
      total_vat_amount: 270,
      total_vat_amount_huf: 270,
      fulfillment_date: today,
      payment_method: 'cash',
    };
    const error = await client.post('/spendings', { body: base }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingoApiError);
    const fields = (error as BillingoApiError).validationErrors.map((v) => v.field).sort();
    expect(fields).toEqual(['conversion_rate', 'due_date', 'invoice_date', 'invoice_number']);
    for (const category of ['service', 'stock']) {
      const other = await client
        .post('/spendings', { body: { ...base, category } })
        .catch((e: unknown) => e);
      const otherFields = (other as BillingoApiError).validationErrors.map((v) => v.field).sort();
      expect(otherFields, category).toEqual([
        'conversion_rate',
        'due_date',
        'invoice_date',
        'invoice_number',
      ]);
    }
    const full = {
      ...base,
      conversion_rate: 1,
      invoice_number: 'LIVE-1',
      invoice_date: today,
      due_date: today,
    };
    const created = await client.post<{ id: number }>('/spendings', {
      body: { ...full, comment: 'keep' },
    });
    spendingIds.push(created.id);
    const path = `/spendings/${String(created.id)}`;
    // billingo_update_spending: the PUT needs the same fields, and clears the comment it omits.
    const withoutNumber = Object.fromEntries(
      Object.entries(full).filter(([key]) => key !== 'invoice_number'),
    );
    expect(await statusOf(client.put(path, { body: withoutNumber }))).toBe(422);
    await client.put(path, { body: full });
    expect((await client.get<{ comment: string }>(path)).comment).toBe('');
  });

  it('billingo_check_tax_number: only the hyphenated form passes validation', async () => {
    expect(await statusOf(client.get('/utils/check-tax-number/12345678'))).toBe(422);
    expect(await statusOf(client.get('/utils/check-tax-number/12345678242'))).toBe(422);
    // Hyphenated passes validation; without a NAV connection (every sandbox) it is a 401.
    expect([200, 401]).toContain(
      await statusOf(client.get('/utils/check-tax-number/12345678-2-42')),
    );
  });

  it('billingo_copy_document: copying an issued invoice creates a draft, not an invoice', async () => {
    const doc = await invoice();
    const copy = await client.post<{ id: number; type: string; invoice_number: string }>(
      `/documents/${String(doc.id)}/copy`,
    );
    expect(copy.type).toBe('draft');
    expect(copy.invoice_number).toBe('');
    await client.delete(`/documents/${String(copy.id)}`).catch(() => undefined);
    await client.post(`/documents/${String(doc.id)}/cancel`).catch(() => undefined);
  });

  it('billingo_create_receipt: electronic is required and an invoice block is refused', async () => {
    const blocks = await client.get<{ data: { id: number; type: string }[] }>('/document-blocks');
    const invoiceBlock = blocks.data.find((b) => b.type === 'invoice');
    expect(invoiceBlock).toBeDefined();
    const error = await client
      .post('/documents/receipt', {
        body: {
          block_id: invoiceBlock?.id,
          type: 'receipt',
          name: 'Vevő',
          payment_method: 'cash',
          currency: 'HUF',
          items: [{ name: 'live check', unit_price: 1270, vat: '27%' }],
        },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingoApiError);
    const fields = (error as BillingoApiError).validationErrors.map((v) => v.field);
    expect(fields).toContain('electronic');
    expect(fields).toContain('block_id');
  });

  it('billingo_create_partner: only the uppercase tax_type values are stored, and FOREIGN enables an EU invoice', async () => {
    const de = {
      country_code: 'DE',
      post_code: '10115',
      city: 'Berlin',
      address: 'Beispielstraße 1',
    };
    const lower = await client.post<{ id: number; tax_type: string }>('/partners', {
      body: {
        name: 'live tax type lower',
        address: de,
        taxcode: 'DE123456789',
        tax_type: 'has_tax_number',
      },
    });
    partnerIds.push(lower.id);
    expect(lower.tax_type).toBe('');
    const foreign = await client.post<{ id: number; tax_type: string }>('/partners', {
      body: {
        name: 'live tax type foreign',
        address: de,
        taxcode: 'DE123456789',
        tax_type: 'FOREIGN',
      },
    });
    partnerIds.push(foreign.id);
    expect(foreign.tax_type).toBe('FOREIGN');
    const rate = await client.get<{ conversation_rate: number }>('/currencies', {
      query: { from: 'EUR', to: 'HUF' },
    });
    const euBody = (partner: number) => ({
      partner_id: partner,
      block_id: blockId,
      type: 'invoice',
      fulfillment_date: today,
      due_date: today,
      payment_method: 'wire_transfer',
      language: 'en',
      currency: 'EUR',
      conversion_rate: rate.conversation_rate,
      items: [
        {
          name: 'live EU check',
          unit_price: 100,
          unit_price_type: 'net',
          quantity: 1,
          unit: 'db',
          vat: 'EU',
        },
      ],
    });
    expect(await statusOf(client.post('/documents', { body: euBody(lower.id) }))).toBe(400);
    const issued = await client.post<{ id: number }>('/documents', { body: euBody(foreign.id) });
    await client.post(`/documents/${String(issued.id)}/cancel`).catch(() => undefined);
  });

  it('billingo_copy_document: a proforma and a draft copy are drafts too', async () => {
    for (const type of ['proforma', 'draft']) {
      const source = await invoice({ type });
      const copy = await client.post<{ id: number; type: string }>(
        `/documents/${String(source.id)}/copy`,
      );
      expect(copy.type, type).toBe('draft');
      await client.delete(`/documents/${String(copy.id)}`).catch(() => undefined);
      await client.delete(`/documents/${String(source.id)}`).catch(() => undefined);
    }
  });

  it('update tools: a read-then-write through the MCP tools keeps every stored field', async () => {
    const server = createServer({ client, allowWrite: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'live-roundtrip', version: '0.0.0' });
    await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await mcp.callTool({ name, arguments: args })) as CallToolResult;
    const data = (r: CallToolResult) =>
      JSON.parse((r.content.at(-1) as { text: string }).text) as Record<string, unknown>;

    const created = data(
      await call('billingo_create_partner', {
        name: 'live roundtrip partner',
        address,
        emails: ['roundtrip@example.com'],
        phone: '+36301234567',
        iban: 'HU42117730161111101800000000',
        swift: 'OTPVHUHB',
        internal_comment: 'keep me',
        giro_settings: {
          giro_default_settings: false,
          giro_payment_request_enabled: true,
          giro_different_amount_allowed: true,
        },
        custom_billing_settings: { due_days: 15, payment_method: 'cash' },
      }),
    );
    partnerIds.push(created['id'] as number);
    const read = data(await call('billingo_get_partner', { id: created['id'] }));
    // The model's update: same record, new phone.
    await call('billingo_update_partner', {
      id: created['id'],
      name: read['name'],
      address,
      emails: read['emails'],
      phone: '+36301112222',
      iban: read['iban'],
      swift: read['swift'],
      internal_comment: read['internal_comment'],
      giro_settings: read['giro_settings'],
      custom_billing_settings: { due_days: 15, payment_method: 'cash' },
    });
    const after = data(await call('billingo_get_partner', { id: created['id'] }));
    expect(after).toMatchObject({
      phone: '+36301112222',
      iban: 'HU42117730161111101800000000',
      swift: 'OTPVHUHB',
      internal_comment: 'keep me',
      giro_settings: { giro_payment_request_enabled: true },
      custom_billing_settings: { due_days: 15, payment_method: 'cash' },
    });

    const product = data(
      await call('billingo_create_product', {
        name: 'live roundtrip product',
        net_unit_price: 1000,
        currency: 'HUF',
        vat: '27%',
        unit: 'db',
        sku: 'S1',
        ean: '5990000000000',
        purchase_price: 500,
      }),
    );
    productIds.push(product['id'] as number);
    const p = data(await call('billingo_get_product', { id: product['id'] }));
    await call('billingo_update_product', {
      id: product['id'],
      name: 'live roundtrip product renamed',
      net_unit_price: p['net_unit_price'],
      currency: p['currency'],
      vat: p['vat'],
      unit: p['unit'],
      sku: p['sku'],
      ean: p['ean'],
      purchase_price: p['purchase_price'],
    });
    const pAfter = data(await call('billingo_get_product', { id: product['id'] }));
    expect(pAfter).toMatchObject({
      name: 'live roundtrip product renamed',
      sku: 'S1',
      ean: '5990000000000',
      purchase_price: 500,
    });
    await mcp.close();
  });

  it('every read tool with an outputSchema returns live data that matches it', async () => {
    const doc = await invoice();
    const server = createServer({ client, allowWrite: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'live-schemas', version: '0.0.0' });
    await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await mcp.listTools();
    const product = await client.post<{ id: number }>('/products', {
      body: {
        name: 'live schema check',
        net_unit_price: 1000,
        vat: '27%',
        currency: 'HUF',
        unit: 'db',
      },
    });
    productIds.push(product.id);
    const bank = await client.get<{ data: { id: number }[] }>('/bank-accounts');
    const args: Record<string, Record<string, unknown>> = {
      billingo_get_bank_account: { id: bank.data[0]?.id ?? 0 },
      billingo_get_document: { id: doc.id },
      billingo_get_document_public_url: { id: doc.id },
      billingo_get_online_szamla_status: { id: doc.id },
      billingo_get_document_payments: { id: doc.id },
      billingo_get_document_reminders: { id: doc.id },
      billingo_get_conversion_rate: { from: 'EUR', to: 'HUF' },
      billingo_get_partner: { id: partnerId },
      billingo_get_product: { id: product.id },
      billingo_get_spending: { id: spendingIds[0] ?? 0 },
    };
    const checked: string[] = [];
    for (const tool of tools.filter((t) => t.outputSchema !== undefined)) {
      if (tool.name === 'billingo_get_spending' && spendingIds.length === 0) continue;
      // The server answers a schema mismatch with an isError "Output validation error".
      const result = (await mcp.callTool({
        name: tool.name,
        arguments: args[tool.name] ?? {},
      })) as CallToolResult;
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text, tool.name).not.toContain('Output validation error');
      // online-szamla answers 404 for a document never sent to NAV (every sandbox
      // document); that is an API error, not a schema failure. Everything else succeeds.
      if (tool.name !== 'billingo_get_online_szamla_status') {
        expect(result.isError, tool.name).not.toBe(true);
      }
      checked.push(tool.name);
    }
    expect(checked.length).toBeGreaterThanOrEqual(16);
    await mcp.close();
    await client.post(`/documents/${String(doc.id)}/cancel`).catch(() => undefined);
  });
});
