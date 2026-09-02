// src/tools/documents/read.ts
import { z } from 'zod';
import { BillingoPdfNotReadyError, PDF_NOT_READY_STATUS } from '../../billingo/errors.js';
import { paymentMethodSchema } from '../../billingo/enums.js';
import { isoDate } from '../../billingo/dates.js';
import { pageParamsShape, summarizePage } from '../../billingo/pagination.js';
import type { Paginated } from '../../billingo/pagination.js';
import { defineTool, errorResult, jsonResult } from '../registry.js';
import type { AnyToolDefinition } from '../registry.js';

const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

/**
 * GET /documents query parameters, per spec/billingo-3.0.15.json paths./documents.get —
 * corrected against two wrong guesses in the task brief:
 *
 *  - `type` is NOT `components.schemas.DocumentType` (17 values, e.g. "proforma",
 *    "draft"). The `/documents` list endpoint inlines its own narrower
 *    `{ enum: ["invoice", "receipt"] }`, so documentTypeSchema is intentionally not
 *    used here — it would accept values (e.g. "proforma") the API itself rejects.
 *  - `payment_status` is `components.schemas.PaymentStatus`:
 *    ["expired", "none", "outstanding", "paid", "partially_paid"] — not the guessed
 *    ["paid", "unpaid", "partially_paid"].
 *
 * `payment_method` does use the shared enum (`components.schemas.PaymentMethod` via
 * `$ref`), confirming why paymentMethodSchema is a declared dependency.
 *
 * `start_date`/`end_date` filter by invoice date, not fulfillment date — the API has a
 * separate `fulfillment_start_date`/`fulfillment_end_date` pair for that. Along with
 * `paid_start_date`/`paid_end_date`, `start_number`/`end_number`/`start_year`/`end_year`,
 * and `last_modified_date`, those are left out here to match the brief's scoped filter
 * set; they exist in the spec if a future task wants them.
 */
const listDocuments = defineTool({
  name: 'billingo_list_documents',
  scope: 'read',
  title: 'List documents',
  description:
    'Lists documents (invoices, receipts, proformas, drafts and more), newest first. Filter by type, invoice date range, partner, payment status/method or document block.',
  inputSchema: {
    ...pageParamsShape,
    type: z
      .enum(['invoice', 'receipt'])
      .optional()
      .describe('Restrict to one document type. Only "invoice" or "receipt" are accepted here.'),
    start_date: isoDate.optional().describe('Include documents invoiced on or after this date.'),
    end_date: isoDate.optional().describe('Include documents invoiced on or before this date.'),
    partner_id: z.number().int().optional().describe('Restrict to one partner.'),
    block_id: z.number().int().optional().describe('Restrict to one document block.'),
    payment_status: z.enum(['expired', 'none', 'outstanding', 'paid', 'partially_paid']).optional(),
    payment_method: paymentMethodSchema.optional(),
    query: z.string().optional().describe('Free-text search.'),
  },
  annotations: readOnly,
  handler: async (args, { client }) => {
    const result = await client.get<Paginated<unknown>>('/documents', { query: args });
    return jsonResult(result, summarizePage(result));
  },
});

const getDocument = defineTool({
  name: 'billingo_get_document',
  scope: 'read',
  title: 'Get document',
  description:
    'Returns a single document. Give either `id` (the Billingo document id) or `vendor_id` (your own external reference set when the document was created).',
  inputSchema: {
    id: z.number().int().optional().describe('Billingo document id.'),
    vendor_id: z.string().optional().describe('Your external reference for the document.'),
  },
  annotations: readOnly,
  handler: async ({ id, vendor_id }, { client }) => {
    if (id !== undefined) return jsonResult(await client.get(`/documents/${String(id)}`));
    if (vendor_id !== undefined) {
      return jsonResult(await client.get(`/documents/vendor/${encodeURIComponent(vendor_id)}`));
    }
    return errorResult('Give either `id` or `vendor_id`.');
  },
});

const downloadDocument = defineTool({
  name: 'billingo_download_document',
  scope: 'read',
  title: 'Download document',
  description:
    'Gets the document PDF. By default returns a shareable public URL — this is what works in most MCP clients (including Claude Desktop, which rejects the base64 file attachment) and is what you want in almost every case. Pass format="base64" only when a caller specifically needs the raw PDF bytes: it costs a lot of context (base64 is ~1.33x the PDF size) and some clients cannot render the result at all.',
  inputSchema: {
    id: z.number().int().describe('Document id.'),
    format: z
      .enum(['url', 'base64'])
      .optional()
      .describe('"url" returns a public link (default); "base64" returns the PDF bytes.'),
  },
  annotations: readOnly,
  handler: async ({ id, format = 'url' }, { client }) => {
    if (format === 'url')
      return jsonResult(await client.get(`/documents/${String(id)}/public-url`));
    try {
      const { data, contentType } = await client.getBinary(
        `/documents/${String(id)}/download`,
        {},
        PDF_NOT_READY_STATUS,
      );
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: `billingo://document/${String(id)}/pdf`,
              mimeType: contentType,
              blob: Buffer.from(data).toString('base64'),
            },
          },
        ],
      };
    } catch (error) {
      if (error instanceof BillingoPdfNotReadyError) {
        return errorResult(
          `The PDF for document ${String(id)} has not generated yet. This is normal right after creating a document — try again in a few seconds.`,
        );
      }
      throw error;
    }
  },
});

const getPublicUrl = defineTool({
  name: 'billingo_get_document_public_url',
  scope: 'read',
  title: 'Get document public URL',
  description:
    'Returns a shareable public URL for the document, viewable without a Billingo login.',
  inputSchema: { id: z.number().int().describe('Document id.') },
  annotations: readOnly,
  handler: async ({ id }, { client }) =>
    jsonResult(await client.get(`/documents/${String(id)}/public-url`)),
});

const getOnlineSzamlaStatus = defineTool({
  name: 'billingo_get_online_szamla_status',
  scope: 'read',
  title: 'Get NAV Online Számla status',
  description:
    'Returns the NAV Online Számla reporting status of a document: the transaction id, the status, and any validation messages from NAV. Use this to check whether reporting succeeded. ' +
    'Errors (4xx, "NavOnlineSzamla is not found") when the document has no NAV record at all — for example when the organization is not connected to NAV Online Számla, or the document is not subject to reporting. That is not a NAV failure; it means there is nothing to report on.',
  inputSchema: { id: z.number().int().describe('Document id.') },
  annotations: readOnly,
  // `status` is `{ type: "string" }` in the spec — no enum. It likely carries NAV's own
  // RECEIVED/PROCESSING/SAVED/DONE/ABORTED values through, but that isn't documented
  // here, so it is returned verbatim rather than narrowed to a guessed union.
  handler: async ({ id }, { client }) =>
    jsonResult(await client.get(`/documents/${String(id)}/online-szamla`)),
});

const getPayments = defineTool({
  name: 'billingo_get_document_payments',
  scope: 'read',
  title: 'Get document payments',
  description: 'Returns the payments recorded against a document.',
  inputSchema: { id: z.number().int().describe('Document id.') },
  annotations: readOnly,
  handler: async ({ id }, { client }) =>
    jsonResult(await client.get(`/documents/${String(id)}/payments`)),
});

const getReminders = defineTool({
  name: 'billingo_get_document_reminders',
  scope: 'read',
  title: 'Get document reminder events',
  description:
    'Returns the payment reminder events sent for a document, grouped into sent, upcoming and postal-mail reminders.',
  inputSchema: { id: z.number().int().describe('Document id.') },
  annotations: readOnly,
  handler: async ({ id }, { client }) =>
    jsonResult(await client.get(`/documents/${String(id)}/reminders`)),
});

/**
 * GET /documents/{id}/print/pos, per spec — differs from the brief on two points that
 * would otherwise break the tool entirely:
 *  - `size` (58 or 80, the thermal paper width in mm) is a REQUIRED query parameter,
 *    not absent as the brief's handler assumed.
 *  - The response is `application/pdf` binary, not JSON. `client.get` would attempt
 *    `JSON.parse` on raw PDF bytes and throw; this uses `client.getBinary` instead,
 *    the same way `billingo_download_document` does.
 */
const posPrint = defineTool({
  name: 'billingo_pos_print',
  scope: 'read',
  title: 'Get POS print data',
  description: 'Returns a printable PDF receipt for a document, sized for a POS thermal printer.',
  inputSchema: {
    id: z.number().int().describe('Document id.'),
    size: z.literal([58, 80]).describe('Thermal paper width in millimeters: 58 or 80.'),
  },
  annotations: readOnly,
  handler: async ({ id, size }, { client }) => {
    const { data, contentType } = await client.getBinary(`/documents/${String(id)}/print/pos`, {
      query: { size },
    });
    return {
      content: [
        {
          type: 'resource',
          resource: {
            uri: `billingo://document/${String(id)}/pos-print`,
            mimeType: contentType,
            blob: Buffer.from(data).toString('base64'),
          },
        },
      ],
    };
  },
});

export const documentReadTools: AnyToolDefinition[] = [
  listDocuments,
  getDocument,
  downloadDocument,
  getPublicUrl,
  getOnlineSzamlaStatus,
  getPayments,
  getReminders,
  posPrint,
];
