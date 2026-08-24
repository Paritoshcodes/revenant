import { describe, expect, it } from 'vitest';

import { DEFAULT_GUARDRAIL_CONFIG } from '../src/guardrails/config.js';
import type { GuardrailDecision } from '../src/guardrails/types.js';
import { proposeAction } from '../src/recovery/policy-stub.js';
import {
  closingStatusForVetoes,
  planSettlement,
  planTransition,
} from '../src/recovery/transition.js';
import type { TransitionInput } from '../src/recovery/transition.js';
import type { FailureDiagnosis } from '../src/recovery/types.js';

const NOW = 1_787_558_000_000;

const transientDiagnosis: FailureDiagnosis = {
  errorSource: 'gateway',
  errorStep: 'payment_authorization',
};

const terminalDiagnosis: FailureDiagnosis = {
  errorSource: 'business',
  errorStep: 'payment_initiation',
};

/** bank has no wildcard row and no authentication row: genuinely unmapped. */
const unmappedDiagnosis: FailureDiagnosis = {
  errorSource: 'bank',
  errorStep: 'authentication',
};

describe('proposeAction', () => {
  it('reads the action straight off the mapped grid row', () => {
    const proposal = proposeAction(transientDiagnosis);
    expect(proposal.gridCell).toBe('gateway/payment_authorization');
    expect(proposal.action).toBe('retry_with_backoff');
  });

  it('resolves the internal wildcard row rather than treating it as unmapped', () => {
    const proposal = proposeAction({ errorSource: 'internal', errorStep: 'authentication' });
    expect(proposal.gridCell).toBe('internal/authentication');
    expect(proposal.action).toBe('retry_with_backoff');
    expect(proposal.recoveryProbability).toBe(0.5);
  });

  it('gives a terminal cell zero recovery probability, per the frozen protocol', () => {
    const proposal = proposeAction(terminalDiagnosis);
    expect(proposal.action).toBe('never_retry');
    expect(proposal.recoveryProbability).toBe(0);
  });

  it('gives every other mapped cell the same placeholder probability', () => {
    expect(proposeAction(transientDiagnosis).recoveryProbability).toBe(0.5);
  });

  it('does not guess a probability for an unmapped cell', () => {
    const proposal = proposeAction(unmappedDiagnosis);
    expect(proposal.gridCell).toBe('bank/authentication');
    expect(proposal.recoveryProbability).toBe(0);
  });

  it('is deterministic: propensity is always 1', () => {
    for (const diagnosis of [transientDiagnosis, terminalDiagnosis, unmappedDiagnosis]) {
      expect(proposeAction(diagnosis).propensity).toBe(1);
    }
  });
});

describe('closingStatusForVetoes', () => {
  const veto = (guardrail: GuardrailDecision['guardrail']): GuardrailDecision => ({
    guardrail,
    verdict: 'veto',
    reason: 'test',
  });

  it('closes as terminal when the terminal guardrail fired, regardless of what else did', () => {
    expect(closingStatusForVetoes([veto('terminal_grid_cell')])).toBe('terminal');
    expect(closingStatusForVetoes([veto('max_attempts'), veto('terminal_grid_cell')])).toBe(
      'terminal',
    );
  });

  it('closes as abandoned when only max_attempts fired', () => {
    expect(closingStatusForVetoes([veto('max_attempts')])).toBe('abandoned');
  });

  it('leaves the transaction open for a spacing or circuit-breaker veto alone', () => {
    expect(closingStatusForVetoes([veto('minimum_backoff')])).toBeNull();
    expect(closingStatusForVetoes([veto('circuit_breaker')])).toBeNull();
    expect(closingStatusForVetoes([veto('minimum_backoff'), veto('circuit_breaker')])).toBeNull();
  });

  it('returns null when nothing vetoed', () => {
    expect(closingStatusForVetoes([])).toBeNull();
  });
});

describe('planTransition', () => {
  const baseInput: TransitionInput = {
    transactionId: 'txn_abc',
    attemptNumber: 1,
    diagnosis: transientDiagnosis,
    lastAttemptAtMs: null,
    nowMs: NOW,
    batch: { settled: 0, failed: 0 },
    guardrailConfig: DEFAULT_GUARDRAIL_CONFIG,
  };

  it('allows a clean first attempt, leaves the transaction open, and requires an attempt', () => {
    const plan = planTransition(baseInput);
    expect(plan.evaluation.verdict).toBe('allow');
    expect(plan.closingStatus).toBeNull();
    expect(plan.proposal.action).toBe('retry_with_backoff');
    expect(plan.requiresAttempt).toBe(true);
  });

  it('allows a nudge and requires no attempt, but leaves the transaction open', () => {
    // customer/payment_authorization: allowed, but nudge_no_auto_retry does
    // not re-present the payment, so there is nothing terminal about it.
    const plan = planTransition({
      ...baseInput,
      diagnosis: { errorSource: 'customer', errorStep: 'payment_authorization' },
    });
    expect(plan.evaluation.verdict).toBe('allow');
    expect(plan.proposal.action).toBe('nudge_no_auto_retry');
    expect(plan.requiresAttempt).toBe(false);
    expect(plan.closingStatus).toBeNull();
  });

  it('allows a terminal cell whose action is never_retry, and closes it as terminal anyway', () => {
    // The guardrail only vetoes a RETRY proposed on a terminal cell
    // (DECISIONS.md: never_retry does not re-present the payment, so the
    // guardrail passes it through). The stub faithfully proposes the
    // grid's own action, so this is an allow, not a veto — the closing
    // decision has to come from the action itself, not from a veto.
    const plan = planTransition({ ...baseInput, diagnosis: terminalDiagnosis });
    expect(plan.evaluation.verdict).toBe('allow');
    expect(plan.proposal.action).toBe('never_retry');
    expect(plan.requiresAttempt).toBe(false);
    expect(plan.closingStatus).toBe('terminal');
  });

  it('closes as abandoned once the attempt cap is exceeded', () => {
    const plan = planTransition({
      ...baseInput,
      attemptNumber: 4,
      lastAttemptAtMs: NOW - 3_600_000,
    });
    expect(plan.evaluation.verdict).toBe('veto');
    expect(plan.closingStatus).toBe('abandoned');
    expect(plan.requiresAttempt).toBe(false);
  });

  it('leaves the transaction open on a spacing veto: this attempt is proposed again later', () => {
    const plan = planTransition({
      ...baseInput,
      attemptNumber: 2,
      lastAttemptAtMs: NOW - 10_000,
    });
    expect(plan.evaluation.verdict).toBe('veto');
    expect(plan.closingStatus).toBeNull();
  });

  it('leaves the transaction open on a circuit-breaker veto: a batch-wide fact, not this transaction\'s', () => {
    const plan = planTransition({ ...baseInput, batch: { settled: 20, failed: 15 } });
    expect(plan.evaluation.verdict).toBe('veto');
    expect(plan.closingStatus).toBeNull();
  });

  it('vetoes an unmapped cell and closes it as terminal rather than guessing it is safe', () => {
    const plan = planTransition({ ...baseInput, diagnosis: unmappedDiagnosis });
    expect(plan.evaluation.verdict).toBe('veto');
    expect(plan.closingStatus).toBe('terminal');
  });

  it('is deterministic for the same input', () => {
    expect(planTransition(baseInput)).toEqual(planTransition(baseInput));
  });
});

describe('planSettlement', () => {
  it('stops as recovered on capture', () => {
    expect(planSettlement('captured')).toEqual({ finalStatus: 'recovered', decision: 'stop' });
  });

  it('continues on failure, leaving the cap check to the guardrail layer', () => {
    expect(planSettlement('failed')).toEqual({ finalStatus: null, decision: 'continue' });
  });
});
