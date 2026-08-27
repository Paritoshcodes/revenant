/**
 * Integration test against a real Postgres database.
 *
 * `npm run batch --concurrency 4` has been run for real (docs/DECISIONS.md,
 * "batch runner gets a labelled stand-in outcome model"), but nothing ever
 * asserted it produced no duplicates. This is that assertion, at the layer
 * where it actually matters: createIdempotencyStore.reserve()'s
 * `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` is a single atomic
 * statement, so real concurrency needs real separate connections racing a
 * real unique index, not a simulation.
 *
 * This is the one file in the db tier that deliberately does NOT use the
 * rolled-back-transaction pattern the other integration tests use.
 * `ON CONFLICT DO NOTHING` across concurrent UNCOMMITTED transactions does
 * not produce a stable winner: whichever transaction is still holding the
 * row when another one's insert blocks on it will, once it rolls back,
 * let the blocked insert through too — so "exactly one reserve() succeeds"
 * cannot be asserted without letting the winner's row actually commit.
 * `createIdempotencyStore.reserve()` needs only a `Queryable`
 * (`.query()`), so the fix is to pass the raw `pg.Pool` directly rather
 * than a single checked-out client: each concurrent `.reserve()` call is
 * then a genuinely separate connection issuing one autocommitted
 * statement, exactly like N independent browser workers would. Cleanup is
 * explicit — commit, then delete what was written, verified by a
 * zero-row follow-up SELECT — since `attempts`/`transactions` (unlike
 * `audit_log`) carry no append-only trigger and can be cleaned up safely.
 *
 * db tier: requires a real Postgres. FAILS LOUDLY (not skipped) when
 * DATABASE_URL is not configured — see docs/ARCHITECTURE.md, "Regression
 * suite".
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createIdempotencyStore } from '../../src/recovery/idempotency-store.js';
import type { Reservation } from '../../src/recovery/idempotency-store.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '..', '.env') });

const databaseUrl = process.env['DATABASE_URL'];

const CONCURRENCY = 10;

describe('idempotency under real concurrency', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error(
        'tests/db/idempotency-concurrency.test.ts requires DATABASE_URL to be set ' +
          '(it runs against a real Postgres). Run `npm run test:db` with a ' +
          'reachable database instead of skipping this file.',
      );
    }
    pool = new pg.Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it(`exactly one of ${CONCURRENCY} concurrent reserve() calls for the same key succeeds, the rest report duplicate`, async () => {
    const transactionId = `txn_idem_concurrency_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    await pool.query(
      `INSERT INTO transactions (id, amount_paise, arm, status) VALUES ($1, $2, 'treatment', 'open')`,
      [transactionId, 49_900],
    );

    try {
      const store = createIdempotencyStore(pool);

      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => store.reserve(transactionId, 1)),
      );

      for (const result of results) {
        expect(result.ok).toBe(true);
      }
      const reservations = results
        .filter((r): r is { ok: true; value: Reservation } => r.ok)
        .map((r) => r.value);

      const reserved = reservations.filter((r) => r.status === 'reserved');
      const duplicates = reservations.filter((r) => r.status === 'duplicate');

      expect(reserved).toHaveLength(1);
      expect(duplicates).toHaveLength(CONCURRENCY - 1);

      // Every duplicate saw the SAME winner, not a mix of different rows.
      const winnerAttemptId = reserved[0]!.attemptId;
      for (const duplicate of duplicates) {
        expect(duplicate.status).toBe('duplicate');
        if (duplicate.status !== 'duplicate') continue;
        expect(duplicate.existing?.attemptId).toBe(winnerAttemptId);
      }

      // Exactly one row landed in the real table, not one per racer.
      const attemptRows = await pool.query(
        'SELECT id FROM attempts WHERE transaction_id = $1',
        [transactionId],
      );
      expect(attemptRows.rows).toHaveLength(1);
    } finally {
      await pool.query('DELETE FROM attempts WHERE transaction_id = $1', [transactionId]);
      await pool.query('DELETE FROM transactions WHERE id = $1', [transactionId]);

      const attemptsLeft = await pool.query(
        'SELECT id FROM attempts WHERE transaction_id = $1',
        [transactionId],
      );
      const transactionsLeft = await pool.query('SELECT id FROM transactions WHERE id = $1', [
        transactionId,
      ]);
      expect(attemptsLeft.rows).toHaveLength(0);
      expect(transactionsLeft.rows).toHaveLength(0);
    }
  });

  it('rejects a duplicate idempotency_key and a duplicate (transaction_id, attempt_number) at the schema level', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const transactionId = 'txn_idem_schema_check';
      await client.query(
        `INSERT INTO transactions (id, amount_paise, arm, status) VALUES ($1, $2, 'treatment', 'open')`,
        [transactionId, 49_900],
      );
      await client.query(
        `INSERT INTO attempts (transaction_id, attempt_number, idempotency_key, outcome)
         VALUES ($1, 1, $2, 'pending')`,
        [transactionId, `${transactionId}:1`],
      );

      // Same idempotency_key, different attempt_number: the UNIQUE
      // constraint on idempotency_key alone must still reject it.
      await expect(
        client.query(
          `INSERT INTO attempts (transaction_id, attempt_number, idempotency_key, outcome)
           VALUES ($1, 2, $2, 'pending')`,
          [transactionId, `${transactionId}:1`],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);

      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO transactions (id, amount_paise, arm, status) VALUES ($1, $2, 'treatment', 'open')`,
        [transactionId, 49_900],
      );
      await client.query(
        `INSERT INTO attempts (transaction_id, attempt_number, idempotency_key, outcome)
         VALUES ($1, 1, $2, 'pending')`,
        [transactionId, `${transactionId}:1`],
      );

      // Same (transaction_id, attempt_number), a differently-shaped key:
      // the composite UNIQUE constraint must reject this independently of
      // the idempotency_key constraint above.
      await expect(
        client.query(
          `INSERT INTO attempts (transaction_id, attempt_number, idempotency_key, outcome)
           VALUES ($1, 1, $2, 'pending')`,
          [transactionId, `${transactionId}:1:reshaped`],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
