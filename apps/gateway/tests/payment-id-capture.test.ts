import { describe, expect, it } from 'vitest';

import { capturePaymentIds } from '../src/browser/payment-id-capture.js';
import type { ContextLike, RequestLike } from '../src/browser/types.js';

const fakeContext = (): { context: ContextLike; fire: (url: string) => void } => {
  const handlers: Array<(request: RequestLike) => void> = [];
  return {
    context: {
      on: (event, handler) => {
        if (event === 'request') handlers.push(handler);
      },
    },
    fire: (url) => {
      for (const handler of handlers) handler({ url: () => url });
    },
  };
};

describe('capturePaymentIds', () => {
  it('captures the id from a matching authenticate request, pay_-prefixed', () => {
    const { context, fire } = fakeContext();
    const capture = capturePaymentIds(context);

    fire('https://api.razorpay.com/v1/payments/TTeXtRlUAZDA0r/authenticate');

    expect(capture.list()).toEqual(['pay_TTeXtRlUAZDA0r']);
  });

  it('ignores requests that do not match the authenticate path', () => {
    const { context, fire } = fakeContext();
    const capture = capturePaymentIds(context);

    fire('https://api.razorpay.com/v1/gateway/mocksharp/payment?key_id=rzp_test_x');
    fire('https://api.sardine.ai/collect');
    fire('https://js.stripe.com/v3/controller-abc');

    expect(capture.list()).toEqual([]);
  });

  it('accumulates ids across multiple attempts, in order', () => {
    // docs/CHECKOUT-FLOW.md section 7: each attempt creates a separate
    // payment record, so a retry's popup fires its own request against
    // the same shared capture.
    const { context, fire } = fakeContext();
    const capture = capturePaymentIds(context);

    fire('https://api.razorpay.com/v1/payments/TTeXtRlUAZDA0r/authenticate');
    fire('https://api.razorpay.com/v1/payments/TTeZ2u1jK7dWCu/authenticate');

    expect(capture.list()).toEqual(['pay_TTeXtRlUAZDA0r', 'pay_TTeZ2u1jK7dWCu']);
  });

  describe('waitForGrowth', () => {
    it('resolves immediately if the list already grew past the baseline', async () => {
      const { context, fire } = fakeContext();
      const capture = capturePaymentIds(context);
      fire('https://api.razorpay.com/v1/payments/TTeXtRlUAZDA0r/authenticate');

      await expect(capture.waitForGrowth(0, 1_000)).resolves.toBeUndefined();
    });

    it('waits for a request that has not arrived yet, rather than resolving early', async () => {
      // The exact bug this exists to prevent: reading list()[length-1]
      // right after submitting can still miss the newest id by a few
      // milliseconds (docs/CHECKOUT-FLOW.md section 11).
      const { context, fire } = fakeContext();
      const capture = capturePaymentIds(context);

      const before = capture.list().length;
      const growth = capture.waitForGrowth(before, 1_000);

      let resolved = false;
      void growth.then(() => {
        resolved = true;
      });
      // Nothing has fired yet: the wait must still be pending.
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);

      fire('https://api.razorpay.com/v1/payments/TTeZ2u1jK7dWCu/authenticate');
      await growth;

      expect(resolved).toBe(true);
      expect(capture.list()[capture.list().length - 1]).toBe('pay_TTeZ2u1jK7dWCu');
    });

    it('rejects once the timeout elapses with nothing captured', async () => {
      const { context } = fakeContext();
      const capture = capturePaymentIds(context);

      await expect(capture.waitForGrowth(0, 10)).rejects.toThrow(/timed out/);
    });

    it('measures growth against the given baseline, not against zero', async () => {
      const { context, fire } = fakeContext();
      const capture = capturePaymentIds(context);
      fire('https://api.razorpay.com/v1/payments/TTeXtRlUAZDA0r/authenticate');

      // The list already has one id; waiting from baseline 1 must not
      // resolve until a SECOND id arrives.
      await expect(capture.waitForGrowth(1, 10)).rejects.toThrow(/timed out/);
    });
  });
});
