import { describe, expect, it } from 'vitest';

import { err, ok } from '@revenant/contracts';
import type { Failure, Result } from '@revenant/contracts';

import { createPlaywrightAttemptExecutor } from '../src/browser/executor.js';
import type { CheckoutSession, CheckoutSessionProvider } from '../src/browser/types.js';
import { createCheckoutFixture } from './support/checkout-fixture.js';

const openedSession = (
  outcome: 'success' | 'failure',
  cardNumber = '4111111111111111',
): CheckoutSession => {
  const { page, world } = createCheckoutFixture();
  world.stage = 'contactFilled'; // as if openCheckout already ran
  return { page, cardNumber, outcome };
};

describe('createPlaywrightAttemptExecutor', () => {
  it('resolves a session, drives it through the real frame/popup flow, and reports captured', async () => {
    const sessions: CheckoutSessionProvider = {
      prepare: async () => ok(openedSession('success')),
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
      prepare: async () => ok(openedSession('failure', '4100280000020007')),
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
    // Session handed back at the wrong stage (never contact-filled): the
    // card method click rejects, exactly as a real premature click would.
    const { page } = createCheckoutFixture();
    const sessions: CheckoutSessionProvider = {
      prepare: async () => ok({ page, cardNumber: '4111111111111111', outcome: 'success' }),
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
    expect(result.error.message).toContain('contact has not been filled');
  });
});
