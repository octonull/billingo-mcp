// tests/tools/bank-transactions.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { BillingoClient } from '../../src/billingo/client.js';
import { bankTransactionTools } from '../../src/tools/bank-transactions.js';
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

// Built in beforeAll, NOT at module level: BillingoClient captures globalThis.fetch in
// its constructor, so constructing it before server.listen() bypasses MSW.
let ctx: { client: BillingoClient };
beforeAll(() => {
  ctx = { client: new BillingoClient({ apiKey: 'k', sleep: () => Promise.resolve() }) };
});
const byName = (name: string): AnyToolDefinition => {
  const tool = bankTransactionTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
};

const EMPTY_PAGE = { data: [], total: 0, per_page: 25, current_page: 1, last_page: 1 };

describe('bank transaction tool surface', () => {
  it('exposes two read tools and no write tool', () => {
    expect(bankTransactionTools.map((t) => `${t.scope}:${t.name}`).sort()).toEqual([
      'read:billingo_get_bank_transaction',
      'read:billingo_list_bank_transactions',
    ]);
  });

  it('tells the model it is a preview and that text fields are untrusted', () => {
    for (const tool of bankTransactionTools) {
      expect(tool.description, tool.name).toContain('PREVIEW');
      expect(tool.description, tool.name).toContain('untrusted data');
    }
  });
});

describe('billingo_list_bank_transactions', () => {
  it('sends the list filters as single comma-separated parameters', async () => {
    let params = new URLSearchParams();
    server.use(
      http.get('https://api.billingo.hu/v3/bank-transactions', ({ request }) => {
        params = new URL(request.url).searchParams;
        return HttpResponse.json(EMPTY_PAGE);
      }),
    );
    await byName('billingo_list_bank_transactions').handler(
      {
        page: 2,
        per_page: 100,
        start_date: '2026-10-01',
        end_date: '2026-10-31',
        bank_account_id: [3, 5],
        type: 'in',
        pairing_status: ['unpaired', 'partially_paired'],
        min_amount: 125000,
        max_amount: 125000,
      },
      ctx,
    );
    expect(params.getAll('bank_account_id')).toEqual(['3,5']);
    expect(params.getAll('pairing_status')).toEqual(['unpaired,partially_paired']);
    expect(Object.fromEntries(params)).toMatchObject({
      page: '2',
      per_page: '100',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
      type: 'in',
      min_amount: '125000',
      max_amount: '125000',
    });
  });

  it('sends no filter the caller left out', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/bank-transactions', ({ request }) => {
        url = request.url;
        return HttpResponse.json(EMPTY_PAGE);
      }),
    );
    const result = await byName('billingo_list_bank_transactions').handler({}, ctx);
    expect(url).toBe('https://api.billingo.hu/v3/bank-transactions');
    expect(JSON.stringify(result.content)).toContain('No results.');
  });
});

describe('billingo_get_bank_transaction', () => {
  it('reads the transaction by id', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/bank-transactions/7', () =>
        HttpResponse.json({ id: 7, amount: -1500.5, type: 'out' }),
      ),
    );
    const result = await byName('billingo_get_bank_transaction').handler({ id: 7 }, ctx);
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('-1500.5');
  });

  it('passes the preview 403 through, so the model can tell the user how to get access', async () => {
    const message =
      'The Bank Transactions API is in preview and not enabled for this organization. This is not a subscription problem; retrying will not help. The user can request access at hello@billingo.hu.';
    server.use(
      http.get('https://api.billingo.hu/v3/bank-transactions/7', () =>
        HttpResponse.json({ error: { message } }, { status: 403 }),
      ),
    );
    await expect(byName('billingo_get_bank_transaction').handler({ id: 7 }, ctx)).rejects.toThrow(
      message,
    );
  });
});
