// src/tools/organization.ts
import { z } from 'zod';
import { isoDate } from '../billingo/dates.js';
import { currencySchema } from '../billingo/enums.js';
import { defineTool, jsonResult } from './registry.js';
import type { AnyToolDefinition } from './registry.js';

const getOrganization = defineTool({
  name: 'billingo_get_organization',
  scope: 'read',
  title: 'Get organization',
  description:
    'Returns account-level data for the organization that owns the API key: its tax code, its Billingo subscription, and whether NAV Online Számla is connected. This is NOT a company profile — it contains no name, id or address. Use it to check the subscription or NAV connection status.',
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (_args, { client }) => jsonResult(await client.get('/organization')),
});

const checkTaxNumber = defineTool({
  name: 'billingo_check_tax_number',
  scope: 'read',
  title: 'Check tax number',
  description:
    'Looks up a Hungarian tax number at NAV and returns the company data behind it. Use this to validate a tax number before creating a partner. Works only when the Billingo account has a live NAV Online Számla connection (not available on sandbox accounts).',
  inputSchema: {
    // Verified live 2026-10-14: "12345678" and "12345678242" both 422 with "The tax
    // number format is invalid."; only the hyphenated 11-digit form passes validation.
    tax_number: z
      .string()
      .regex(/^\d{8}-\d-\d{2}$/, 'must be the full tax number, e.g. "12345678-2-42"')
      .describe('Full Hungarian tax number with hyphens, e.g. "12345678-2-42".'),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ tax_number }, { client }) =>
    jsonResult(await client.get(`/utils/check-tax-number/${encodeURIComponent(tax_number)}`)),
});

const getConversionRate = defineTool({
  name: 'billingo_get_conversion_rate',
  scope: 'read',
  title: 'Get currency conversion rate',
  description: 'Returns the conversion rate Billingo would apply between two currencies.',
  inputSchema: {
    from: currencySchema.describe('Source currency.'),
    to: currencySchema.describe('Target currency.'),
    date: isoDate
      .optional()
      .describe(
        "Rate as of this date. Omit for today's rate. For a backdated or historical document, pass its fulfillment_date here — otherwise you'll get today's rate on a document dated in the past.",
      ),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ from, to, date }, { client }) =>
    jsonResult(await client.get('/currencies', { query: { from, to, date } })),
});

export const organizationTools: AnyToolDefinition[] = [
  getOrganization,
  checkTaxNumber,
  getConversionRate,
];
