import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WRITE_THROTTLE,
  ORDERS_WRITE_THROTTLE,
  PAYMENT_LINKS_WRITE_THROTTLE,
  RAZORPAY_WRITE_THROTTLES,
  createThrottle,
} from '../../src/razorpay/throttle.js';
import type { ThrottleDeps } from '../../src/razorpay/throttle.js';

/**
 * A virtual clock. `sleep` advances time instantly, so a 40-second wait costs
 * nothing to assert.
 */
const virtualClock = (): ThrottleDeps & { elapsed: () => number } => {
  let current = 1_000_000;
  const start = current;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    elapsed: () => current - start,
  };
};

/** Runs `count` writes against `endpoint` back to back and returns their start times. */
const burst = async (
  throttle: ReturnType<typeof createThrottle>,
  clock: ReturnType<typeof virtualClock>,
  endpoint: string,
  count: number,
): Promise<number[]> => {
  const startedAt: number[] = [];
  await Promise.all(
    Array.from({ length: count }, () =>
      throttle.run(endpoint, async () => {
        startedAt.push(clock.now());
      }),
    ),
  );
  return startedAt;
};

describe('per-endpoint throttle profiles', () => {
  it('stays one write under each endpoint\'s observed 429 threshold', () => {
    // docs/API-BEHAVIOUR.md: /orders allowed 7 then 429'd; /payment_links
    // allowed ~5.
    expect(ORDERS_WRITE_THROTTLE.maxWrites).toBe(6);
    expect(ORDERS_WRITE_THROTTLE.maxWrites).toBeLessThan(7);
    expect(PAYMENT_LINKS_WRITE_THROTTLE.maxWrites).toBe(4);
    expect(PAYMENT_LINKS_WRITE_THROTTLE.maxWrites).toBeLessThan(5);
  });

  it('gives /orders a much shorter window than /payment_links, matching Retry-After vs the ~40s clearance', () => {
    expect(ORDERS_WRITE_THROTTLE.windowMs).toBeLessThan(
      PAYMENT_LINKS_WRITE_THROTTLE.windowMs,
    );
    expect(PAYMENT_LINKS_WRITE_THROTTLE.windowMs).toBe(40_000);
  });

  it('registers both measured endpoints under their exact request paths', () => {
    expect(RAZORPAY_WRITE_THROTTLES['/orders']).toBe(ORDERS_WRITE_THROTTLE);
    expect(RAZORPAY_WRITE_THROTTLES['/payment_links']).toBe(PAYMENT_LINKS_WRITE_THROTTLE);
  });

  it('falls back to the slower, more conservative profile for an unmeasured endpoint', () => {
    expect(DEFAULT_WRITE_THROTTLE).toBe(PAYMENT_LINKS_WRITE_THROTTLE);
  });
});

describe('createThrottle: endpoints have independent budgets', () => {
  it('does not delay a /payment_links write while /orders is fully saturated', async () => {
    // docs/API-BEHAVIOUR.md: while /orders was rate limited, other calls
    // still went through with zero 429s. A shared window would have made
    // /payment_links wait for /orders' budget to free up; independent
    // windows must not.
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    await burst(throttle, clock, '/orders', ORDERS_WRITE_THROTTLE.maxWrites);
    const beforeOtherEndpoint = clock.elapsed();

    const startedAt = await burst(throttle, clock, '/payment_links', 1);

    expect(startedAt[0]).toBe(1_000_000 + beforeOtherEndpoint);
  });

  it('tracks remaining budget separately per endpoint', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    await burst(throttle, clock, '/orders', 2);

    expect(throttle.remainingInWindow('/orders')).toBe(
      ORDERS_WRITE_THROTTLE.maxWrites - 2,
    );
    expect(throttle.remainingInWindow('/payment_links')).toBe(
      PAYMENT_LINKS_WRITE_THROTTLE.maxWrites,
    );
  });

  it('uses the fallback profile for any endpoint not in the config map', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    expect(throttle.remainingInWindow('/some/future/endpoint')).toBe(
      DEFAULT_WRITE_THROTTLE.maxWrites,
    );
  });

  it('does not let one endpoint\'s writes count against another\'s window', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    // Exhaust /orders and /payment_links independently, in parallel: if
    // they shared any state, one would starve the other's admission.
    const [ordersStarts, linksStarts] = await Promise.all([
      burst(throttle, clock, '/orders', ORDERS_WRITE_THROTTLE.maxWrites),
      burst(throttle, clock, '/payment_links', PAYMENT_LINKS_WRITE_THROTTLE.maxWrites),
    ]);

    expect(ordersStarts).toHaveLength(ORDERS_WRITE_THROTTLE.maxWrites);
    expect(linksStarts).toHaveLength(PAYMENT_LINKS_WRITE_THROTTLE.maxWrites);
  });
});

describe('createThrottle: sliding-window behaviour, per endpoint', () => {
  it('runs the first write immediately', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    await throttle.run('/payment_links', async () => 'done');

    expect(clock.elapsed()).toBe(0);
  });

  it('spaces consecutive writes by minSpacingMs', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    const startedAt = await burst(throttle, clock, '/payment_links', 3);

    const gaps = startedAt.slice(1).map((t, i) => t - startedAt[i]!);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(PAYMENT_LINKS_WRITE_THROTTLE.minSpacingMs);
    }
  });

  it('never exceeds the observed write rate over a burst', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    // A batch fired in a tight loop, exactly what trips the real 429.
    const startedAt = await burst(throttle, clock, '/payment_links', 12);

    expect(startedAt).toHaveLength(12);

    // The invariant the limiter exists for: no window ever holds more
    // writes than the observed limit tolerates. A token bucket failed this
    // with 7, because it refilled while the burst was still draining.
    for (const windowStart of startedAt) {
      const inWindow = startedAt.filter(
        (t) => t >= windowStart && t < windowStart + PAYMENT_LINKS_WRITE_THROTTLE.windowMs,
      );
      expect(inWindow.length).toBeLessThanOrEqual(PAYMENT_LINKS_WRITE_THROTTLE.maxWrites);
    }
  });

  it('holds the fifth write until the first leaves the window', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    const startedAt = await burst(throttle, clock, '/payment_links', 5);

    // Four paced by minSpacing, then a wait for the window to roll over.
    expect(startedAt.slice(0, 4)).toEqual([0, 4_000, 8_000, 12_000].map((t) => t + 1_000_000));
    expect(startedAt[4]! - startedAt[0]!).toBe(PAYMENT_LINKS_WRITE_THROTTLE.windowMs);
  });

  it('paces a 50-attempt /payment_links batch instead of firing it flat out', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    const startedAt = await burst(throttle, clock, '/payment_links', 50);
    const span = startedAt[49]! - startedAt[0]!;

    // 4 writes per 40s means a 50-write batch cannot finish in seconds.
    expect(span).toBeGreaterThan(7 * 60_000);
  });

  it('clears an /orders burst far faster than a /payment_links one, matching the observed Retry-After', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    const startedAt = await burst(throttle, clock, '/orders', 12);
    const span = startedAt[11]! - startedAt[0]!;

    // 6 writes per 5s: nowhere near the 7-minute-plus /payment_links span.
    expect(span).toBeLessThan(15_000);
  });

  it('serialises concurrent callers on the same endpoint rather than letting them all through', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(
      { '/probe': { maxWrites: 2, windowMs: 10_000, minSpacingMs: 1_000 } },
      clock,
    );

    const startedAt = await burst(throttle, clock, '/probe', 4);

    expect(startedAt[1]! - startedAt[0]!).toBe(1_000);
    // Third has to wait for the first to age out of the 10s window.
    expect(startedAt[2]! - startedAt[0]!).toBe(10_000);
  });

  it('reports the remaining budget and recovers it as the window rolls', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    expect(throttle.remainingInWindow('/payment_links')).toBe(4);

    await throttle.run('/payment_links', async () => undefined);
    expect(throttle.remainingInWindow('/payment_links')).toBe(3);

    await clock.sleep(PAYMENT_LINKS_WRITE_THROTTLE.windowMs);
    expect(throttle.remainingInWindow('/payment_links')).toBe(4);
  });

  it('propagates the wrapped result and its rejection without wedging the queue', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLES, clock);

    await expect(throttle.run('/orders', async () => 42)).resolves.toBe(42);
    await expect(
      throttle.run('/orders', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(throttle.run('/orders', async () => 'still works')).resolves.toBe(
      'still works',
    );
  });
});
