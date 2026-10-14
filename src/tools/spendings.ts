// src/tools/spendings.ts
import { z } from 'zod';
import { BillingoArgumentError } from '../billingo/errors.js';
import { paginatedSchema, spendingSchema } from '../billingo/schemas.js';
import { isoDate } from '../billingo/dates.js';
import { categorySchema, currencySchema, paymentMethodSchema } from '../billingo/enums.js';
import { pageParamsShape, summarizePage } from '../billingo/pagination.js';
import type { Paginated } from '../billingo/pagination.js';
import { patchDescription, patchRecord, patchShape } from './merge.js';
import { defineTool, jsonResult } from './registry.js';
import type { AnyToolDefinition } from './registry.js';

/**
 * Fields shared by create and update, matching components.schemas.SpendingSave — the actual
 * write schema (components.schemas.Spending is the read model and does not accept a
 * partner_name; a spending references an existing partner by partner_id instead).
 * SpendingSave.required: currency, total_gross, total_gross_huf, total_vat_amount,
 * total_vat_amount_huf, fulfillment_date, category, payment_method.
 *
 * The live API requires four more. Verified 2026-10-14 for categories other, service
 * and stock, currency HUF: POST and PUT without conversion_rate, invoice_number,
 * invoice_date and due_date 422 with "The ... field is required." for each.
 */
const spendingFields = {
  category: categorySchema.describe('Spending category.'),
  currency: currencySchema,
  total_gross: z.number(),
  total_gross_huf: z
    .number()
    .describe('HUF equivalent of total_gross; equal to total_gross when the currency is HUF.'),
  total_vat_amount: z.number(),
  total_vat_amount_huf: z.number().describe('HUF equivalent of total_vat_amount.'),
  fulfillment_date: isoDate,
  payment_method: paymentMethodSchema,
  conversion_rate: z.number().describe('Conversion rate to HUF; 1 when the currency is HUF.'),
  paid_at: isoDate.optional().describe('Date the spending was paid.'),
  comment: z.string().optional(),
  invoice_number: z.string().min(1).describe('Number of the supplier invoice.'),
  invoice_date: isoDate.describe('Date of the supplier invoice.'),
  due_date: isoDate.describe('Payment due date.'),
  partner_id: z
    .number()
    .int()
    .optional()
    .describe(
      'Id of an existing partner (see billingo_list_partners / billingo_create_partner). SpendingSave has no field for a raw partner name.',
    ),
};

const listSpendings = defineTool({
  name: 'billingo_list_spendings',
  scope: 'read',
  title: 'List spendings',
  description: 'Lists recorded spendings (costs), optionally filtered by date range.',
  inputSchema: {
    ...pageParamsShape,
    start_date: isoDate.optional().describe('Include spendings fulfilled on or after this date.'),
    end_date: isoDate.optional().describe('Include spendings fulfilled on or before this date.'),
  },
  outputSchema: paginatedSchema(spendingSchema),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ page, per_page, start_date, end_date }, { client }) => {
    const result = await client.get<Paginated<unknown>>('/spendings', {
      query: { page, per_page, start_date, end_date },
    });
    return jsonResult(result, summarizePage(result));
  },
});

const getSpending = defineTool({
  name: 'billingo_get_spending',
  scope: 'read',
  title: 'Get spending',
  description: 'Returns a single spending by id.',
  inputSchema: { id: z.number().int().describe('Spending id.') },
  outputSchema: spendingSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ id }, { client }) => jsonResult(await client.get(`/spendings/${String(id)}`)),
});

const createSpending = defineTool({
  name: 'billingo_create_spending',
  scope: 'write',
  title: 'Create spending',
  description:
    'Records a new spending (cost). This is bookkeeping only — nothing is issued or reported to NAV. Beyond what the spec marks required, the API also requires conversion_rate (1 for HUF), invoice_number, invoice_date and due_date.',
  inputSchema: spendingFields,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, { client }) => jsonResult(await client.post('/spendings', { body: args })),
});

/** Fields of components.schemas.SpendingSave, the body PUT /spendings/{id} takes. */
const SPENDING_WRITABLE = [
  'currency',
  'conversion_rate',
  'total_gross',
  'total_gross_huf',
  'total_vat_amount',
  'total_vat_amount_huf',
  'fulfillment_date',
  'paid_at',
  'category',
  'comment',
  'invoice_number',
  'invoice_date',
  'due_date',
  'payment_method',
  'partner_id',
] as const;

/**
 * The read model (components.schemas.Spending) names two amounts differently and nests
 * the partner. Verified live 2026-10-14: a spending read back, mapped this way and sent
 * unchanged stays identical.
 */
function spendingToWritable(record: Record<string, unknown>): Record<string, unknown> {
  const partner = record['partner'] as { id?: unknown } | null | undefined;
  return {
    ...record,
    total_gross_huf: record['total_gross_local'],
    total_vat_amount_huf: record['total_vat_amount_local'],
    partner_id: partner?.id,
  };
}

const TOTALS = [
  ['total_gross', 'total_gross_huf'],
  ['total_vat_amount', 'total_vat_amount_huf'],
] as const;

/**
 * Billingo stores each total and its HUF equivalent exactly as sent and does not convert
 * (verified live 2026-10-14: a HUF spending updated to total_gross 25400 kept
 * total_gross_huf 12700). So a changed amount must not travel with the stale HUF value
 * read a moment earlier. In HUF the HUF fields mirror the totals and the rate is 1,
 * unless the caller gives them. In another currency the tool cannot know the rate the
 * caller meant, so a changed total, currency or rate without its HUF values is refused.
 */
function consistentTotals(
  body: Record<string, unknown>,
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const given = (key: string) => patch[key] !== undefined && patch[key] !== null;
  const changed = (key: string) => given(key) && patch[key] !== current[key];
  const out = { ...body };
  if (out['currency'] === 'HUF') {
    if (!given('conversion_rate')) out['conversion_rate'] = 1;
    for (const [total, huf] of TOTALS) if (!given(huf)) out[huf] = out[total];
    return out;
  }
  const basisChanged = changed('currency') || changed('conversion_rate');
  if (changed('currency') && !given('conversion_rate')) {
    throw new BillingoArgumentError(
      'A new currency needs its conversion_rate (and total_gross_huf, total_vat_amount_huf): Billingo does not convert.',
    );
  }
  for (const [total, huf] of TOTALS) {
    if ((basisChanged || changed(total)) && !given(huf)) {
      throw new BillingoArgumentError(
        `Give ${huf} together with the new ${basisChanged ? 'currency or conversion_rate' : total}: Billingo stores the HUF amount as sent and does not convert.`,
      );
    }
  }
  return out;
}

const updateSpending = defineTool({
  name: 'billingo_update_spending',
  scope: 'write',
  title: 'Update spending',
  description: `${patchDescription('spending')} In HUF, total_gross_huf and total_vat_amount_huf follow the totals by themselves. In another currency Billingo does not convert, so a new total, currency or conversion_rate must come with its HUF amounts.`,
  inputSchema: {
    id: z.number().int().describe('Spending id.'),
    ...patchShape(spendingFields),
  },
  // destructiveHint: true because the given fields overwrite the stored values.
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async ({ id, ...patch }, { client }) =>
    jsonResult(
      await patchRecord(
        client,
        {
          path: `/spendings/${String(id)}`,
          writable: SPENDING_WRITABLE,
          toWritable: spendingToWritable,
          finalize: consistentTotals,
        },
        patch,
      ),
    ),
});

const deleteSpending = defineTool({
  name: 'billingo_delete_spending',
  scope: 'write',
  title: 'Delete spending',
  description: 'Deletes a recorded spending. Cannot be undone.',
  inputSchema: { id: z.number().int().describe('Spending id.') },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async ({ id }, { client }) =>
    jsonResult(await client.delete(`/spendings/${String(id)}`)),
});

export const spendingTools: AnyToolDefinition[] = [
  listSpendings,
  getSpending,
  createSpending,
  updateSpending,
  deleteSpending,
];
