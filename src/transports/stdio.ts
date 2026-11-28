// src/transports/stdio.ts
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { McpServer } from '@modelcontextprotocol/server';
import { BillingoClient } from '../billingo/client.js';
import { loadStdioConfig } from '../config.js';
import { createServer, tenantId } from '../server.js';
import { DuplicateGuard } from '../tools/safeguards.js';

/**
 * Reads the stdio config and returns a factory for the server, not the server itself:
 * `serveStdio` asks for an instance per connection (and one more for a 2026-07-28
 * `server/discover` probe that it may discard), so it needs to be able to build one.
 */
export function buildStdioServer(env: NodeJS.ProcessEnv): {
  createServer: () => McpServer;
  allowWrite: boolean;
} {
  const config = loadStdioConfig(env);
  const client = new BillingoClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  // One guard for the process, shared by every server instance serveStdio builds.
  const duplicateGuard = new DuplicateGuard();
  const tenant = tenantId(config.apiKey);
  return {
    createServer: () =>
      createServer({
        client,
        allowWrite: config.allowWrite,
        categories: config.categories,
        confirmWrites: config.confirmWrites,
        duplicateGuard,
        tenant,
      }),
    allowWrite: config.allowWrite,
  };
}

export function main(): Promise<void> {
  const { createServer: factory, allowWrite } = buildStdioServer(process.env);
  // stdout carries the protocol — every diagnostic must go to stderr.
  console.error(`billingo-mcp: stdio, ${allowWrite ? 'read/write' : 'read-only'} mode`);
  // serveStdio picks the protocol era from the client's opening message: a 2026-07-28
  // client gets the stateless revision, a 2025-era client the `initialize` handshake.
  serveStdio(factory, {
    onerror: (error) => {
      console.error(`billingo-mcp: ${error.message}`);
    },
  });
  return Promise.resolve();
}
