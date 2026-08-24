/**
 * Guardrail composition.
 *
 * Every guardrail runs on every evaluation. None of them short-circuits, so
 * the audit log records what all five thought, not just the first to object.
 *
 * The result is order-independent: guardrails may be supplied in any order
 * and the verdict, the reason string and the ordering of `decisions` are
 * identical. That holds because each guardrail is a pure function of the
 * same context, and the output is sorted by GUARDRAIL_ORDER rather than by
 * the order it was evaluated in.
 */
import { DEFAULT_GUARDRAIL_CONFIG } from './config.js';
import {
  circuitBreaker,
  maxAttempts,
  minimumBackoff,
  terminalGridCell,
} from './rules.js';
import type {
  Guardrail,
  GuardrailConfig,
  GuardrailContext,
  GuardrailDecision,
  GuardrailEvaluation,
  GuardrailId,
} from './types.js';

/**
 * Canonical reporting order, most fundamental refusal first. A terminal cell
 * is a fact about the failure, an exhausted cap is a fact about the
 * transaction, and the breaker is a fact about the whole batch.
 */
export const GUARDRAIL_ORDER: readonly GuardrailId[] = [
  'terminal_grid_cell',
  'max_attempts',
  'minimum_backoff',
  'circuit_breaker',
];

export const ALL_GUARDRAILS: readonly Guardrail[] = [
  terminalGridCell,
  maxAttempts,
  minimumBackoff,
  circuitBreaker,
];

const rank = (id: GuardrailId): number => {
  const index = GUARDRAIL_ORDER.indexOf(id);
  // An unranked guardrail sorts last rather than throwing: a new rule that
  // someone forgot to register must still be able to veto.
  return index === -1 ? GUARDRAIL_ORDER.length : index;
};

/**
 * Runs every guardrail and composes one verdict.
 *
 * A single veto is enough to refuse the action, which is what makes the
 * result independent of evaluation order: logical AND over the allows.
 */
export const evaluateGuardrails = (
  context: GuardrailContext,
  config: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG,
  guardrails: readonly Guardrail[] = ALL_GUARDRAILS,
): GuardrailEvaluation => {
  const decisions: GuardrailDecision[] = guardrails
    .map((guardrail) => guardrail(context, config))
    .sort((a, b) => rank(a.guardrail) - rank(b.guardrail));

  const vetoes = decisions.filter((decision) => decision.verdict === 'veto');

  if (vetoes.length === 0) {
    return {
      verdict: 'allow',
      reason: `all ${decisions.length} guardrails allowed ${context.proposedAction}`,
      decisions,
      vetoes,
    };
  }

  return {
    verdict: 'veto',
    reason: vetoes
      .map((decision) => `${decision.guardrail}: ${decision.reason}`)
      .join('; '),
    decisions,
    vetoes,
  };
};

/**
 * The single reason to write to `decisions.guardrail_reason`, which holds
 * one string. The highest-ranked veto, or null when the action was allowed.
 */
export const primaryVetoReason = (
  evaluation: GuardrailEvaluation,
): string | null =>
  evaluation.vetoes.length === 0
    ? null
    : `${evaluation.vetoes[0]!.guardrail}: ${evaluation.vetoes[0]!.reason}`;
