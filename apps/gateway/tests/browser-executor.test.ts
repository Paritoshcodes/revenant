import { describe, expect, it } from 'vitest';

import { err, ok } from '@revenant/contracts';
import type { Failure, Result } from '@revenant/contracts';

import { createPlaywrightAttemptExecutor } from '../src/browser/executor.js';
import { SELECTORS } from '../src/browser/selectors.js';
import type { CheckoutSession, CheckoutSessionProvider, PageLike } from '../src/browser/types.js';

/** A page that reaches the given DOM outcome with no other surprises. */
const passthroughPage = (domOutcome: 'captured' | 'failed'): PageLike => {
  const popupPage: PageLike = {
    goto: () => Promise.reject(new Error('unused')),
    fill: () => Promise.reject(new Error('unused')),
    click: async () => {},
    locator: () => {
      throw new Error('unused');
    },
    waitForEvent: () => Promise.reject(new Error('unused')),
    waitForSelector: () => Promise.reject(new Error('unused')),
    waitForLoadState: async () => {},
    screenshot: async () => {},
  };

  return {
    goto: async () => {},
    fill: async () => {},
    click: async () => {},
    locator: () => ({
      // No save-card prompt in this fixture.
      waitFor: () => Promise.reject(new Error('no save-card prompt')),
      click: async () => {},
    }),
    waitForEvent: async () => popupPage,
    waitForSelector: async (selector) => {
      if (selector === SELECTORS.completed && domOutcome === 'captured') return undefined;
      if (selector === SELECTORS.retrySurface && domOutcome === 'failed') return undefined;
      throw new Error('timeout');
    },
    waitForLoadState: async () => {},
    screenshot: async () => {},
  };
};

const captureSession: CheckoutSession = {
  page: passthroughPage('captured'),
  cardNumber: '4111111111111111',
  outcome: 'success',
};

describe('createPlaywrightAttemptExecutor', () => {
  it('resolves a session, drives it, and reports a captured attempt with no taxonomy guessed', async () => {
    const sessions: CheckoutSessionProvider = {
      prepare: async () => ok(captureSession),
    };
    const executor = createPlaywrightAttemptExecutor({ sessions });

    const result = await executor.execute({
      transactionId: 'txn_abc',
      attemptNumber: 1,
      idempotencyKey: 'txn_abc:1',
      action: 'retry_with_backoff',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      outcome: 'captured',
      rzpPaymentId: null,
      rzpRequestId: null,
      rzpResponseId: null,
      errorCode: null,
      errorSource: null,
      errorStep: null,
      errorReason: null,
      authCode: null,
    });
  });

  it('reports a failed attempt when the retry surface appears', async () => {
    const sessions: CheckoutSessionProvider = {
      prepare: async () =>
        ok({
          page: passthroughPage('failed'),
          cardNumber: '4100280000020007',
          outcome: 'failure',
        }),
    };
    const executor = createPlaywrightAttemptExecutor({ sessions });

    const result = await executor.execute({
      transactionId: 'txn_abc',
      attemptNumber: 2,
      idempotencyKey: 'txn_abc:2',
      action: 'retry_with_backoff',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('failed');
  });

  it('propagates a failure to resolve a session without driving any page', async () => {
    const failure: Failure = { kind: 'not_found', message: 'no payment link on this transaction' };
    const sessions: CheckoutSessionProvider = {
      prepare: async (): Promise<Result<CheckoutSession>> => err(failure),
    };
    const executor = createPlaywrightAttemptExecutor({ sessions });

    const result = await executor.execute({
      transactionId: 'txn_missing_link',
      attemptNumber: 1,
      idempotencyKey: 'txn_missing_link:1',
      action: 'retry_with_backoff',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(failure);
  });

  it('propagates a typed failure from the checkout flow itself', async () => {
    const brokenPage: PageLike = {
      goto: async () => {},
      fill: async () => {
        throw new Error('field not found');
      },
      click: async () => {},
      locator: () => ({ waitFor: async () => {}, click: async () => {} }),
      waitForEvent: () => Promise.reject(new Error('unused')),
      waitForSelector: () => Promise.reject(new Error('unused')),
      waitForLoadState: async () => {},
      screenshot: async () => {},
    };
    const sessions: CheckoutSessionProvider = {
      prepare: async () =>
        ok({ page: brokenPage, cardNumber: '4111111111111111', outcome: 'success' }),
    };
    const executor = createPlaywrightAttemptExecutor({ sessions });

    const result = await executor.execute({
      transactionId: 'txn_abc',
      attemptNumber: 1,
      idempotencyKey: 'txn_abc:1',
      action: 'retry_with_backoff',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('upstream');
    expect(result.error.message).toContain('field not found');
  });
});
