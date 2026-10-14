// src/tools/products.ts
import { z } from 'zod';
import { BillingoArgumentError } from '../billingo/errors.js';
import { paginatedSchema, productSchema } from '../billingo/schemas.js';
import { currencySchema, vatSchema } from '../billingo/enums.js';
import { pageParamsShape, summarizePage } from '../billingo/pagination.js';
import type { Paginated } from '../billingo/pagination.js';
import { patchDescription, patchRecord, patchShape } from './merge.js';
import { defineTool, jsonResult } from './registry.js';
import type { AnyToolDefinition } from './registry.js';

const productFields = {
  name: z.string().min(1).describe('Product or service name, as it appears on the invoice.'),
  comment: z.string().optional(),
  net_unit_price: z
    .number()
    .optional()
    .describe('Net unit price. Give this or gross_unit_price, not both.'),
  gross_unit_price: z
    .number()
    .optional()
    .describe(
      'Gross unit price, for prices quoted with VAT. Give this or net_unit_price, not both.',
    ),
  currency: currencySchema.optional(),
  vat: vatSchema
    .optional()
    .describe(
      'VAT rate. Percentages use a comma for decimals ("25,5%"). Hungarian special codes such as AAM, TAM, EU are also valid.',
    ),
  unit: z.string().optional().describe('Unit of measure, e.g. "db", "óra", "hó".'),
  entitlement: z.string().optional(),
  general_ledger_number: z.string().optional(),
  // Verified live 2026-10-14: a product PUT that leaves out sku, ean,
  // general_ledger_taxcode and purchase_price clears them. The update tool keeps them by
  // reading the product first (src/tools/merge.ts); these fields let a caller set and
  // change them.
  general_ledger_taxcode: z.string().optional(),
  sku: z.string().optional().describe('Stock-keeping unit (cikkszám).'),
  ean: z.string().optional().describe('EAN barcode.'),
  purchase_price: z.number().optional().describe('Purchase (cost) price.'),
};

const listProducts = defineTool({
  name: 'billingo_list_products',
  scope: 'read',
  title: 'List products',
  description: 'Lists products and services from the product catalogue.',
  inputSchema: {
    ...pageParamsShape,
    query: z.string().optional().describe('Free-text search over the product name.'),
  },
  outputSchema: paginatedSchema(productSchema),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ page, per_page, query }, { client }) => {
    const result = await client.get<Paginated<unknown>>('/products', {
      query: { page, per_page, query },
    });
    return jsonResult(result, summarizePage(result));
  },
});

const getProduct = defineTool({
  name: 'billingo_get_product',
  scope: 'read',
  title: 'Get product',
  description: 'Returns a single product by id.',
  inputSchema: { id: z.number().int().describe('Product id.') },
  outputSchema: productSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ id }, { client }) => jsonResult(await client.get(`/products/${String(id)}`)),
});

const getProductQuantity = defineTool({
  name: 'billingo_get_product_quantity',
  scope: 'read',
  title: 'Get product stock quantity',
  description: 'Returns the current inventory quantity for a product.',
  inputSchema: { id: z.number().int().describe('Product id.') },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ id }, { client }) =>
    jsonResult(await client.get(`/inventory/product/${String(id)}/quantity`)),
});

const createProduct = defineTool({
  name: 'billingo_create_product',
  scope: 'write',
  title: 'Create product',
  description: 'Creates a product in the catalogue. Does not issue anything to NAV.',
  inputSchema: productFields,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, { client }) => jsonResult(await client.post('/products', { body: args })),
});

/** Writable fields of components.schemas.Product, the body PUT /products/{id} takes. */
const PRODUCT_WRITABLE = [
  'name',
  'comment',
  'currency',
  'vat',
  'net_unit_price',
  'gross_unit_price',
  'unit',
  'general_ledger_number',
  'general_ledger_taxcode',
  'entitlement',
  'ean',
  'sku',
  'is_manage',
  'purchase_price',
  'is_generate_erase_code',
  'connect_product_id',
  'apply_discount',
  'apply_quantity',
  'is_connect_product',
  'is_deposit_fee',
] as const;

/**
 * A product reads back with both prices, but a PUT may carry only one (verified live
 * 2026-10-14: "You must specify only one price (net_unit_price or gross_unit_price)").
 * Send the price the caller changed: a price equal to the stored one is not a change,
 * so a record read back and edited in one price works. Two changed prices conflict and
 * are refused rather than one being dropped. With a new vat and only a gross price given,
 * the gross price is kept (a VAT-inclusive price). Otherwise the stored net price is sent
 * (the gross one when there is no net price), so the net price stays fixed.
 */
function onePrice(
  body: Record<string, unknown>,
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const { net_unit_price: net, gross_unit_price: gross, ...rest } = body;
  const given = (key: string) => patch[key] !== undefined && patch[key] !== null;
  // Numbers compare by value, so a price read back as "1270.00" still equals 1270.
  const same = (a: unknown, b: unknown) =>
    a === b || (a !== '' && b !== '' && a !== null && b !== null && Number(a) === Number(b));
  const changed = (key: string) => given(key) && !same(patch[key], current[key]);
  if (changed('net_unit_price') && changed('gross_unit_price')) {
    throw new BillingoArgumentError(
      'Give a new net_unit_price or a new gross_unit_price, not both: Billingo stores one price and derives the other from the VAT rate.',
    );
  }
  if (changed('gross_unit_price')) return { ...rest, gross_unit_price: gross };
  if (changed('net_unit_price')) return { ...rest, net_unit_price: net };
  if (changed('vat') && given('gross_unit_price') && !given('net_unit_price')) {
    return { ...rest, gross_unit_price: gross };
  }
  return net === undefined
    ? { ...rest, gross_unit_price: gross }
    : { ...rest, net_unit_price: net };
}

const updateProduct = defineTool({
  name: 'billingo_update_product',
  scope: 'write',
  title: 'Update product',
  description: `${patchDescription('product')} Give a new price as net_unit_price or gross_unit_price, not both. A new vat keeps the net price, so the gross price changes with it (a product stored with only a gross price keeps that one); to keep a VAT-inclusive price, send the new vat together with gross_unit_price (and no net_unit_price).`,
  inputSchema: {
    id: z.number().int().describe('Product id.'),
    ...patchShape(productFields),
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
        { path: `/products/${String(id)}`, writable: PRODUCT_WRITABLE, finalize: onePrice },
        patch,
      ),
    ),
});

const deleteProduct = defineTool({
  name: 'billingo_delete_product',
  scope: 'write',
  title: 'Delete product',
  description:
    'Deletes a product from the catalogue. Cannot be undone. Does not affect invoices already issued with this product.',
  inputSchema: { id: z.number().int().describe('Product id.') },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async ({ id }, { client }) => jsonResult(await client.delete(`/products/${String(id)}`)),
});

export const productTools: AnyToolDefinition[] = [
  listProducts,
  getProduct,
  getProductQuantity,
  createProduct,
  updateProduct,
  deleteProduct,
];
