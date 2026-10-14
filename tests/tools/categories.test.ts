// tests/tools/categories.test.ts
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BillingoClient } from '../../src/billingo/client.js';
import { createServer } from '../../src/server.js';
import {
  allTools,
  parseToolCategories,
  TOOL_CATEGORIES,
  toolsByCategory,
  toolsInCategories,
} from '../../src/tools/index.js';
import type { ToolCategory } from '../../src/tools/index.js';

async function listTools(allowWrite: boolean, categories?: ToolCategory[]) {
  const billingo = new BillingoClient({ apiKey: 'k', sleep: async () => {} });
  const server = createServer({ client: billingo, allowWrite, categories });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  return { names: tools.map((t) => t.name), instructions: client.getInstructions() ?? '' };
}

describe('tool categories', () => {
  it('put every tool in exactly one category', () => {
    const seen = TOOL_CATEGORIES.flatMap((c) => toolsByCategory[c].map((t) => t.name));
    expect(seen).toHaveLength(allTools.length);
    expect(new Set(seen).size).toBe(allTools.length);
  });

  it('are the seven parts of Billingo, in a stable order', () => {
    expect(TOOL_CATEGORIES).toEqual([
      'organization',
      'partners',
      'products',
      'spendings',
      'bank_accounts',
      'document_blocks',
      'documents',
    ]);
  });

  it('select every tool when none is given, and only the asked groups otherwise', () => {
    expect(toolsInCategories(undefined)).toBe(allTools);
    const names = toolsInCategories(['partners']).map((t) => t.name);
    expect(names.every((n) => n.includes('partner'))).toBe(true);
    expect(names).toHaveLength(toolsByCategory.partners.length);
  });
});

describe('parseToolCategories', () => {
  it('reads a comma-separated list, trimming, lowercasing and de-duplicating', () => {
    expect(parseToolCategories(' Documents, partners ,documents')).toEqual([
      'documents',
      'partners',
    ]);
  });

  it('treats absent, empty, blank or separators-only as "all"', () => {
    expect(parseToolCategories(undefined)).toBeUndefined();
    expect(parseToolCategories('')).toBeUndefined();
    expect(parseToolCategories('  ')).toBeUndefined();
    // Never an empty list: that would register no tools at all.
    expect(parseToolCategories(',')).toBeUndefined();
    expect(parseToolCategories(' , ')).toBeUndefined();
  });

  it('rejects an unknown name and lists the valid ones — a typo must not load everything', () => {
    expect(() => parseToolCategories('documents,invoices')).toThrow(
      /invoices.*Valid: organization/,
    );
  });
});

describe('createServer with categories', () => {
  it('lists only the read tools of the chosen groups in read-only mode', async () => {
    const { names } = await listTools(false, ['documents']);
    const expected = toolsByCategory.documents.filter((t) => t.scope === 'read').map((t) => t.name);
    expect(names.sort()).toEqual(expected.sort());
  });

  it('adds the write tools of those groups, and only those, when writes are allowed', async () => {
    const { names } = await listTools(true, ['partners', 'products']);
    const expected = [...toolsByCategory.partners, ...toolsByCategory.products].map((t) => t.name);
    expect(names.sort()).toEqual(expected.sort());
  });

  it('lists all 22 read tools when no category is given, in the same order as before', async () => {
    const { names } = await listTools(false);
    expect(names).toEqual(allTools.filter((t) => t.scope === 'read').map((t) => t.name));
    expect(names).toHaveLength(22);
  });

  it('tells the model which groups are loaded, so it can say what is missing', async () => {
    const limited = await listTools(false, ['documents', 'partners']);
    expect(limited.instructions).toContain('only these tool groups: documents, partners');
    const full = await listTools(false);
    expect(full.instructions).not.toContain('tool groups');
  });
});
