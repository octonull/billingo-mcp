#!/usr/bin/env node
// src/transports/stdio.ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BillingoClient } from '../billingo/client.js';
import { loadStdioConfig } from '../config.js';
import { createServer } from '../server.js';

export function buildStdioServer(env: NodeJS.ProcessEnv): {
  server: McpServer;
  allowWrite: boolean;
} {
  const config = loadStdioConfig(env);
  const client = new BillingoClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  return {
    server: createServer({ client, allowWrite: config.allowWrite }),
    allowWrite: config.allowWrite,
  };
}

export async function main(): Promise<void> {
  const { server, allowWrite } = buildStdioServer(process.env);
  // stdout carries the protocol — every diagnostic must go to stderr.
  console.error(`billingo-mcp: stdio, ${allowWrite ? 'read/write' : 'read-only'} mode`);
  await server.connect(new StdioServerTransport());
}

// Only run when executed directly, so importing this module in tests starts nothing.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
