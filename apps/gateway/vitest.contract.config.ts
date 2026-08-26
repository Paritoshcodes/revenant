import { defineConfig } from 'vitest/config';

/**
 * Separate from vitest.config.ts on purpose: that config's
 * `include: ['tests/**\/*.test.ts']` never matches `*.contract.ts`, so the
 * contract test is invisible to `npm test` by construction, not just
 * skipped. This config exists only so `npm run test:contract` can find it.
 *
 * The test itself is still gated on RUN_CONTRACT_TEST inside the file: it
 * launches a real browser and creates real Razorpay test-mode orders, so
 * running this config alone must not be enough to trigger that by accident.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/contract/**/*.contract.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
