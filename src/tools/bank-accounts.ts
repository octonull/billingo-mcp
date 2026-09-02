// src/tools/bank-accounts.ts
import { z } from 'zod';
import { currencySchema } from '../billingo/enums.js';
import { pageParamsShape, summarizePage } from '../billingo/pagination.js';
import type { Paginated } from '../billingo/pagination.js';
import { defineTool, jsonResult } from './registry.js';
import type { AnyToolDefinition } from './registry.js';

/**
 * Matches components.schemas.BankAccount.required: name, account_number, currency are
 * all required to create an account — an earlier draft of this tool made account_number
 * optional, which the API would just reject with a 422.
 */
const bankAccountFields = {
  name: z.string().min(1).describe('Display name of the account, e.g. "OTP HUF".'),
  account_number: z.string().min(1).describe('Domestic account number. Required.'),
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

const updateBankAccount = defineTool({
  name: 'billingo_update_bank_account',
  scope: 'write',
  title: 'Update bank account',
  description:
    'Replaces an existing bank account. PUT is a full update, not a patch: the API re-validates the entire required field set (name, account_number, currency) on every call, even for attributes you are not changing — sending only the changed fields (e.g. just { name }) will fail with a 422. To update safely: call billingo_get_bank_account first, merge your changes into the full record, and send that complete result here.',
  inputSchema: {
    id: z.number().int().describe('Bank account id.'),
    ...bankAccountFields,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async ({ id, ...body }, { client }) =>
    jsonResult(await client.put(`/bank-accounts/${String(id)}`, { body })),
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
