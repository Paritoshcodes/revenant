/**
 * Adapts the checkout-flow driver to the AttemptExecutor port
 * (src/recovery/types.ts). AttemptExecutor.execute()'s input carries no
 * payment link URL, card number, or target bank outcome, so a
 * CheckoutSessionProvider resolves those, plus the PaymentIdCapture shared
 * across the transaction's attempts (types.ts); this module's only job is
 * to drive the resolved session through attempt() and shape the result.
 *
 * The DOM only tells us captured vs failed, plus the payment id captured
 * from the popup's initial navigation. The richer taxonomy fields
 * (error_source, error_step, auth_code, ...) come from the Razorpay
 * payment record itself, not the page, so they are left null here rather
 * than guessed at from what the browser can see.
 */
import { ok } from '@revenant/contracts';

import type { AttemptExecutionResult, AttemptExecutor } from '../recovery/types.js';

import { attempt } from './checkout-flow.js';
import type { AttemptFlowOptions, CheckoutSessionProvider } from './types.js';

export interface PlaywrightAttemptExecutorDeps {
  readonly sessions: CheckoutSessionProvider;
  readonly options?: AttemptFlowOptions;
}

export const createPlaywrightAttemptExecutor = (
  deps: PlaywrightAttemptExecutorDeps,
): AttemptExecutor => ({
  execute: async (input) => {
    const session = await deps.sessions.prepare(input);
    if (!session.ok) return session;

    const driven = await attempt(
      session.value.page,
      session.value.cardNumber,
      session.value.outcome,
      session.value.capture,
      deps.options,
    );
    if (!driven.ok) return driven;

    const result: AttemptExecutionResult = {
      outcome: driven.value.outcome,
      rzpPaymentId: driven.value.paymentId,
      rzpRequestId: null,
      rzpResponseId: null,
      errorCode: null,
      errorSource: null,
      errorStep: null,
      errorReason: null,
      authCode: null,
    };
    return ok(result);
  },
});
