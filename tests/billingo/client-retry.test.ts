// tests/billingo/client-retry.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { BillingoPdfNotReadyError, BillingoRateLimitError } from '../../src/billingo/errors.js';
import { BillingoClient } from '../../src/billingo/client.js';

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

/** Records how long the client would have slept, without actually sleeping. */
function makeClient(maxRetries = 3) {
  const slept: number[] = [];
  const client = new BillingoClient({
    apiKey: 'k',
    maxRetries,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  return { client, slept };
}

describe('retry behavior', () => {
  it('retries a rate-limited GET and returns the eventual success', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.billingo.hu/v3/documents', () => {
        calls += 1;
        if (calls < 3) {
          return HttpResponse.json({ error: { message: 'Too Many Attempts.' } }, { status: 429 });
        }
        return HttpResponse.json({ data: [{ id: 1 }] });
      }),
    );
    const { client, slept } = makeClient();
    const result = await client.get<{ data: unknown[] }>('/documents');
    expect(calls).toBe(3);
    expect(result.data).toHaveLength(1);
    expect(slept).toHaveLength(2);
  });

  it('waits exactly as long as Retry-After says', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.billingo.hu/v3/documents', () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            { error: { message: 'Too Many Attempts.' } },
            {
              status: 429,
              headers: { 'Retry-After': '7' },
            },
          );
        }
        return HttpResponse.json({ data: [] });
      }),
    );
    const { client, slept } = makeClient();
    await client.get('/documents');
    expect(slept).toEqual([7000]);
  });

  it('backs off exponentially when Retry-After is absent', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/documents', () =>
        HttpResponse.json({ error: { message: 'Too Many Attempts.' } }, { status: 429 }),
      ),
    );
    const { client, slept } = makeClient(3);
    await expect(client.get('/documents')).rejects.toThrow(BillingoRateLimitError);
    expect(slept).toHaveLength(3);
    // 500 * 2^n plus up to 250ms jitter.
    expect(slept[0]).toBeGreaterThanOrEqual(500);
    expect(slept[0]).toBeLessThan(750);
    expect(slept[1]).toBeGreaterThanOrEqual(1000);
    expect(slept[1]).toBeLessThan(1250);
    expect(slept[2]).toBeGreaterThanOrEqual(2000);
    expect(slept[2]).toBeLessThan(2250);
  });

  it('NEVER retries a rate-limited POST — a retried invoice cannot be un-issued', async () => {
    let calls = 0;
    server.use(
      http.post('https://api.billingo.hu/v3/documents', () => {
        calls += 1;
        return HttpResponse.json({ error: { message: 'Too Many Attempts.' } }, { status: 429 });
      }),
    );
    const { client, slept } = makeClient();
    await expect(client.post('/documents', { body: {} })).rejects.toThrow(BillingoRateLimitError);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it('never retries PUT or DELETE either', async () => {
    let puts = 0;
    let deletes = 0;
    server.use(
      http.put('https://api.billingo.hu/v3/documents/1', () => {
        puts += 1;
        return HttpResponse.json({ error: { message: 'Too Many Attempts.' } }, { status: 429 });
      }),
      http.delete('https://api.billingo.hu/v3/documents/1', () => {
        deletes += 1;
        return HttpResponse.json({ error: { message: 'Too Many Attempts.' } }, { status: 429 });
      }),
    );
    const { client } = makeClient();
    await expect(client.put('/documents/1', { body: {} })).rejects.toThrow();
    await expect(client.delete('/documents/1')).rejects.toThrow();
    expect(puts).toBe(1);
    expect(deletes).toBe(1);
  });

  it("retries a not-yet-generated PDF (HTTP 202, per spec — not 400), which is Billingo's documented remedy", async () => {
    let calls = 0;
    server.use(
      http.get('https://api.billingo.hu/v3/documents/1/download', () => {
        calls += 1;
        if (calls < 2) {
          // The 202 body is the flat ClientError shape ({ message }), not the
          // wrapped ClientErrorResponse shape ({ error: { message } }) used by 4xx/5xx.
          return HttpResponse.json(
            {
              message:
                'Document PDF has not generated yet. You should try to download again later.',
            },
            { status: 202 },
          );
        }
        return HttpResponse.arrayBuffer(new Uint8Array([37, 80, 68, 70]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
        });
      }),
    );
    const { client } = makeClient();
    const { contentType, data } = await client.getBinary('/documents/1/download', {}, 202);
    expect(calls).toBe(2);
    expect(contentType).toBe('application/pdf');
    expect(Array.from(data)).toEqual([37, 80, 68, 70]);
  });

  it('honours Retry-After on a 202 not-ready response, since that response uniquely documents the header for this purpose', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.billingo.hu/v3/documents/1/download', () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            { message: 'Document PDF has not generated yet.' },
            { status: 202, headers: { 'Retry-After': '3' } },
          );
        }
        return HttpResponse.arrayBuffer(new Uint8Array([37, 80, 68, 70]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
        });
      }),
    );
    const { client, slept } = makeClient();
    await client.getBinary('/documents/1/download', {}, 202);
    expect(slept).toEqual([3000]);
  });

  it('exhausts retries and throws BillingoPdfNotReadyError when the PDF never becomes ready', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.billingo.hu/v3/documents/1/download', () => {
        calls += 1;
        return HttpResponse.json(
          { message: 'Document PDF has not generated yet.' },
          { status: 202 },
        );
      }),
    );
    const { client } = makeClient(2);
    await expect(client.getBinary('/documents/1/download', {}, 202)).rejects.toThrow(
      BillingoPdfNotReadyError,
    );
    expect(calls).toBe(3); // initial attempt + 2 retries
  });

  it('does not treat a 202 as not-ready unless the caller opts in — a future 202 elsewhere is not silently swallowed', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/documents/1/print/pos', () =>
        HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
          status: 202,
        }),
      ),
    );
    const { client } = makeClient();
    // No notReadyStatus passed — the response is 2xx and must be returned as-is.
    const { data, contentType } = await client.getBinary('/documents/1/print/pos');
    expect(contentType).toBe('application/pdf');
    expect(Array.from(data)).toEqual([1, 2, 3]);
  });

  it('does not retry an ordinary 400, so a quota error fails fast with its message intact', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.billingo.hu/v3/documents', () => {
        calls += 1;
        return HttpResponse.json({ error: { message: 'API keret elfogyott.' } }, { status: 400 });
      }),
    );
    const { client } = makeClient();
    await expect(client.get('/documents')).rejects.toThrow('API keret elfogyott.');
    expect(calls).toBe(1);
  });
});
