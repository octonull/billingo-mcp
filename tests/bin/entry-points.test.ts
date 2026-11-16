// tests/bin/entry-points.test.ts
// The bin files must start their transport unconditionally on import: any "am I the
// entry point?" check is what broke `npx` (issue #31). The transports are mocked, so
// importing the bin files here starts nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stdioMain = vi.fn(() => Promise.resolve());
const httpMain = vi.fn(() => Promise.resolve());

vi.mock('../../src/transports/stdio.js', () => ({ main: stdioMain }));
vi.mock('../../src/transports/http.js', () => ({ main: httpMain }));

beforeEach(() => {
  vi.resetModules();
  stdioMain.mockClear();
  httpMain.mockClear();
});

describe('bin entry points', () => {
  it('stdio starts the stdio transport on import, whatever process.argv says', async () => {
    await import('../../src/bin/stdio.js');
    expect(stdioMain).toHaveBeenCalledOnce();
    expect(httpMain).not.toHaveBeenCalled();
  });

  it('http starts the HTTP transport on import', async () => {
    await import('../../src/bin/http.js');
    expect(httpMain).toHaveBeenCalledOnce();
    expect(stdioMain).not.toHaveBeenCalled();
  });
});
