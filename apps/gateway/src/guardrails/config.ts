/**
 * Guardrail configuration.
 *
 * Config is a parameter, not a constant baked into the rules, because the
 * two experiment arms are not allowed to share one. See CONTROL_ARM below.
 */
import type { GuardrailConfig } from './types.js';

/**
 * The agent policy's guardrails.
 *
 * maxAttempts 3 is the bound in ARCHITECTURE.md and EXPERIMENT-PROTOCOL.md.
 *
 * Attempt spacing starts at 60s and doubles, capped at 15 minutes. This is
 * separate from the outbound throttle in src/razorpay/throttle.ts: the
 * throttle protects Razorpay's rate limit across all transactions, this
 * protects one customer's card from being hammered by repeated attempts.
 */
export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  maxAttempts: 3,
  attemptSpacing: {
    baseMs: 60_000,
    factor: 2,
    maxMs: 900_000,
  },
  circuitBreaker: {
    minSettled: 10,
    failureRateThreshold: 0.5,
  },
};

/**
 * The baseline arm's guardrails.
 *
 * EXPERIMENT-PROTOCOL.md freezes the control arm as "retry immediately, up
 * to 3 attempts, no grid awareness". Spacing is therefore zero: applying the
 * agent's 60s schedule to the control arm would make the baseline something
 * other than the protocol says it is, and the measured lift would then be
 * partly an artefact of our own configuration.
 *
 * The attempt cap and the circuit breaker still apply. They are safety
 * bounds on real money, not part of the policy being measured.
 */
export const CONTROL_ARM_GUARDRAIL_CONFIG: GuardrailConfig = {
  ...DEFAULT_GUARDRAIL_CONFIG,
  attemptSpacing: {
    ...DEFAULT_GUARDRAIL_CONFIG.attemptSpacing,
    baseMs: 0,
  },
};
