/**
 * The recovery state machine's decision logic, kept pure and separate from
 * the DB/network orchestration in state-machine.ts: given the same inputs
 * this always produces the same plan, so it is unit-testable without a
 * database, an AttemptExecutor, or a clock.
 */
import type { SettledOutcome, TransactionStatus } from '@revenant/contracts';

import { evaluateGuardrails } from '../guardrails/evaluate.js';
import { isRetryAction } from '../guardrails/rules.js';
import type {
  BatchStats,
  GuardrailConfig,
  GuardrailContext,
  GuardrailDecision,
  GuardrailEvaluation,
} from '../guardrails/types.js';

import { proposeAction } from './policy-stub.js';
import type { ProposedAction } from './policy-stub.js';
import type { FailureDiagnosis } from './types.js';

export interface TransitionInput {
  readonly transactionId: string;
  readonly attemptNumber: number;
  readonly diagnosis: FailureDiagnosis;
  readonly lastAttemptAtMs: number | null;
  readonly nowMs: number;
  readonly batch: BatchStats;
  readonly guardrailConfig: GuardrailConfig;
}

type ClosingStatus = Extract<TransactionStatus, 'terminal' | 'abandoned'>;

/**
 * Only these two vetoes end the transaction. `minimum_backoff` means "not
 * yet": the same attempt is proposed again once the required gap elapses.
 * `circuit_breaker` is a fact about the whole batch, not this transaction,
 * so it also leaves the transaction open rather than closing it.
 */
export const closingStatusForVetoes = (
  vetoes: readonly GuardrailDecision[],
): ClosingStatus | null => {
  if (vetoes.some((v) => v.guardrail === 'terminal_grid_cell')) return 'terminal';
  if (vetoes.some((v) => v.guardrail === 'max_attempts')) return 'abandoned';
  return null;
};

export interface TransitionPlan {
  readonly proposal: ProposedAction;
  readonly evaluation: GuardrailEvaluation;
  /**
   * Set when this decision alone determines the transaction closes right
   * now: either a veto that ends it (terminal cell, exhausted cap), or an
   * ALLOWED `never_retry` — the guardrail passes non-retry actions through
   * untouched (DECISIONS.md, "Guardrails restrain money actions, not
   * messages"), so a terminal cell where the policy itself already chose
   * not to retry closes here just the same as one where the guardrail had
   * to refuse a misbehaving proposal. Null means stay open: either nothing
   * closes it, or an attempt is about to be made and closing depends on
   * how that settles.
   */
  readonly closingStatus: ClosingStatus | null;
  /**
   * True only for an allowed, money-moving retry: the one case that goes
   * on to reserve, execute and settle an attempt. `nudge_no_auto_retry` and
   * `never_retry` do not re-present the payment (DECISIONS.md), so an
   * allowed decision on either of them makes no attempt at all.
   */
  readonly requiresAttempt: boolean;
}

export const planTransition = (input: TransitionInput): TransitionPlan => {
  const proposal = proposeAction(input.diagnosis);

  const context: GuardrailContext = {
    transactionId: input.transactionId,
    errorSource: input.diagnosis.errorSource,
    errorStep: input.diagnosis.errorStep,
    proposedAction: proposal.action,
    attemptNumber: input.attemptNumber,
    nowMs: input.nowMs,
    lastAttemptAtMs: input.lastAttemptAtMs,
    batch: input.batch,
  };
  const evaluation = evaluateGuardrails(context, input.guardrailConfig);

  if (evaluation.verdict === 'veto') {
    return {
      proposal,
      evaluation,
      closingStatus: closingStatusForVetoes(evaluation.vetoes),
      requiresAttempt: false,
    };
  }

  const requiresAttempt = isRetryAction(proposal.action);
  return {
    proposal,
    evaluation,
    closingStatus: !requiresAttempt && proposal.action === 'never_retry' ? 'terminal' : null,
    requiresAttempt,
  };
};

export interface SettlementPlan {
  readonly finalStatus: Extract<TransactionStatus, 'recovered'> | null;
  readonly decision: 'stop' | 'continue';
}

/**
 * `captured` stops the transaction as recovered. `failed` continues:
 * whether the attempt cap is now exhausted is left to the guardrail layer
 * on the next call rather than re-checked here, so there is exactly one
 * place that decides "no more attempts".
 */
export const planSettlement = (outcome: SettledOutcome): SettlementPlan =>
  outcome === 'captured'
    ? { finalStatus: 'recovered', decision: 'stop' }
    : { finalStatus: null, decision: 'continue' };
