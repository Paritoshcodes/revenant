import { defineConfig } from 'vitest/config';

/**
 * Unit tier: pure, no I/O, no network, no database. This is `npm test`'s
 * config — the fast default every commit runs. See docs/ARCHITECTURE.md,
 * "Regression suite".
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
