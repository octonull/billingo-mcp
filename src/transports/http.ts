// src/transports/http.ts
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostHeaderValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { BillingoClient } from '../billingo/client.js';
import { loadHttpConfig, parseBooleanFlag, parseOptOutFlag } from '../config.js';
import type { HttpConfig } from '../config.js';
import { createServer, tenantId } from '../server.js';
import { DuplicateGuard } from '../tools/safeguards.js';
import { parseToolCategories } from '../tools/index.js';
import type { ToolCategory } from '../tools/index.js';

export const API_KEY_HEADER = 'x-billingo-api-key';
export const ALLOW_WRITE_HEADER = 'x-billingo-allow-write';
export const TOOL_CATEGORIES_HEADER = 'x-billingo-tool-categories';
/** "false" turns off the confirmation form for irreversible writes (on by default). */
export const CONFIRM_WRITES_HEADER = 'x-billingo-confirm-writes';
/** Same list as the header, for clients that can set a URL but not a header. */
export const TOOL_CATEGORIES_QUERY = 'categories';

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** What one request's headers resolved to, carried to the server factory. */
interface TenantSettings {
  allowWrite: boolean;
  categories: ToolCategory[] | undefined;
  confirmWrites: boolean;
}

/**
 * `BILLINGO_ALLOWED_HOSTS` entries may carry a port (`localhost:3000`), as the v1 SDK
 * compared whole `Host` values. The v2 guard compares hostnames only, so drop the port.
 */
export function hostnameOf(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0] ?? host;
}

/**
 * The stateless design: every request builds its own McpServer from that request's
 * headers, so nothing is shared between tenants and no credential outlives the request.
 *
 * The headers are checked here, in front of the MCP handler, and handed to the server
 * factory as `req.auth` (`toNodeHandler` passes it through as `authInfo`). Whatever a
 * client sends, `req.auth` is overwritten before the handler runs.
 *
 * `createMcpHandler` serves both protocol eras on one endpoint: 2026-07-28 requests
 * (which carry their protocol version in `_meta`) and 2025-era clients, which it answers
 * through the stateless legacy path, one fresh server per request, as before.
 */
export function createHandler(
  config: HttpConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  // Every request gets a fresh server, so the memory of recent calls lives here, shared
  // by all requests of this process and keyed by a hash of each API key.
  const duplicateGuard = new DuplicateGuard();
  const mcp = toNodeHandler(
    createMcpHandler(({ authInfo }) => {
      const tenant = authInfo?.extra as TenantSettings | undefined;
      if (authInfo === undefined || tenant === undefined) {
        // Unreachable through createHandler, which always sets req.auth first.
        throw new Error('billingo-mcp: request reached the MCP handler without an API key');
      }
      return createServer({
        client: new BillingoClient({ apiKey: authInfo.token, baseUrl: config.baseUrl }),
        allowWrite: tenant.allowWrite,
        categories: tenant.categories,
        confirmWrites: tenant.confirmWrites,
        duplicateGuard,
        tenant: tenantId(authInfo.token),
      });
    }),
  );
  const validateHost =
    config.allowedHosts === undefined
      ? undefined
      : hostHeaderValidation(config.allowedHosts.map(hostnameOf));

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

    // DNS-rebinding protection: answers 403 itself when the Host is not allowed.
    if (validateHost !== undefined && !validateHost(req, res)) return;

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

    let categories: ToolCategory[] | undefined;
    try {
      const fromQuery = new URL(req.url ?? '/', 'http://localhost').searchParams.get(
        TOOL_CATEGORIES_QUERY,
      );
      // The header wins when it holds a value; an empty header falls back to the query.
      const fromHeader = readHeader(req, TOOL_CATEGORIES_HEADER);
      categories = parseToolCategories(
        fromHeader !== undefined && fromHeader.trim() !== ''
          ? fromHeader
          : (fromQuery ?? undefined),
      );
    } catch (error) {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
        id: null,
      });
      return;
    }

    const tenant: TenantSettings = {
      allowWrite: parseBooleanFlag(readHeader(req, ALLOW_WRITE_HEADER)),
      categories,
      confirmWrites: parseOptOutFlag(readHeader(req, CONFIRM_WRITES_HEADER)),
    };
    const auth: AuthInfo = {
      token: apiKey,
      clientId: 'billingo-api-key',
      scopes: [],
      extra: { ...tenant },
    };
    // A server-side IncomingMessage always has a method and url (they are only undefined
    // on a client-side message), but its type says otherwise and the adapter's does not.
    const withAuth = req as IncomingMessage & { method: string; url: string; auth?: AuthInfo };
    withAuth.auth = auth;
    await mcp(withAuth, res);
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
