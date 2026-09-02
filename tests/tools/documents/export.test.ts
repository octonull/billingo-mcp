// tests/tools/documents/export.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { BillingoClient } from '../../../src/billingo/client.js';
import { documentExportTools } from '../../../src/tools/documents/export.js';
import type { AnyToolDefinition } from '../../../src/tools/registry.js';

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

// Built in beforeAll, NOT at module level: BillingoClient captures globalThis.fetch in
// its constructor, so constructing it before server.listen() bypasses MSW and lets the
// test hit the real Billingo API.
let ctx: { client: BillingoClient };
beforeAll(() => {
  ctx = { client: new BillingoClient({ apiKey: 'k', sleep: () => Promise.resolve() }) };
});
const tool = (): AnyToolDefinition => {
  const found = documentExportTools.find((t) => t.name === 'billingo_export_documents');
  if (found === undefined) throw new Error('missing export tool');
  return found;
};
const textOf = (result: { content: unknown[] }): string =>
  result.content.map((c) => (c as { text?: string }).text ?? '').join('\n');

/**
 * No real waiting: the tool takes an injectable sleep via ToolContext. A function, not a
 * plain object, because `ctx` is only populated inside `beforeAll` above — a plain
 * object spreading `ctx` at module-eval time would capture `ctx` while still undefined.
 */
const opts = (): { client: BillingoClient; sleep: () => Promise<void>; maxPolls: number } => ({
  ...ctx,
  sleep: async () => {},
  maxPolls: 10,
});

describe('billingo_export_documents', () => {
  it('is a read tool despite using POST — it exports, it does not mutate', () => {
    expect(tool().scope).toBe('read');
    expect(tool().annotations.readOnlyHint).toBe(true);
  });

  it('creates, polls until success, then downloads', async () => {
    let polls = 0;
    server.use(
      http.post('https://api.billingo.hu/v3/document-export', () =>
        HttpResponse.json({ id: 'exp-1' }, { status: 201 }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/poll', () => {
        polls += 1;
        if (polls === 1) return HttpResponse.json({ id: 'exp-1', state: 'pending' });
        if (polls === 2) return HttpResponse.json({ id: 'exp-1', state: 'processing' });
        return HttpResponse.json({ id: 'exp-1', state: 'success' });
      }),
      http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
        HttpResponse.arrayBuffer(new Uint8Array([80, 75, 3, 4]).buffer, {
          headers: { 'Content-Type': 'application/zip' },
        }),
      ),
    );
    const result = await tool().handler(
      { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
      opts(),
    );
    expect(polls).toBe(3);
    const resource = result.content.find((c) => (c as { type: string }).type === 'resource');
    expect(resource).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'application/zip',
        blob: Buffer.from([80, 75, 3, 4]).toString('base64'),
      },
    });
  });

  it("sends the real CreateDocumentExport wire shape (query_type/export_type/document_block_id), not the brief's guessed field names", async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/document-export', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 'exp-shape' }, { status: 201 });
      }),
      http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
        HttpResponse.json({ id: 'exp-shape', state: 'success' }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
        HttpResponse.arrayBuffer(new Uint8Array([1]).buffer, {
          headers: { 'Content-Type': 'application/zip' },
        }),
      ),
    );
    await tool().handler(
      { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
      opts(),
    );
    expect(body).toMatchObject({
      document_block_id: 1,
      start_date: '2026-01-01',
      end_date: '2026-01-31',
      export_type: 'simple_csv',
    });
    expect(body).toHaveProperty('query_type');
  });

  it('treats "warning" as terminal and still returns the file, surfacing the message', async () => {
    server.use(
      http.post('https://api.billingo.hu/v3/document-export', () =>
        HttpResponse.json({ id: 'exp-2' }, { status: 201 }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
        HttpResponse.json({
          id: 'exp-2',
          state: 'warning',
          message: 'Some documents were skipped.',
        }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
        HttpResponse.arrayBuffer(new Uint8Array([80, 75]).buffer, {
          headers: { 'Content-Type': 'application/zip' },
        }),
      ),
    );
    const result = await tool().handler(
      { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
      opts(),
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Some documents were skipped.');
    expect(result.content.some((c) => (c as { type: string }).type === 'resource')).toBe(true);
  });

  it('uses default sleep/maxPolls from ToolContext when not overridden, without needing to actually wait', async () => {
    // First poll already returns a terminal state, so the default sleep (a real
    // setTimeout wrapper) is defined but never invoked — this exercises the `ctx.sleep
    // ?? ...` / `ctx.maxPolls ?? DEFAULT_MAX_POLLS` fallback branches without slowing
    // the test down.
    server.use(
      http.post('https://api.billingo.hu/v3/document-export', () =>
        HttpResponse.json({ id: 'exp-default' }, { status: 201 }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
        HttpResponse.json({ id: 'exp-default', state: 'success' }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
        HttpResponse.arrayBuffer(new Uint8Array([1]).buffer, {
          headers: { 'Content-Type': 'application/zip' },
        }),
      ),
    );
    const result = await tool().handler(
      { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
      ctx,
    );
    expect(result.content.some((c) => (c as { type: string }).type === 'resource')).toBe(true);
  });

  it('really waits between polls when sleep is not overridden, via the default setTimeout-based implementation', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      server.use(
        http.post('https://api.billingo.hu/v3/document-export', () =>
          HttpResponse.json({ id: 'exp-real-sleep' }, { status: 201 }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/poll', () => {
          polls += 1;
          return HttpResponse.json({
            id: 'exp-real-sleep',
            state: polls === 1 ? 'pending' : 'success',
          });
        }),
        http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
          HttpResponse.arrayBuffer(new Uint8Array([1]).buffer, {
            headers: { 'Content-Type': 'application/zip' },
          }),
        ),
      );
      const promise = tool().handler(
        { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
        ctx,
      );
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;
      expect(polls).toBe(2);
      expect(result.content.some((c) => (c as { type: string }).type === 'resource')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a generic message when "fail" carries none', async () => {
    server.use(
      http.post('https://api.billingo.hu/v3/document-export', () =>
        HttpResponse.json({ id: 'exp-fail-no-msg' }, { status: 201 }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
        HttpResponse.json({ id: 'exp-fail-no-msg', state: 'fail' }),
      ),
    );
    const result = await tool().handler(
      { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
      opts(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('exp-fail-no-msg');
  });

  it('falls back to a "(no message)" note when "warning" carries none', async () => {
    server.use(
      http.post('https://api.billingo.hu/v3/document-export', () =>
        HttpResponse.json({ id: 'exp-warn-no-msg' }, { status: 201 }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
        HttpResponse.json({ id: 'exp-warn-no-msg', state: 'warning' }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
        HttpResponse.arrayBuffer(new Uint8Array([1]).buffer, {
          headers: { 'Content-Type': 'application/zip' },
        }),
      ),
    );
    const result = await tool().handler(
      { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
      opts(),
    );
    expect(textOf(result)).toContain('(no message)');
  });

  it('returns an error result on "fail" without attempting a download', async () => {
    let downloads = 0;
    server.use(
      http.post('https://api.billingo.hu/v3/document-export', () =>
        HttpResponse.json({ id: 'exp-3' }, { status: 201 }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
        HttpResponse.json({ id: 'exp-3', state: 'fail', message: 'Export failed.' }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/download', () => {
        downloads += 1;
        return HttpResponse.json({});
      }),
    );
    const result = await tool().handler(
      { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
      opts(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Export failed.');
    expect(downloads).toBe(0);
  });

  it('gives up after maxPolls rather than looping forever, and says the export is still running', async () => {
    let polls = 0;
    server.use(
      http.post('https://api.billingo.hu/v3/document-export', () =>
        HttpResponse.json({ id: 'exp-4' }, { status: 201 }),
      ),
      http.get('https://api.billingo.hu/v3/document-export/:id/poll', () => {
        polls += 1;
        return HttpResponse.json({ id: 'exp-4', state: 'processing' });
      }),
    );
    const result = await tool().handler(
      { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
      { ...ctx, sleep: async () => {}, maxPolls: 3 },
    );
    expect(polls).toBe(3);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('exp-4');
    expect(textOf(result)).toContain('still');
  });

  it('restricts `format` to the real DocumentExportType enum ("csv" alone is not a member; "simple_csv" is)', () => {
    const schema = z.object(tool().inputSchema);
    const base = { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31' };
    expect(() => schema.parse({ ...base, format: 'csv' })).toThrow();
    expect(schema.parse({ ...base, format: 'simple_csv' }).format).toBe('simple_csv');
  });

  it('does not accept a `type` filter — CreateDocumentExport has no such field in the spec', () => {
    const schema = z.object(tool().inputSchema);
    expect(Object.keys(tool().inputSchema)).not.toContain('type');
    expect(
      schema.parse({
        block_id: 1,
        start_date: '2026-01-01',
        end_date: '2026-01-31',
        format: 'simple_csv',
      }),
    ).toBeDefined();
  });

  describe('text vs. binary content negotiation', () => {
    it('returns a readable type: "text" block for text/csv, with the leading UTF-8 BOM stripped', async () => {
      const csvBody = '﻿"id","total"\n"1","100"\n';
      server.use(
        http.post('https://api.billingo.hu/v3/document-export', () =>
          HttpResponse.json({ id: 'exp-csv' }, { status: 201 }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
          HttpResponse.json({ id: 'exp-csv', state: 'success' }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
          HttpResponse.text(csvBody, { headers: { 'Content-Type': 'text/csv; charset=UTF-8' } }),
        ),
      );
      const result = await tool().handler(
        { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
        opts(),
      );
      expect(result.isError).toBeUndefined();
      expect(result.content.some((c) => (c as { type: string }).type === 'resource')).toBe(false);
      const text = result.content.find((c) => (c as { type: string }).type === 'text') as
        { type: 'text'; text: string } | undefined;
      expect(text?.text).toBe('"id","total"\n"1","100"\n');
      expect(text?.text.startsWith('﻿')).toBe(false);
    });

    it('returns a readable type: "text" block for application/xml', async () => {
      const xmlBody = '<?xml version="1.0"?><root><doc>1</doc></root>';
      server.use(
        http.post('https://api.billingo.hu/v3/document-export', () =>
          HttpResponse.json({ id: 'exp-xml' }, { status: 201 }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
          HttpResponse.json({ id: 'exp-xml', state: 'success' }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
          HttpResponse.text(xmlBody, { headers: { 'Content-Type': 'application/xml' } }),
        ),
      );
      const result = await tool().handler(
        { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'nav_xml' },
        opts(),
      );
      expect(result.isError).toBeUndefined();
      expect(result.content.some((c) => (c as { type: string }).type === 'resource')).toBe(false);
      expect(textOf(result)).toContain(xmlBody);
    });

    it.each([
      ['application/json', '{"id":1}'],
      ['application/atom+xml', '<feed/>'],
      ['application/hal+json', '{"id":1}'],
    ])('treats %s as textual too', async (contentType, body) => {
      server.use(
        http.post('https://api.billingo.hu/v3/document-export', () =>
          HttpResponse.json({ id: 'exp-variant' }, { status: 201 }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
          HttpResponse.json({ id: 'exp-variant', state: 'success' }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
          HttpResponse.text(body, { headers: { 'Content-Type': contentType } }),
        ),
      );
      const result = await tool().handler(
        { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'nav_xml' },
        opts(),
      );
      expect(result.content.some((c) => (c as { type: string }).type === 'resource')).toBe(false);
      expect(textOf(result)).toContain(body);
    });

    it('still returns a resource blob for a binary xlsx response, now preceded by a text line naming format and size', async () => {
      const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff]);
      server.use(
        http.post('https://api.billingo.hu/v3/document-export', () =>
          HttpResponse.json({ id: 'exp-xlsx' }, { status: 201 }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
          HttpResponse.json({ id: 'exp-xlsx', state: 'success' }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
          HttpResponse.arrayBuffer(bytes.buffer, { headers: { 'Content-Type': xlsxMime } }),
        ),
      );
      const result = await tool().handler(
        { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_excel' },
        opts(),
      );
      expect(result.isError).toBeUndefined();
      const resource = result.content.find((c) => (c as { type: string }).type === 'resource');
      expect(resource).toMatchObject({
        type: 'resource',
        resource: { mimeType: xlsxMime, blob: Buffer.from(bytes).toString('base64') },
      });
      const leadingText = result.content.find((c) => (c as { type: string }).type === 'text') as
        { type: 'text'; text: string } | undefined;
      expect(leadingText?.text).toContain('simple_excel');
      expect(leadingText?.text).toContain(String(bytes.byteLength));
    });

    it('truncates an oversized text payload with an explicit, unmistakable note rather than silently cutting it off', async () => {
      const bigCsv = 'x'.repeat(200 * 1024); // 200 KB, well past the inline cap
      server.use(
        http.post('https://api.billingo.hu/v3/document-export', () =>
          HttpResponse.json({ id: 'exp-big' }, { status: 201 }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/poll', () =>
          HttpResponse.json({ id: 'exp-big', state: 'success' }),
        ),
        http.get('https://api.billingo.hu/v3/document-export/:id/download', () =>
          HttpResponse.text(bigCsv, { headers: { 'Content-Type': 'text/csv; charset=UTF-8' } }),
        ),
      );
      const result = await tool().handler(
        { block_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', format: 'simple_csv' },
        opts(),
      );
      expect(result.isError).toBeUndefined();
      const combined = textOf(result);
      expect(combined).toContain('Truncat');
      expect(combined).toContain(String(bigCsv.length));
      expect(combined.length).toBeLessThan(bigCsv.length + 500);
      expect(combined).toContain('date range');
    });
  });
});
