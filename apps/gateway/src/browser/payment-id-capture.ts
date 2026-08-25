/**
 * Captures Razorpay payment ids from the popup's initial navigation.
 *
 * docs/CHECKOUT-FLOW.md sections 4 and 11: the popup's FIRST url is
 * /v1/payments/<id>/authenticate; reading popup.url() after it resolves is
 * too late, since by then (especially headless) it may have already
 * navigated on to the mocksharp bank page and the id is gone. A
 * context-level request listener catches the id-bearing request itself,
 * regardless of exactly when the popup handle becomes readable.
 *
 * Recording the list length before triggering an attempt and waiting for
 * it to GROW, rather than reading the last element immediately, matters:
 * the probe run that verified this found reading the list right after
 * submit could still miss the newest id by a few milliseconds.
 */
import { AUTHENTICATE_URL_PATTERN } from './selectors.js';
import type { ContextLike, PaymentIdCapture } from './types.js';

export const capturePaymentIds = (context: ContextLike): PaymentIdCapture => {
  const ids: string[] = [];
  let wake: (() => void) | null = null;

  context.on('request', (request) => {
    const match = AUTHENTICATE_URL_PATTERN.exec(request.url());
    if (match === null) return;
    ids.push(`pay_${match[1]}`);
    if (wake !== null) {
      const fire = wake;
      wake = null;
      fire();
    }
  });

  return {
    list: () => ids,
    waitForGrowth: (fromLength, timeoutMs) => {
      if (ids.length > fromLength) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          wake = null;
          reject(
            new Error(`timed out after ${timeoutMs}ms waiting for a payment id to be captured`),
          );
        }, timeoutMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
  };
};
