/**
 * A fake RazorpayClient for reconcile.ts's tests. Every method not
 * overridden throws, so a test that exercises a call path it did not
 * expect fails loudly instead of silently returning a default.
 */
import type { Result } from '@revenant/contracts';

import type { RazorpayClient } from '../../src/razorpay/client.js';

const notUsed =
  (name: string) =>
  (): Promise<Result<never>> => {
    throw new Error(`fake-razorpay-client: ${name} should not be called in this test`);
  };

export const createFakeRazorpayClient = (
  overrides: Partial<RazorpayClient> = {},
): RazorpayClient => ({
  createOrder: notUsed('createOrder'),
  fetchOrder: notUsed('fetchOrder'),
  fetchOrderPayments: notUsed('fetchOrderPayments'),
  createPaymentLink: notUsed('createPaymentLink'),
  fetchPaymentLink: notUsed('fetchPaymentLink'),
  fetchPayment: notUsed('fetchPayment'),
  listPayments: notUsed('listPayments'),
  ...overrides,
});
