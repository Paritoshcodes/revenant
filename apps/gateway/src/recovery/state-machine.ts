/**
 * The recovery state machine.
 *
 * One call is one attempt cycle: diagnose the failure into a grid cell and
 * propose an action (policy-stub.ts / transition.ts), evaluate guardrails,
 * and if allowed, reserve the idempotency key, drive the attempt, settle
 * it, then decide whether the transaction stops (recovered / abandoned /
 * terminal) or continues — the caller invokes this again for the next
 * attempt once guardrail spacing allows. A guardrail veto ends the attempt
 * right there: no reservation, no outbound call (CLAUDE.md hard rule 2).
 *
 * `client` must already be inside an open transaction, exactly like
 * appendAuditEvent (src/audit/writer.ts): every database write here is
 * paired with its audit event in that same transaction, so the caller
 * commits or rolls back the whole step atomically. That does mean the
 * transaction stays open for the duration of `executor.execute`, holding
 * the audit chain's advisory lock for as long as the attempt takes to
 * settle. Acceptable at Layer 1's scale (docs/ARCHITECTURE.md: "small N,
 * real API outcomes"); revisit if that stops being true.
 */
import { ok } from '@revenant/contracts';
import type { Result } from '@revenant/contracts';

import { appendAuditEvent } from '../audit/writer.js';
import type { TransactionClient } from '../audit/types.js';
import { primaryVetoReason } from '../guardrails/evaluate.js';

import { closeTransaction, insertDecision } from './db.js';
import { createIdempotencyStore } from './idempotency-store.js';
import { planSettlement, planTransition } from './transition.js';
import type { RecoveryStepDeps, RecoveryStepInput, RecoveryStepResult } from './types.js';

export const runRecoveryStep = async (
  client: TransactionClient,
  deps: RecoveryStepDeps,
  input: RecoveryStepInput,
): Promise<Result<RecoveryStepResult>> => {
  const nowMs = deps.now();
  const timestamp = new Date(nowMs).toISOString();

  const plan = planTransition({
    transactionId: input.transactionId,
    attemptNumber: input.attemptNumber,
    diagnosis: input.diagnosis,
    lastAttemptAtMs: input.lastAttemptAtMs,
    nowMs,
    batch: input.batch,
    guardrailConfig: deps.guardrailConfig,
  });
  const reason = primaryVetoReason(plan.evaluation);

  const inserted = await insertDecision(client, {
    transactionId: input.transactionId,
    attemptNumber: input.attemptNumber,
    gridCell: plan.proposal.gridCell,
    recoveryProbability: plan.proposal.recoveryProbability,
    proposedAction: plan.proposal.action,
    propensity: plan.proposal.propensity,
    guardrailVerdict: plan.evaluation.verdict,
    guardrailReason: reason,
  });
  if (!inserted.ok) return inserted;

  // -- vetoed: record the refusal, maybe close the transaction, stop here --

  if (plan.evaluation.verdict === 'veto') {
    const audited = await appendAuditEvent(client, {
      kind: 'guardrail_veto',
      timestamp,
      transaction_id: input.transactionId,
      arm: input.arm,
      attempt_number: input.attemptNumber,
      grid_cell: plan.proposal.gridCell,
      proposed_action: plan.proposal.action,
      guardrail_verdict: 'veto',
      guardrail_reason: reason!,
    });
    if (!audited.ok) return audited;

    if (plan.closingStatus !== null) {
      const closed = await closeTransaction(client, input.transactionId, plan.closingStatus);
      if (!closed.ok) return closed;

      if (closed.value === 'closed') {
        const closedAudit = await appendAuditEvent(client, {
          kind: 'transaction_closed',
          timestamp,
          transaction_id: input.transactionId,
          arm: input.arm,
          final_status: plan.closingStatus,
          attempts_made: input.attemptNumber - 1,
          narrative: null,
        });
        if (!closedAudit.ok) return closedAudit;
      }
    }

    return ok({
      status: 'vetoed',
      gridCell: plan.proposal.gridCell,
      proposedAction: plan.proposal.action,
      guardrailReason: reason!,
      transactionStatus: plan.closingStatus ?? 'open',
    });
  }

  // -- allowed --------------------------------------------------------

  const decisionAudited = await appendAuditEvent(client, {
    kind: 'decision_made',
    timestamp,
    transaction_id: input.transactionId,
    arm: input.arm,
    attempt_number: input.attemptNumber,
    grid_cell: plan.proposal.gridCell,
    recovery_probability: plan.proposal.recoveryProbability,
    proposed_action: plan.proposal.action,
    propensity: plan.proposal.propensity,
    guardrail_verdict: 'allow',
    diagnosis: null,
  });
  if (!decisionAudited.ok) return decisionAudited;

  // nudge_no_auto_retry or never_retry: neither re-presents the payment
  // (DECISIONS.md), so there is no attempt to reserve, execute or settle.
  if (!plan.requiresAttempt) {
    if (plan.closingStatus !== null) {
      const closed = await closeTransaction(client, input.transactionId, plan.closingStatus);
      if (!closed.ok) return closed;

      if (closed.value === 'closed') {
        const closedAudit = await appendAuditEvent(client, {
          kind: 'transaction_closed',
          timestamp,
          transaction_id: input.transactionId,
          arm: input.arm,
          final_status: plan.closingStatus,
          attempts_made: input.attemptNumber - 1,
          narrative: null,
        });
        if (!closedAudit.ok) return closedAudit;
      }
    }

    return ok({
      status: 'no_attempt',
      gridCell: plan.proposal.gridCell,
      proposedAction: plan.proposal.action,
      transactionStatus: plan.closingStatus ?? 'open',
    });
  }

  // -- requires an attempt: reserve, execute, settle -------------------

  const store = createIdempotencyStore(client);
  const reservation = await store.reserve(input.transactionId, input.attemptNumber);
  if (!reservation.ok) return reservation;

  if (reservation.value.status === 'duplicate') {
    return ok({
      status: 'duplicate',
      idempotencyKey: reservation.value.key,
      existing: reservation.value.existing,
    });
  }

  const idempotencyKey = reservation.value.key;

  const startAudited = await appendAuditEvent(client, {
    kind: 'attempt_started',
    timestamp,
    transaction_id: input.transactionId,
    arm: input.arm,
    attempt_number: input.attemptNumber,
    idempotency_key: idempotencyKey,
    action: plan.proposal.action,
    rzp_request_id: null,
  });
  if (!startAudited.ok) return startAudited;

  const execution = await deps.executor.execute({
    transactionId: input.transactionId,
    attemptNumber: input.attemptNumber,
    idempotencyKey,
    action: plan.proposal.action,
  });
  // An unresolved attempt (network/browser failure) is left `pending`
  // rather than guessed at: ARCHITECTURE.md has it reconciled later by
  // fetching the real outcome from Razorpay, never assumed here.
  if (!execution.ok) return execution;

  const settlement = planSettlement(execution.value.outcome);
  const settleTimestamp = new Date(deps.now()).toISOString();

  const settled = await store.settle(idempotencyKey, {
    outcome: execution.value.outcome,
    rzpPaymentId: execution.value.rzpPaymentId,
    errorCode: execution.value.errorCode,
    errorSource: execution.value.errorSource,
    errorStep: execution.value.errorStep,
    errorReason: execution.value.errorReason,
    authCode: execution.value.authCode,
  });
  if (!settled.ok) return settled;

  // A racing settle (the driver's own flow and a reconciliation run can
  // both reach here for the same attempt, docs/DECISIONS.md Build log
  // entry 10) already wrote this event — only the caller whose settle
  // actually transitioned pending -> settled writes it.
  if (settled.value.status === 'settled') {
    const settleAudited = await appendAuditEvent(client, {
      kind: 'attempt_settled',
      timestamp: settleTimestamp,
      transaction_id: input.transactionId,
      arm: input.arm,
      attempt_number: input.attemptNumber,
      idempotency_key: idempotencyKey,
      rzp_payment_id: execution.value.rzpPaymentId,
      rzp_response_id: execution.value.rzpResponseId,
      error_code: execution.value.errorCode,
      error_source: execution.value.errorSource,
      error_step: execution.value.errorStep,
      error_reason: execution.value.errorReason,
      auth_code: execution.value.authCode,
      outcome: execution.value.outcome,
    });
    if (!settleAudited.ok) return settleAudited;
  }

  if (settlement.finalStatus !== null) {
    const closed = await closeTransaction(client, input.transactionId, settlement.finalStatus);
    if (!closed.ok) return closed;

    if (closed.value === 'closed') {
      const closedAudit = await appendAuditEvent(client, {
        kind: 'transaction_closed',
        timestamp: settleTimestamp,
        transaction_id: input.transactionId,
        arm: input.arm,
        final_status: settlement.finalStatus,
        attempts_made: input.attemptNumber,
        narrative: null,
      });
      if (!closedAudit.ok) return closedAudit;
    }
  }

  return ok({
    status: 'settled',
    gridCell: plan.proposal.gridCell,
    proposedAction: plan.proposal.action,
    outcome: execution.value.outcome,
    decision: settlement.decision,
    transactionStatus: settlement.finalStatus ?? 'open',
  });
};
