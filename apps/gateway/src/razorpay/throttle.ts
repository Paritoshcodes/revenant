/**
 * Outbound write throttle.
 *
 * The limit is PER ENDPOINT, not a global account budget
 * (docs/API-BEHAVIOUR.md, "Rate limits are PER ENDPOINT"): while /orders
 * was rate limited, GET /payments kept returning 200, and /orders and
 * /payment_links tolerated different burst sizes before a 429 (7 vs ~5)
 * and cleared at very different speeds (Retry-After: 3 vs ~40s). A single
 * shared window would pace /orders as if it were as slow as
 * /payment_links, or worse, let /payment_links borrow /orders' budget.
 * So each endpoint gets its own independent sliding window, keyed by the
 * request path.
 *
 * This is a sliding window, not a token bucket. A bucket was tried first
 * and failed its own test: with capacity 4 and a token every 10s, the
 * bucket refills while the burst is draining, so 7 writes landed inside
 * one 40s window. The observation is literally "N writes inside a window,
 * then 429", so the limiter states that invariant directly and can be
 * asserted against it.
 *
 * The clock and sleep are injected so the test suite can assert the
 * schedule without waiting real seconds.
 */

export interface ThrottleConfig {
  /** Hard ceiling on writes inside any `windowMs`-long window. */
  readonly maxWrites: number;
  readonly windowMs: number;
  /** Floor on the gap between two consecutive writes. */
  readonly minSpacingMs: number;
}

/**
 * `POST /orders`: 7 writes ok, 429 on the 8th, `Retry-After: 3`
 * (docs/API-BEHAVIOUR.md). 6 stays one under the observed threshold; a 5s
 * window sits just above the 3s the server itself reported clearing in.
 * minSpacing is short because the whole window is short: at 500ms apart,
 * 6 writes exactly fill the 5s window rather than front-loading it.
 */
export const ORDERS_WRITE_THROTTLE: ThrottleConfig = {
  maxWrites: 6,
  windowMs: 5_000,
  minSpacingMs: 500,
};

/**
 * `POST /payment_links`: ~5 writes ok, then 429, needing ~40s to clear
 * (docs/API-BEHAVIOUR.md). 4 stays one under the observed ~5, and 40s is
 * the observed clearance time. minSpacing 4s matches the throttle already
 * used by scripts/make_links.py, so a burst is paced rather than fired
 * flat out.
 */
export const PAYMENT_LINKS_WRITE_THROTTLE: ThrottleConfig = {
  maxWrites: 4,
  windowMs: 40_000,
  minSpacingMs: 4_000,
};

/**
 * Every known write endpoint's profile, keyed by request path exactly as
 * client.ts calls it (both are literal, unparameterised paths).
 */
export const RAZORPAY_WRITE_THROTTLES: Record<string, ThrottleConfig> = {
  '/orders': ORDERS_WRITE_THROTTLE,
  '/payment_links': PAYMENT_LINKS_WRITE_THROTTLE,
};

/**
 * Fallback for a write endpoint with no measured profile yet. Defaults to
 * the slower, more conservative of the two known profiles: assuming an
 * unmeasured endpoint is as forgiving as the fastest one risks a 429 the
 * throttle exists to prevent.
 */
export const DEFAULT_WRITE_THROTTLE: ThrottleConfig = PAYMENT_LINKS_WRITE_THROTTLE;

export interface ThrottleDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface Throttle {
  /** Queues `fn` against `endpoint`'s own window, running it once that window and spacing allow. */
  run<T>(endpoint: string, fn: () => Promise<T>): Promise<T>;
  /** Writes still permitted in `endpoint`'s current window. For tests and metrics. */
  remainingInWindow(endpoint: string): number;
}

const defaultDeps: ThrottleDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface EndpointState {
  /** Start times of writes admitted inside the current window, oldest first. */
  admitted: number[];
  lastRunAt: number;
  /** Serialises callers on this endpoint only; other endpoints queue independently. */
  queueTail: Promise<unknown>;
}

export const createThrottle = (
  configs: Record<string, ThrottleConfig> = RAZORPAY_WRITE_THROTTLES,
  deps: ThrottleDeps = defaultDeps,
): Throttle => {
  const states = new Map<string, EndpointState>();

  const configFor = (endpoint: string): ThrottleConfig =>
    configs[endpoint] ?? DEFAULT_WRITE_THROTTLE;

  const stateFor = (endpoint: string): EndpointState => {
    const existing = states.get(endpoint);
    if (existing !== undefined) return existing;
    const created: EndpointState = {
      admitted: [],
      lastRunAt: Number.NEGATIVE_INFINITY,
      queueTail: Promise.resolve(),
    };
    states.set(endpoint, created);
    return created;
  };

  const prune = (config: ThrottleConfig, state: EndpointState, now: number): void => {
    while (state.admitted.length > 0 && state.admitted[0]! <= now - config.windowMs) {
      state.admitted.shift();
    }
  };

  const waitForSlot = async (endpoint: string): Promise<void> => {
    const config = configFor(endpoint);
    const state = stateFor(endpoint);
    for (;;) {
      const now = deps.now();
      prune(config, state, now);

      const spacingWait =
        state.lastRunAt === Number.NEGATIVE_INFINITY
          ? 0
          : Math.max(0, state.lastRunAt + config.minSpacingMs - now);
      const windowWait =
        state.admitted.length < config.maxWrites
          ? 0
          : Math.max(0, state.admitted[0]! + config.windowMs - now);
      const wait = Math.max(spacingWait, windowWait);

      if (wait <= 0) {
        state.admitted.push(now);
        state.lastRunAt = now;
        return;
      }
      await deps.sleep(wait);
    }
  };

  const run = <T>(endpoint: string, fn: () => Promise<T>): Promise<T> => {
    const state = stateFor(endpoint);
    // The tail tracks admission, not completion: two admitted writes may
    // legitimately be in flight, the window is what bounds the rate. Both
    // handlers are waitForSlot so one rejected call cannot wedge the queue.
    const slot = state.queueTail.then(
      () => waitForSlot(endpoint),
      () => waitForSlot(endpoint),
    );
    state.queueTail = slot;
    return slot.then(fn);
  };

  return {
    run,
    remainingInWindow: (endpoint) => {
      const config = configFor(endpoint);
      const state = stateFor(endpoint);
      prune(config, state, deps.now());
      return Math.max(0, config.maxWrites - state.admitted.length);
    },
  };
};
