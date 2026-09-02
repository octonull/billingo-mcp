// src/tools/documents/destructive.ts
import { z } from 'zod';
import { defineTool, jsonResult } from '../registry.js';
import type { AnyToolDefinition } from '../registry.js';

const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const cancelDocument = defineTool({
  name: 'billingo_cancel_document',
  scope: 'write',
  title: 'Cancel document (storno)',
  description:
    'Issues a storno (cancellation) document that voids an existing invoice. The storno is reported to NAV and CANNOT be undone — if you storno the wrong invoice, the only remedy is to issue a fresh invoice with the same data. If only some details are wrong, prefer billingo_create_modification_document. Always confirm with the user first.',
  inputSchema: { id: z.number().int().describe('Id of the document to cancel.') },
  annotations: destructive,
  handler: async ({ id }, { client }) =>
    jsonResult(await client.post(`/documents/${String(id)}/cancel`)),
});

const sendDocument = defineTool({
  name: 'billingo_send_document',
  scope: 'write',
  title: 'Send document by email',
  description:
    "Emails the document to the given recipients (or to the partner's stored addresses if none are given). This sends real email to real customers and cannot be recalled. Confirm the recipients with the user first.",
  inputSchema: {
    id: z.number().int().describe('Document id.'),
    emails: z
      .array(z.email())
      .optional()
      .describe("Recipients. Omit to use the partner's stored email addresses."),
  },
  annotations: destructive,
  handler: async ({ id, ...body }, { client }) =>
    jsonResult(await client.post(`/documents/${String(id)}/send`, { body })),
});

const deleteDocument = defineTool({
  name: 'billingo_delete_document',
  scope: 'write',
  title: 'Delete document',
  description:
    'Deletes a document. Only drafts and unissued documents can be deleted — an issued invoice cannot be deleted and must be cancelled with billingo_cancel_document instead. Cannot be undone.',
  inputSchema: { id: z.number().int().describe('Document id.') },
  annotations: destructive,
  handler: async ({ id }, { client }) =>
    jsonResult(await client.delete(`/documents/${String(id)}`)),
});

const deletePayment = defineTool({
  name: 'billingo_delete_payment',
  scope: 'write',
  title: 'Delete document payments',
  description: 'Deletes the payment history of a document, marking it unpaid. Cannot be undone.',
  inputSchema: { id: z.number().int().describe('Document id.') },
  annotations: destructive,
  handler: async ({ id }, { client }) =>
    jsonResult(await client.delete(`/documents/${String(id)}/payments`)),
});

export const documentDestructiveTools: AnyToolDefinition[] = [
  cancelDocument,
  sendDocument,
  deleteDocument,
  deletePayment,
];
