import { describe, expect, it } from 'vitest';

import { request } from '../../src/razorpay/http.js';
import type { HttpDeps, RazorpayCredentials } from '../../src/razorpay/http.js';
import type { Throttle } from '../../src/razorpay/throttle.js';

const creds: RazorpayCredentials = { key: 'rzp_test_x', secret: 'secret' };

interface FakeResponseInit {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

const fakeResponse = ({ status, body, headers = {} }: FakeResponseInit): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

/** Runs `fn` immediately and records which endpoint it was asked to queue. */
const passthroughThrottle = (): Throttle & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    run: (endpoint, fn) => {
      calls.push(endpoint);
      return fn();
    },
    remainingInWindow: () => Number.POSITIVE_INFINITY,
  };
};

/** Proves a read never reaches the throttle at all. */
const forbiddenThrottle = (): Throttle => ({
  run: () => {
    throw new Error('throttle.run should not be called for a read');
  },
  remainingInWindow: () => Number.POSITIVE_INFINITY,
});

const baseDeps = (fetchImpl: HttpDeps['fetch'], throttle: Throttle): HttpDeps => ({
  fetch: fetchImpl,
  sleep: async () => {},
  random: () => 0,
  throttle,
  baseUrl: 'https://api.razorpay.com/v1',
});

describe('request: reads bypass the throttle entirely', () => {
  it('never calls throttle.run for a GET', async () => {
    const fetchImpl = (async () =>
      fakeResponse({ status: 200, body: { count: 0, items: [] } })) as HttpDeps['fetch'];
    const deps = baseDeps(fetchImpl, forbiddenThrottle());

    const result = await request(creds, deps, {
      method: 'GET',
      path: '/payments',
      isWrite: false,
    });

    expect(result.ok).toBe(true);
  });

  it('queues a write by its endpoint path', async () => {
    const fetchImpl = (async () =>
      fakeResponse({ status: 200, body: { id: 'order_1' } })) as HttpDeps['fetch'];
    const throttle = passthroughThrottle();
    const deps = baseDeps(fetchImpl, throttle);

    await request(creds, deps, { method: 'POST', path: '/orders', isWrite: true });

    expect(throttle.calls).toEqual(['/orders']);
  });
});

describe('request: an ordinary per-window 429 is retried, honouring Retry-After', () => {
  it('waits exactly the 3 seconds Retry-After asked for, not the fallback policy', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return fakeResponse({
          status: 429,
          body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' } },
          headers: { 'retry-after': '3' },
        });
      }
      return fakeResponse({ status: 200, body: { id: 'order_1' } });
    }) as HttpDeps['fetch'];

    const sleeps: number[] = [];
    const deps: HttpDeps = {
      ...baseDeps(fetchImpl, passthroughThrottle()),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };

    const result = await request(creds, deps, {
      method: 'POST',
      path: '/orders',
      isWrite: true,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([3_000]);
  });
});

describe('request: the quota ceiling is a distinct, non-retryable failure', () => {
  it('does not retry RATE_LIMIT_EXCEEDED, unlike an ordinary per-window 429', async () => {
    // docs/API-BEHAVIOUR.md: same HTTP 429 as a per-window throttle, but a
    // permanent per-account cap. Retrying it wastes four attempts and
    // several minutes on a failure that will never clear.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return fakeResponse({
        status: 429,
        body: {
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            description: 'test mode limit of 30 reached for payment_link',
          },
        },
      });
    }) as HttpDeps['fetch'];
    const deps = baseDeps(fetchImpl, passthroughThrottle());

    const result = await request(creds, deps, {
      method: 'POST',
      path: '/payment_links',
      isWrite: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('quota_exceeded');
    expect(calls).toBe(1);
  });

  it('still treats a same-status BAD_REQUEST_ERROR 429 as the retryable rate_limited kind', async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        status: 429,
        body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' } },
      })) as HttpDeps['fetch'];
    const deps = baseDeps(fetchImpl, passthroughThrottle());

    const result = await request(creds, deps, {
      method: 'POST',
      path: '/orders',
      isWrite: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate_limited');
  });
});

describe('request: a network error is never retried on a write, but is on a read', () => {
  it('calls fetch exactly once for a write that fails with a network error', async () => {
    // backoff.ts's isRetryable(kind, isWrite) says a write that fails with
    // a network error must not be retried: Razorpay does not deduplicate,
    // so a POST that timed out might already have created an order, and
    // retrying it risks a second one. This proves that reasoning actually
    // holds through the full request() loop, not just isRetryable in
    // isolation.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error('ECONNRESET');
    }) as HttpDeps['fetch'];
    const deps = baseDeps(fetchImpl, passthroughThrottle());

    const result = await request(creds, deps, {
      method: 'POST',
      path: '/orders',
      isWrite: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('network');
    expect(calls).toBe(1);
  });

  it('retries a read that fails with a network error, and succeeds once it clears', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNRESET');
      return fakeResponse({ status: 200, body: { count: 0, items: [] } });
    }) as HttpDeps['fetch'];
    const deps: HttpDeps = {
      ...baseDeps(fetchImpl, forbiddenThrottle()),
      sleep: async () => {},
    };

    const result = await request(creds, deps, {
      method: 'GET',
      path: '/payments',
      isWrite: false,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });
});
