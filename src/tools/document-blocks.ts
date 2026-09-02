// src/tools/document-blocks.ts
import { z } from 'zod';
import { pageParamsShape, summarizePage } from '../billingo/pagination.js';
import type { Paginated } from '../billingo/pagination.js';
import { defineTool, jsonResult } from './registry.js';
import type { AnyToolDefinition } from './registry.js';

const listDocumentBlocks = defineTool({
  name: 'billingo_list_document_blocks',
  scope: 'read',
  title: 'List document blocks',
  description:
    'Lists document blocks (invoice number ranges). Every document belongs to a block; you need a block id to create an invoice.',
  inputSchema: { ...pageParamsShape },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async ({ page, per_page }, { client }) => {
    const result = await client.get<Paginated<unknown>>('/document-blocks', {
      query: { page, per_page },
    });
    return jsonResult(result, summarizePage(result));
  },
});

const createDocumentBlock = defineTool({
  name: 'billingo_create_document_block',
  scope: 'write',
  title: 'Create document block',
  description:
    'Creates a new document block (invoice number range). Blocks are long-lived configuration — create one only when the user explicitly wants a separate numbering range.',
  inputSchema: {
    name: z.string().min(1).describe('Block name.'),
    prefix: z.string().optional().describe('Invoice number prefix for this block.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, { client }) =>
    jsonResult(await client.post('/document-blocks', { body: args })),
});

export const documentBlockTools: AnyToolDefinition[] = [listDocumentBlocks, createDocumentBlock];
