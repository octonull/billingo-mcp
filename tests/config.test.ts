// tests/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadHttpConfig, loadStdioConfig, parseBooleanFlag } from '../src/config.js';

describe('parseBooleanFlag', () => {
  it('treats only explicit true-ish strings as true', () => {
    expect(parseBooleanFlag('true')).toBe(true);
    expect(parseBooleanFlag('1')).toBe(true);
    expect(parseBooleanFlag('TRUE')).toBe(true);
  });

  it('defaults to false for absent or unrecognized values', () => {
    // Anything ambiguous must mean "no writes" — the safe direction.
    expect(parseBooleanFlag(undefined)).toBe(false);
    expect(parseBooleanFlag('')).toBe(false);
    expect(parseBooleanFlag('false')).toBe(false);
    expect(parseBooleanFlag('yes')).toBe(false);
    expect(parseBooleanFlag('maybe')).toBe(false);
  });
});

describe('loadStdioConfig', () => {
  it('reads the key and defaults to read-only against the production base URL', () => {
    const config = loadStdioConfig({ BILLINGO_API_KEY: 'abc' });
    expect(config).toEqual({
      apiKey: 'abc',
      baseUrl: 'https://api.billingo.hu/v3',
      allowWrite: false,
    });
  });

  it('enables writes only on an explicit opt-in', () => {
    expect(
      loadStdioConfig({ BILLINGO_API_KEY: 'abc', BILLINGO_ALLOW_WRITE: 'true' }).allowWrite,
    ).toBe(true);
  });

  it('fails with an actionable message when the key is missing', () => {
    expect(() => loadStdioConfig({})).toThrow(/BILLINGO_API_KEY/);
  });

  it('rejects an empty key rather than sending it to the API', () => {
    expect(() => loadStdioConfig({ BILLINGO_API_KEY: '' })).toThrow(/BILLINGO_API_KEY/);
  });

  it('rejects a base URL that is not a URL', () => {
    expect(() =>
      loadStdioConfig({ BILLINGO_API_KEY: 'a', BILLINGO_BASE_URL: 'not-a-url' }),
    ).toThrow(/BILLINGO_BASE_URL/);
  });
});

describe('loadHttpConfig', () => {
  it('defaults the port to 3000 and takes no API key', () => {
    const config = loadHttpConfig({});
    expect(config.port).toBe(3000);
    expect(config.baseUrl).toBe('https://api.billingo.hu/v3');
    expect(config.allowedHosts).toBeUndefined();
  });

  it('parses a port and a comma-separated host allowlist', () => {
    const config = loadHttpConfig({
      PORT: '8080',
      BILLINGO_ALLOWED_HOSTS: 'mcp.example.com, localhost',
    });
    expect(config.port).toBe(8080);
    expect(config.allowedHosts).toEqual(['mcp.example.com', 'localhost']);
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadHttpConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('leaves commitSha and buildVersion undefined outside a built image', () => {
    const config = loadHttpConfig({});
    expect(config.commitSha).toBeUndefined();
    expect(config.buildVersion).toBeUndefined();
  });

  it('picks up commitSha and buildVersion baked in at build time', () => {
    const config = loadHttpConfig({ COMMIT_SHA: 'abc1234', BUILD_VERSION: '0.1.0' });
    expect(config.commitSha).toBe('abc1234');
    expect(config.buildVersion).toBe('0.1.0');
  });

  it('treats an empty-string BUILD_VERSION the same as unset (Docker ARG with no value)', () => {
    const config = loadHttpConfig({ COMMIT_SHA: 'abc1234', BUILD_VERSION: '' });
    expect(config.commitSha).toBe('abc1234');
    expect(config.buildVersion).toBeUndefined();
  });
});
