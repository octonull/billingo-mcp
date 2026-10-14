// src/tools/partners.ts
import { z } from 'zod';
import { paginatedSchema, partnerSchema } from '../billingo/schemas.js';
import { currencySchema, documentLanguageSchema, paymentMethodSchema } from '../billingo/enums.js';
import { pageParamsShape, summarizePage } from '../billingo/pagination.js';
import type { Paginated } from '../billingo/pagination.js';
import { patchDescription, patchRecord, patchShape } from './merge.js';
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
  post_code: z.string().min(1).describe('Postal code.'),
  city: z.string().min(1).describe('City.'),
  address: z.string().min(1).describe('Street address.'),
});

/**
 * Fields shared by create and update. Create needs name and a complete address (verified
 * live 2026-07-17: {"name":"renamed"} 422s with address.post_code, address.city and
 * address.address all "required"). Update takes any subset of them: the tool reads the
 * partner and fills in the rest, because PUT /partners/{id} is a full replace.
 */
const partnerFields = {
  name: z.string().min(1).describe('Partner (company or person) name.'),
  address: addressSchema.describe('Full address. On update, give only the parts that change.'),
  emails: z.array(z.email()).optional().describe('Email addresses invoices are sent to.'),
  taxcode: z.string().optional().describe('Tax number.'),
  group_member_tax_number: z.string().optional(),
  // Per spec components.schemas.PartnerTaxType: '', FOREIGN, HAS_TAX_NUMBER, NO_TAX_NUMBER.
  // Verified live 2026-10-14: the lowercase values the tool used to accept ('none',
  // 'has_tax_number', 'no_tax_number') return 201 but are stored as '' (not set), and
  // without FOREIGN an EU (VAT "EU") invoice is refused: "the customer type must be set
  // to 'Foreign'". With FOREIGN the same EU invoice is issued.
  tax_type: z
    .enum(['', 'FOREIGN', 'HAS_TAX_NUMBER', 'NO_TAX_NUMBER'])
    .optional()
    .describe(
      'Customer type: HAS_TAX_NUMBER for a Hungarian business with a tax number, NO_TAX_NUMBER for a private person, FOREIGN for a buyer outside Hungary, "" for not set (what Billingo returns for a partner without one). EU (VAT "EU") invoices need FOREIGN and the EU VAT number in taxcode.',
    ),
  phone: z.string().optional(),
  account_number: z.string().optional(),
  // Verified live 2026-10-14: a partner PUT that leaves out iban, swift and
  // internal_comment clears them and resets giro_settings to its defaults. The update
  // tool keeps them by reading the partner first (src/tools/merge.ts); these fields let a
  // caller set and change them.
  iban: z.string().optional(),
  swift: z.string().optional(),
  internal_comment: z.string().optional().describe('Internal note, not printed on invoices.'),
  giro_settings: z
    .object({
      giro_default_settings: z.boolean().optional(),
      giro_payment_request_enabled: z.boolean().optional(),
      giro_different_amount_allowed: z.boolean().optional(),
    })
    .optional()
    .describe('GIRO direct-debit settings (components.schemas.PartnerGiroSettings).'),
  general_ledger_number: z.string().optional(),
  // Per spec components.schemas.PartnerCustomBillingSettings. Verified live 2026-10-14:
  // the fields the tool used to offer (default_currency, default_payment_method and
  // custom_billing_settings.payment_days) return 201 but are stored as null; due_days,
  // payment_method and document_currency inside custom_billing_settings are stored.
  custom_billing_settings: z
    .object({
      due_days: z.number().int().optional().describe('Default payment term in days.'),
      payment_method: paymentMethodSchema.optional(),
      document_currency: currencySchema.optional(),
      template_language_code: documentLanguageSchema.optional(),
    })
    .optional()
    .describe("Defaults Billingo applies to this partner's new documents."),
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
  outputSchema: paginatedSchema(partnerSchema),
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
  outputSchema: partnerSchema,
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

/** Writable fields of components.schemas.Partner, the body PUT /partners/{id} takes. */
const PARTNER_WRITABLE = [
  'name',
  'address',
  'emails',
  'taxcode',
  'iban',
  'swift',
  'account_number',
  'phone',
  'general_ledger_number',
  'tax_type',
  'custom_billing_settings',
  'group_member_tax_number',
  'giro_settings',
  'partner_shipping',
  'internal_comment',
  'partner_show_type',
] as const;

const updatePartner = defineTool({
  name: 'billingo_update_partner',
  scope: 'write',
  title: 'Update partner',
  description: patchDescription('partner'),
  inputSchema: {
    id: z.number().int().describe('Partner id.'),
    ...patchShape({
      ...partnerFields,
      address: addressSchema
        .partial()
        .describe('Only the parts that change; the rest of the stored address is kept.'),
    }),
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
        { path: `/partners/${String(id)}`, writable: PARTNER_WRITABLE },
        patch,
      ),
    ),
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
