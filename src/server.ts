// src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BillingoError } from './billingo/errors.js';
import type { BillingoClient } from './billingo/client.js';
import { errorResult, filterByScope } from './tools/registry.js';
import type { AnyToolDefinition, ToolContext } from './tools/registry.js';
import { allTools } from './tools/index.js';

export interface CreateServerOptions {
  client: BillingoClient;
  /** When false, write tools are never registered — the model cannot see them. */
  allowWrite: boolean;
}

/**
 * An API failure is a normal outcome the model should see and reason about, not a
 * transport-level crash. Anything unexpected still propagates.
 */
async function runTool(
  tool: AnyToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  try {
    return await tool.handler(args, ctx);
  } catch (error) {
    if (error instanceof BillingoError) return errorResult(error.message);
    throw error;
  }
}

export function createServer({ client, allowWrite }: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: 'billingo', version: '0.1.0' },
    {
      instructions:
        'Tools for the Billingo invoicing API. Issued invoices are reported to NAV automatically and cannot be undone — always confirm details with the user before creating, finalizing, cancelling or sending a document. If write tools are absent, the server is in read-only mode and the user must enable writes themselves.',
    },
  );

  const ctx: ToolContext = { client };

  for (const tool of filterByScope(allTools, allowWrite)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => runTool(tool, args, ctx),
    );
  }

  return server;
}
