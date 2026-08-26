import { describe, expect, it } from 'vitest';

import { ok } from '@revenant/contracts';

import { reconcileTransaction } from '../src/recovery/reconcile.js';
import type { RzpOrder, RzpPayment, RzpPaymentLink } from '../src/razorpay/types.js';
import { auditKinds, createFakeRecoveryDb } from './support/fake-recovery-db.js';
import type { FakeAttemptRow, FakeTransactionRow } from './support/fake-recovery-db.js';
import { createFakeRazorpayClient } from './support/fake-razorpay-client.js';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

const transaction = (overrides: Partial<FakeTransactionRow> = {}): FakeTransactionRow => ({
  id: 'txn_1',
  rzp_order_id: null,
  rzp_payment_link_id: 'plink_1',
  amount_paise: 49_900,
  arm: 'treatment',
  status: 'open',
  ...overrides,
});

const pendingAttempt = (overrides: Partial<FakeAttemptRow> = {}): FakeAttemptRow => ({
  id: 1,
  transaction_id: 'txn_1',
  attempt_number: 1,
  idempotency_key: 'txn_1:1',
  rzp_payment_id: null,
  error_code: null,
  error_source: null,
  error_step: null,
  error_reason: null,
  auth_code: null,
  outcome: 'pending',
  created_at: '2026-08-26T11:00:00.000Z',
  ...overrides,
});

const rzpPayment = (overrides: Partial<RzpPayment> = {}): RzpPayment => ({
  id: 'pay_1',
  entity: 'payment',
  amount: 49_900,
  currency: 'INR',
  status: 'created',
  order_id: 'order_1',
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
  created_at: 1_700_000_000,
  ...overrides,
});

const rzpOrder = (overrides: Partial<RzpOrder> = {}): RzpOrder => ({
  id: 'order_1',
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
  ...overrides,
});

const rzpPaymentLink = (overrides: Partial<RzpPaymentLink> = {}): RzpPaymentLink => ({
  id: 'plink_1',
  entity: 'payment_link',
  amount: 49_900,
  currency: 'INR',
  status: 'created',
  short_url: 'https://rzp.io/rzp/abc',
  order_id: null,
  reference_id: null,
  description: null,
  amount_paid: 0,
  notes: [],
  created_at: 1_700_000_000,
  ...overrides,
});

describe('reconcileTransaction', () => {
  it('returns a not_found failure for an unknown transaction', async () => {
    const db = createFakeRecoveryDb();
    const razorpay = createFakeRazorpayClient();

    const result = await reconcileTransaction(db, razorpay, 'txn_missing', { now: () => NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_found');
  });

  it('leaves every pending attempt pending when no order exists yet, and claims no divergence', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction()],
      attempts: [pendingAttempt()],
    });
    const razorpay = createFakeRazorpayClient({
      fetchPaymentLink: async () => ok(rzpPaymentLink({ order_id: null })),
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      orderId: null,
      remoteAttemptCount: null,
      attemptCountDivergence: false,
      pendingAttempts: [
        { resolution: 'no_remote_record_yet', outcome: 'pending', rzpPaymentId: null },
      ],
    });
    // Never assumed failed from absence.
    expect(db.attempts[0]!.outcome).toBe('pending');
  });

  it('resolves the order id via the payment link and persists it, when the transaction did not already have one', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction({ rzp_order_id: null })],
      attempts: [pendingAttempt()],
    });
    const razorpay = createFakeRazorpayClient({
      fetchPaymentLink: async () => ok(rzpPaymentLink({ order_id: 'order_1' })),
      fetchOrder: async () => ok(rzpOrder({ attempts: 1 })),
      fetchOrderPayments: async () => ok({ entity: 'collection', count: 0, items: [] }),
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orderId).toBe('order_1');
    expect(db.transactions.get('txn_1')!.rzp_order_id).toBe('order_1');
  });

  it('does not fetch the payment link when the transaction already has an order id', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction({ rzp_order_id: 'order_1' })],
      attempts: [pendingAttempt()],
    });
    const razorpay = createFakeRazorpayClient({
      fetchOrder: async () => ok(rzpOrder({ attempts: 1 })),
      fetchOrderPayments: async () => ok({ entity: 'collection', count: 0, items: [] }),
      // fetchPaymentLink deliberately left as "not used": calling it fails the test.
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(result.ok).toBe(true);
  });

  it('a payment fetched as "created" stays pending: never settled either way', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction({ rzp_order_id: 'order_1' })],
      attempts: [pendingAttempt()],
    });
    const razorpay = createFakeRazorpayClient({
      fetchOrder: async () => ok(rzpOrder({ attempts: 1 })),
      fetchOrderPayments: async () =>
        ok({ entity: 'collection', count: 1, items: [rzpPayment({ status: 'created' })] }),
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingAttempts).toEqual([
      { attemptId: 1, attemptNumber: 1, idempotencyKey: 'txn_1:1', resolution: 'still_pending', outcome: 'pending', rzpPaymentId: 'pay_1' },
    ]);
    expect(db.attempts[0]!.outcome).toBe('pending');
    expect(db.auditLog).toHaveLength(0);
  });

  it('settles a captured payment, closes the transaction as recovered, and writes both audit events', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction({ rzp_order_id: 'order_1' })],
      attempts: [pendingAttempt()],
    });
    const razorpay = createFakeRazorpayClient({
      fetchOrder: async () => ok(rzpOrder({ attempts: 1 })),
      fetchOrderPayments: async () =>
        ok({
          entity: 'collection',
          count: 1,
          items: [rzpPayment({ status: 'captured', captured: true, acquirer_data: { auth_code: '112693' } })],
        }),
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingAttempts).toEqual([
      { attemptId: 1, attemptNumber: 1, idempotencyKey: 'txn_1:1', resolution: 'settled_now', outcome: 'captured', rzpPaymentId: 'pay_1' },
    ]);
    expect(result.value.transactionStatus).toBe('recovered');

    expect(db.attempts[0]!.outcome).toBe('captured');
    expect(db.attempts[0]!.auth_code).toBe('112693');
    expect(db.transactions.get('txn_1')!.status).toBe('recovered');
    expect(auditKinds(db)).toEqual(['attempt_settled', 'transaction_closed']);
  });

  it('settles a failed payment but leaves the transaction open for a retry', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction({ rzp_order_id: 'order_1' })],
      attempts: [pendingAttempt()],
    });
    const razorpay = createFakeRazorpayClient({
      fetchOrder: async () => ok(rzpOrder({ attempts: 1 })),
      fetchOrderPayments: async () =>
        ok({
          entity: 'collection',
          count: 1,
          items: [
            rzpPayment({
              status: 'failed',
              error_code: 'BAD_REQUEST_ERROR',
              error_source: 'gateway',
              error_step: 'payment_authorization',
              error_reason: 'payment_failed',
            }),
          ],
        }),
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingAttempts[0]).toMatchObject({ resolution: 'settled_now', outcome: 'failed' });
    expect(result.value.transactionStatus).toBe('open');

    expect(db.attempts[0]!.outcome).toBe('failed');
    expect(db.attempts[0]!.error_reason).toBe('payment_failed');
    expect(db.transactions.get('txn_1')!.status).toBe('open');
    expect(auditKinds(db)).toEqual(['attempt_settled']);
  });

  it('leaves a pending attempt pending, not failed, when Razorpay has no matching payment at all', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction({ rzp_order_id: 'order_1' })],
      attempts: [pendingAttempt()],
    });
    const razorpay = createFakeRazorpayClient({
      fetchOrder: async () => ok(rzpOrder({ attempts: 0 })),
      fetchOrderPayments: async () => ok({ entity: 'collection', count: 0, items: [] }),
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingAttempts).toEqual([
      { attemptId: 1, attemptNumber: 1, idempotencyKey: 'txn_1:1', resolution: 'no_remote_record_yet', outcome: 'pending', rzpPaymentId: null },
    ]);
    expect(db.attempts[0]!.outcome).toBe('pending');
  });

  it('excludes a previously settled attempt\'s payment id from the pool a pending attempt can match', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction({ rzp_order_id: 'order_1' })],
      attempts: [
        pendingAttempt({
          id: 1,
          attempt_number: 1,
          idempotency_key: 'txn_1:1',
          outcome: 'failed',
          rzp_payment_id: 'pay_1',
        }),
        pendingAttempt({
          id: 2,
          attempt_number: 2,
          idempotency_key: 'txn_1:2',
          outcome: 'pending',
          rzp_payment_id: null,
          created_at: '2026-08-26T11:05:00.000Z',
        }),
      ],
    });
    const razorpay = createFakeRazorpayClient({
      fetchOrder: async () => ok(rzpOrder({ attempts: 2 })),
      fetchOrderPayments: async () =>
        ok({
          entity: 'collection',
          count: 2,
          items: [
            rzpPayment({ id: 'pay_1', status: 'failed', created_at: 1_700_000_000 }),
            rzpPayment({ id: 'pay_2', status: 'captured', created_at: 1_700_000_100 }),
          ],
        }),
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only attempt 2 is reported: attempt 1 was already settled, not re-reconciled.
    expect(result.value.pendingAttempts).toEqual([
      { attemptId: 2, attemptNumber: 2, idempotencyKey: 'txn_1:2', resolution: 'settled_now', outcome: 'captured', rzpPaymentId: 'pay_2' },
    ]);
    expect(result.value.attemptCountDivergence).toBe(false);
  });

  it('matches multiple pending attempts to unclaimed payments in creation order, not list order', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction({ rzp_order_id: 'order_1' })],
      attempts: [
        pendingAttempt({ id: 1, attempt_number: 1, idempotency_key: 'txn_1:1' }),
        pendingAttempt({ id: 2, attempt_number: 2, idempotency_key: 'txn_1:2' }),
      ],
    });
    const razorpay = createFakeRazorpayClient({
      fetchOrder: async () => ok(rzpOrder({ attempts: 2 })),
      fetchOrderPayments: async () =>
        ok({
          entity: 'collection',
          count: 2,
          // Deliberately returned newest-first, to prove the match is by
          // created_at, not by list position.
          items: [
            rzpPayment({ id: 'pay_second', status: 'captured', created_at: 1_700_000_200 }),
            rzpPayment({ id: 'pay_first', status: 'failed', created_at: 1_700_000_100 }),
          ],
        }),
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingAttempts).toEqual([
      { attemptId: 1, attemptNumber: 1, idempotencyKey: 'txn_1:1', resolution: 'settled_now', outcome: 'failed', rzpPaymentId: 'pay_first' },
      { attemptId: 2, attemptNumber: 2, idempotencyKey: 'txn_1:2', resolution: 'settled_now', outcome: 'captured', rzpPaymentId: 'pay_second' },
    ]);
  });

  it('fetches a pending attempt\'s payment directly when a payment id is already known, rather than matching by position', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction({ rzp_order_id: 'order_1' })],
      attempts: [pendingAttempt({ rzp_payment_id: 'pay_known' })],
    });
    let fetchPaymentCalledWith: string | null = null;
    const razorpay = createFakeRazorpayClient({
      fetchOrder: async () => ok(rzpOrder({ attempts: 1 })),
      fetchOrderPayments: async () =>
        ok({ entity: 'collection', count: 1, items: [rzpPayment({ id: 'pay_decoy', status: 'captured' })] }),
      fetchPayment: async (id) => {
        fetchPaymentCalledWith = id;
        return ok(rzpPayment({ id: 'pay_known', status: 'captured' }));
      },
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(fetchPaymentCalledWith).toBe('pay_known');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingAttempts[0]).toMatchObject({ rzpPaymentId: 'pay_known', outcome: 'captured' });
  });

  it('surfaces a divergence between order.attempts and the local attempt count, rather than passing silently', async () => {
    const db = createFakeRecoveryDb({
      transactions: [transaction({ rzp_order_id: 'order_1', status: 'open' })],
      attempts: [pendingAttempt({ outcome: 'failed', rzp_payment_id: 'pay_1' })],
    });
    const razorpay = createFakeRazorpayClient({
      // Razorpay recorded 3 attempts; we only have 1 local row: a lost record.
      fetchOrder: async () => ok(rzpOrder({ attempts: 3 })),
      fetchOrderPayments: async () =>
        ok({ entity: 'collection', count: 1, items: [rzpPayment({ id: 'pay_1', status: 'failed' })] }),
    });

    const result = await reconcileTransaction(db, razorpay, 'txn_1', { now: () => NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.localAttemptCount).toBe(1);
    expect(result.value.remoteAttemptCount).toBe(3);
    expect(result.value.attemptCountDivergence).toBe(true);
  });
});
