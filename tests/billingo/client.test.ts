// tests/billingo/client.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { BillingoApiError, BillingoRateLimitError } from '../../src/billingo/errors.js';
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

const makeClient = () => new BillingoClient({ apiKey: 'test-key', sleep: async () => {} });

describe('BillingoClient', () => {
  it('sends the API key in the X-API-KEY header', async () => {
    let seen: string | null = null;
    server.use(
      http.get('https://api.billingo.hu/v3/organization', ({ request }) => {
        seen = request.headers.get('X-API-KEY');
        return HttpResponse.json({ name: 'Acme Kft.' });
      }),
    );
    const result = await makeClient().get<{ name: string }>('/organization');
    expect(seen).toBe('test-key');
    expect(result).toEqual({ name: 'Acme Kft.' });
  });

  it('serializes query params, expanding arrays as repeated keys', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: [] });
      }),
    );
    await makeClient().get('/documents', {
      query: { page: 1, per_page: 25, type: ['invoice', 'receipt'] },
    });
    expect(url).toContain('page=1');
    expect(url).toContain('per_page=25');
    expect(url).toContain('type=invoice');
    expect(url).toContain('type=receipt');
  });

  it('omits undefined and null query params rather than sending "undefined"', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: [] });
      }),
    );
    await makeClient().get('/documents', { query: { page: 1, partner_id: undefined, q: null } });
    expect(url).not.toContain('partner_id');
    expect(url).not.toContain('q=');
  });

  it('sends a JSON body on POST', async () => {
    let body: unknown = null;
    server.use(
      http.post('https://api.billingo.hu/v3/partners', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 1 }, { status: 201 });
      }),
    );
    await makeClient().post('/partners', { body: { name: 'Acme' } });
    expect(body).toEqual({ name: 'Acme' });
  });

  it('maps an error response to a typed error', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/organization', () =>
        HttpResponse.json({ error: { message: 'Unauthenticated.' } }, { status: 401 }),
      ),
    );
    await expect(makeClient().get('/organization')).rejects.toThrow(BillingoApiError);
    await expect(makeClient().get('/organization')).rejects.toThrow('Unauthenticated.');
  });

  it('reads Retry-After into the rate limit error', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/organization', () =>
        HttpResponse.json(
          { error: { message: 'Too Many Attempts.' } },
          {
            status: 429,
            headers: { 'Retry-After': '42' },
          },
        ),
      ),
    );
    // maxRetries 0 so the error surfaces instead of being retried away.
    const client = new BillingoClient({ apiKey: 'k', maxRetries: 0, sleep: async () => {} });
    const err = await client.get('/organization').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingoRateLimitError);
    expect((err as BillingoRateLimitError).retryAfterMs).toBe(42_000);
  });

  it('handles a 204 No Content without trying to parse a body', async () => {
    server.use(
      http.delete(
        'https://api.billingo.hu/v3/partners/1',
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    await expect(makeClient().delete('/partners/1')).resolves.toBeNull();
  });

  it('fetches binary content with its content type', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/documents/1/download', () =>
        HttpResponse.arrayBuffer(new Uint8Array([37, 80, 68, 70]).buffer, {
          headers: { 'Content-Type': 'application/pdf' },
        }),
      ),
    );
    const { data, contentType } = await makeClient().getBinary('/documents/1/download');
    expect(contentType).toBe('application/pdf');
    expect(Array.from(data)).toEqual([37, 80, 68, 70]);
  });

  it('treats a 202 on an ordinary JSON GET as success, since only a caller that opts in treats 202 as not-ready', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/organization', () =>
        HttpResponse.json({ name: 'Acme Kft.' }, { status: 202 }),
      ),
    );
    const result = await makeClient().get<{ name: string }>('/organization');
    expect(result).toEqual({ name: 'Acme Kft.' });
  });

  it('never leaks the API key into an error message', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/organization', () =>
        HttpResponse.json({ error: { message: 'Unauthenticated.' } }, { status: 401 }),
      ),
    );
    const client = new BillingoClient({ apiKey: 'super-secret-key', sleep: async () => {} });
    const err = await client.get('/organization').catch((e: unknown) => e);
    expect(String(err)).not.toContain('super-secret-key');
  });

  it('drops query values that are neither string, number, boolean, nor array — and serializes booleans', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: [] });
      }),
    );
    await makeClient().get('/documents', {
      query: { active: true, nested: { unsupported: true } },
    });
    expect(url).toContain('active=true');
    expect(url).not.toContain('nested');
  });

  it('drops unsupported values inside a query array without dropping the supported siblings', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: [] });
      }),
    );
    await makeClient().get('/documents', {
      query: { type: ['invoice', { unsupported: true }] },
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.getAll('type')).toEqual(['invoice']);
  });

  it('produces no query string when every provided query value is filtered out', async () => {
    let url = '';
    server.use(
      http.get('https://api.billingo.hu/v3/documents', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: [] });
      }),
    );
    await makeClient().get('/documents', { query: { partner_id: undefined, q: null } });
    expect(url).toBe('https://api.billingo.hu/v3/documents');
  });

  it('reads an HTTP-date Retry-After header, not just a seconds count', async () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    server.use(
      http.get('https://api.billingo.hu/v3/organization', () =>
        HttpResponse.json(
          { error: { message: 'Too Many Attempts.' } },
          { status: 429, headers: { 'Retry-After': future } },
        ),
      ),
    );
    const client = new BillingoClient({ apiKey: 'k', maxRetries: 0, sleep: async () => {} });
    const err = await client.get('/organization').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingoRateLimitError);
    const retryAfterMs = (err as BillingoRateLimitError).retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it('ignores an unparseable Retry-After header instead of throwing', async () => {
    server.use(
      http.get('https://api.billingo.hu/v3/organization', () =>
        HttpResponse.json(
          { error: { message: 'Too Many Attempts.' } },
          { status: 429, headers: { 'Retry-After': 'not-a-valid-value' } },
        ),
      ),
    );
    const client = new BillingoClient({ apiKey: 'k', maxRetries: 0, sleep: async () => {} });
    const err = await client.get('/organization').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingoRateLimitError);
    expect((err as BillingoRateLimitError).retryAfterMs).toBeUndefined();
  });

  it('defaults the binary content type when the response omits Content-Type', async () => {
    server.use(
      http.get(
        'https://api.billingo.hu/v3/documents/1/download',
        () => new Response(new Uint8Array([1, 2, 3]).buffer),
      ),
    );
    const { contentType, data } = await makeClient().getBinary('/documents/1/download');
    expect(contentType).toBe('application/octet-stream');
    expect(Array.from(data)).toEqual([1, 2, 3]);
  });

  it('returns null for a non-204 response with an empty body', async () => {
    server.use(
      http.get(
        'https://api.billingo.hu/v3/organization',
        () => new HttpResponse('', { status: 200 }),
      ),
    );
    await expect(makeClient().get('/organization')).resolves.toBeNull();
  });

  it('uses a custom fetchImpl instead of the global fetch when provided', async () => {
    let called = false;
    const customFetch = ((...args: Parameters<typeof fetch>) => {
      called = true;
      return fetch(...args);
    }) as typeof fetch;
    server.use(
      http.get('https://api.billingo.hu/v3/organization', () =>
        HttpResponse.json({ name: 'Acme Kft.' }),
      ),
    );
    const client = new BillingoClient({
      apiKey: 'k',
      sleep: async () => {},
      fetchImpl: customFetch,
    });
    const result = await client.get<{ name: string }>('/organization');
    expect(called).toBe(true);
    expect(result).toEqual({ name: 'Acme Kft.' });
  });

  it('uses a real timer for backoff when no sleep is injected', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.billingo.hu/v3/documents', () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            { error: { message: 'Too Many Attempts.' } },
            { status: 429, headers: { 'Retry-After': '0.001' } },
          );
        }
        return HttpResponse.json({ data: [] });
      }),
    );
    // No `sleep` passed — exercises the real setTimeout-based default.
    const client = new BillingoClient({ apiKey: 'k' });
    const result = await client.get<{ data: unknown[] }>('/documents');
    expect(calls).toBe(2);
    expect(result.data).toEqual([]);
  });
});
