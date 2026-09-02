import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sequential: these tests share one sandbox account and a 300 req/min budget.
    fileParallelism: false,
    retry: 0,
  },
});
