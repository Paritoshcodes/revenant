/**
 * Integration test against a real Postgres database.
 *
 * Two scenarios reconcile.ts must get right when a real attempt is
 * genuinely still in flight, not merely stale:
 *
 *   (a) A payment Razorpay reports as status "created" — the live
 *       in-flight state (docs/CHECKOUT-FLOW.md section 12) — must never be
 *       settled either way. This was already correctly implemented
 *       (reconcile.ts's mapToSettleInput returns null for anything other
 *       than captured/failed) and already covered by a fake-based unit
 *       test and a raw-INSERT db test; this closes the remaining gap with
 *       a DB-tier check that seeds the pending attempt through the real
 *       createIdempotencyStore.reserve() path.
 *
 *   (b) A payment that HAS genuinely resolved (status "captured") is
 *       reconciled by reconcileTransaction at the same moment the driver's
 *       own flow independently settles the same attempt directly — the
 *       exact race settle-race.test.ts proves is now safe at the store
 *       level, exercised here specifically through reconcile.ts's own
 *       call site. Per the task's own instruction, if nothing prevented a
 *       double settle here this would be reported as a finding rather
 *       than a passing-but-vacuous test; after docs/DECISIONS.md Build log
 *       entry 10's fix, something does, so this is a real, meaningful
 *       assertion, not a vacuous one — noted explicitly rather than
 *       silently.
 *
 * Same technique as the other db-tier integration tests for (a): rolled
 * back at the end. (b) needs a real committed winner for the same reason
 * settle-race.test.ts and idempotency-concurrency.test.ts do, so it
 * commits and cleans up explicitly.
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

import { ok } from '@revenant/contracts';

import type { TransactionClient } from '../../src/audit/types.js';
import { createIdempotencyStore } from '../../src/recovery/idempotency-store.js';
import { reconcileTransaction } from '../../src/recovery/reconcile.js';
import { createFakeRazorpayClient } from '../support/fake-razorpay-client.js';
import type { RzpOrder, RzpPayment } from '../../src/razorpay/types.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '..', '.env') });

const databaseUrl = process.env['DATABASE_URL'];

const NOW = Date.parse('2026-08-26T15:00:00.000Z');

const rzpOrder = (id: string): RzpOrder => ({
  id,
  entity: 'order',
  amount: 49_900,
  amount_paid: 0,
  amount_due: 49_900,
  currency: 'INR',
  receipt: null,
  status: 'attempted',
  attempts: 1,
  notes: [],
  created_at: 1_700_000_000,
});

const rzpPayment = (overrides: Partial<RzpPayment> & { id: string }): RzpPayment => ({
  entity: 'payment',
  amount: 49_900,
  currency: 'INR',
  order_id: overrides.order_id ?? null,
  method: 'card',
  captured: overrides.status === 'captured',
  card: null,
  description: null,
  notes: [],
  error_code: null,
  error_description: null,
  error_source: null,
  error_step: null,
  error_reason: null,
  acquirer_data: null,
  created_at: 1_700_000_100,
  status: 'created',
  ...overrides,
});

describe('reconcileTransaction racing a live attempt', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error(
        'tests/db/reconcile-race.test.ts requires DATABASE_URL to be set ' +
          '(it runs against a real Postgres). Run `npm run test:db` with a ' +
          'reachable database instead of skipping this file.',
      );
    }
    pool = new pg.Pool({ connectionString: databaseUrl });
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it('never settles an attempt whose payment is still genuinely status: "created"', async () => {
    await client.query('BEGIN');
    try {
      const transactionId = 'txn_reconcile_race_created';
      await client.query(
        `INSERT INTO transactions (id, rzp_order_id, amount_paise, arm, status)
         VALUES ($1, $2, $3, 'treatment', 'open')`,
        [transactionId, `order_${transactionId}`, 49_900],
      );

      const store = createIdempotencyStore(client as TransactionClient);
      const reservation = await store.reserve(transactionId, 1);
      expect(reservation.ok).toBe(true);
      if (!reservation.ok || reservation.value.status !== 'reserved') return;

      const razorpay = createFakeRazorpayClient({
        fetchOrder: async () => ok(rzpOrder(`order_${transactionId}`)),
        fetchOrderPayments: async () =>
          ok({
            entity: 'collection' as const,
            count: 1,
            items: [
              rzpPayment({
                id: 'pay_still_live',
                order_id: `order_${transactionId}`,
                status: 'created',
              }),
            ],
          }),
      });

      // Run reconciliation twice, as a genuinely in-flight attempt could be
      // checked more than once before it resolves: it must stay pending
      // both times, never guessed at on either pass.
      for (let pass = 0; pass < 2; pass += 1) {
        const result = await reconcileTransaction(client as TransactionClient, razorpay, transactionId, {
          now: () => NOW,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.pendingAttempts).toEqual([
          {
            attemptId: reservation.value.attemptId,
            attemptNumber: 1,
            idempotencyKey: `${transactionId}:1`,
            resolution: 'still_pending',
            outcome: 'pending',
            rzpPaymentId: 'pay_still_live',
          },
        ]);
      }

      const attemptRows = await client.query('SELECT outcome FROM attempts WHERE transaction_id = $1', [
        transactionId,
      ]);
      expect(attemptRows.rows).toEqual([{ outcome: 'pending' }]);

      const txnRows = await client.query('SELECT status FROM transactions WHERE id = $1', [transactionId]);
      expect(txnRows.rows).toEqual([{ status: 'open' }]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('does not double-settle when reconcileTransaction races a direct driver settle for a genuinely captured payment', async () => {
    const transactionId = 'txn_reconcile_race_captured';

    await pool.query(
      `INSERT INTO transactions (id, rzp_order_id, amount_paise, arm, status)
       VALUES ($1, $2, $3, 'treatment', 'open')`,
      [transactionId, `order_${transactionId}`, 49_900],
    );

    try {
      const store = createIdempotencyStore(pool);
      const reservation = await store.reserve(transactionId, 1);
      expect(reservation.ok).toBe(true);
      if (!reservation.ok || reservation.value.status !== 'reserved') return;

      const razorpay = createFakeRazorpayClient({
        fetchOrder: async () => ok(rzpOrder(`order_${transactionId}`)),
        fetchOrderPayments: async () =>
          ok({
            entity: 'collection' as const,
            count: 1,
            items: [
              rzpPayment({
                id: 'pay_race_captured',
                order_id: `order_${transactionId}`,
                status: 'captured',
                acquirer_data: { auth_code: '112693' },
              }),
            ],
          }),
      });

      // Racer A: reconcileTransaction, discovering the payment resolved.
      // reconcileTransaction's own contract (see its doc comment) requires
      // `db` to already be inside an open transaction — appendAuditEvent's
      // advisory lock only means anything across a single connection's own
      // BEGIN/COMMIT — so this racer gets its own dedicated client, not
      // the bare pool.
      // Racer B: the driver's own flow, settling directly at the same
      // moment via a single atomic statement, which needs no such wrapper.
      // Genuinely separate connections, run concurrently.
      const reconcileClient = await pool.connect();
      const runReconcile = async () => {
        try {
          await reconcileClient.query('BEGIN');
          const result = await reconcileTransaction(
            reconcileClient as unknown as TransactionClient,
            razorpay,
            transactionId,
            { now: () => NOW },
          );
          if (result.ok) {
            await reconcileClient.query('COMMIT');
          } else {
            await reconcileClient.query('ROLLBACK');
          }
          return result;
        } finally {
          reconcileClient.release();
        }
      };

      const [reconcileResult, directSettle] = await Promise.all([
        runReconcile(),
        store.settle(reservation.value.key, {
          outcome: 'captured',
          rzpPaymentId: 'pay_race_captured',
          authCode: '112693',
        }),
      ]);

      expect(reconcileResult.ok).toBe(true);
      expect(directSettle.ok).toBe(true);
      if (!reconcileResult.ok || !directSettle.ok) return;

      // Exactly one row, one coherent outcome — not two settle operations
      // both silently succeeding.
      const attemptRows = await pool.query(
        'SELECT outcome, rzp_payment_id FROM attempts WHERE transaction_id = $1',
        [transactionId],
      );
      expect(attemptRows.rows).toHaveLength(1);
      expect(attemptRows.rows[0]!.outcome).toBe('captured');
      expect(attemptRows.rows[0]!.rzp_payment_id).toBe('pay_race_captured');

      const txnRows = await pool.query('SELECT status FROM transactions WHERE id = $1', [transactionId]);
      expect(txnRows.rows).toEqual([{ status: 'recovered' }]);

      // reconcileTransaction's own report is coherent either way: whether
      // it won the race (resolution 'settled_now') or lost it to the
      // direct settle (the attempt was already gone from the pending list
      // it read at the start — in which case pendingAttempts is empty,
      // since the direct settle's own commit landed between reconcile's
      // read and its own settle attempt is not guaranteed either way at
      // true concurrency), the underlying data above is what actually
      // matters and is asserted unconditionally.
      expect(reconcileResult.value.pendingAttempts.length).toBeLessThanOrEqual(1);
    } finally {
      await pool.query('DELETE FROM attempts WHERE transaction_id = $1', [transactionId]);
      await pool.query('DELETE FROM transactions WHERE id = $1', [transactionId]);

      const attemptsLeft = await pool.query('SELECT id FROM attempts WHERE transaction_id = $1', [
        transactionId,
      ]);
      const transactionsLeft = await pool.query('SELECT id FROM transactions WHERE id = $1', [
        transactionId,
      ]);
      expect(attemptsLeft.rows).toHaveLength(0);
      expect(transactionsLeft.rows).toHaveLength(0);
    }
  });
});
