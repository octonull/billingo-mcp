// src/tools/products.ts
import { z } from 'zod';
import { currencySchema, vatSchema } from '../billingo/enums.js';
import { pageParamsShape, summarizePage } from '../billingo/pagination.js';
import type { Paginated } from '../billingo/pagination.js';
import { defineTool, jsonResult } from './registry.js';
import type { AnyToolDefinition } from './registry.js';

const productFields = {
  name: z.string().min(1).describe('Product or service name, as it appears on the invoice.'),
  comment: z.string().optional(),
  net_unit_price: z.number().optional().describe('Net unit price.'),
  currency: currencySchema.optional(),
  vat: vatSchema
    .optional()
    .describe(
      'VAT rate. Percentages use a comma for decimals ("25,5%"). Hungarian special codes such as AAM, TAM, EU are also valid.',
    ),
  unit: z.string().optional().describe('Unit of measure, e.g. "db", "óra", "hó".'),
  entitlement: z.string().optional(),
  general_ledger_number: z.string().optional(),
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

/**
 * PUT /products/{id} uses the same components.schemas.Product as POST /products, whose
 * required set is [name, currency, vat, unit] (spec/billingo-3.0.15.json) — confirmed live
 * 2026-07-17: a PUT with only {"name": "renamed"} 422s asking for currency, unit and vat.
 * So update must require them too, even though productFields (shared with create) leaves
 * them optional there.
 */
const updateProduct = defineTool({
  name: 'billingo_update_product',
  scope: 'write',
  title: 'Update product',
  description:
    'Replaces an existing product. PUT is a full update, not a patch: the API re-validates the entire required field set (name, currency, vat, unit) on every call, even for attributes you are not changing — sending only the changed fields (e.g. just { name }) will fail with a 422. To update safely: call billingo_get_product first, merge your changes into the full record, and send that complete result here.',
  inputSchema: {
    id: z.number().int().describe('Product id.'),
    ...productFields,
    currency: currencySchema.describe(
      'Currency. Required on update — PUT replaces the whole product.',
    ),
    vat: vatSchema.describe(
      'VAT rate. Percentages use a comma for decimals ("25,5%"). Hungarian special codes such as AAM, TAM, EU are also valid. Required on update — PUT replaces the whole product.',
    ),
    unit: z
      .string()
      .min(1)
      .describe(
        'Unit of measure, e.g. "db", "óra", "hó". Required on update — PUT replaces the whole product.',
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async ({ id, ...body }, { client }) =>
    jsonResult(await client.put(`/products/${String(id)}`, { body })),
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
