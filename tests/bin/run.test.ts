// tests/bin/run.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/bin/run.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('run', () => {
  it('starts main without exiting when it succeeds', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const main = vi.fn(() => Promise.resolve());
    run(main);
    await vi.waitFor(() => {
      expect(main).toHaveBeenCalledOnce();
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it('prints the error message and exits 1 when main rejects with an Error', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    run(() => Promise.reject(new Error('BILLINGO_API_KEY is required')));
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    expect(log).toHaveBeenCalledWith('BILLINGO_API_KEY is required');
  });

  it('stringifies a non-Error rejection', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error path is what is under test
    run(() => Promise.reject('boom'));
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    expect(log).toHaveBeenCalledWith('boom');
  });
});
