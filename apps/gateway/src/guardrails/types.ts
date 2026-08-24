/**
 * Guardrail vocabulary.
 *
 * Guardrails are pure functions with no I/O. Everything they need arrives in
 * the context, including the current time, so a verdict is reproducible from
 * its inputs alone and can be replayed from the audit log.
 */
import type {
  ErrorSource,
  ErrorStep,
  GuardrailVerdict,
  RecoveryAction,
} from '@revenant/contracts';

/**
 * Canonical identifiers. The order of this union is not significant; the
 * evaluation order is fixed by GUARDRAIL_ORDER in evaluate.ts.
 */
export type GuardrailId =
  | 'terminal_grid_cell'
  | 'max_attempts'
  | 'minimum_backoff'
  | 'circuit_breaker';

/** One guardrail's answer. `reason` is populated on allow as well as veto. */
export interface GuardrailDecision {
  readonly guardrail: GuardrailId;
  readonly verdict: GuardrailVerdict;
  readonly reason: string;
}

/** Outcome counts for the batch currently in flight. */
export interface BatchStats {
  /** Attempts that have settled so far in this batch. */
  readonly settled: number;
  /** How many of those failed. */
  readonly failed: number;
}

/**
 * Everything a guardrail may look at. No clock, no database, no network:
 * the caller resolves all of it first.
 */
export interface GuardrailContext {
  readonly transactionId: string;
  readonly errorSource: ErrorSource;
  readonly errorStep: ErrorStep;
  /** What the policy wants to do. The guardrail may refuse it. */
  readonly proposedAction: RecoveryAction;
  /** The attempt being proposed, 1-based. Attempt 1 is the first try. */
  readonly attemptNumber: number;
  /** Epoch milliseconds. Injected, never read from the clock. */
  readonly nowMs: number;
  /** Epoch milliseconds of the previous attempt, or null if this is the first. */
  readonly lastAttemptAtMs: number | null;
  readonly batch: BatchStats;
}

/** Spacing schedule between attempts on the same transaction. */
export interface AttemptSpacingConfig {
  /** Required gap before attempt 2. Zero disables spacing entirely. */
  readonly baseMs: number;
  /** Multiplier per subsequent attempt. */
  readonly factor: number;
  /** Ceiling on the required gap. */
  readonly maxMs: number;
}

export interface CircuitBreakerConfig {
  /** Do not trip before this many attempts have settled: small N is noise. */
  readonly minSettled: number;
  /** Failure rate above which the batch is halted, 0..1. */
  readonly failureRateThreshold: number;
}

export interface GuardrailConfig {
  /** Hard ceiling on attempts per transaction. */
  readonly maxAttempts: number;
  readonly attemptSpacing: AttemptSpacingConfig;
  readonly circuitBreaker: CircuitBreakerConfig;
}

/** The composed result. */
export interface GuardrailEvaluation {
  /** `veto` if any guardrail vetoed, otherwise `allow`. */
  readonly verdict: GuardrailVerdict;
  /**
   * Deterministic summary. On veto, the reasons of every vetoing guardrail
   * in canonical order. On allow, a short confirmation.
   */
  readonly reason: string;
  /** Every guardrail's decision, always in canonical order. */
  readonly decisions: readonly GuardrailDecision[];
  /** The vetoing subset, in canonical order. Empty when allowed. */
  readonly vetoes: readonly GuardrailDecision[];
}

/** A guardrail is a pure function of context and config. */
export type Guardrail = (
  context: GuardrailContext,
  config: GuardrailConfig,
) => GuardrailDecision;
