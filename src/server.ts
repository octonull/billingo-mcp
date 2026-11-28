// src/server.ts
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  acceptedContent,
  inputRequired,
  inputResponse,
} from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
  ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DuplicateGuard, SAFEGUARDS } from './tools/safeguards.js';
import { BillingoError, describeError } from './billingo/errors.js';
import type { BillingoClient } from './billingo/client.js';
import { errorResult, filterByScope } from './tools/registry.js';
import type { AnyToolDefinition, ToolContext } from './tools/registry.js';
import { toolsInCategories } from './tools/index.js';
import type { ToolCategory } from './tools/index.js';

/**
 * The version reported in `initialize` (`serverInfo.version`), read from package.json so
 * it follows every release instead of a hard-coded string. package.json sits one level
 * above this file in every layout: `src/` (tests), `dist/` (npm package, Docker image).
 */
export const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export interface CreateServerOptions {
  client: BillingoClient;
  /** When false, write tools are never registered — the model cannot see them. */
  allowWrite: boolean;
  /** Only these tool groups are registered. Undefined registers every group. */
  categories?: readonly ToolCategory[] | undefined;
  /**
   * Ask the user to confirm irreversible writes on clients that support elicitation
   * (see src/tools/safeguards.ts). Default true.
   */
  confirmWrites?: boolean | undefined;
  /**
   * Shared memory of recent non-repeatable calls. The HTTP transport passes one guard
   * for the whole process (each request gets a fresh server); without one, the server
   * keeps its own.
   */
  duplicateGuard?: DuplicateGuard | undefined;
  /** Separates tenants in the duplicate guard. See tenantId. */
  tenant?: string | undefined;
}

/** A stable, non-reversible tenant id for an API key, so the key itself is never kept as a map key. */
export function tenantId(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 32);
}

const CONFIRM_KEY = 'confirm';
const confirmSchema = z.object({
  confirm: z.boolean().default(true).describe('Go ahead'),
});

/** Added to the input schema of every tool with `dedupe` (see src/tools/safeguards.ts). */
const ALLOW_DUPLICATE = 'allow_duplicate';
const allowDuplicateSchema = z
  .boolean()
  .optional()
  .describe(
    'Set to true only when the user really wants a second, identical call: an identical call made in the last 10 minutes (for example a retry after a dropped connection) is otherwise refused, so a document is never issued twice by accident.',
  );

/**
 * Whether the client can show an elicitation form. A 2026-07-28 request carries the
 * client's capabilities itself; a 2025-era one relies on the initialize handshake of this
 * server instance (stdio). A 2025-era stateless HTTP request has neither and cannot be
 * asked anything, so it proceeds as before.
 */
function canElicit(server: McpServer, mcpCtx: ServerContext): boolean {
  // The envelope's public type hides its wire keys; on 2026-07-28 requests it carries the
  // client's declared capabilities under the spec's reserved _meta key.
  const envelope = mcpCtx.mcpReq.envelope as
    Record<string, ClientCapabilities | undefined> | undefined;
  const capabilities =
    envelope?.[CLIENT_CAPABILITIES_META_KEY] ??
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the source on 2025-era stdio connections; backfilled per request on HTTP
    server.server.getClientCapabilities();
  const elicitation = capabilities?.elicitation;
  if (elicitation === undefined) return false;
  // An empty `elicitation: {}` means form mode (the 2025-06-18 shape).
  return elicitation.form !== undefined || elicitation.url === undefined;
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
  let result: CallToolResult;
  try {
    result = await tool.handler(args, ctx);
  } catch (error) {
    if (error instanceof BillingoError) {
      const idempotent = tool.annotations.idempotentHint === true;
      return errorResult(error.message, describeError(error, { idempotent }));
    }
    throw error;
  }
  if (result.isError === true) return result;
  if (tool.outputSchema === undefined) {
    // structuredContent belongs to tools that publish a schema; others keep text only.
    const withoutStructured = { ...result };
    delete withoutStructured.structuredContent;
    return withoutStructured;
  }
  // An empty body (204) has no object to return. Send {} when the schema allows it, so
  // the SDK does not turn a successful call into a missing-structured-content error.
  if (result.structuredContent === undefined && tool.outputSchema.safeParse({}).success) {
    return { ...result, structuredContent: {} };
  }
  return result;
}

/**
 * How long a 2026-07-28 client may reuse `tools/list` and `server/discover` answers
 * before asking again. The tool set only changes with a new release or a different
 * connection config (write scope, categories), so an hour is safe. `private`: the list
 * depends on the caller's own headers, so a shared cache must not hand it to anyone else.
 * 2025-era responses never carry these fields.
 */
export const CACHE_HINT = { ttlMs: 60 * 60 * 1000, cacheScope: 'private' } as const;

function duplicateResult(
  tool: string,
  state: 'pending' | 'done',
  agoMs: number,
  outcome?: string,
): CallToolResult {
  const when =
    state === 'pending'
      ? 'is still running'
      : `succeeded ${String(Math.max(1, Math.round(agoMs / 1000)))} s ago${outcome === undefined ? '' : ` (${outcome})`}`;
  return errorResult(
    `Not sent: an identical ${tool} call ${when}. This is most likely a retry after a dropped connection, so nothing was sent to Billingo this time and nothing was issued twice. Check the result of the first call (e.g. with billingo_list_documents). Only if the user really wants a second, identical one, call again with ${ALLOW_DUPLICATE}: true.`,
    { code: 'duplicate_call', retryable: false },
  );
}

/** "document #123" from a create/finalize result, to point the model at what the first call made. */
function outcomeOf(result: CallToolResult): string | undefined {
  // Tools without an outputSchema return the API answer as JSON text only (see runTool).
  const last = result.content.at(-1);
  let body: unknown = result.structuredContent;
  if (body === undefined && last?.type === 'text') {
    try {
      body = JSON.parse(last.text);
    } catch {
      return undefined;
    }
  }
  const id = (body as Record<string, unknown> | null | undefined)?.id;
  return typeof id === 'number' || typeof id === 'string' ? `id ${String(id)}` : undefined;
}

export function createServer({
  client,
  allowWrite,
  categories,
  confirmWrites = true,
  duplicateGuard = new DuplicateGuard(),
  tenant = 'default',
}: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: 'billingo', version: SERVER_VERSION },
    {
      cacheHints: { 'tools/list': CACHE_HINT, 'server/discover': CACHE_HINT },
      instructions:
        'Tools for the Billingo invoicing API. Issued invoices are reported to NAV automatically and cannot be undone — always confirm details with the user before creating, finalizing, cancelling or sending a document. If write tools are absent, the server is in read-only mode and the user must enable writes themselves.' +
        (categories === undefined
          ? ''
          : ` This connection loads only these tool groups: ${categories.join(', ')}. For other parts of Billingo the user must add them to the connection.`),
    },
  );

  for (const tool of filterByScope(toolsInCategories(categories), allowWrite)) {
    const safeguard = SAFEGUARDS[tool.name];
    const dedupe = safeguard?.dedupe === true;
    const inputShape = dedupe
      ? { ...tool.inputSchema, [ALLOW_DUPLICATE]: allowDuplicateSchema }
      : tool.inputSchema;

    const call = async (
      input: Record<string, unknown>,
      mcpCtx: ServerContext,
    ): Promise<CallToolResult | InputRequiredResult> => {
      const { [ALLOW_DUPLICATE]: allowDuplicate, ...args } = input;

      // Reads stop calling Billingo once nobody waits for the answer (cancelled call,
      // closed connection). Writes run to the end: see BillingoClient#withSignal.
      const ctx: ToolContext = {
        client: tool.scope === 'read' ? client.withSignal(mcpCtx.mcpReq.signal) : client,
      };

      const key = DuplicateGuard.key(tenant, tool.name, args);
      if (dedupe && allowDuplicate !== true) {
        // Checked before asking, so the user is never asked to confirm a refused call.
        const seen = duplicateGuard.check(key);
        if (seen.duplicate) return duplicateResult(tool.name, seen.state, seen.agoMs, seen.outcome);
      }

      const question = confirmWrites ? safeguard?.confirm?.(args) : undefined;
      if (question !== undefined && canElicit(server, mcpCtx)) {
        const answer = inputResponse(mcpCtx.mcpReq.inputResponses, CONFIRM_KEY);
        if (answer.kind === 'missing') {
          return inputRequired({
            inputRequests: {
              [CONFIRM_KEY]: inputRequired.elicit({
                message: question,
                requestedSchema: confirmSchema,
              }),
            },
          });
        }
        const accepted = acceptedContent(mcpCtx.mcpReq.inputResponses, CONFIRM_KEY, confirmSchema);
        if (answer.kind !== 'elicit' || answer.action !== 'accept' || accepted?.confirm !== true) {
          return errorResult(
            'The user did not confirm, so nothing was sent to Billingo. Ask what they want to change before trying again.',
            { code: 'not_confirmed', retryable: false },
          );
        }
      }

      if (!dedupe) return runTool(tool, args, ctx);
      const pending = duplicateGuard.begin(key);
      let result: CallToolResult;
      try {
        result = await runTool(tool, args, ctx);
      } catch (error) {
        pending.settle(false);
        throw error;
      }
      pending.settle(result.isError !== true, outcomeOf(result));
      return result;
    };

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: z.object(inputShape),
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        annotations: tool.annotations,
      },
      call,
    );
  }

  return server;
}
