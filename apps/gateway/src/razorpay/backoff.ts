/**
 * Retry and backoff policy for outbound Razorpay calls.
 *
 * Pure functions only, no I/O and no clock, so the numbers below can be
 * asserted in a unit test rather than waited out.
 *
 * The constants come from observed test-mode behaviour recorded in
 * docs/DECISIONS.md: roughly 5 payment-link creates trip an HTTP 429, and
 * clearing it needed about 40 seconds.
 */
import type { Failure, FailureKind } from '@revenant/contracts';

export interface BackoffPolicy {
  /** Delay before the first retry, in milliseconds. */
  readonly baseMs: number;
  /** Multiplier applied per subsequent retry. */
  readonly factor: number;
  /** Ceiling on the exponential term, before jitter. */
  readonly maxMs: number;
  /** Additive random spread, 0..jitterMs, to decorrelate concurrent callers. */
  readonly jitterMs: number;
  /** Retries after the initial call. 0 means never retry. */
  readonly maxRetries: number;
}

/**
 * A 429 needed ~40s to clear, so the first retry waits that long rather than
 * the usual sub-second. Jitter is additive rather than the more common full
 * jitter: full jitter could pick a 2-second delay, and we already know from
 * observation that 2 seconds is not enough.
 */
export const RATE_LIMIT_BACKOFF: BackoffPolicy = {
  baseMs: 40_000,
  factor: 2,
  maxMs: 160_000,
  jitterMs: 5_000,
  maxRetries: 4,
};

/** Network wobble and 5xx on reads. Cheap to retry, so retry quickly. */
export const TRANSIENT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 16_000,
  jitterMs: 250,
  maxRetries: 3,
};

/**
 * Delay before retry number `attempt`, where attempt 1 is the first retry.
 *
 * `random` is injected so the test can pin the jitter. The exponential term
 * is a floor: the returned delay is never below `baseMs * factor^(attempt-1)`
 * capped at `maxMs`, because the observed 429 recovery time is a hard
 * minimum, not an average to jitter around.
 */
export const backoffDelayMs = (
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number => {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be an integer >= 1, got ${attempt}`);
  }
  const exponential = Math.min(
    policy.maxMs,
    policy.baseMs * policy.factor ** (attempt - 1),
  );
  return Math.round(exponential + random() * policy.jitterMs);
};

/**
 * Retry-After, in milliseconds, or null when the header is absent or
 * unparseable. Razorpay sends delta-seconds; the HTTP spec also allows a
 * date, so both are handled.
 */
export const retryAfterMs = (
  headerValue: string | null | undefined,
  now: number = Date.now(),
): number | null => {
  if (headerValue === null || headerValue === undefined) return null;
  const trimmed = headerValue.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1_000;
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - now);
};

/**
 * Whether a failed call may be retried.
 *
 * Writes are deliberately stricter than reads. Razorpay does not deduplicate
 * for us: two identical `POST /orders` with the same receipt created two
 * distinct orders (docs/DECISIONS.md). So a write that failed with a network
 * error must NOT be retried, because we cannot tell whether the request
 * reached the API and created something. A 429 is different: a rate-limited
 * request was rejected before it did any work, so retrying it is safe.
 */
export const isRetryable = (kind: FailureKind, isWrite: boolean): boolean => {
  if (isWrite) return kind === 'rate_limited';
  return kind === 'rate_limited' || kind === 'network' || kind === 'upstream';
};

/** Policy to use for a given failure. */
export const policyFor = (kind: FailureKind): BackoffPolicy =>
  kind === 'rate_limited' ? RATE_LIMIT_BACKOFF : TRANSIENT_BACKOFF;

/**
 * How long to wait before retrying `failure`, honouring a server-supplied
 * Retry-After when it asks for longer than our own policy would.
 */
export const delayForFailure = (
  failure: Failure,
  attempt: number,
  random: () => number = Math.random,
): number => {
  const policy = policyFor(failure.kind);
  const computed = backoffDelayMs(attempt, policy, random);
  const serverAsked = (failure.retry_after_seconds ?? 0) * 1_000;
  return Math.max(computed, serverAsked);
};
