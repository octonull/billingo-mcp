// src/tools/index.ts
import { bankAccountTools } from './bank-accounts.js';
import { documentBlockTools } from './document-blocks.js';
import { documentDestructiveTools } from './documents/destructive.js';
import { documentExportTools } from './documents/export.js';
import { documentReadTools } from './documents/read.js';
import { documentWriteTools } from './documents/write.js';
import { organizationTools } from './organization.js';
import { partnerTools } from './partners.js';
import { productTools } from './products.js';
import { spendingTools } from './spendings.js';
import type { AnyToolDefinition } from './registry.js';

/**
 * Tools grouped by the part of Billingo they work on. A connection can load only the
 * groups it needs, so a host that puts every tool schema into the prompt is not handed
 * all 49 when it only issues invoices.
 */
export const toolsByCategory = {
  organization: organizationTools,
  partners: partnerTools,
  products: productTools,
  spendings: spendingTools,
  bank_accounts: bankAccountTools,
  document_blocks: documentBlockTools,
  documents: [
    ...documentReadTools,
    ...documentWriteTools,
    ...documentExportTools,
    ...documentDestructiveTools,
  ],
} satisfies Record<string, AnyToolDefinition[]>;

export type ToolCategory = keyof typeof toolsByCategory;

export const TOOL_CATEGORIES = Object.keys(toolsByCategory) as ToolCategory[];

/** Every tool the server can offer: 22 read, 27 write. */
export const allTools: AnyToolDefinition[] = TOOL_CATEGORIES.flatMap((c) => toolsByCategory[c]);

/** The tools of the given categories, in catalogue order; every tool when none is given. */
export function toolsInCategories(
  categories: readonly ToolCategory[] | undefined,
): AnyToolDefinition[] {
  if (categories === undefined) return allTools;
  const wanted = new Set(categories);
  return TOOL_CATEGORIES.filter((c) => wanted.has(c)).flatMap((c) => toolsByCategory[c]);
}

/**
 * Parses a comma-separated category list (e.g. "documents,partners"). Unknown names are
 * an error, never silently dropped: a typo must not quietly hide the tools a user asked
 * for or, worse, fall back to loading everything. Empty or whitespace means "all".
 */
export function parseToolCategories(raw: string | undefined): ToolCategory[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const names = raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  // A list of separators only (",", " , ") names no group: treat it as unset, not as
  // "load nothing", which would leave the server with no tools at all.
  if (names.length === 0) return undefined;
  const unknown = names.filter((name) => !(TOOL_CATEGORIES as string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown tool categor${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}. Valid: ${TOOL_CATEGORIES.join(', ')}.`,
    );
  }
  return [...new Set(names)] as ToolCategory[];
}
