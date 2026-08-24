/**
 * Razorpay client. Orders, payment links, payment fetch.
 *
 * Every method returns a Result. Writes are throttled and retried only where
 * retrying is provably safe. The client does not know about idempotency
 * keys: the store in src/recovery reserves the key before any of these
 * methods is called. See CLAUDE.md hard rule 4.
 */
import type { Result } from '@revenant/contracts';

import { defaultHttpDeps, request } from './http.js';
import type { HttpDeps, RazorpayCredentials } from './http.js';
import type {
  CreateOrderInput,
  CreatePaymentLinkInput,
  RzpList,
  RzpOrder,
  RzpPayment,
  RzpPaymentLink,
} from './types.js';

export interface RazorpayClient {
  /**
   * Razorpay does NOT deduplicate on `receipt`: two identical creates made
   * two distinct orders. Reserve the idempotency key first.
   */
  createOrder(input: CreateOrderInput): Promise<Result<RzpOrder>>;
  fetchOrder(orderId: string): Promise<Result<RzpOrder>>;

  /**
   * Razorpay DOES reject a duplicate `reference_id`, the opposite of orders
   * on the same account. Our own store stays the enforcement point either
   * way, so the two endpoints behave the same from the caller's side.
   */
  createPaymentLink(input: CreatePaymentLinkInput): Promise<Result<RzpPaymentLink>>;
  fetchPaymentLink(linkId: string): Promise<Result<RzpPaymentLink>>;

  fetchPayment(paymentId: string): Promise<Result<RzpPayment>>;
  /** Newest first. `count` is capped at 100 by the API. */
  listPayments(params?: {
    count?: number;
    skip?: number;
  }): Promise<Result<RzpList<RzpPayment>>>;
}

export const createRazorpayClient = (
  creds: RazorpayCredentials,
  deps: HttpDeps = defaultHttpDeps(),
): RazorpayClient => ({
  createOrder: (input) =>
    request<RzpOrder>(creds, deps, {
      method: 'POST',
      path: '/orders',
      isWrite: true,
      body: {
        amount: input.amount_paise,
        currency: input.currency ?? 'INR',
        ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      },
    }),

  fetchOrder: (orderId) =>
    request<RzpOrder>(creds, deps, {
      method: 'GET',
      path: `/orders/${encodeURIComponent(orderId)}`,
      isWrite: false,
    }),

  createPaymentLink: (input) =>
    request<RzpPaymentLink>(creds, deps, {
      method: 'POST',
      path: '/payment_links',
      isWrite: true,
      body: {
        amount: input.amount_paise,
        currency: input.currency ?? 'INR',
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.reference_id === undefined
          ? {}
          : { reference_id: input.reference_id }),
        ...(input.customer === undefined ? {} : { customer: input.customer }),
        ...(input.notify === undefined ? {} : { notify: input.notify }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.expire_by === undefined ? {} : { expire_by: input.expire_by }),
      },
    }),

  fetchPaymentLink: (linkId) =>
    request<RzpPaymentLink>(creds, deps, {
      method: 'GET',
      path: `/payment_links/${encodeURIComponent(linkId)}`,
      isWrite: false,
    }),

  fetchPayment: (paymentId) =>
    request<RzpPayment>(creds, deps, {
      method: 'GET',
      path: `/payments/${encodeURIComponent(paymentId)}`,
      isWrite: false,
    }),

  listPayments: (params) =>
    request<RzpList<RzpPayment>>(creds, deps, {
      method: 'GET',
      path: '/payments',
      isWrite: false,
      query: { count: params?.count ?? 10, skip: params?.skip ?? 0 },
    }),
});
