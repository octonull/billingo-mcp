// src/tools/documents/write.ts
import { z } from 'zod';
import {
  currencySchema,
  paymentMethodSchema,
  vatSchema,
  documentTypeSchema,
} from '../../billingo/enums.js';
import { isoDate } from '../../billingo/dates.js';
import { defineTool, jsonResult } from '../registry.js';
import type { AnyToolDefinition } from '../registry.js';

/** A document can issue and report to NAV, so nothing here is idempotent or safe to retry. */
const issuing = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const NAV_WARNING =
  'Issuing a non-draft document is reported to NAV automatically and immediately, and CANNOT be undone — an issued invoice can only be cancelled with a storno, which is itself irreversible. Confirm the details with the user before calling this.';

/**
 * Per spec/billingo-3.0.15.json → components.schemas.DocumentInsert.type, the create
 * endpoint refs `DocumentInsertType` — a narrow 4-value enum — NOT the full 17-value
 * `DocumentType` enum (documentTypeSchema) that the task brief guessed. "proforma" is
 * in both, but e.g. "cert_of_completion" or "receipt" are valid DocumentType values
 * that DocumentInsertType rejects.
 */
const documentInsertTypeSchema = z.enum(['advance', 'draft', 'invoice', 'proforma']);

/**
 * Per spec components.schemas.DocumentLanguage.enum. The brief guessed
 * ['hu','en','de','fr','it','hr','ro','sk','es','cz','pl'] — wrong on both ends: "es",
 * "cz" and "pl" do not exist, and "us" (present in the real enum) was missing.
 */
const documentLanguageSchema = z.enum(['de', 'en', 'fr', 'hr', 'hu', 'it', 'ro', 'sk', 'us']);

/** Per spec components.schemas.Round.enum — the brief invented a "half_up" value. */
const roundSchema = z.enum(['five', 'none', 'one', 'ten']);

/** Per spec components.schemas.OnlinePayment.enum — not a free string, as the brief had it. */
const onlinePaymentSchema = z.enum(['', 'Barion', 'SimplePay', 'Stripe', 'no']);

/**
 * Per spec, DocumentInsert.items and ModificationDocumentInsert.items are both a
 * `oneOf` of two shapes:
 *  - DocumentItemData: a reference to an existing catalogue product (`product_id` +
 *    `quantity`).
 *  - DocumentProductData: an inline ad-hoc line (`name`/`unit_price`/`unit_price_type`/
 *    `unit`/`vat`).
 * The brief flattened these into one object with an optional `product_id` alongside
 * the inline fields, and invented a `general_ledger_number` field that does not exist
 * in the spec at all — both are wrong. Modelled here as a real union instead.
 */
const catalogItemSchema = z.object({
  product_id: z.number().int().describe('Link the line to a catalogue product.'),
  quantity: z.number(),
  comment: z.string().optional(),
});

const inlineItemSchema = z.object({
  name: z.string().min(1).describe('Line item name, as printed on the invoice.'),
  unit_price: z.number().describe('Unit price, net or gross per unit_price_type.'),
  unit_price_type: z.enum(['net', 'gross']),
  quantity: z.number(),
  unit: z.string().describe('Unit of measure, e.g. "db", "óra".'),
  vat: vatSchema.describe(
    'VAT rate. Percentages use a comma for decimals ("25,5%"). Hungarian codes such as AAM, TAM, EU are valid.',
  ),
  comment: z.string().optional(),
  // Entitlement is its own 16-value Hungarian tax-law enum (AAM, EAM, TAM, ...) per
  // spec components.schemas.Entitlement. Left as a free string, the same way
  // billingo_get_online_szamla_status leaves `status` unenumerated, rather than
  // guessing at a legally significant enum this task wasn't scoped to verify.
  entitlement: z.string().optional(),
});

const documentItemSchema = z.union([inlineItemSchema, catalogItemSchema]);

const documentSettingsSchema = z
  .object({
    mediated_service: z.boolean().optional(),
    without_financial_fulfillment: z.boolean().optional(),
    online_payment: onlinePaymentSchema.optional(),
    // Per spec the real field is `should_send_email` (opt-in, default false) — the
    // brief's `no_send_email` does not exist and has inverted semantics: setting it to
    // false would not actually enable sending, since the real default is "don't send".
    should_send_email: z
      .boolean()
      .optional()
      .describe(
        'Send the standard notification email to the partner. Defaults to false (no email) if omitted.',
      ),
    round: roundSchema.optional(),
  })
  .optional();

/**
 * Per spec, DocumentInsert.conversion_rate has no `required` entry and defaults to "1",
 * but that default only makes sense for a HUF document — a non-HUF body with no
 * conversion_rate 422s live. The MCP SDK builds its schema straight from this flat shape
 * (no room for a cross-field .refine() at this layer), so the conditional requirement is
 * expressed in the description instead of enforced unconditionally — making it
 * always-required would break every HUF document.
 */
const CONVERSION_RATE_DESCRIPTION =
  'Exchange rate to HUF. Required unless currency is "HUF" — the API rejects a non-HUF document with no conversion_rate. Optional and defaults to 1 when currency is HUF. Look one up with billingo_get_conversion_rate.';

/**
 * Shared DocumentInsert shape. Used both by billingo_create_document (POST /documents)
 * and billingo_finalize_draft (PUT /documents/{id}) — per spec, finalizing a draft is
 * not a partial conversion, it requires resending the complete document body.
 */
const documentInsertShape = {
  partner_id: z
    .number()
    .int()
    .describe(
      'Partner id. Find or create one with billingo_list_partners / billingo_create_partner.',
    ),
  block_id: z
    .number()
    .int()
    .describe('Document block id. Get one from billingo_list_document_blocks.'),
  type: documentInsertTypeSchema.describe(
    'Document type. Use "draft" to create a draft that is NOT reported to NAV until finalized.',
  ),
  fulfillment_date: isoDate,
  due_date: isoDate,
  payment_method: paymentMethodSchema,
  language: documentLanguageSchema,
  currency: currencySchema,
  conversion_rate: z.number().optional().describe(CONVERSION_RATE_DESCRIPTION),
  electronic: z.boolean().optional().describe('Issue as an e-invoice.'),
  paid: z.boolean().optional(),
  comment: z.string().optional(),
  settings: documentSettingsSchema,
  vendor_id: z
    .string()
    .optional()
    .describe('Your own external reference; look it up later with billingo_get_document.'),
  items: z.array(documentItemSchema).min(1).describe('At least one line item.'),
};

const createDocument = defineTool({
  name: 'billingo_create_document',
  scope: 'write',
  title: 'Create document (invoice, proforma, draft, or advance)',
  description: `Creates a document: an invoice, proforma, draft or advance invoice. ${NAV_WARNING} To stage something safely, create it with type="draft" and finalize it later with billingo_finalize_draft.`,
  inputSchema: documentInsertShape,
  annotations: issuing,
  handler: async (args, { client }) => jsonResult(await client.post('/documents', { body: args })),
});

/**
 * Per spec components.schemas.ReceiptVat.enum — a narrower, receipt-specific VAT enum
 * (none/5%/18%/27%/AAM/TAM), distinct from the general Vat enum used by document items.
 */
const receiptVatSchema = z.enum(['none', '5%', '18%', '27%', 'AAM', 'TAM']);

/** Per spec components.schemas.ReceiptInsert.items oneOf ReceiptItemData | ReceiptProductData. */
const receiptCatalogItemSchema = z.object({
  product_id: z.number().int().describe('Link the line to a catalogue product.'),
});

const receiptInlineItemSchema = z.object({
  name: z.string().optional(),
  unit_price: z.number(),
  vat: receiptVatSchema,
});

const receiptItemSchema = z.union([receiptInlineItemSchema, receiptCatalogItemSchema]);

/**
 * Shared ReceiptInsert shape. Used both by billingo_create_receipt (POST
 * /documents/receipt) and billingo_finalize_receipt_draft (PUT /documents/receipt/{id})
 * — per spec, finalizing a draft receipt requires resending the complete receipt body,
 * the same way finalizing a document draft does.
 */
const receiptInsertShape = {
  block_id: z.number().int().describe('Document block id.'),
  // Per spec, ReceiptInsert.type refs the full DocumentType enum (documentTypeSchema)
  // — not a receipt-specific narrower enum as the brief assumed. In practice only
  // "receipt" and "draft" are meaningful for a receipt, even though the schema
  // technically allows the rest.
  type: documentTypeSchema.describe(
    'Document type. Use "draft" to stage a receipt without issuing it.',
  ),
  partner_id: z
    .number()
    .int()
    .optional()
    .describe('Partner id, if the buyer has a partner record.'),
  name: z
    .string()
    .optional()
    .describe('Buyer name to print on the receipt, when there is no partner record.'),
  emails: z.array(z.string()).optional().describe('Email addresses to send the receipt to.'),
  payment_method: paymentMethodSchema,
  currency: currencySchema,
  conversion_rate: z.number().optional().describe(CONVERSION_RATE_DESCRIPTION),
  electronic: z.boolean().optional().describe('Issue as an e-invoice.'),
  items: z.array(receiptItemSchema).min(1).describe('At least one line item.'),
  vendor_id: z.string().optional().describe('Your own external reference.'),
};

const createReceipt = defineTool({
  name: 'billingo_create_receipt',
  scope: 'write',
  title: 'Create receipt',
  description: `Creates a receipt (nyugta). ${NAV_WARNING}`,
  inputSchema: receiptInsertShape,
  annotations: issuing,
  handler: async (args, { client }) =>
    jsonResult(await client.post('/documents/receipt', { body: args })),
});

const finalizeDraft = defineTool({
  name: 'billingo_finalize_draft',
  scope: 'write',
  title: 'Finalize draft into an invoice',
  description: `Finalizes an existing draft into a real invoice. This is the moment the invoice is issued and reported to NAV — it CANNOT be undone. PUT /documents/{id} is a full replace, not a partial conversion: the API requires the complete document body, not just the id. Fetch the draft first with billingo_get_document, then pass its fields back here — with type changed from "draft" to the type you want to issue (e.g. "invoice") — along with any other changes. ${NAV_WARNING}`,
  inputSchema: { id: z.number().int().describe('Draft document id.'), ...documentInsertShape },
  annotations: issuing,
  handler: async ({ id, ...body }, { client }) =>
    jsonResult(await client.put(`/documents/${String(id)}`, { body })),
});

const finalizeReceiptDraft = defineTool({
  name: 'billingo_finalize_receipt_draft',
  scope: 'write',
  title: 'Finalize draft into a receipt',
  description: `Finalizes an existing draft into a real receipt. This issues the receipt and reports it to NAV — it CANNOT be undone. PUT /documents/receipt/{id} is a full replace, not a partial conversion: the API requires the complete receipt body, not just the id. Fetch the draft first with billingo_get_document, then pass its fields back here — with type changed from "draft" to "receipt" — along with any other changes. ${NAV_WARNING}`,
  inputSchema: { id: z.number().int().describe('Draft document id.'), ...receiptInsertShape },
  annotations: issuing,
  handler: async ({ id, ...body }, { client }) =>
    jsonResult(await client.put(`/documents/receipt/${String(id)}`, { body })),
});

const createFromProforma = defineTool({
  name: 'billingo_create_document_from_proforma',
  scope: 'write',
  title: 'Create invoice from proforma',
  description: `Issues a real invoice from an existing proforma. ${NAV_WARNING}`,
  inputSchema: { id: z.number().int().describe('Proforma document id.') },
  annotations: issuing,
  handler: async ({ id }, { client }) =>
    jsonResult(await client.post(`/documents/${String(id)}/create-from-proforma`)),
});

const copyDocument = defineTool({
  name: 'billingo_copy_document',
  scope: 'write',
  title: 'Copy document',
  description:
    'Copies an existing document into a new one with the same content. Useful for repeating a recurring invoice. If the source document is not a draft, the copy is issued immediately and reported to NAV, exactly like creating that document type — the same irreversibility applies. Confirm the details with the user before calling this.',
  inputSchema: { id: z.number().int().describe('Document id to copy.') },
  annotations: issuing,
  handler: async ({ id }, { client }) =>
    jsonResult(await client.post(`/documents/${String(id)}/copy`)),
});

const createModificationDocument = defineTool({
  name: 'billingo_create_modification_document',
  scope: 'write',
  title: 'Create modification (correction) document',
  description: `Creates a modification document (módosító számla) correcting an existing invoice. Prefer this over a storno when only some details are wrong. ${NAV_WARNING}`,
  inputSchema: {
    id: z.number().int().describe('Id of the document being corrected.'),
    // Per spec components.schemas.ModificationDocumentInsert, this is a much smaller
    // shape than DocumentInsert — no block_id, type, language or currency — and none
    // of its fields are required. The brief spread the full document-creation field
    // set here, which is wrong.
    due_date: isoDate.optional(),
    comment: z.string().optional(),
    payment_method: paymentMethodSchema.optional(),
    without_financial_fulfillment: z.boolean().optional(),
    items: z
      .array(documentItemSchema)
      .optional()
      .describe('Corrected line items, if any are changing.'),
  },
  annotations: issuing,
  handler: async ({ id, ...body }, { client }) =>
    jsonResult(
      await client.post(`/documents/${String(id)}/create-modification-document`, { body }),
    ),
});

const updatePayment = defineTool({
  name: 'billingo_update_payment',
  scope: 'write',
  title: 'Update document payments',
  description:
    'Replaces the payment history of a document. This records money received; it does not issue anything to NAV.',
  inputSchema: {
    id: z.number().int().describe('Document id.'),
    payments: z.array(
      z.object({
        payment_method: paymentMethodSchema,
        // Per spec components.schemas.PaymentHistory, this field is named `date`, not
        // `paid_at` as the brief guessed.
        date: isoDate.describe('Date the payment was made or received.'),
        price: z.number().describe('Amount paid, in the document currency.'),
        voucher_number: z.string().optional(),
      }),
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Per spec, PUT /documents/{id}/payments takes a raw PaymentHistory[] array as the
  // request body — not an object wrapping a "payments" key, as the brief had it.
  handler: async ({ id, payments }, { client }) =>
    jsonResult(await client.put(`/documents/${String(id)}/payments`, { body: payments })),
});

const archiveDocument = defineTool({
  name: 'billingo_archive_document',
  scope: 'write',
  title: 'Archive document',
  description:
    'Archives an existing proforma document. Per the Billingo API, this endpoint is documented for proforma documents only.',
  inputSchema: { id: z.number().int().describe('Document id.') },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async ({ id }, { client }) =>
    jsonResult(await client.put(`/documents/${String(id)}/archive`)),
});

export const documentWriteTools: AnyToolDefinition[] = [
  createDocument,
  createReceipt,
  finalizeDraft,
  finalizeReceiptDraft,
  createFromProforma,
  copyDocument,
  createModificationDocument,
  updatePayment,
  archiveDocument,
];
