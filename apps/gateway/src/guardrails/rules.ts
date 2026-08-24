/**
 * The individual guardrails.
 *
 * Every one is a pure function: same context and config in, same decision
 * out, no clock and no I/O. A guardrail may veto what the policy proposed;
 * the policy cannot override a veto. See CLAUDE.md hard rule 2.
 */
import { gridCell, lookupGridRow } from '@revenant/contracts';
import type { RecoveryAction } from '@revenant/contracts';

import type { Guardrail, GuardrailDecision, GuardrailId } from './types.js';

const allow = (guardrail: GuardrailId, reason: string): GuardrailDecision => ({
  guardrail,
  verdict: 'allow',
  reason,
});

const veto = (guardrail: GuardrailId, reason: string): GuardrailDecision => ({
  guardrail,
  verdict: 'veto',
  reason,
});

/**
 * Actions that move money by re-presenting the payment. Nudging a customer
 * is not one, so it is not what the terminal or spacing rules restrain.
 */
const RETRY_ACTIONS: ReadonlySet<RecoveryAction> = new Set([
  'retry_with_backoff',
  'retry_prompt_alternate',
  'retry_on_timing_window',
]);

export const isRetryAction = (action: RecoveryAction): boolean =>
  RETRY_ACTIONS.has(action);

/**
 * Required gap before `attemptNumber`, in milliseconds.
 *
 * Deterministic by construction: no jitter, because a guardrail that
 * sometimes allows and sometimes refuses the same inputs is not auditable.
 */
export const requiredGapMs = (
  attemptNumber: number,
  spacing: { baseMs: number; factor: number; maxMs: number },
): number => {
  if (attemptNumber <= 1 || spacing.baseMs === 0) return 0;
  return Math.min(
    spacing.maxMs,
    spacing.baseMs * spacing.factor ** (attemptNumber - 2),
  );
};

/**
 * Terminal grid rows are never retried.
 *
 * `business / payment_initiation` is the observable terminal row in test
 * mode: an international card on a domestic-only account will fail exactly
 * the same way every time, so a retry spends rate limit and customer
 * goodwill for a guaranteed decline.
 */
export const terminalGridCell: Guardrail = (context) => {
  const id: GuardrailId = 'terminal_grid_cell';
  const cell = gridCell(context.errorSource, context.errorStep);
  const row = lookupGridRow(context.errorSource, context.errorStep);

  if (row === undefined) {
    // An unmapped cell is not proof of safety. Refuse rather than guess.
    return veto(id, `grid cell ${cell} is not on the policy grid`);
  }

  if (row.failure_class !== 'terminal') {
    return allow(id, `grid cell ${cell} is ${row.failure_class}, not terminal`);
  }

  if (!isRetryAction(context.proposedAction)) {
    return allow(
      id,
      `grid cell ${cell} is terminal but ${context.proposedAction} is not a retry`,
    );
  }

  return veto(
    id,
    `grid cell ${cell} is terminal: ${context.proposedAction} refused, terminal cells are never retried`,
  );
};

/** Hard ceiling on attempts per transaction. */
export const maxAttempts: Guardrail = (context, config) => {
  const id: GuardrailId = 'max_attempts';

  if (!isRetryAction(context.proposedAction)) {
    return allow(id, `${context.proposedAction} is not a retry, cap does not apply`);
  }

  if (context.attemptNumber > config.maxAttempts) {
    return veto(
      id,
      `attempt ${context.attemptNumber} exceeds the maximum of ${config.maxAttempts} per transaction`,
    );
  }

  return allow(
    id,
    `attempt ${context.attemptNumber} of ${config.maxAttempts}`,
  );
};

/** Exponential spacing between attempts on the same transaction. */
export const minimumBackoff: Guardrail = (context, config) => {
  const id: GuardrailId = 'minimum_backoff';

  if (!isRetryAction(context.proposedAction)) {
    return allow(id, `${context.proposedAction} is not a retry, spacing does not apply`);
  }

  if (context.lastAttemptAtMs === null) {
    return allow(id, 'first attempt, nothing to space from');
  }

  const required = requiredGapMs(context.attemptNumber, config.attemptSpacing);
  if (required === 0) {
    return allow(id, 'spacing disabled for this arm');
  }

  const elapsed = context.nowMs - context.lastAttemptAtMs;

  if (elapsed < required) {
    return veto(
      id,
      `only ${elapsed}ms since the last attempt, ${required}ms required before attempt ${context.attemptNumber}`,
    );
  }

  return allow(
    id,
    `${elapsed}ms since the last attempt, ${required}ms required`,
  );
};

/**
 * Global circuit breaker on the batch failure rate.
 *
 * Halts everything when a run goes bad wholesale, which in test mode most
 * likely means a credential or account problem rather than genuine declines.
 * Below minSettled the rate is noise and the breaker stays out of the way.
 */
export const circuitBreaker: Guardrail = (context, config) => {
  const id: GuardrailId = 'circuit_breaker';
  const { settled, failed } = context.batch;
  const { minSettled, failureRateThreshold } = config.circuitBreaker;

  if (settled < minSettled) {
    return allow(
      id,
      `only ${settled} settled attempts, breaker arms at ${minSettled}`,
    );
  }

  const rate = failed / settled;
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

  if (rate > failureRateThreshold) {
    return veto(
      id,
      `batch failure rate ${percent(rate)} (${failed}/${settled}) exceeds ${percent(failureRateThreshold)}`,
    );
  }

  return allow(
    id,
    `batch failure rate ${percent(rate)} (${failed}/${settled}) within ${percent(failureRateThreshold)}`,
  );
};
