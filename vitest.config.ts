import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/billingo/types.gen.ts', 'src/transports/**'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
