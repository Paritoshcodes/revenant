/**
 * Integration test against a real Postgres database.
 *
 * Same technique as audit-integration.test.ts and recovery-integration.test.ts:
 * audit_log rejects DELETE as well as UPDATE and TRUNCATE, so anything
 * committed here would sit in the table forever. Everything runs inside one
 * transaction that is rolled back at the end.
 *
 * Skipped when DATABASE_URL is not configured, so the rest of the suite
 * still runs on a machine without a local Postgres.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ok } from '@revenant/contracts';

import { fetchChain } from '../src/audit/reader.js';
import type { TransactionClient } from '../src/audit/types.js';
import { verifyChain } from '../src/audit/verify.js';
import { reconcileTransaction } from '../src/recovery/reconcile.js';
import { createFakeRazorpayClient } from './support/fake-razorpay-client.js';
import type { RzpOrder, RzpPayment, RzpPaymentLink } from '../src/razorpay/types.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '.env') });

const databaseUrl = process.env['DATABASE_URL'];

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

const insertTransaction = (
  client: TransactionClient,
  id: string,
  overrides: { rzpOrderId?: string | null; rzpPaymentLinkId?: string | null } = {},
) =>
  client.query(
    `INSERT INTO transactions (id, rzp_order_id, rzp_payment_link_id, amount_paise, arm, status)
     VALUES ($1, $2, $3, $4, 'treatment', 'open')`,
    [id, overrides.rzpOrderId ?? null, overrides.rzpPaymentLinkId ?? 'plink_reconcile_it', 49_900],
  );

const insertPendingAttempt = (client: TransactionClient, transactionId: string, attemptNumber: number) =>
  client.query(
    `INSERT INTO attempts (transaction_id, attempt_number, idempotency_key, outcome)
     VALUES ($1, $2, $3, 'pending')`,
    [transactionId, attemptNumber, `${transactionId}:${attemptNumber}`],
  );

describe.skipIf(!databaseUrl)('reconcileTransaction against a live database', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it('resolves a pending attempt against a real captured payment, closes the transaction, and extends a verifiable audit chain', async () => {
    await client.query('BEGIN');
    try {
      const transactionId = 'txn_reconcile_integration_captured';
      await insertTransaction(client as TransactionClient, transactionId, { rzpOrderId: 'order_it_1' });
      await insertPendingAttempt(client as TransactionClient, transactionId, 1);

      const before = await fetchChain(client as TransactionClient);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const startingPrevHash =
        before.value.length > 0 ? before.value[before.value.length - 1]!.hash : '0'.repeat(64);

      const razorpay = createFakeRazorpayClient({
        fetchOrder: async () =>
          ok<RzpOrder>({
            id: 'order_it_1',
            entity: 'order',
            amount: 49_900,
            amount_paid: 49_900,
            amount_due: 0,
            currency: 'INR',
            receipt: null,
            status: 'paid',
            attempts: 1,
            notes: [],
            created_at: 1_700_000_000,
          }),
        fetchOrderPayments: async () =>
          ok({
            entity: 'collection' as const,
            count: 1,
            items: [
              {
                id: 'pay_reconcile_it',
                entity: 'payment' as const,
                amount: 49_900,
                currency: 'INR',
                status: 'captured' as const,
                order_id: 'order_it_1',
                method: 'card',
                captured: true,
                card: null,
                description: null,
                notes: [],
                error_code: null,
                error_description: null,
                error_source: null,
                error_step: null,
                error_reason: null,
                acquirer_data: { auth_code: '112693' },
                created_at: 1_700_000_100,
              } satisfies RzpPayment,
            ],
          }),
      });

      const result = await reconcileTransaction(client as TransactionClient, razorpay, transactionId, {
        now: () => NOW,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        orderId: 'order_it_1',
        attemptCountDivergence: false,
        transactionStatus: 'recovered',
      });
      expect(result.value.pendingAttempts).toEqual([
        {
          attemptId: expect.any(Number),
          attemptNumber: 1,
          idempotencyKey: `${transactionId}:1`,
          resolution: 'settled_now',
          outcome: 'captured',
          rzpPaymentId: 'pay_reconcile_it',
        },
      ]);

      // -- the underlying rows really changed -----------------------------

      const attemptRows = await client.query(
        'SELECT outcome, rzp_payment_id, auth_code FROM attempts WHERE transaction_id = $1',
        [transactionId],
      );
      expect(attemptRows.rows).toEqual([
        { outcome: 'captured', rzp_payment_id: 'pay_reconcile_it', auth_code: '112693' },
      ]);

      const txnRows = await client.query('SELECT status FROM transactions WHERE id = $1', [transactionId]);
      expect(txnRows.rows).toEqual([{ status: 'recovered' }]);

      // -- and the audit chain is a verifiable extension of the tail ------

      const after = await fetchChain(client as TransactionClient);
      expect(after.ok).toBe(true);
      if (!after.ok) return;

      const newRows = after.value.slice(before.value.length);
      expect(newRows.map((row) => (row.payload as { kind: string }).kind)).toEqual([
        'attempt_settled',
        'transaction_closed',
      ]);

      const verification = verifyChain(newRows, startingPrevHash);
      expect(verification).toEqual({ ok: true, rowsVerified: newRows.length });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('discovers the order id via the payment link, persists it, and leaves a pending attempt pending on status "created"', async () => {
    await client.query('BEGIN');
    try {
      const transactionId = 'txn_reconcile_integration_pending';
      await insertTransaction(client as TransactionClient, transactionId, {
        rzpOrderId: null,
        rzpPaymentLinkId: 'plink_reconcile_it_2',
      });
      await insertPendingAttempt(client as TransactionClient, transactionId, 1);

      const razorpay = createFakeRazorpayClient({
        fetchPaymentLink: async () =>
          ok<RzpPaymentLink>({
            id: 'plink_reconcile_it_2',
            entity: 'payment_link',
            amount: 49_900,
            currency: 'INR',
            status: 'created',
            short_url: 'https://rzp.io/rzp/reconcile-it-2',
            order_id: 'order_it_2',
            reference_id: null,
            description: null,
            amount_paid: 0,
            notes: [],
            created_at: 1_700_000_000,
          }),
        fetchOrder: async () =>
          ok<RzpOrder>({
            id: 'order_it_2',
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
          }),
        fetchOrderPayments: async () =>
          ok({
            entity: 'collection' as const,
            count: 1,
            items: [
              {
                id: 'pay_reconcile_it_2',
                entity: 'payment' as const,
                amount: 49_900,
                currency: 'INR',
                status: 'created' as const,
                order_id: 'order_it_2',
                method: 'card',
                captured: false,
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
              } satisfies RzpPayment,
            ],
          }),
      });

      const result = await reconcileTransaction(client as TransactionClient, razorpay, transactionId, {
        now: () => NOW,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.orderId).toBe('order_it_2');
      expect(result.value.pendingAttempts).toEqual([
        {
          attemptId: expect.any(Number),
          attemptNumber: 1,
          idempotencyKey: `${transactionId}:1`,
          resolution: 'still_pending',
          outcome: 'pending',
          rzpPaymentId: 'pay_reconcile_it_2',
        },
      ]);

      const txnRows = await client.query(
        'SELECT rzp_order_id, status FROM transactions WHERE id = $1',
        [transactionId],
      );
      expect(txnRows.rows).toEqual([{ rzp_order_id: 'order_it_2', status: 'open' }]);

      const attemptRows = await client.query('SELECT outcome FROM attempts WHERE transaction_id = $1', [
        transactionId,
      ]);
      expect(attemptRows.rows).toEqual([{ outcome: 'pending' }]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
