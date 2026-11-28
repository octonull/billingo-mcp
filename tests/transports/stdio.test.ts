// tests/transports/stdio.test.ts
import { describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildStdioServer } from '../../src/transports/stdio.js';

describe('buildStdioServer', () => {
  it('builds a read-only server from a bare API key', () => {
    const { createServer, allowWrite } = buildStdioServer({ BILLINGO_API_KEY: 'k' });
    expect(allowWrite).toBe(false);
    expect(createServer()).toBeDefined();
  });

  it('enables writes when the env says so explicitly', () => {
    const { allowWrite } = buildStdioServer({
      BILLINGO_API_KEY: 'k',
      BILLINGO_ALLOW_WRITE: 'true',
    });
    expect(allowWrite).toBe(true);
  });

  it('fails loudly when the key is missing rather than starting a useless server', () => {
    expect(() => buildStdioServer({})).toThrow(/BILLINGO_API_KEY/);
  });
});

describe('stdio serving across protocol eras', () => {
  // serveStdio over an in-memory pair stands in for a real stdin/stdout connection.
  async function connect(mode: 'legacy' | { pin: '2026-07-28' }): Promise<Client> {
    const { createServer } = buildStdioServer({ BILLINGO_API_KEY: 'k' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    serveStdio(createServer, { transport: serverSide });
    const client = new Client({ name: 'probe', version: '0' }, { versionNegotiation: { mode } });
    await client.connect(clientSide);
    return client;
  }

  it('serves a 2026-07-28 client', async () => {
    const client = await connect({ pin: '2026-07-28' });
    expect(client.getProtocolEra()).toBe('modern');
    expect((await client.listTools()).tools).toHaveLength(24);
    await client.close();
  });

  it('still serves a 2025-era client through the initialize handshake', async () => {
    const client = await connect('legacy');
    expect(client.getProtocolEra()).toBe('legacy');
    expect((await client.listTools()).tools).toHaveLength(24);
    await client.close();
  });
});
