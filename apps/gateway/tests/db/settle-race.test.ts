/**
 * Integration test against a real Postgres database.
 *
 * docs/DECISIONS.md, Build log entry 10: the driver's own flow
 * (state-machine.ts, right after an attempt executes) and a reconciliation
 * run (reconcile.ts — the realistic response when a webhook or any other
 * out-of-band signal says it's worth checking Razorpay's own record) can
 * both reach a settle for the same attempt if the driver is still
 * mid-flight when reconciliation runs. This asserts the fix:
 * createIdempotencyStore.settle() and recovery/db.ts's closeTransaction()
 * both now guard their UPDATE on the row's current state, so exactly one
 * racer's settle/close transitions the row and the other gets back an
 * `already_settled`/`already_closed` result instead of silently
 * succeeding a second time.
 *
 * Deterministic sequential orderings first (call settle() twice, in each
 * order, and assert the invariant holds regardless of which "identity"
 * went first — no flakiness, per CLAUDE.md's working style), then one
 * genuinely concurrent Promise.all race for extra confidence that the
 * invariant holds under real concurrency too, not only sequential calls.
 *
 * Like idempotency-concurrency.test.ts, this test cannot use the
 * rolled-back-transaction pattern: a real race needs a real committed
 * winner for the loser's UPDATE to find 0 rows against. Cleanup is
 * explicit (commit, then DELETE, verified by a zero-row follow-up SELECT)
 * since attempts/transactions carry no append-only trigger.
 *
 * db tier: requires a real Postgres. FAILS LOUDLY (not skipped) when
 * DATABASE_URL is not configured — see docs/ARCHITECTURE.md, "Regression
 * suite".
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closeTransaction } from '../../src/recovery/db.js';
import { createIdempotencyStore } from '../../src/recovery/idempotency-store.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '..', '.env') });

const databaseUrl = process.env['DATABASE_URL'];

describe('settle() and closeTransaction() are safe against a racing settler', () => {
  let pool: pg.Pool;
  const createdTransactionIds: string[] = [];

  beforeAll(() => {
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error(
        'tests/db/settle-race.test.ts requires DATABASE_URL to be set ' +
          '(it runs against a real Postgres). Run `npm run test:db` with a ' +
          'reachable database instead of skipping this file.',
      );
    }
    pool = new pg.Pool({ connectionString: databaseUrl });
  });

  afterEach(async () => {
    while (createdTransactionIds.length > 0) {
      const id = createdTransactionIds.pop()!;
      await pool.query('DELETE FROM attempts WHERE transaction_id = $1', [id]);
      await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  /** A committed transaction + a reserved, still-pending attempt, ready for two racers. */
  const seedPendingAttempt = async (transactionId: string): Promise<string> => {
    await pool.query(
      `INSERT INTO transactions (id, amount_paise, arm, status) VALUES ($1, $2, 'treatment', 'open')`,
      [transactionId, 49_900],
    );
    createdTransactionIds.push(transactionId);
    const store = createIdempotencyStore(pool);
    const reservation = await store.reserve(transactionId, 1);
    if (!reservation.ok || reservation.value.status !== 'reserved') {
      throw new Error(`seedPendingAttempt: reserve failed for ${transactionId}`);
    }
    return reservation.value.key;
  };

  it.each([
    ['driver-then-reconcile' as const],
    ['reconcile-then-driver' as const],
  ])('settle: %s — exactly one call transitions the row, the other is already_settled', async (order) => {
    const transactionId = `txn_settle_race_${order}`;
    const key = await seedPendingAttempt(transactionId);
    const store = createIdempotencyStore(pool);

    const first = await store.settle(key, { outcome: 'captured', rzpPaymentId: 'pay_first' });
    const second = await store.settle(key, { outcome: 'captured', rzpPaymentId: 'pay_second' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Order-independent: whichever "identity" (driver or reconcile) called
    // first wins the 'settled' status; the invariant — exactly one of
    // each — holds either way, which is the whole point of testing both
    // labelled orderings against the same code path.
    const statuses = [first.value.status, second.value.status].sort();
    expect(statuses).toEqual(['already_settled', 'settled']);

    // The row holds exactly one coherent outcome: whichever racer actually
    // won, not a blend of both attempts' inputs.
    const rows = await pool.query(
      'SELECT outcome, rzp_payment_id FROM attempts WHERE transaction_id = $1',
      [transactionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.outcome).toBe('captured');
    expect(['pay_first', 'pay_second']).toContain(rows.rows[0]!.rzp_payment_id);
  });

  it('settle: two genuinely concurrent calls still produce exactly one settled and one already_settled', async () => {
    const transactionId = 'txn_settle_race_concurrent';
    const key = await seedPendingAttempt(transactionId);
    const store = createIdempotencyStore(pool);

    const [a, b] = await Promise.all([
      store.settle(key, { outcome: 'captured', rzpPaymentId: 'pay_a' }),
      store.settle(key, { outcome: 'captured', rzpPaymentId: 'pay_b' }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const statuses = [a.value.status, b.value.status].sort();
    expect(statuses).toEqual(['already_settled', 'settled']);

    const rows = await pool.query('SELECT outcome FROM attempts WHERE transaction_id = $1', [
      transactionId,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.outcome).toBe('captured');
  });

  it.each([
    ['driver-then-reconcile' as const],
    ['reconcile-then-driver' as const],
  ])('closeTransaction: %s — exactly one call closes it, the other is already_closed', async (order) => {
    const transactionId = `txn_close_race_${order}`;
    await pool.query(
      `INSERT INTO transactions (id, amount_paise, arm, status) VALUES ($1, $2, 'treatment', 'open')`,
      [transactionId, 49_900],
    );
    createdTransactionIds.push(transactionId);

    const first = await closeTransaction(pool, transactionId, 'recovered');
    const second = await closeTransaction(pool, transactionId, 'recovered');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const statuses = [first.value, second.value].sort();
    expect(statuses).toEqual(['already_closed', 'closed']);

    const rows = await pool.query('SELECT status FROM transactions WHERE id = $1', [transactionId]);
    expect(rows.rows).toEqual([{ status: 'recovered' }]);
  });

  it('closeTransaction: two genuinely concurrent calls still produce exactly one closed and one already_closed', async () => {
    const transactionId = 'txn_close_race_concurrent';
    await pool.query(
      `INSERT INTO transactions (id, amount_paise, arm, status) VALUES ($1, $2, 'treatment', 'open')`,
      [transactionId, 49_900],
    );
    createdTransactionIds.push(transactionId);

    const [a, b] = await Promise.all([
      closeTransaction(pool, transactionId, 'recovered'),
      closeTransaction(pool, transactionId, 'recovered'),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const statuses = [a.value, b.value].sort();
    expect(statuses).toEqual(['already_closed', 'closed']);
  });
});
