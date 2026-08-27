/**
 * Integration test against a real Postgres database.
 *
 * reconcile-integration.test.ts already covers reconcileTransaction end to
 * end, but its pending attempt is seeded with a raw INSERT. This file
 * seeds it through createIdempotencyStore(client).reserve() instead — the
 * real path a crashed browser session would have taken — then never calls
 * .settle(), simulating exactly what "pending" means in
 * docs/ARCHITECTURE.md: "reserved but unresolved... the row was written
 * before the outbound call and no result has come back yet." Three cases,
 * matching reconcile.ts's own mapToSettleInput: a payment fetched as
 * captured or failed must be settled now; one fetched as "created" — the
 * live in-flight state (docs/CHECKOUT-FLOW.md section 12) — must stay
 * pending, never guessed at either way.
 *
 * Same technique as the other db-tier integration tests: everything runs
 * inside one transaction per test, rolled back at the end, leaving zero
 * permanent rows.
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

const NOW = Date.parse('2026-08-26T13:00:00.000Z');

const insertTransaction = (client: TransactionClient, id: string) =>
  client.query(
    `INSERT INTO transactions (id, rzp_order_id, amount_paise, arm, status)
     VALUES ($1, $2, $3, 'treatment', 'open')`,
    [id, `order_${id}`, 49_900],
  );

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

describe('reconcileTransaction against a genuinely orphaned attempt', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error(
        'tests/db/reconcile-orphan.test.ts requires DATABASE_URL to be set ' +
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

  it('settles a genuinely orphaned attempt whose payment resolved captured', async () => {
    await client.query('BEGIN');
    try {
      const transactionId = 'txn_orphan_captured';
      await insertTransaction(client as TransactionClient, transactionId);

      const store = createIdempotencyStore(client as TransactionClient);
      const reservation = await store.reserve(transactionId, 1);
      expect(reservation.ok).toBe(true);
      if (!reservation.ok || reservation.value.status !== 'reserved') return;
      // Simulating a crash: reserved, then the process died before .settle()
      // was ever called. No further store call happens on this attempt
      // outside reconcileTransaction itself.

      const razorpay = createFakeRazorpayClient({
        fetchOrder: async () => ok(rzpOrder(`order_${transactionId}`)),
        fetchOrderPayments: async () =>
          ok({
            entity: 'collection' as const,
            count: 1,
            items: [
              rzpPayment({
                id: 'pay_orphan_captured',
                order_id: `order_${transactionId}`,
                status: 'captured',
                acquirer_data: { auth_code: '112693' },
              }),
            ],
          }),
      });

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
          resolution: 'settled_now',
          outcome: 'captured',
          rzpPaymentId: 'pay_orphan_captured',
        },
      ]);

      const attemptRows = await client.query('SELECT outcome FROM attempts WHERE transaction_id = $1', [
        transactionId,
      ]);
      expect(attemptRows.rows).toEqual([{ outcome: 'captured' }]);

      const txnRows = await client.query('SELECT status FROM transactions WHERE id = $1', [transactionId]);
      expect(txnRows.rows).toEqual([{ status: 'recovered' }]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('settles a genuinely orphaned attempt whose payment resolved failed', async () => {
    await client.query('BEGIN');
    try {
      const transactionId = 'txn_orphan_failed';
      await insertTransaction(client as TransactionClient, transactionId);

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
                id: 'pay_orphan_failed',
                order_id: `order_${transactionId}`,
                status: 'failed',
                error_code: 'BAD_REQUEST_ERROR',
                error_source: 'gateway',
                error_step: 'payment_authorization',
                error_reason: 'payment_failed',
              }),
            ],
          }),
      });

      const result = await reconcileTransaction(client as TransactionClient, razorpay, transactionId, {
        now: () => NOW,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pendingAttempts[0]).toMatchObject({
        resolution: 'settled_now',
        outcome: 'failed',
        rzpPaymentId: 'pay_orphan_failed',
      });

      const attemptRows = await client.query('SELECT outcome FROM attempts WHERE transaction_id = $1', [
        transactionId,
      ]);
      expect(attemptRows.rows).toEqual([{ outcome: 'failed' }]);

      // A single failed attempt does not close the transaction: there is
      // still budget for a retry, so it must stay open, not be assumed
      // abandoned.
      const txnRows = await client.query('SELECT status FROM transactions WHERE id = $1', [transactionId]);
      expect(txnRows.rows).toEqual([{ status: 'open' }]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('leaves a genuinely orphaned attempt pending when Razorpay still reports it as "created"', async () => {
    await client.query('BEGIN');
    try {
      const transactionId = 'txn_orphan_created';
      await insertTransaction(client as TransactionClient, transactionId);

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
                id: 'pay_orphan_created',
                order_id: `order_${transactionId}`,
                status: 'created',
              }),
            ],
          }),
      });

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
          rzpPaymentId: 'pay_orphan_created',
        },
      ]);

      // Never settled either way: the row genuinely is still pending in
      // the database, not merely reported as such.
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
});
