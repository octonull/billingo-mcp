// tests/transports/stdio.test.ts
import { describe, expect, it } from 'vitest';
import { buildStdioServer } from '../../src/transports/stdio.js';

describe('buildStdioServer', () => {
  it('builds a read-only server from a bare API key', () => {
    const { server, allowWrite } = buildStdioServer({ BILLINGO_API_KEY: 'k' });
    expect(allowWrite).toBe(false);
    expect(server).toBeDefined();
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
