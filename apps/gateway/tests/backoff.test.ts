import { describe, expect, it } from 'vitest';

import {
  RATE_LIMIT_BACKOFF,
  TRANSIENT_BACKOFF,
  backoffDelayMs,
  delayForFailure,
  isRetryable,
  policyFor,
  retryAfterMs,
} from '../src/razorpay/backoff.js';

/** Pins jitter so the schedule is exact. */
const noJitter = (): number => 0;
const maxJitter = (): number => 1;

describe('backoffDelayMs', () => {
  it('starts at the fallback base, not the old fixed-40s delay', () => {
    // docs/API-BEHAVIOUR.md: Retry-After now wins outright (see
    // delayForFailure), so this policy only ever fires when the header is
    // absent. 40s was sized for the wrong assumption; 5s is the fallback now.
    expect(backoffDelayMs(1, RATE_LIMIT_BACKOFF, noJitter)).toBe(5_000);
  });

  it('doubles per retry', () => {
    const delays = [1, 2, 3].map((n) =>
      backoffDelayMs(n, RATE_LIMIT_BACKOFF, noJitter),
    );
    expect(delays).toEqual([5_000, 10_000, 20_000]);
  });

  it('caps the exponential term at maxMs', () => {
    expect(backoffDelayMs(9, RATE_LIMIT_BACKOFF, noJitter)).toBe(
      RATE_LIMIT_BACKOFF.maxMs,
    );
  });

  it('treats the base delay as a floor and only adds jitter', () => {
    const floor = 5_000;
    expect(backoffDelayMs(1, RATE_LIMIT_BACKOFF, noJitter)).toBe(floor);
    expect(backoffDelayMs(1, RATE_LIMIT_BACKOFF, maxJitter)).toBe(
      floor + RATE_LIMIT_BACKOFF.jitterMs,
    );
    for (const random of [() => 0.01, () => 0.5, () => 0.99]) {
      const delay = backoffDelayMs(1, RATE_LIMIT_BACKOFF, random);
      expect(delay).toBeGreaterThanOrEqual(floor);
      expect(delay).toBeLessThanOrEqual(floor + RATE_LIMIT_BACKOFF.jitterMs);
    }
  });

  it('uses a fast schedule for transient failures', () => {
    expect(backoffDelayMs(1, TRANSIENT_BACKOFF, noJitter)).toBe(1_000);
    expect(backoffDelayMs(4, TRANSIENT_BACKOFF, noJitter)).toBe(8_000);
  });

  it('rejects a non-positive or fractional attempt number', () => {
    expect(() => backoffDelayMs(0, TRANSIENT_BACKOFF)).toThrow(RangeError);
    expect(() => backoffDelayMs(-1, TRANSIENT_BACKOFF)).toThrow(RangeError);
    expect(() => backoffDelayMs(1.5, TRANSIENT_BACKOFF)).toThrow(RangeError);
  });
});

describe('retryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(retryAfterMs('40')).toBe(40_000);
    expect(retryAfterMs('  7 ')).toBe(7_000);
    expect(retryAfterMs('0')).toBe(0);
  });

  it('parses an HTTP date relative to now', () => {
    const now = Date.parse('2026-08-24T10:00:00Z');
    expect(retryAfterMs('Mon, 24 Aug 2026 10:00:30 GMT', now)).toBe(30_000);
  });

  it('never returns a negative delay for a past date', () => {
    const now = Date.parse('2026-08-24T10:00:00Z');
    expect(retryAfterMs('Mon, 24 Aug 2026 09:59:00 GMT', now)).toBe(0);
  });

  it('returns null when absent or unparseable', () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
    expect(retryAfterMs('')).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});

describe('isRetryable', () => {
  it('retries a rate-limited write, because the request never executed', () => {
    expect(isRetryable('rate_limited', true)).toBe(true);
  });

  it('never retries a write that failed with a network error', () => {
    // Razorpay does not deduplicate: two POST /orders with the same receipt
    // created two orders. A timed-out write may or may not have landed, so
    // retrying it risks charging twice.
    expect(isRetryable('network', true)).toBe(false);
    expect(isRetryable('upstream', true)).toBe(false);
  });

  it('retries reads on network and upstream failures', () => {
    expect(isRetryable('network', false)).toBe(true);
    expect(isRetryable('upstream', false)).toBe(true);
    expect(isRetryable('rate_limited', false)).toBe(true);
  });

  it('never retries a client-side failure, read or write', () => {
    for (const kind of ['auth', 'validation', 'not_found', 'conflict'] as const) {
      expect(isRetryable(kind, true)).toBe(false);
      expect(isRetryable(kind, false)).toBe(false);
    }
  });

  it('never retries a quota-exceeded failure, read or write', () => {
    // docs/API-BEHAVIOUR.md: permanent per-account ceiling. Waiting does
    // not help, and cancelling existing resources does not free it, so
    // unlike rate_limited this is never worth another attempt.
    expect(isRetryable('quota_exceeded', true)).toBe(false);
    expect(isRetryable('quota_exceeded', false)).toBe(false);
  });
});

describe('policyFor', () => {
  it('sends 429 to the slow policy and everything else to the fast one', () => {
    expect(policyFor('rate_limited')).toBe(RATE_LIMIT_BACKOFF);
    expect(policyFor('network')).toBe(TRANSIENT_BACKOFF);
    expect(policyFor('upstream')).toBe(TRANSIENT_BACKOFF);
  });
});

describe('delayForFailure', () => {
  it('uses Retry-After outright, even when it is SHORTER than the fallback policy would give', () => {
    // The bug this fixes: Razorpay sent Retry-After: 3 on an /orders 429
    // while the old code did Math.max(computed, serverAsked), so a
    // computed delay bigger than 3s silently discarded the server's
    // instruction. retry_after_seconds must win outright, not just when
    // it happens to be the larger number.
    const delay = delayForFailure(
      { kind: 'rate_limited', message: '429', retry_after_seconds: 3 },
      1,
      noJitter,
    );
    expect(delay).toBe(3_000);
    // The fallback policy alone would have picked something bigger.
    expect(backoffDelayMs(1, RATE_LIMIT_BACKOFF, noJitter)).toBeGreaterThan(3_000);
  });

  it('uses Retry-After outright even when it is LONGER than the fallback policy would give', () => {
    const delay = delayForFailure(
      { kind: 'rate_limited', message: '429', retry_after_seconds: 120 },
      1,
      noJitter,
    );
    expect(delay).toBe(120_000);
  });

  it('falls back to the exponential policy only when the header is absent', () => {
    const delay = delayForFailure({ kind: 'network', message: 'reset' }, 2, noJitter);
    expect(delay).toBe(2_000);
  });

  it('falls back for rate_limited too when no Retry-After was sent', () => {
    const delay = delayForFailure({ kind: 'rate_limited', message: '429' }, 1, noJitter);
    expect(delay).toBe(RATE_LIMIT_BACKOFF.baseMs);
  });

  it('treats retry_after_seconds: 0 as a real instruction, not "absent"', () => {
    const delay = delayForFailure(
      { kind: 'rate_limited', message: '429', retry_after_seconds: 0 },
      1,
      noJitter,
    );
    expect(delay).toBe(0);
  });
});
