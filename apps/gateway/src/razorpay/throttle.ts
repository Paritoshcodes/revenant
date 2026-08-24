/**
 * Outbound write throttle.
 *
 * Sized against observed test-mode behaviour: roughly 5 payment-link creates
 * before HTTP 429, needing about 40 seconds to clear (docs/DECISIONS.md).
 * A 50-attempt batch cannot be fired in a tight loop, so every write queues
 * through here.
 *
 * This is a sliding window, not a token bucket. A bucket was tried first and
 * failed its own test: with capacity 4 and a token every 10s, the bucket
 * refills while the burst is draining, so 7 writes landed inside one 40s
 * window. The observation is literally "N writes inside a window, then 429",
 * so the limiter states that invariant directly and can be asserted against
 * it.
 *
 * The clock and sleep are injected so the test suite can assert the schedule
 * without waiting 40 seconds.
 */

export interface ThrottleConfig {
  /** Hard ceiling on writes inside any `windowMs`-long window. */
  readonly maxWrites: number;
  readonly windowMs: number;
  /** Floor on the gap between two consecutive writes. */
  readonly minSpacingMs: number;
}

/**
 * 4 writes per 40s stays one under the observed ~5, and 40s is the observed
 * clearance time. minSpacing 4s matches the throttle already used by
 * scripts/make_links.py, so a burst is paced rather than fired flat out.
 */
export const RAZORPAY_WRITE_THROTTLE: ThrottleConfig = {
  maxWrites: 4,
  windowMs: 40_000,
  minSpacingMs: 4_000,
};

export interface ThrottleDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface Throttle {
  /** Queues `fn`, running it once the window and spacing allow. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Writes still permitted in the current window. For tests and metrics. */
  remainingInWindow(): number;
}

const defaultDeps: ThrottleDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const createThrottle = (
  config: ThrottleConfig = RAZORPAY_WRITE_THROTTLE,
  deps: ThrottleDeps = defaultDeps,
): Throttle => {
  /** Start times of writes admitted inside the current window, oldest first. */
  const admitted: number[] = [];
  let lastRunAt = Number.NEGATIVE_INFINITY;
  // Serialises callers: each waits for the previous one to be admitted, so a
  // burst of concurrent writes cannot all see an empty window at once.
  let queueTail: Promise<unknown> = Promise.resolve();

  const prune = (now: number): void => {
    while (admitted.length > 0 && admitted[0]! <= now - config.windowMs) {
      admitted.shift();
    }
  };

  const waitForSlot = async (): Promise<void> => {
    for (;;) {
      const now = deps.now();
      prune(now);

      const spacingWait =
        lastRunAt === Number.NEGATIVE_INFINITY
          ? 0
          : Math.max(0, lastRunAt + config.minSpacingMs - now);
      const windowWait =
        admitted.length < config.maxWrites
          ? 0
          : Math.max(0, admitted[0]! + config.windowMs - now);
      const wait = Math.max(spacingWait, windowWait);

      if (wait <= 0) {
        admitted.push(now);
        lastRunAt = now;
        return;
      }
      await deps.sleep(wait);
    }
  };

  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    // The tail tracks admission, not completion: two admitted writes may
    // legitimately be in flight, the window is what bounds the rate. Both
    // handlers are waitForSlot so one rejected call cannot wedge the queue.
    const slot = queueTail.then(waitForSlot, waitForSlot);
    queueTail = slot;
    return slot.then(fn);
  };

  return {
    run,
    remainingInWindow: () => {
      prune(deps.now());
      return Math.max(0, config.maxWrites - admitted.length);
    },
  };
};
