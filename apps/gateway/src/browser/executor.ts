/**
 * Adapts the checkout-flow driver to the AttemptExecutor port
 * (src/recovery/types.ts). AttemptExecutor.execute()'s input carries no
 * payment link URL, card number, or target bank outcome, so a
 * CheckoutSessionProvider resolves those (types.ts); this module's only
 * job is to drive the resolved session through attempt() and shape the
 * result.
 *
 * The DOM only tells us captured vs failed. The richer taxonomy fields
 * (rzp_payment_id, error_source, error_step, auth_code, ...) come from the
 * Razorpay payment record itself, not the page, so they are left null
 * here rather than guessed at from what the browser can see.
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
      deps.options,
    );
    if (!driven.ok) return driven;

    const result: AttemptExecutionResult = {
      outcome: driven.value.outcome,
      rzpPaymentId: null,
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
