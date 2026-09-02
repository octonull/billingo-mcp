// src/transports/http.ts
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { BillingoClient } from '../billingo/client.js';
import { loadHttpConfig, parseBooleanFlag } from '../config.js';
import type { HttpConfig } from '../config.js';
import { createServer } from '../server.js';

export const API_KEY_HEADER = 'x-billingo-api-key';
export const ALLOW_WRITE_HEADER = 'x-billingo-allow-write';

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Builds a fresh McpServer per request. This is the stateless design: the API key and
 * write scope come from this request's headers, so nothing is shared between tenants
 * and no credential outlives the request.
 */
export function createHandler(
  config: HttpConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url?.startsWith('/health') === true) {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.url?.startsWith('/build_version') === true) {
      const buildVer =
        config.commitSha === undefined
          ? 'unknown'
          : config.buildVersion === undefined
            ? config.commitSha
            : `${config.commitSha}@${config.buildVersion}`;
      sendJson(res, 200, { buildVer });
      return;
    }

    const apiKey = readHeader(req, API_KEY_HEADER);
    if (apiKey === undefined || apiKey === '') {
      sendJson(res, 401, {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message:
            'Missing X-Billingo-Api-Key header. Send your Billingo API key with every request.',
        },
        id: null,
      });
      return;
    }

    const allowWrite = parseBooleanFlag(readHeader(req, ALLOW_WRITE_HEADER));
    const client = new BillingoClient({ apiKey, baseUrl: config.baseUrl });
    const server = createServer({ client, allowWrite });
    // sessionIdGenerator is intentionally omitted rather than set to `undefined`: under
    // exactOptionalPropertyTypes, omitting an optional key and assigning it `undefined`
    // are different things to the type checker, and the SDK treats them the same at
    // runtime — "not provided" means stateless mode, which is what we want here.
    const transport = new StreamableHTTPServerTransport({
      ...(config.allowedHosts === undefined
        ? {}
        : { allowedHosts: config.allowedHosts, enableDnsRebindingProtection: true }),
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    // StreamableHTTPServerTransport implements onclose/onerror/onmessage as accessors
    // typed `(() => void) | undefined`, while Transport declares them as plain optional
    // properties (`() => void`). Under exactOptionalPropertyTypes that reads as a real
    // mismatch even though the two are behaviorally identical; StdioServerTransport
    // doesn't hit this because it declares those as plain properties instead.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
  };
}

export async function main(): Promise<void> {
  const config = loadHttpConfig(process.env);
  const handler = createHandler(config);
  const server = createHttpServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(config.port, () => {
      console.error(
        `billingo-mcp: http on :${String(config.port)} (stateless, per-request API key)`,
      );
      resolve();
    });
  });
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
