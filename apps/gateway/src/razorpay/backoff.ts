/**
 * Retry and backoff policy for outbound Razorpay calls.
 *
 * Pure functions only, no I/O and no clock, so the numbers below can be
 * asserted in a unit test rather than waited out.
 *
 * Razorpay sends `Retry-After` on its 429s and means it: /orders asked for
 * 3 seconds while the old fixed 40s policy would have waited 13x longer
 * for no reason (docs/API-BEHAVIOUR.md). `delayForFailure` therefore
 * honours `retry_after_seconds` outright when present. The exponential
 * policy below is a fallback for the rare case the header is absent, not
 * the default path.
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
 * Fallback only: used when a 429 arrives WITHOUT a `Retry-After` header,
 * which `delayForFailure` treats as the exception rather than the rule.
 * 40s was sized when the header was being ignored outright; now that it
 * wins whenever present, this path exists purely for the case we have no
 * server signal at all. 5s sits close to the faster endpoint's observed
 * recovery (/orders: 3s) with a little headroom, rather than assuming the
 * slower one (/payment_links: ~40s) by default. Jitter stays additive
 * rather than full jitter, so it can only push the wait up, never below
 * the floor.
 */
export const RATE_LIMIT_BACKOFF: BackoffPolicy = {
  baseMs: 5_000,
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
 * capped at `maxMs`, because a policy's base delay is a hard minimum for
 * that failure class, not an average to jitter around.
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
 *
 * `quota_exceeded` is never retryable, for either reads or writes: it is a
 * permanent per-account ceiling, not a transient condition, and Razorpay
 * confirmed cancelling existing resources does not free it
 * (docs/API-BEHAVIOUR.md). Falls out of the exhaustive lists below rather
 * than needing its own branch — it matches neither write's single allowed
 * kind nor any of the read exceptions.
 */
export const isRetryable = (kind: FailureKind, isWrite: boolean): boolean => {
  if (isWrite) return kind === 'rate_limited';
  return kind === 'rate_limited' || kind === 'network' || kind === 'upstream';
};

/** Policy to use for a given failure. */
export const policyFor = (kind: FailureKind): BackoffPolicy =>
  kind === 'rate_limited' ? RATE_LIMIT_BACKOFF : TRANSIENT_BACKOFF;

/**
 * How long to wait before retrying `failure`.
 *
 * `retry_after_seconds`, when present, wins outright: Razorpay sent
 * `Retry-After: 3` on an /orders 429 while the old policy waited a fixed
 * 40 seconds regardless, roughly 13x too slow. The exponential policy
 * (with jitter) only runs when the header is absent, which is the
 * exception, not the common case.
 */
export const delayForFailure = (
  failure: Failure,
  attempt: number,
  random: () => number = Math.random,
): number => {
  if (failure.retry_after_seconds !== undefined) {
    return failure.retry_after_seconds * 1_000;
  }
  const policy = policyFor(failure.kind);
  return backoffDelayMs(attempt, policy, random);
};
