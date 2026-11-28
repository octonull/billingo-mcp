// tests/server/safeguards-flow.test.ts
// The safeguards end to end, over real MCP connections in both protocol eras: the
// confirmation form (elicitation), the duplicate guard and cancellation of reads.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, ElicitRequest, ElicitResult } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { BillingoClient } from '../../src/billingo/client.js';
import { createServer } from '../../src/server.js';
import type { CreateServerOptions } from '../../src/server.js';
import { DuplicateGuard } from '../../src/tools/safeguards.js';

const API = 'https://api.billingo.hu/v3';
const api = setupServer();
let posts = 0;
beforeAll(() => {
  api.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  api.resetHandlers();
  posts = 0;
});
afterAll(() => {
  api.close();
});

function issuingApi(status = 201): void {
  api.use(
    http.post(`${API}/documents`, () => {
      posts += 1;
      return status === 201
        ? HttpResponse.json({ id: 1000 + posts, type: 'invoice' }, { status })
        : HttpResponse.json({ message: 'invalid', errors: [] }, { status });
    }),
  );
}

const invoice = {
  partner_id: 1,
  block_id: 2,
  type: 'invoice',
  fulfillment_date: '2026-11-28',
  due_date: '2026-12-05',
  payment_method: 'wire_transfer',
  language: 'hu',
  currency: 'HUF',
  items: [
    {
      name: 'Consulting',
      unit_price: 1000,
      unit_price_type: 'net',
      quantity: 1,
      unit: 'db',
      vat: '27%',
    },
  ],
};

type Era = 'legacy' | { pin: '2026-07-28' };
type Answer = ElicitResult | 'no-elicitation';

/**
 * A client connected through serveStdio over an in-memory pair, so both eras are served
 * the way the stdio binary serves them. `answer` is what the user does with the form.
 */
async function connect(
  era: Era,
  answer: Answer,
  options: Partial<CreateServerOptions> = {},
): Promise<{ client: Client; asked: string[] }> {
  const billingo = new BillingoClient({ apiKey: 'k', sleep: async () => {} });
  const guard = options.duplicateGuard ?? new DuplicateGuard();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  serveStdio(
    () => createServer({ client: billingo, allowWrite: true, duplicateGuard: guard, ...options }),
    { transport: serverSide },
  );
  const asked: string[] = [];
  const client = new Client(
    { name: 'test', version: '0' },
    {
      versionNegotiation: { mode: era },
      capabilities: answer === 'no-elicitation' ? {} : { elicitation: { form: {} } },
    },
  );
  if (answer !== 'no-elicitation') {
    client.setRequestHandler('elicitation/create', (request: ElicitRequest) => {
      asked.push(request.params.message);
      return Promise.resolve(answer);
    });
  }
  await client.connect(clientSide);
  return { client, asked };
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

const errorCode = (result: CallToolResult): string | undefined => {
  const block = result.content.at(-1);
  if (block?.type !== 'text') return undefined;
  return (JSON.parse(block.text) as { error?: { code?: string } }).error?.code;
};

const ACCEPT: ElicitResult = { action: 'accept', content: { confirm: true } };

describe.each<[string, Era]>([
  ['2026-07-28', { pin: '2026-07-28' }],
  ['2025 era', 'legacy'],
])('confirmation over %s', (_, era) => {
  it('asks before issuing, and issues once the user confirms', async () => {
    issuingApi();
    const { client, asked } = await connect(era, ACCEPT);
    const result = await call(client, 'billingo_create_document', invoice);
    expect(result.isError).not.toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Issue an invoice for partner #1, HUF: 1 item: Consulting × 1');
    expect(posts).toBe(1);
    await client.close();
  });

  it('sends nothing when the user declines', async () => {
    issuingApi();
    const { client } = await connect(era, { action: 'decline' });
    const result = await call(client, 'billingo_create_document', invoice);
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('not_confirmed');
    expect(posts).toBe(0);
    await client.close();
  });

  it('sends nothing when the user submits the form unticked', async () => {
    issuingApi();
    const { client } = await connect(era, { action: 'accept', content: { confirm: false } });
    expect(errorCode(await call(client, 'billingo_create_document', invoice))).toBe(
      'not_confirmed',
    );
    expect(posts).toBe(0);
    await client.close();
  });

  it('does not ask for a draft', async () => {
    issuingApi();
    const { client, asked } = await connect(era, ACCEPT);
    await call(client, 'billingo_create_document', { ...invoice, type: 'draft' });
    expect(asked).toEqual([]);
    expect(posts).toBe(1);
    await client.close();
  });

  it('proceeds without asking when the client cannot show a form', async () => {
    issuingApi();
    const { client } = await connect(era, 'no-elicitation');
    expect((await call(client, 'billingo_create_document', invoice)).isError).not.toBe(true);
    expect(posts).toBe(1);
    await client.close();
  });

  it('proceeds without asking when confirmation is turned off', async () => {
    issuingApi();
    const { client, asked } = await connect(era, ACCEPT, { confirmWrites: false });
    await call(client, 'billingo_create_document', invoice);
    expect(asked).toEqual([]);
    expect(posts).toBe(1);
    await client.close();
  });
});

describe('duplicate guard', () => {
  it('refuses an identical repeat without asking or sending, and says where the first went', async () => {
    issuingApi();
    const { client, asked } = await connect({ pin: '2026-07-28' }, ACCEPT);
    await call(client, 'billingo_create_document', invoice);
    const repeat = await call(client, 'billingo_create_document', invoice);
    expect(errorCode(repeat)).toBe('duplicate_call');
    expect(JSON.stringify(repeat.content)).toContain('id 1001');
    expect(asked).toHaveLength(1);
    expect(posts).toBe(1);
    await client.close();
  });

  it('sends the repeat when the caller says it is wanted', async () => {
    issuingApi();
    const { client } = await connect({ pin: '2026-07-28' }, 'no-elicitation');
    await call(client, 'billingo_create_document', invoice);
    const again = await call(client, 'billingo_create_document', {
      ...invoice,
      allow_duplicate: true,
    });
    expect(again.isError).not.toBe(true);
    expect(posts).toBe(2);
    await client.close();
  });

  it('allows a retry after a failed call', async () => {
    issuingApi(422);
    const { client } = await connect({ pin: '2026-07-28' }, 'no-elicitation');
    await call(client, 'billingo_create_document', invoice);
    api.resetHandlers();
    issuingApi();
    expect((await call(client, 'billingo_create_document', invoice)).isError).not.toBe(true);
    await client.close();
  });

  it('catches a resend that arrives on a new connection (dropped stream)', async () => {
    issuingApi();
    const guard = new DuplicateGuard();
    const first = await connect({ pin: '2026-07-28' }, 'no-elicitation', { duplicateGuard: guard });
    await call(first.client, 'billingo_create_document', invoice);
    await first.client.close();
    const second = await connect({ pin: '2026-07-28' }, 'no-elicitation', {
      duplicateGuard: guard,
    });
    expect(errorCode(await call(second.client, 'billingo_create_document', invoice))).toBe(
      'duplicate_call',
    );
    expect(posts).toBe(1);
    await second.client.close();
  });

  it('offers allow_duplicate only on guarded tools', async () => {
    const { client } = await connect({ pin: '2026-07-28' }, 'no-elicitation');
    const { tools } = await client.listTools();
    const withFlag = tools
      .filter((t) => 'allow_duplicate' in (t.inputSchema.properties ?? {}))
      .map((t) => t.name);
    expect(withFlag).toContain('billingo_create_document');
    expect(withFlag).not.toContain('billingo_delete_partner');
    expect(withFlag).not.toContain('billingo_list_documents');
    await client.close();
  });
});

describe('cancellation', () => {
  it('stops a read tool from waiting on Billingo once the caller cancels', async () => {
    let aborted = false;
    api.use(
      http.get(`${API}/organization`, async ({ request }) => {
        request.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await delay(2_000);
        return HttpResponse.json({ tax_code: 'x' });
      }),
    );
    const { client } = await connect({ pin: '2026-07-28' }, 'no-elicitation');
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'billingo_get_organization', arguments: {} },
      { signal: controller.signal },
    );
    await delay(100);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await delay(50);
    expect(aborted).toBe(true);
    await client.close();
  });
});
