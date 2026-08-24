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
  it('starts at the observed 429 recovery time, not a sub-second delay', () => {
    // DECISIONS.md: ~5 writes trip a 429 and clearing it needed ~40s.
    expect(backoffDelayMs(1, RATE_LIMIT_BACKOFF, noJitter)).toBe(40_000);
  });

  it('doubles per retry', () => {
    const delays = [1, 2, 3].map((n) =>
      backoffDelayMs(n, RATE_LIMIT_BACKOFF, noJitter),
    );
    expect(delays).toEqual([40_000, 80_000, 160_000]);
  });

  it('caps the exponential term at maxMs', () => {
    expect(backoffDelayMs(9, RATE_LIMIT_BACKOFF, noJitter)).toBe(
      RATE_LIMIT_BACKOFF.maxMs,
    );
  });

  it('treats the exponential term as a floor and only adds jitter', () => {
    // Full jitter could return 2s for a 429, and 2s is known to be too short.
    const floor = 40_000;
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
});

describe('policyFor', () => {
  it('sends 429 to the slow policy and everything else to the fast one', () => {
    expect(policyFor('rate_limited')).toBe(RATE_LIMIT_BACKOFF);
    expect(policyFor('network')).toBe(TRANSIENT_BACKOFF);
    expect(policyFor('upstream')).toBe(TRANSIENT_BACKOFF);
  });
});

describe('delayForFailure', () => {
  it('honours Retry-After when the server asks for longer than our policy', () => {
    const delay = delayForFailure(
      { kind: 'rate_limited', message: '429', retry_after_seconds: 120 },
      1,
      noJitter,
    );
    expect(delay).toBe(120_000);
  });

  it('keeps our own delay when the server asks for less', () => {
    const delay = delayForFailure(
      { kind: 'rate_limited', message: '429', retry_after_seconds: 5 },
      1,
      noJitter,
    );
    expect(delay).toBe(40_000);
  });

  it('falls back to the policy when the server says nothing', () => {
    const delay = delayForFailure({ kind: 'network', message: 'reset' }, 2, noJitter);
    expect(delay).toBe(2_000);
  });
});
