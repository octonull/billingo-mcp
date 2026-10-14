// src/billingo/schemas.ts
import { z } from 'zod';

/**
 * Output schemas for the read tools, published as each tool's `outputSchema` so hosts
 * that run tools from code (code mode) get typed results instead of `any`.
 *
 * Shaped from live responses (2026-10-14) and checked against the spec. The SDK server
 * validates every result against the schema and turns a mismatch into an error, so a
 * schema that is stricter than the API breaks a call that used to work. The rules:
 *
 * - Every object is `z.looseObject`. A plain `z.object` is published as JSON Schema with
 *   `additionalProperties: false`, and SDK clients validate `structuredContent` against
 *   it, so a field Billingo adds tomorrow would turn every call into an error.
 * - Only `id` (and a list's `data` array) is required: a record without one is not a
 *   record. Every other field is `nullish`, as the spec makes every field optional.
 * - Defensive, not observed in the recorded responses: nested objects also accept `[]`
 *   (PHP serialises an empty associative array that way), numbers also accept numeric
 *   strings, and booleans also accept 0/1.
 * - Only the fields an agent filters or joins on are typed. The schema documents the
 *   shape, it does not police the API.
 */

const nstr = z.string().nullish();
const nnum = z.union([z.number(), z.string()]).nullish();
const nbool = z.union([z.boolean(), z.number()]).nullish();
const emptyArray = z.array(z.unknown()).max(0);

/** A nested object that may be missing, null, or PHP's empty `[]`. */
function nested<T extends z.ZodRawShape>(shape: T) {
  return z.union([z.looseObject(shape), emptyArray]).nullish();
}

const addressShape = {
  country_code: nstr,
  post_code: nstr,
  city: nstr,
  address: nstr,
};

/** Laravel-paginator envelope around a list. */
export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.looseObject({
    data: z.array(item),
    total: nnum,
    per_page: nnum,
    current_page: nnum,
    last_page: nnum,
    prev_page_url: nstr,
    next_page_url: nstr,
  });
}

export const bankAccountSchema = z.looseObject({
  id: z.number(),
  name: nstr,
  account_number: nstr,
  account_number_iban: nstr,
  swift: nstr,
  currency: nstr,
  need_qr: nbool,
});

export const documentBlockSchema = z.looseObject({
  id: z.number(),
  name: nstr,
  prefix: nstr,
  type: nstr,
});

export const partnerSchema = z.looseObject({
  id: z.number(),
  name: nstr,
  address: nested(addressShape),
  emails: z.array(z.string().nullable()).nullish(),
  taxcode: nstr,
  iban: nstr,
  swift: nstr,
  account_number: nstr,
  phone: nstr,
  tax_type: nstr,
});

export const productSchema = z.looseObject({
  id: z.number(),
  name: nstr,
  comment: nstr,
  currency: nstr,
  vat: nstr,
  net_unit_price: nnum,
  gross_unit_price: nnum,
  unit: nstr,
  sku: nstr,
  ean: nstr,
});

export const documentItemSchema = z.looseObject({
  name: nstr,
  quantity: nnum,
  unit: nstr,
  net_unit_amount: nnum,
  net_amount: nnum,
  gross_amount: nnum,
  vat: nstr,
});

export const documentSchema = z.looseObject({
  id: z.number(),
  invoice_number: nstr,
  type: nstr,
  correction_type: nstr,
  cancelled: nbool,
  block_id: nnum,
  payment_status: nstr,
  payment_method: nstr,
  gross_total: nnum,
  currency: nstr,
  conversion_rate: nnum,
  invoice_date: nstr,
  fulfillment_date: nstr,
  due_date: nstr,
  paid_date: nstr,
  partner: nested({ id: nnum, name: nstr, taxcode: nstr }),
  items: z.array(documentItemSchema).nullish(),
  summary: nested({ net_amount: nnum, gross_amount_local: nnum, vat_amount: nnum }),
  online_szamla_status: nstr,
  related_documents: z.array(z.looseObject({ id: nnum, invoice_number: nstr })).nullish(),
});

export const paymentSchema = z.looseObject({
  date: nstr,
  price: nnum,
  payment_method: nstr,
  voucher_number: nstr,
  conversion_rate: nnum,
});

export const spendingSchema = z.looseObject({
  id: z.number(),
  category: nstr,
  invoice_number: nstr,
  currency: nstr,
  conversion_rate: nnum,
  total_gross: nnum,
  total_gross_local: nnum,
  total_vat_amount: nnum,
  total_vat_amount_local: nnum,
  fulfillment_date: nstr,
  invoice_date: nstr,
  due_date: nstr,
  paid_at: nstr,
  payment_method: nstr,
  comment: nstr,
  partner: nested({ id: nnum, name: nstr, tax_code: nstr }),
});

export const organizationSchema = z.looseObject({
  tax_code: nstr,
  has_nav_connection: nbool,
  subscription: nested({ expiration_date: nstr, features: z.array(z.unknown()).nullish() }),
});

/** GET /currencies. `conversation_rate` (sic) is the field name the API uses. */
export const conversionRateSchema = z.looseObject({
  from_currency: nstr,
  to_currency: nstr,
  conversation_rate: nnum,
  date: nstr,
});

export const publicUrlSchema = z.looseObject({ public_url: nstr });

export const onlineSzamlaStatusSchema = z.looseObject({
  transaction_id: nstr,
  status: nstr,
  messages: z
    .array(
      z.looseObject({
        validation_result_code: nstr,
        validation_error_code: nstr,
        human_readable_message: nstr,
      }),
    )
    .nullish(),
});

export const remindersSchema = z.looseObject({
  sent_reminders: z.array(z.unknown()).nullish(),
  upcoming_reminders: z.array(z.unknown()).nullish(),
  sent_postal_mail: z.array(z.unknown()).nullish(),
});

/** The payments endpoint returns a bare array; structured content wraps it. */
export const paymentsResultSchema = z.looseObject({ payments: z.array(paymentSchema) });
