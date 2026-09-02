// tests/transports/http.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../../src/transports/http.js';

const api = setupServer();
beforeAll(() => {
  api.listen({ onUnhandledRequest: 'bypass' });
});
afterEach(() => {
  api.resetHandlers();
});
afterAll(() => {
  api.close();
});

/** Boots the handler on an ephemeral port and returns a caller bound to it. */
async function withServer<T>(
  fn: (call: (headers: Record<string, string>, body: unknown) => Promise<Response>) => Promise<T>,
): Promise<T> {
  const handler = createHandler({
    baseUrl: 'https://api.billingo.hu/v3',
    port: 0,
    allowedHosts: undefined,
    commitSha: undefined,
    buildVersion: undefined,
  });
  const node = createHttpServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => node.listen(0, resolve));
  const { port } = node.address() as AddressInfo;
  const call = (headers: Record<string, string>, body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    return await fn(call);
  } finally {
    await new Promise<void>((resolve) =>
      node.close(() => {
        resolve();
      }),
    );
  }
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe', version: '0' },
  },
};

describe('HTTP transport', () => {
  it('rejects a request with no API key header, without reaching the API', async () => {
    await withServer(async (call) => {
      const response = await call({}, initialize);
      expect(response.status).toBe(401);
      expect(await response.text()).toContain('X-Billingo-Api-Key');
    });
  });

  it('accepts a request carrying an API key', async () => {
    await withServer(async (call) => {
      const response = await call({ 'X-Billingo-Api-Key': 'k' }, initialize);
      expect(response.status).toBe(200);
    });
  });

  it('answers a health check without requiring a key', async () => {
    const handler = createHandler({
      baseUrl: 'https://api.billingo.hu/v3',
      port: 0,
      allowedHosts: undefined,
      commitSha: undefined,
      buildVersion: undefined,
    });
    const node = createHttpServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => node.listen(0, resolve));
    const { port } = node.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
    await new Promise<void>((resolve) =>
      node.close(() => {
        resolve();
      }),
    );
  });

  it('reports "unknown" build_version outside a built image', async () => {
    const handler = createHandler({
      baseUrl: 'https://api.billingo.hu/v3',
      port: 0,
      allowedHosts: undefined,
      commitSha: undefined,
      buildVersion: undefined,
    });
    const node = createHttpServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => node.listen(0, resolve));
    const { port } = node.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/build_version`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ buildVer: 'unknown' });
    await new Promise<void>((resolve) =>
      node.close(() => {
        resolve();
      }),
    );
  });

  it('reports just the commit SHA in build_version when there is no release version', async () => {
    const handler = createHandler({
      baseUrl: 'https://api.billingo.hu/v3',
      port: 0,
      allowedHosts: undefined,
      commitSha: 'abc1234',
      buildVersion: undefined,
    });
    const node = createHttpServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => node.listen(0, resolve));
    const { port } = node.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/build_version`);
    expect(await response.json()).toMatchObject({ buildVer: 'abc1234' });
    await new Promise<void>((resolve) =>
      node.close(() => {
        resolve();
      }),
    );
  });

  it('reports commit SHA + version in build_version for a released build', async () => {
    const handler = createHandler({
      baseUrl: 'https://api.billingo.hu/v3',
      port: 0,
      allowedHosts: undefined,
      commitSha: 'abc1234',
      buildVersion: '0.1.0',
    });
    const node = createHttpServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => node.listen(0, resolve));
    const { port } = node.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(port)}/build_version`);
    expect(await response.json()).toMatchObject({ buildVer: 'abc1234@0.1.0' });
    await new Promise<void>((resolve) =>
      node.close(() => {
        resolve();
      }),
    );
  });

  it('is read-only unless the allow-write header says otherwise', async () => {
    await withServer(async (call) => {
      await call({ 'X-Billingo-Api-Key': 'k' }, initialize);
      const response = await call(
        { 'X-Billingo-Api-Key': 'k' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      );
      const text = await response.text();
      expect(text).toContain('billingo_get_organization');
      expect(text).not.toContain('billingo_create_document');
      expect(text).not.toContain('billingo_cancel_document');
    });
  });

  it('exposes write tools when the caller opts in via header', async () => {
    await withServer(async (call) => {
      await call({ 'X-Billingo-Api-Key': 'k', 'X-Billingo-Allow-Write': 'true' }, initialize);
      const response = await call(
        { 'X-Billingo-Api-Key': 'k', 'X-Billingo-Allow-Write': 'true' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      );
      expect(await response.text()).toContain('billingo_create_document');
    });
  });

  it('treats an unrecognized allow-write value as false', async () => {
    await withServer(async (call) => {
      await call({ 'X-Billingo-Api-Key': 'k', 'X-Billingo-Allow-Write': 'yes-please' }, initialize);
      const response = await call(
        { 'X-Billingo-Api-Key': 'k', 'X-Billingo-Allow-Write': 'yes-please' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      );
      expect(await response.text()).not.toContain('billingo_create_document');
    });
  });

  it('keeps tenants apart: each request uses only its own key', async () => {
    const keysSeen: string[] = [];
    api.use(
      http.get('https://api.billingo.hu/v3/organization', ({ request }) => {
        keysSeen.push(request.headers.get('X-API-KEY') ?? '(none)');
        return HttpResponse.json({ name: 'Acme' });
      }),
    );
    await withServer(async (call) => {
      for (const key of ['tenant-a', 'tenant-b']) {
        await call({ 'X-Billingo-Api-Key': key }, initialize);
        await call(
          { 'X-Billingo-Api-Key': key },
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'billingo_get_organization', arguments: {} },
          },
        );
      }
      expect(keysSeen).toEqual(['tenant-a', 'tenant-b']);
    });
  });
});
