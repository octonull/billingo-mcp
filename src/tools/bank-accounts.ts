// src/tools/bank-accounts.ts
import { z } from 'zod';
import { bankAccountSchema, paginatedSchema } from '../billingo/schemas.js';
import { currencySchema } from '../billingo/enums.js';
import { pageParamsShape, summarizePage } from '../billingo/pagination.js';
import type { Paginated } from '../billingo/pagination.js';
import { patchDescription, patchRecord, patchShape } from './merge.js';
import { defineTool, jsonResult } from './registry.js';
import type { AnyToolDefinition } from './registry.js';

/**
 * Matches components.schemas.BankAccount.required: name, account_number, currency are
 * all required to create an account — an earlier draft of this tool made account_number
 * optional, which the API would just reject with a 422.
 */
const bankAccountFields = {
  name: z.string().min(1).describe('Display name of the account, e.g. "OTP HUF".'),
  account_number: z.string().min(1).describe('Domestic account number.'),
  currency: currencySchema,
  account_number_iban: z.string().optional().describe('IBAN.'),
  swift: z.string().optional(),
};

const listBankAccounts = defineTool({
  name: 'billingo_list_bank_accounts',
  scope: 'read',
  title: 'List bank accounts',
  description: 'Lists the bank accounts configured on the organization.',
  inputSchema: { ...pageParamsShape },
  outputSchema: paginatedSchema(bankAccountSchema),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ page, per_page }, { client }) => {
    const result = await client.get<Paginated<unknown>>('/bank-accounts', {
      query: { page, per_page },
    });
    return jsonResult(result, summarizePage(result));
  },
});

const getBankAccount = defineTool({
  name: 'billingo_get_bank_account',
  scope: 'read',
  title: 'Get bank account',
  description: 'Returns a single bank account by id.',
  inputSchema: { id: z.number().int().describe('Bank account id.') },
  outputSchema: bankAccountSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ id }, { client }) =>
    jsonResult(await client.get(`/bank-accounts/${String(id)}`)),
});

const createBankAccount = defineTool({
  name: 'billingo_create_bank_account',
  scope: 'write',
  title: 'Create bank account',
  description: 'Adds a bank account to the organization. Nothing is issued or reported to NAV.',
  inputSchema: bankAccountFields,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, { client }) =>
    jsonResult(await client.post('/bank-accounts', { body: args })),
});

/** Writable fields of components.schemas.BankAccount (need_qr is deprecated and left out). */
const BANK_ACCOUNT_WRITABLE = [
  'name',
  'account_number',
  'account_number_iban',
  'swift',
  'currency',
] as const;

const updateBankAccount = defineTool({
  name: 'billingo_update_bank_account',
  scope: 'write',
  title: 'Update bank account',
  description: patchDescription('bank account'),
  inputSchema: {
    id: z.number().int().describe('Bank account id.'),
    ...patchShape(bankAccountFields),
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
        { path: `/bank-accounts/${String(id)}`, writable: BANK_ACCOUNT_WRITABLE },
        patch,
      ),
    ),
});

const deleteBankAccount = defineTool({
  name: 'billingo_delete_bank_account',
  scope: 'write',
  title: 'Delete bank account',
  description:
    'Deletes a bank account from the organization. Cannot be undone. Does not affect invoices already issued with this account.',
  inputSchema: { id: z.number().int().describe('Bank account id.') },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async ({ id }, { client }) =>
    jsonResult(await client.delete(`/bank-accounts/${String(id)}`)),
});

export const bankAccountTools: AnyToolDefinition[] = [
  listBankAccounts,
  getBankAccount,
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
];
