// tests/scaffold.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('scaffold', () => {
  it('vendors both spec documents with the expected versions', () => {
    const v14 = JSON.parse(readFileSync('spec/billingo-3.0.14.json', 'utf8')) as {
      info: { version: string };
    };
    const v15 = JSON.parse(readFileSync('spec/billingo-3.0.15.json', 'utf8')) as {
      info: { version: string };
    };
    expect(v14.info.version).toBe('3.0.14');
    expect(v15.info.version).toBe('3.0.15');
  });

  it('vendors the partner-by-id operations only 3.0.14 documents', () => {
    const v14 = JSON.parse(readFileSync('spec/billingo-3.0.14.json', 'utf8')) as {
      paths: Record<string, unknown>;
    };
    const v15 = JSON.parse(readFileSync('spec/billingo-3.0.15.json', 'utf8')) as {
      paths: Record<string, unknown>;
    };
    expect(v14.paths['/partners/{id}']).toBeDefined();
    expect(v15.paths['/partners/{id}']).toBeUndefined();
  });
});
