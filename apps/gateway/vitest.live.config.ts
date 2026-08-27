import { defineConfig } from 'vitest/config';

/**
 * live tier: requires live Razorpay test mode, a real Playwright browser,
 * and (for the webhook test) a reachable public tunnel. Gated on
 * RUN_LIVE_TESTS=1, checked in each file's own beforeAll — a missing
 * prerequisite fails loudly, it is never silently skipped. Generous
 * timeouts: real browser-driven test-mode payments and a possible zrok
 * tunnel startup. See docs/ARCHITECTURE.md, "Regression suite".
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Files may each try to bind GATEWAY_PORT / start a zrok share; run
    // them one at a time rather than risk two files racing the same port
    // or tunnel name.
    fileParallelism: false,
  },
});
