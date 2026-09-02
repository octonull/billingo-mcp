// src/tools/spendings.ts
import { z } from 'zod';
import { isoDate } from '../billingo/dates.js';
import { categorySchema, currencySchema, paymentMethodSchema } from '../billingo/enums.js';
import { pageParamsShape, summarizePage } from '../billingo/pagination.js';
import type { Paginated } from '../billingo/pagination.js';
import { defineTool, jsonResult } from './registry.js';
import type { AnyToolDefinition } from './registry.js';

/**
 * Fields shared by create and update, matching components.schemas.SpendingSave — the actual
 * write schema (components.schemas.Spending is the read model and does not accept a
 * partner_name; a spending references an existing partner by partner_id instead).
 * SpendingSave.required: currency, total_gross, total_gross_huf, total_vat_amount,
 * total_vat_amount_huf, fulfillment_date, category, payment_method.
 */
const spendingFields = {
  category: categorySchema.describe('Spending category.'),
  currency: currencySchema,
  total_gross: z.number(),
  total_gross_huf: z
    .number()
    .describe(
      'HUF equivalent of total_gross. Required even when currency is HUF, in which case it should equal total_gross.',
    ),
  total_vat_amount: z.number(),
  total_vat_amount_huf: z.number().describe('HUF equivalent of total_vat_amount.'),
  fulfillment_date: isoDate,
  payment_method: paymentMethodSchema,
  conversion_rate: z.number().optional(),
  paid_at: isoDate.optional().describe('Date the spending was paid.'),
  comment: z.string().optional(),
  invoice_number: z.string().optional(),
  invoice_date: isoDate.optional(),
  due_date: isoDate.optional(),
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
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ id }, { client }) => jsonResult(await client.get(`/spendings/${String(id)}`)),
});

const createSpending = defineTool({
  name: 'billingo_create_spending',
  scope: 'write',
  title: 'Create spending',
  description:
    'Records a new spending (cost). This is bookkeeping only — nothing is issued or reported to NAV.',
  inputSchema: spendingFields,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, { client }) => jsonResult(await client.post('/spendings', { body: args })),
});

/**
 * PUT /spendings/{id} takes the same components.schemas.SpendingSave as POST /spendings
 * (spec/billingo-3.0.15.json) — not a separate partial-update schema. So, like the other
 * three update tools, this is a full replace: update must require the same fields create
 * does, even though this endpoint was not itself probed live.
 */
const updateSpending = defineTool({
  name: 'billingo_update_spending',
  scope: 'write',
  title: 'Update spending',
  description:
    'Replaces an existing spending. PUT uses the same schema as create, so it is a full update, not a patch: the API re-validates the entire required field set (currency, total_gross, total_gross_huf, total_vat_amount, total_vat_amount_huf, fulfillment_date, category, payment_method) on every call, even for attributes you are not changing — sending only the changed fields (e.g. just { total_gross }) will fail with a 422. To update safely: call billingo_get_spending first, merge your changes into the full record, and send that complete result here.',
  inputSchema: {
    id: z.number().int().describe('Spending id.'),
    ...spendingFields,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async ({ id, ...body }, { client }) =>
    jsonResult(await client.put(`/spendings/${String(id)}`, { body })),
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
