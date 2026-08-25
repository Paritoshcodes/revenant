/**
 * Razorpay webhook envelope and event vocabulary, observed live
 * (docs/API-BEHAVIOUR.md, sections 8 and 12).
 *
 * The payload's payment entity is byte-identical in shape to the REST
 * payment object, same 31 keys, so RzpPayment from ../razorpay/types.js
 * is reused directly here rather than defining a second type for it. Only
 * `payment`'s congruence with the REST shape was directly observed; the
 * order and payment_link entities are read with the same REST types on
 * the reasonable assumption that Razorpay wraps them the same way, not
 * because that specific pairing was itself verified.
 */
import type { RzpOrder, RzpPayment, RzpPaymentLink } from '../razorpay/types.js';

/**
 * The event types this handler processes. Razorpay sends many more
 * (invoice.*, settlement.*, fund_account.*, refund.*, engage.*); those
 * are deliberately ignored (docs/API-BEHAVIOUR.md section 12) and never
 * reach the dispatcher.
 */
export type WebhookEventType =
  | 'payment.authorized'
  | 'payment.failed'
  | 'payment.captured'
  | 'order.paid'
  | 'payment_link.paid'
  | 'payment.downtime.started'
  | 'payment.downtime.updated'
  | 'payment.downtime.resolved';

export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set<WebhookEventType>([
  'payment.authorized',
  'payment.failed',
  'payment.captured',
  'order.paid',
  'payment_link.paid',
  'payment.downtime.started',
  'payment.downtime.updated',
  'payment.downtime.resolved',
]);

/**
 * Keyed by entity type (e.g. "payment", "order"), each wrapping
 * `{ entity: <object> }`. `contains` lists which of these keys are
 * present, so dispatch can be driven by it without guessing
 * (docs/API-BEHAVIOUR.md section 8). Untyped here (rather than a precise
 * per-key shape) because payment.downtime.*'s payload key and shape were
 * not observed in the material this was built against; it is read
 * generically and stored verbatim rather than guessed at.
 */
export type WebhookPayload = Record<string, { readonly entity: unknown } | undefined>;

export interface WebhookEnvelope {
  readonly entity: 'event';
  readonly account_id: string;
  readonly event: string;
  readonly contains: readonly string[];
  readonly payload: WebhookPayload;
  readonly created_at: number;
}

const entityOf = <T>(envelope: WebhookEnvelope, key: string): T | null => {
  const wrapped = envelope.payload[key];
  return wrapped === undefined ? null : (wrapped.entity as T);
};

/** The one entity shape directly verified against the REST payment object. */
export const extractPayment = (envelope: WebhookEnvelope): RzpPayment | null =>
  entityOf<RzpPayment>(envelope, 'payment');

export const extractOrder = (envelope: WebhookEnvelope): RzpOrder | null =>
  entityOf<RzpOrder>(envelope, 'order');

export const extractPaymentLink = (envelope: WebhookEnvelope): RzpPaymentLink | null =>
  entityOf<RzpPaymentLink>(envelope, 'payment_link');
