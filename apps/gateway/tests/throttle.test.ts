import { describe, expect, it } from 'vitest';

import {
  RAZORPAY_WRITE_THROTTLE,
  createThrottle,
} from '../src/razorpay/throttle.js';
import type { ThrottleDeps } from '../src/razorpay/throttle.js';

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

/** Runs `count` writes back to back and returns their start times. */
const burst = async (
  throttle: ReturnType<typeof createThrottle>,
  clock: ReturnType<typeof virtualClock>,
  count: number,
): Promise<number[]> => {
  const startedAt: number[] = [];
  await Promise.all(
    Array.from({ length: count }, () =>
      throttle.run(async () => {
        startedAt.push(clock.now());
      }),
    ),
  );
  return startedAt;
};

describe('RAZORPAY_WRITE_THROTTLE', () => {
  it('stays one write under the observed 429 threshold', () => {
    // DECISIONS.md: roughly 5 payment-link creates before a 429.
    expect(RAZORPAY_WRITE_THROTTLE.maxWrites).toBe(4);
    expect(RAZORPAY_WRITE_THROTTLE.maxWrites).toBeLessThan(5);
  });

  it('uses the observed ~40s clearance time as its window', () => {
    expect(RAZORPAY_WRITE_THROTTLE.windowMs).toBe(40_000);
  });
});

describe('createThrottle', () => {
  it('runs the first write immediately', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLE, clock);

    await throttle.run(async () => 'done');

    expect(clock.elapsed()).toBe(0);
  });

  it('spaces consecutive writes by minSpacingMs', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLE, clock);

    const startedAt = await burst(throttle, clock, 3);

    const gaps = startedAt.slice(1).map((t, i) => t - startedAt[i]!);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(RAZORPAY_WRITE_THROTTLE.minSpacingMs);
    }
  });

  it('never exceeds the observed write rate over a burst', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLE, clock);

    // A batch fired in a tight loop, exactly what trips the real 429.
    const startedAt = await burst(throttle, clock, 12);

    expect(startedAt).toHaveLength(12);

    // The invariant the limiter exists for: no 40s window ever holds more
    // writes than the observed limit tolerates. A token bucket failed this
    // with 7, because it refilled while the burst was still draining.
    for (const windowStart of startedAt) {
      const inWindow = startedAt.filter(
        (t) => t >= windowStart && t < windowStart + RAZORPAY_WRITE_THROTTLE.windowMs,
      );
      expect(inWindow.length).toBeLessThanOrEqual(
        RAZORPAY_WRITE_THROTTLE.maxWrites,
      );
    }
  });

  it('holds the fifth write until the first leaves the window', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLE, clock);

    const startedAt = await burst(throttle, clock, 5);

    // Four paced by minSpacing, then a wait for the window to roll over.
    expect(startedAt.slice(0, 4)).toEqual([0, 4_000, 8_000, 12_000].map((t) => t + 1_000_000));
    expect(startedAt[4]! - startedAt[0]!).toBe(RAZORPAY_WRITE_THROTTLE.windowMs);
  });

  it('paces a 50-attempt batch instead of firing it flat out', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLE, clock);

    const startedAt = await burst(throttle, clock, 50);
    const span = startedAt[49]! - startedAt[0]!;

    // 4 writes per 40s means a 50-write batch cannot finish in seconds.
    expect(span).toBeGreaterThan(7 * 60_000);
  });

  it('serialises concurrent callers rather than letting them all through', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(
      { maxWrites: 2, windowMs: 10_000, minSpacingMs: 1_000 },
      clock,
    );

    const startedAt = await burst(throttle, clock, 4);

    expect(startedAt[1]! - startedAt[0]!).toBe(1_000);
    // Third has to wait for the first to age out of the 10s window.
    expect(startedAt[2]! - startedAt[0]!).toBe(10_000);
  });

  it('reports the remaining budget and recovers it as the window rolls', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLE, clock);

    expect(throttle.remainingInWindow()).toBe(4);

    await throttle.run(async () => undefined);
    expect(throttle.remainingInWindow()).toBe(3);

    await clock.sleep(RAZORPAY_WRITE_THROTTLE.windowMs);
    expect(throttle.remainingInWindow()).toBe(4);
  });

  it('propagates the wrapped result and its rejection without wedging the queue', async () => {
    const clock = virtualClock();
    const throttle = createThrottle(RAZORPAY_WRITE_THROTTLE, clock);

    await expect(throttle.run(async () => 42)).resolves.toBe(42);
    await expect(
      throttle.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(throttle.run(async () => 'still works')).resolves.toBe(
      'still works',
    );
  });
});
