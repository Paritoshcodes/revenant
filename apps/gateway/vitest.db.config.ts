import { defineConfig } from 'vitest/config';

/**
 * db tier: requires a live Postgres via DATABASE_URL. Every file under
 * tests/db/ fails loudly in its own beforeAll when DATABASE_URL is unset —
 * never skips silently. See docs/ARCHITECTURE.md, "Regression suite".
 *
 * fileParallelism: false — these files share one live database, and most
 * of them rely on "nothing else commits to audit_log while my own
 * transaction is open" to keep their own before/after row counts clean
 * (audit_log has no per-test namespacing; its seq is one global sequence).
 * audit-concurrency.test.ts genuinely commits rows (by design, see its own
 * doc comment), so running files in parallel let its commits leak into
 * another file's still-open transaction and corrupt its event-sequence
 * assertions. Running files serially is also simply correct practice for
 * a suite whose files share one external, stateful resource.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
