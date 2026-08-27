/**
 * Reconciliation: resolving `pending` attempts by asking Razorpay, never by
 * assuming an outcome.
 *
 * A `pending` attempt means the idempotency key was reserved and an
 * outbound Razorpay write happened, but the process never learned the
 * result — it died, the browser crashed, or a webhook never arrived
 * (docs/ARCHITECTURE.md: "pending means reserved but unresolved"). Guessing
 * `failed` here would corrupt the one number this project exists to
 * produce, so this module only ever settles an attempt on a positive,
 * terminal answer from Razorpay itself.
 *
 * `status: "created"` is Razorpay's own in-flight state, observed live on a
 * payment sitting at an unanswered bank page, which only became
 * `failed`/`payment_cancelled` about a minute after the popup closed
 * (docs/CHECKOUT-FLOW.md section 12). A payment fetched as `created` is
 * genuinely still open and MUST stay pending here, not be settled either
 * way.
 *
 * `payment_link.payments` is documented as always empty even when attempts
 * exist (docs/API-BEHAVIOUR.md section 3); `GET /orders/<id>/payments` is
 * the only reliable enumeration, and a link has no `order_id` until its
 * first attempt, so that lookup is tolerated as absent rather than treated
 * as an error.
 */
import { err, ok } from '@revenant/contracts';
import type { Arm, AttemptOutcome, Failure, Result, TransactionStatus } from '@revenant/contracts';

import { appendAuditEvent } from '../audit/writer.js';
import type { TransactionClient } from '../audit/types.js';
import type { RazorpayClient } from '../razorpay/client.js';
import type { RzpPayment } from '../razorpay/types.js';

import {
  closeTransaction,
  fetchTransaction,
  listAttempts,
  setTransactionOrderId,
} from './db.js';
import type { AttemptRow, TransactionRow } from './db.js';
import { createIdempotencyStore } from './idempotency-store.js';
import type { SettleInput } from './idempotency-store.js';
import { planSettlement } from './transition.js';

export interface AttemptReconciliation {
  readonly attemptId: number;
  readonly attemptNumber: number;
  readonly idempotencyKey: string;
  /**
   * `settled_now`: this run resolved it, from a real Razorpay record.
   * `still_pending`: a remote record exists but its own status
   * (`created`, or an unresolved `authorized`/`refunded`) is not terminal.
   * `no_remote_record_yet`: Razorpay has no matching payment at all —
   * never treated as failure, since the browser may simply not have
   * reached Razorpay before it crashed.
   */
  readonly resolution: 'settled_now' | 'still_pending' | 'no_remote_record_yet';
  readonly outcome: AttemptOutcome;
  readonly rzpPaymentId: string | null;
}

export interface ReconciliationReport {
  readonly transactionId: string;
  readonly orderId: string | null;
  readonly localAttemptCount: number;
  /** Razorpay's own server-side counter (order.attempts), null if no order exists yet. */
  readonly remoteAttemptCount: number | null;
  /**
   * True when remoteAttemptCount and localAttemptCount disagree. Per
   * docs/API-BEHAVIOUR.md section 4: "A divergence means we lost an
   * attempt record and should reconcile" — surfaced here, never swallowed,
   * since the max_attempts guardrail trusts localAttemptCount as its input.
   */
  readonly attemptCountDivergence: boolean;
  readonly pendingAttempts: readonly AttemptReconciliation[];
  readonly transactionStatus: TransactionStatus;
}

/**
 * `created` is genuinely still open (docs/CHECKOUT-FLOW.md section 12) and
 * must never settle. `authorized` and `refunded` were never observed in
 * this project's test-mode flow, which only ever resolves to `captured` or
 * `failed`; treated the same conservative way rather than guessed at.
 */
const mapToSettleInput = (payment: RzpPayment): SettleInput | null => {
  if (payment.status === 'captured') {
    return {
      outcome: 'captured',
      rzpPaymentId: payment.id,
      errorCode: null,
      errorSource: null,
      errorStep: null,
      errorReason: null,
      authCode: payment.acquirer_data?.auth_code ?? null,
    };
  }
  if (payment.status === 'failed') {
    return {
      outcome: 'failed',
      rzpPaymentId: payment.id,
      errorCode: payment.error_code,
      errorSource: payment.error_source,
      errorStep: payment.error_step,
      errorReason: payment.error_reason,
      authCode: payment.acquirer_data?.auth_code ?? null,
    };
  }
  return null;
};

/**
 * Orders are created at first attempt, not link creation
 * (docs/API-BEHAVIOUR.md section 2): `transactions.rzp_order_id` can be
 * null even for a transaction that has already attempted once, if all we
 * had stored was the payment link. Resolves and persists it once knowable;
 * returns null, tolerated rather than treated as an error, when nothing has
 * reached Razorpay for this transaction yet.
 */
const resolveOrderId = async (
  db: TransactionClient,
  razorpay: RazorpayClient,
  transaction: TransactionRow,
): Promise<Result<string | null>> => {
  if (transaction.rzpOrderId !== null) return ok(transaction.rzpOrderId);
  if (transaction.rzpPaymentLinkId === null) return ok(null);

  const link = await razorpay.fetchPaymentLink(transaction.rzpPaymentLinkId);
  if (!link.ok) return link;
  if (link.value.order_id === null) return ok(null);

  const persisted = await setTransactionOrderId(db, transaction.id, link.value.order_id);
  if (!persisted.ok) return persisted;

  return ok(link.value.order_id);
};

const stillPending = (attempt: AttemptRow, rzpPaymentId: string | null): AttemptReconciliation => ({
  attemptId: attempt.id,
  attemptNumber: attempt.attemptNumber,
  idempotencyKey: attempt.idempotencyKey,
  resolution: 'still_pending',
  outcome: 'pending',
  rzpPaymentId,
});

const noRemoteRecordYet = (attempt: AttemptRow): AttemptReconciliation => ({
  attemptId: attempt.id,
  attemptNumber: attempt.attemptNumber,
  idempotencyKey: attempt.idempotencyKey,
  resolution: 'no_remote_record_yet',
  outcome: 'pending',
  rzpPaymentId: null,
});

export interface ReconcileDeps {
  readonly now?: () => number;
}

/**
 * Resolves every `pending` attempt on one transaction against Razorpay's
 * own records, and cross-checks the local attempt count against
 * `order.attempts`. `db` must already be inside an open transaction, same
 * requirement as `runRecoveryStep` and `appendAuditEvent`: settling an
 * attempt and closing a transaction here writes the same audit events a
 * live settlement would, so a reconciled attempt counts identically to one
 * that resolved in real time.
 */
export const reconcileTransaction = async (
  db: TransactionClient,
  razorpay: RazorpayClient,
  transactionId: string,
  deps: ReconcileDeps = {},
): Promise<Result<ReconciliationReport>> => {
  const now = deps.now ?? Date.now;

  const txn = await fetchTransaction(db, transactionId);
  if (!txn.ok) return txn;
  if (txn.value === null) {
    return err<Failure>({
      kind: 'not_found',
      message: `reconcileTransaction: no transaction ${transactionId}`,
    });
  }
  const transaction = txn.value;

  const attemptsResult = await listAttempts(db, transactionId);
  if (!attemptsResult.ok) return attemptsResult;
  const localAttempts = attemptsResult.value;
  const pendingAttempts = localAttempts.filter((a) => a.outcome === 'pending');

  const orderIdResult = await resolveOrderId(db, razorpay, transaction);
  if (!orderIdResult.ok) return orderIdResult;
  const orderId = orderIdResult.value;

  // Nothing has reached Razorpay for this transaction yet: every pending
  // attempt stays pending, and there is no server-side count to compare
  // against, so no divergence claim can be made either way.
  if (orderId === null) {
    return ok({
      transactionId,
      orderId: null,
      localAttemptCount: localAttempts.length,
      remoteAttemptCount: null,
      attemptCountDivergence: false,
      pendingAttempts: pendingAttempts.map((a) => noRemoteRecordYet(a)),
      transactionStatus: transaction.status,
    });
  }

  const orderResult = await razorpay.fetchOrder(orderId);
  if (!orderResult.ok) return orderResult;

  const paymentsResult = await razorpay.fetchOrderPayments(orderId);
  if (!paymentsResult.ok) return paymentsResult;

  const remoteAttemptCount = orderResult.value.attempts;
  const attemptCountDivergence = remoteAttemptCount !== localAttempts.length;

  // Remote payments already accounted for by a previously settled local
  // attempt are excluded, so what remains is exactly the pool a pending
  // attempt (which has no stored payment id of its own) could match.
  // Sorted by creation time: attempts happen strictly one after another
  // (the attempt-spacing guardrail serialises them), so pairing the
  // earliest unclaimed remote payment with the earliest pending local
  // attempt is a real correlation, not a guess.
  const claimedIds = new Set(
    localAttempts.flatMap((a) => (a.rzpPaymentId === null ? [] : [a.rzpPaymentId])),
  );
  const unclaimed = paymentsResult.value.items
    .filter((p) => !claimedIds.has(p.id))
    .slice()
    .sort((a, b) => a.created_at - b.created_at);

  const results: AttemptReconciliation[] = [];
  let unclaimedIndex = 0;
  let transactionStatus = transaction.status;

  for (const attempt of pendingAttempts) {
    let remotePayment: RzpPayment | null = null;

    if (attempt.rzpPaymentId !== null) {
      // Not currently possible via the driver (a crash before settle()
      // never records a payment id), but tolerated: a known id is fetched
      // directly rather than matched by position.
      const fetched = await razorpay.fetchPayment(attempt.rzpPaymentId);
      if (!fetched.ok) return fetched;
      remotePayment = fetched.value;
    } else if (unclaimedIndex < unclaimed.length) {
      remotePayment = unclaimed[unclaimedIndex]!;
      unclaimedIndex += 1;
    }

    if (remotePayment === null) {
      results.push(noRemoteRecordYet(attempt));
      continue;
    }

    const settleInput = mapToSettleInput(remotePayment);
    if (settleInput === null) {
      results.push(stillPending(attempt, remotePayment.id));
      continue;
    }

    const store = createIdempotencyStore(db);
    const settled = await store.settle(attempt.idempotencyKey, settleInput);
    if (!settled.ok) return settled;

    const timestamp = new Date(now()).toISOString();

    // A racing settle (the driver's own flow can reach the same attempt at
    // the same moment reconciliation does, docs/DECISIONS.md Build log
    // entry 10) already wrote this event — only the caller whose settle
    // actually transitioned pending -> settled writes it.
    if (settled.value.status === 'settled') {
      const settleAudited = await appendAuditEvent(db, {
        kind: 'attempt_settled',
        timestamp,
        transaction_id: transactionId,
        arm: transaction.arm as Arm,
        attempt_number: attempt.attemptNumber,
        idempotency_key: attempt.idempotencyKey,
        rzp_payment_id: settleInput.rzpPaymentId ?? null,
        // Nothing was written to Razorpay here, only read: there is no fresh
        // request id to report, unlike a live settlement.
        rzp_response_id: null,
        error_code: settleInput.errorCode ?? null,
        error_source: settleInput.errorSource ?? null,
        error_step: settleInput.errorStep ?? null,
        error_reason: settleInput.errorReason ?? null,
        auth_code: settleInput.authCode ?? null,
        outcome: settleInput.outcome,
      });
      if (!settleAudited.ok) return settleAudited;
    }

    if (transactionStatus === 'open') {
      const settlementPlan = planSettlement(settleInput.outcome);
      if (settlementPlan.finalStatus !== null) {
        const closed = await closeTransaction(db, transactionId, settlementPlan.finalStatus);
        if (!closed.ok) return closed;
        transactionStatus = settlementPlan.finalStatus;

        if (closed.value === 'closed') {
          const closedAudited = await appendAuditEvent(db, {
            kind: 'transaction_closed',
            timestamp,
            transaction_id: transactionId,
            arm: transaction.arm as Arm,
            final_status: settlementPlan.finalStatus,
            attempts_made: attempt.attemptNumber,
            narrative: null,
          });
          if (!closedAudited.ok) return closedAudited;
        }
      }
    }

    results.push({
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      idempotencyKey: attempt.idempotencyKey,
      resolution: 'settled_now',
      outcome: settleInput.outcome,
      rzpPaymentId: settleInput.rzpPaymentId ?? null,
    });
  }

  return ok({
    transactionId,
    orderId,
    localAttemptCount: localAttempts.length,
    remoteAttemptCount,
    attemptCountDivergence,
    pendingAttempts: results,
    transactionStatus,
  });
};
