// tests/tools/updates.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BillingoClient } from '../../src/billingo/client.js';
import { BillingoArgumentError, describeError } from '../../src/billingo/errors.js';
import { allTools } from '../../src/tools/index.js';
import type { AnyToolDefinition } from '../../src/tools/registry.js';

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

// Built in beforeAll, after server.listen(): BillingoClient captures fetch on construction.
let ctx: { client: BillingoClient };
beforeAll(() => {
  ctx = { client: new BillingoClient({ apiKey: 'k', sleep: () => Promise.resolve() }) };
});
const byName = (name: string): AnyToolDefinition => {
  const tool = allTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};
const BASE = 'https://api.billingo.hu/v3';

/** Serves `stored` on GET `path` and records the PUT body. */
function storedRecord(path: string, stored: Record<string, unknown>) {
  const seen: { body: Record<string, unknown> | null } = { body: null };
  server.use(
    http.get(`${BASE}${path}`, () => HttpResponse.json(stored)),
    http.put(`${BASE}${path}`, async ({ request }) => {
      seen.body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ ...stored, ...seen.body });
    }),
  );
  return seen;
}
const call = async (name: string, args: Record<string, unknown>) =>
  byName(name).handler(z.object(byName(name).inputSchema).parse(args), ctx);

// A partner as Billingo returns it, read-only fields and nulls included.
const storedPartner = {
  id: 7,
  name: 'Example Kft.',
  address: { country_code: 'HU', post_code: '1011', city: 'Budapest', address: 'Példa utca 1.' },
  emails: ['billing@example.com'],
  taxcode: '12345678-2-42',
  iban: 'HU42117730161111101800000000',
  swift: 'OTPVHUHB',
  account_number: '',
  phone: '+36301234567',
  general_ledger_number: '',
  tax_type: 'HAS_TAX_NUMBER',
  custom_billing_settings: { payment_method: null, due_days: 15, document_form: null },
  group_member_tax_number: '',
  giro_settings: {
    giro_default_settings: false,
    giro_payment_request_enabled: true,
    giro_different_amount_allowed: true,
  },
  internal_comment: null,
  partner_show_type: 'show_all',
};

describe('update tools change only the fields they are given', () => {
  it('update_partner reads the partner, changes the phone and sends everything else back', async () => {
    const seen = storedRecord('/partners/7', storedPartner);
    await call('billingo_update_partner', { id: 7, phone: '+36301112222' });
    const expected = Object.fromEntries(
      Object.entries(storedPartner).filter(([key]) => key !== 'id' && key !== 'internal_comment'),
    );
    expect(seen.body).toEqual({
      ...expected,
      phone: '+36301112222',
      custom_billing_settings: { due_days: 15 },
    });
  });

  it('merges a nested object key by key: a new city keeps the rest of the address', async () => {
    const seen = storedRecord('/partners/7', storedPartner);
    await call('billingo_update_partner', { id: 7, address: { city: 'Szeged' } });
    expect(seen.body?.['address']).toEqual({ ...storedPartner.address, city: 'Szeged' });
  });

  it('accepts a record read back with nulls in it, and treats null as "keep"', async () => {
    const seen = storedRecord('/partners/7', storedPartner);
    await call('billingo_update_partner', {
      id: 7,
      phone: '+36301112222',
      internal_comment: null,
      giro_settings: null,
      tax_type: '',
    });
    expect(seen.body).toMatchObject({
      phone: '+36301112222',
      giro_settings: storedPartner.giro_settings,
      tax_type: '',
    });
    expect(seen.body).not.toHaveProperty('internal_comment');
  });

  it('empties a text field when given ""', async () => {
    const seen = storedRecord('/partners/7', storedPartner);
    await call('billingo_update_partner', { id: 7, phone: '' });
    expect(seen.body?.['phone']).toBe('');
  });

  it('update_product keeps one price: net by default, gross when the caller changes it', async () => {
    const stored = {
      id: 3,
      name: 'Widget',
      currency: 'HUF',
      vat: '27%',
      net_unit_price: 1000,
      gross_unit_price: 1270,
      unit: 'db',
      sku: 'S1',
      ean: '5990000000000',
      purchase_price: 500,
      entitlement: null,
    };
    const rename = storedRecord('/products/3', stored);
    await call('billingo_update_product', { id: 3, name: 'Widget v2' });
    expect(rename.body).toMatchObject({
      name: 'Widget v2',
      net_unit_price: 1000,
      sku: 'S1',
      ean: '5990000000000',
      purchase_price: 500,
    });
    expect(rename.body).not.toHaveProperty('gross_unit_price');
    expect(rename.body).not.toHaveProperty('entitlement');
    const reprice = storedRecord('/products/3', stored);
    await call('billingo_update_product', { id: 3, gross_unit_price: 2540 });
    expect(reprice.body).toMatchObject({ gross_unit_price: 2540 });
    expect(reprice.body).not.toHaveProperty('net_unit_price');
  });

  it('update_bank_account keeps the IBAN and SWIFT when only the name changes', async () => {
    const seen = storedRecord('/bank-accounts/5', {
      id: 5,
      name: 'OTP',
      account_number: '11773016-11111018-00000000',
      account_number_iban: 'HU42117730161111101800000000',
      swift: 'OTPVHUHB',
      currency: 'HUF',
      need_qr: false,
    });
    await call('billingo_update_bank_account', { id: 5, name: 'OTP HUF' });
    expect(seen.body).toEqual({
      name: 'OTP HUF',
      account_number: '11773016-11111018-00000000',
      account_number_iban: 'HU42117730161111101800000000',
      swift: 'OTPVHUHB',
      currency: 'HUF',
    });
  });

  it('update_spending maps the read model to the write model', async () => {
    const seen = storedRecord('/spendings/11', {
      id: 11,
      organization_id: 1,
      category: 'other',
      paid_at: null,
      fulfillment_date: '2026-10-14',
      partner: { id: 9, name: 'Example Kft.' },
      invoice_number: 'SUP-1',
      currency: 'HUF',
      conversion_rate: 1,
      total_gross: 12700,
      total_gross_local: 12700,
      total_vat_amount: 2700,
      total_vat_amount_local: 2700,
      invoice_date: '2026-10-14',
      due_date: '2026-10-14',
      payment_method: 'cash',
      comment: 'keep',
      items: [],
      created_by_nav: false,
    });
    await call('billingo_update_spending', { id: 11, comment: 'changed' });
    expect(seen.body).toEqual({
      category: 'other',
      fulfillment_date: '2026-10-14',
      invoice_number: 'SUP-1',
      currency: 'HUF',
      conversion_rate: 1,
      total_gross: 12700,
      total_gross_huf: 12700,
      total_vat_amount: 2700,
      total_vat_amount_huf: 2700,
      invoice_date: '2026-10-14',
      due_date: '2026-10-14',
      payment_method: 'cash',
      comment: 'changed',
      partner_id: 9,
    });
  });

  it('every update tool needs nothing but the id, is destructive, and says it keeps the rest', () => {
    for (const name of [
      'billingo_update_partner',
      'billingo_update_product',
      'billingo_update_bank_account',
      'billingo_update_spending',
    ]) {
      const tool = byName(name);
      expect(z.object(tool.inputSchema).safeParse({ id: 1 }).success, name).toBe(true);
      expect(tool.annotations.destructiveHint, name).toBe(true);
      expect(tool.description, name).toContain('Changes only the fields you send');
    }
  });

  it('the server accepts a real partner read back and sent as-is, nested nulls included, and changes nothing', async () => {
    const recorded = (
      JSON.parse(
        readFileSync(join(import.meta.dirname, '..', 'fixtures', 'live', 'partner.json'), 'utf8'),
      ) as {
        body: Record<string, unknown>;
      }
    ).body;
    const seen = storedRecord('/partners/7', recorded);
    const sentBack = Object.fromEntries(Object.entries(recorded).filter(([key]) => key !== 'id'));
    const args = z
      .object(byName('billingo_update_partner').inputSchema)
      .safeParse({ id: 7, ...sentBack });
    expect(args.success, JSON.stringify(args.error?.issues.slice(0, 2))).toBe(true);
    await byName('billingo_update_partner').handler(args.data as Record<string, unknown>, ctx);
    // Same as the stored writable fields, nulls dropped: the nested nulls mean "keep".
    expect(seen.body?.['custom_billing_settings']).toEqual({});
    expect(seen.body?.['name']).toBe(recorded['name']);
    expect(seen.body?.['address']).toEqual(recorded['address']);
  });

  it('keeps a nested value when the patch gives null for it', async () => {
    const seen = storedRecord('/partners/7', storedPartner);
    await call('billingo_update_partner', {
      id: 7,
      custom_billing_settings: { due_days: null },
      address: { city: null },
    });
    expect(seen.body?.['custom_billing_settings']).toEqual({ due_days: 15 });
    expect(seen.body?.['address']).toEqual(storedPartner.address);
  });

  it('drops nested nulls when nothing is stored under that key', async () => {
    const seen = storedRecord('/partners/7', { ...storedPartner, custom_billing_settings: null });
    await call('billingo_update_partner', {
      id: 7,
      custom_billing_settings: { due_days: 30, payment_method: null },
    });
    expect(seen.body?.['custom_billing_settings']).toEqual({ due_days: 30 });
  });

  describe('update_spending keeps the HUF amounts in step', () => {
    const huf = {
      id: 11,
      category: 'other',
      currency: 'HUF',
      conversion_rate: 1,
      total_gross: 12700,
      total_gross_local: 12700,
      total_vat_amount: 2700,
      total_vat_amount_local: 2700,
      fulfillment_date: '2026-10-14',
      payment_method: 'cash',
      invoice_number: 'SUP-1',
      invoice_date: '2026-10-14',
      due_date: '2026-10-14',
      partner: null,
    };
    const eur = {
      ...huf,
      currency: 'EUR',
      conversion_rate: 400,
      total_gross: 100,
      total_gross_local: 40000,
      total_vat_amount: 21,
      total_vat_amount_local: 8400,
    };

    it('in HUF a new total carries its HUF amount along', async () => {
      const seen = storedRecord('/spendings/11', huf);
      await call('billingo_update_spending', {
        id: 11,
        total_gross: 25400,
        total_vat_amount: 5400,
      });
      expect(seen.body).toMatchObject({
        total_gross: 25400,
        total_gross_huf: 25400,
        total_vat_amount: 5400,
        total_vat_amount_huf: 5400,
        conversion_rate: 1,
      });
    });

    it('switching to HUF sets the rate to 1 and mirrors the totals', async () => {
      const seen = storedRecord('/spendings/11', eur);
      await call('billingo_update_spending', {
        id: 11,
        currency: 'HUF',
        total_gross: 40000,
        total_vat_amount: 8400,
      });
      expect(seen.body).toMatchObject({ conversion_rate: 1, total_gross_huf: 40000 });
    });

    it('in another currency a new total without its HUF amount is refused', async () => {
      const seen = storedRecord('/spendings/11', eur);
      await expect(
        call('billingo_update_spending', { id: 11, total_gross: 200 }),
      ).rejects.toBeInstanceOf(BillingoArgumentError);
      expect(seen.body).toBeNull();
    });

    it('a new currency without a rate, or a new rate without HUF amounts, is refused', async () => {
      const seen = storedRecord('/spendings/11', huf);
      await expect(
        call('billingo_update_spending', { id: 11, currency: 'EUR' }),
      ).rejects.toBeInstanceOf(BillingoArgumentError);
      storedRecord('/spendings/11', eur);
      await expect(
        call('billingo_update_spending', { id: 11, conversion_rate: 410 }),
      ).rejects.toBeInstanceOf(BillingoArgumentError);
      expect(seen.body).toBeNull();
    });

    it('a new currency is refused without its rate even when the HUF amounts are given', async () => {
      const seen = storedRecord('/spendings/11', huf);
      await expect(
        call('billingo_update_spending', {
          id: 11,
          currency: 'EUR',
          total_gross_huf: 12700,
          total_vat_amount_huf: 2700,
        }),
      ).rejects.toThrow(/conversion_rate/);
      expect(seen.body).toBeNull();
    });

    it('in another currency a change with every HUF amount given goes through unchanged', async () => {
      const seen = storedRecord('/spendings/11', eur);
      await call('billingo_update_spending', {
        id: 11,
        total_gross: 200,
        total_gross_huf: 80000,
        total_vat_amount: 42,
        total_vat_amount_huf: 16800,
      });
      expect(seen.body).toMatchObject({
        total_gross: 200,
        total_gross_huf: 80000,
        conversion_rate: 400,
      });
    });

    it('in another currency an unrelated change keeps the stored HUF amounts', async () => {
      const seen = storedRecord('/spendings/11', eur);
      await call('billingo_update_spending', { id: 11, comment: 'x' });
      expect(seen.body).toMatchObject({ total_gross_huf: 40000, total_vat_amount_huf: 8400 });
    });
  });

  describe('update_product price rule', () => {
    const stored = {
      id: 3,
      name: 'Widget',
      currency: 'HUF',
      vat: '27%',
      net_unit_price: 1000,
      gross_unit_price: 1270,
      unit: 'db',
    };

    it('sends the changed net price when the caller also echoes the stored gross price', async () => {
      const seen = storedRecord('/products/3', stored);
      await call('billingo_update_product', {
        id: 3,
        net_unit_price: 2000,
        gross_unit_price: 1270,
      });
      expect(seen.body).toMatchObject({ net_unit_price: 2000 });
      expect(seen.body).not.toHaveProperty('gross_unit_price');
    });

    it('is not idempotent: repeating a call that echoes one price can undo the other', async () => {
      const update = byName('billingo_update_product');
      expect(update.annotations.idempotentHint).toBe(false);
      // After {net 2000, gross 1270} has been applied, the stored gross price is 2540, so
      // the same call now reads as a gross change and would restore net 1000.
      const seen = storedRecord('/products/3', {
        ...stored,
        net_unit_price: 2000,
        gross_unit_price: 2540,
      });
      await call('billingo_update_product', {
        id: 3,
        net_unit_price: 2000,
        gross_unit_price: 1270,
      });
      expect(seen.body).toMatchObject({ gross_unit_price: 1270 });
    });

    it('refuses two changed prices instead of dropping one', async () => {
      const seen = storedRecord('/products/3', stored);
      await expect(
        call('billingo_update_product', { id: 3, net_unit_price: 2000, gross_unit_price: 3000 }),
      ).rejects.toBeInstanceOf(BillingoArgumentError);
      expect(seen.body).toBeNull();
      expect(describeError(new BillingoArgumentError('x'))).toEqual({
        code: 'invalid_arguments',
        retryable: false,
      });
    });

    it('keeps a VAT-inclusive price when vat changes and only the gross price is given', async () => {
      const seen = storedRecord('/products/3', stored);
      await call('billingo_update_product', { id: 3, vat: '5%', gross_unit_price: 1270 });
      expect(seen.body).toMatchObject({ vat: '5%', gross_unit_price: 1270 });
      expect(seen.body).not.toHaveProperty('net_unit_price');
    });

    it('keeps the net price when vat changes alone', async () => {
      const seen = storedRecord('/products/3', stored);
      await call('billingo_update_product', { id: 3, vat: '5%' });
      expect(seen.body).toMatchObject({ vat: '5%', net_unit_price: 1000 });
    });

    it('treats a price read back as a numeric string as unchanged', async () => {
      const seen = storedRecord('/products/3', { ...stored, gross_unit_price: '1270.00' });
      await call('billingo_update_product', {
        id: 3,
        net_unit_price: 2000,
        gross_unit_price: 1270,
      });
      expect(seen.body).toMatchObject({ net_unit_price: 2000 });
      expect(seen.body).not.toHaveProperty('gross_unit_price');
    });

    it('falls back to the gross price when the product has no net price', async () => {
      const grossOnly = Object.fromEntries(
        Object.entries(stored).filter(([key]) => key !== 'net_unit_price'),
      );
      const seen = storedRecord('/products/3', grossOnly);
      await call('billingo_update_product', { id: 3, name: 'Renamed' });
      expect(seen.body).toMatchObject({ name: 'Renamed', gross_unit_price: 1270 });
    });
  });
});
