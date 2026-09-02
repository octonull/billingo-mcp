// src/tools/registry.ts
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodRawShape } from 'zod';
import type { BillingoClient } from '../billingo/client.js';

export type ToolScope = 'read' | 'write';

export interface ToolContext {
  client: BillingoClient;
  /** Injectable so tests do not wait. Defaults applied by consumers. */
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
}

export interface ToolDefinition<TShape extends ZodRawShape> {
  name: string;
  /** 'write' tools are omitted from tools/list unless the caller opts in. */
  scope: ToolScope;
  title: string;
  description: string;
  inputSchema: TShape;
  annotations: ToolAnnotations;
  /**
   * Declared with method-shorthand syntax (not `handler: (args) => ...`) so TypeScript
   * checks `args` bivariantly. That lets each domain tool's `ToolDefinition<TShape>` be
   * cast to `AnyToolDefinition` for storage in a homogeneous array.
   */
  handler(args: z.infer<z.ZodObject<TShape>>, ctx: ToolContext): Promise<CallToolResult>;
}

/** Identity function that pins the generic, so each tool's args type is inferred. */
export function defineTool<TShape extends ZodRawShape>(
  def: ToolDefinition<TShape>,
): ToolDefinition<TShape> {
  return def;
}

export type AnyToolDefinition = ToolDefinition<ZodRawShape>;

/**
 * Read-only is the default. Write tools are filtered out here — not rejected at call
 * time — so a model without the write scope never learns they exist.
 */
export function filterByScope(
  tools: AnyToolDefinition[],
  allowWrite: boolean,
): AnyToolDefinition[] {
  if (allowWrite) return [...tools];
  return tools.filter((tool) => tool.scope === 'read');
}

/**
 * A successful result. The optional summary is emitted first, as models read top-down.
 *
 * `value` is `null` whenever BillingoClient saw a 204 (or another empty-bodied success) —
 * e.g. most delete tools and billingo_archive_document, all of which the spec documents
 * as returning 204. Serializing that as JSON would print the literal text "null", which
 * a model cannot distinguish from "the operation produced no meaningful result" vs.
 * "something went wrong" — it has already seen "null" used both ways elsewhere. Spell
 * out success explicitly instead.
 */
export function jsonResult(value: unknown, summary?: string): CallToolResult {
  const content: CallToolResult['content'] = [];
  if (summary !== undefined) content.push({ type: 'text', text: summary });
  const text =
    value === null
      ? 'Success. The API returned no content (empty body).'
      : JSON.stringify(value, null, 2);
  content.push({ type: 'text', text });
  return { content };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
