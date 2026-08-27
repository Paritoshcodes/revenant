import { describe, expect, it, vi } from 'vitest';

import { err, ok } from '@revenant/contracts';

import { isTransientNetworkFailure, withNetworkRetry } from '../../src/browser/retry.js';

describe('isTransientNetworkFailure', () => {
  it('matches known Chromium transient network error codes in the message', () => {
    expect(isTransientNetworkFailure({ kind: 'network', message: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://rzp.io' })).toBe(true);
    expect(isTransientNetworkFailure({ kind: 'network', message: 'net::ERR_QUIC_PROTOCOL_ERROR' })).toBe(true);
    expect(isTransientNetworkFailure({ kind: 'network', message: 'net::ERR_NETWORK_CHANGED' })).toBe(true);
  });

  it('matches the same patterns inside a wrapped cause, not just the top-level message', () => {
    const failure = {
      kind: 'network' as const,
      message: 'openCheckout https://rzp.io: connection lost',
      cause: new Error('getaddrinfo ENOTFOUND api.razorpay.com'),
    };
    expect(isTransientNetworkFailure(failure)).toBe(true);
  });

  it('does not match an application-level failure', () => {
    expect(
      isTransientNetworkFailure({
        kind: 'upstream',
        message: 'locator.click: Timeout 30000ms exceeded waiting for [data-testid="bottom-cta-button"]',
      }),
    ).toBe(false);
  });
});

describe('withNetworkRetry', () => {
  it('returns success immediately without retrying', async () => {
    const operation = vi.fn().mockResolvedValue(ok('value'));

    const result = await withNetworkRetry(operation, { sleep: async () => undefined });

    expect(result).toEqual(ok('value'));
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a transient network failure and returns the eventual success', async () => {
    const operation = vi
      .fn()
      .mockResolvedValueOnce(err({ kind: 'network', message: 'net::ERR_NETWORK_CHANGED' }))
      .mockResolvedValueOnce(ok('recovered'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withNetworkRetry(operation, { sleep, attempts: 3 });

    expect(result).toEqual(ok('recovered'));
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-network failure', async () => {
    const failure = { kind: 'upstream' as const, message: 'locator.click: Timeout 30000ms exceeded' };
    const operation = vi.fn().mockResolvedValue(err(failure));

    const result = await withNetworkRetry(operation, { sleep: async () => undefined });

    expect(result).toEqual(err(failure));
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured number of attempts and returns the last failure', async () => {
    const failure = { kind: 'network' as const, message: 'net::ERR_NAME_NOT_RESOLVED' };
    const operation = vi.fn().mockResolvedValue(err(failure));

    const result = await withNetworkRetry(operation, { sleep: async () => undefined, attempts: 3 });

    expect(result).toEqual(err(failure));
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('backs off linearly, attempt N waiting backoffMs * N', async () => {
    const operation = vi
      .fn()
      .mockResolvedValueOnce(err({ kind: 'network', message: 'net::ERR_NETWORK_CHANGED' }))
      .mockResolvedValueOnce(err({ kind: 'network', message: 'net::ERR_NETWORK_CHANGED' }))
      .mockResolvedValueOnce(ok('done'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await withNetworkRetry(operation, { sleep, attempts: 3, backoffMs: 1000 });

    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });
});
