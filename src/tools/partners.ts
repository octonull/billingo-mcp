// src/tools/partners.ts
import { z } from 'zod';
import { currencySchema, paymentMethodSchema } from '../billingo/enums.js';
import { pageParamsShape, summarizePage } from '../billingo/pagination.js';
import type { Paginated } from '../billingo/pagination.js';
import { defineTool, jsonResult } from './registry.js';
import type { AnyToolDefinition } from './registry.js';

/**
 * post_code, city and address are REQUIRED — verified against the live API on
 * 2026-07-17, which 422s on a partner without them:
 *   {"message":"Validation Failed","errors":[
 *     {"field":"name","message":"The name field is required."},
 *     {"field":"address.post_code","message":"The address.post code field is required."},
 *     {"field":"address.city","message":"The address.city field is required."},
 *     {"field":"address.address","message":"The address.address field is required."}]}
 * Making them optional here would just move the failure from us to the API.
 */
const addressSchema = z.object({
  country_code: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, e.g. "HU".'),
  post_code: z.string().min(1).describe('Postal code. Required.'),
  city: z.string().min(1).describe('City. Required.'),
  address: z.string().min(1).describe('Street address. Required.'),
});

/**
 * Fields shared by create and update. PUT /partners/{id} is a full replace, not a patch —
 * verified live 2026-07-17, where {"name":"renamed"} 422s with address.post_code,
 * address.city and address.address all "required". So create and update share the exact
 * same required set (name, address); only the genuinely optional attributes stay optional.
 */
const partnerFields = {
  name: z.string().min(1).describe('Partner (company or person) name.'),
  address: addressSchema.describe(
    'Full address. Required — PUT replaces the whole partner, so this must be sent on every update too, not just on create.',
  ),
  emails: z.array(z.email()).optional().describe('Email addresses invoices are sent to.'),
  taxcode: z.string().optional().describe('Tax number.'),
  group_member_tax_number: z.string().optional(),
  tax_type: z.enum(['none', 'has_tax_number', 'no_tax_number']).optional(),
  phone: z.string().optional(),
  account_number: z.string().optional(),
  general_ledger_number: z.string().optional(),
  default_currency: currencySchema.optional(),
  default_payment_method: paymentMethodSchema.optional(),
  custom_billing_settings: z.object({ payment_days: z.number().int().optional() }).optional(),
};

const listPartners = defineTool({
  name: 'billingo_list_partners',
  scope: 'read',
  title: 'List partners',
  description:
    'Lists partners (customers), newest first. Supports paging and a free-text search over the partner name.',
  inputSchema: {
    ...pageParamsShape,
    query: z.string().optional().describe('Free-text search over the partner name.'),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ page, per_page, query }, { client }) => {
    const result = await client.get<Paginated<unknown>>('/partners', {
      query: { page, per_page, query },
    });
    return jsonResult(result, summarizePage(result));
  },
});

const getPartner = defineTool({
  name: 'billingo_get_partner',
  scope: 'read',
  title: 'Get partner',
  description: 'Returns a single partner by id.',
  inputSchema: { id: z.number().int().describe('Partner id.') },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ id }, { client }) => jsonResult(await client.get(`/partners/${String(id)}`)),
});

const createPartner = defineTool({
  name: 'billingo_create_partner',
  scope: 'write',
  title: 'Create partner',
  description:
    'Creates a new partner (customer). Does not issue anything to NAV. Check for an existing partner with billingo_list_partners first to avoid duplicates.',
  inputSchema: partnerFields,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, { client }) => jsonResult(await client.post('/partners', { body: args })),
});

const updatePartner = defineTool({
  name: 'billingo_update_partner',
  scope: 'write',
  title: 'Update partner',
  description:
    'Replaces an existing partner. PUT is a full update, not a patch: the API re-validates the entire required field set (name and a complete address) on every call, even for attributes you are not changing — sending only the changed fields (e.g. just { name }) will fail with a 422. To update safely: call billingo_get_partner first, merge your changes into the full record, and send that complete result here.',
  inputSchema: {
    id: z.number().int().describe('Partner id.'),
    ...partnerFields,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async ({ id, ...body }, { client }) =>
    jsonResult(await client.put(`/partners/${String(id)}`, { body })),
});

const guessPartner = defineTool({
  name: 'billingo_guess_partner',
  scope: 'write',
  title: 'Guess (find or create) partner',
  description:
    'Finds a partner matching the given details and returns it. If no match exists, it CREATES a new partner and returns that. This is an upsert, not a pure lookup — use billingo_list_partners if you only want to search.',
  inputSchema: {
    name: z.string().min(1).optional(),
    taxcode: z.string().optional(),
    address: addressSchema.optional(),
    emails: z.array(z.email()).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, { client }) =>
    jsonResult(await client.post('/partners/guess', { body: args })),
});

/**
 * DELETE /partners/{id} is, like GET and PUT above, absent from the 3.0.15 spec's
 * /partners paths (only GET /partners, POST /partners and POST /partners/guess are
 * documented) but is exercised live the same way.
 */
const deletePartner = defineTool({
  name: 'billingo_delete_partner',
  scope: 'write',
  title: 'Delete partner',
  description:
    'Deletes a partner. Cannot be undone. Partners referenced by existing invoices may not be deletable — the API will say so.',
  inputSchema: { id: z.number().int().describe('Partner id.') },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async ({ id }, { client }) => jsonResult(await client.delete(`/partners/${String(id)}`)),
});

export const partnerTools: AnyToolDefinition[] = [
  listPartners,
  getPartner,
  createPartner,
  updatePartner,
  guessPartner,
  deletePartner,
];
