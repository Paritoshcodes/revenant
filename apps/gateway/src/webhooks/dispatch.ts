/**
 * Turns a verified webhook envelope into a human-readable fact.
 *
 * Order independent by construction: this reads only the ONE envelope it
 * is given and asserts nothing about what arrived before or after it.
 * `payment.captured` was observed generated before `order.paid` but
 * delivered after it (docs/API-BEHAVIOUR.md section 10), so nothing here
 * may assume delivery order, or build a sequence out of these calls.
 *
 * Full reconciliation into `attempts`/`transactions` (matching a payment
 * id back to a local row) is separate, later work; this module's job is
 * limited to describing what each event says about its own entity.
 */
import { extractOrder, extractPayment, extractPaymentLink } from './types.js';
import type { WebhookEnvelope } from './types.js';

const PAYMENT_EVENTS = new Set(['payment.authorized', 'payment.failed', 'payment.captured']);

export const describeWebhookEvent = (envelope: WebhookEnvelope): string => {
  const { event } = envelope;

  if (PAYMENT_EVENTS.has(event)) {
    const payment = extractPayment(envelope);
    if (payment === null) return `${event}: no payment entity in payload`;
    const reason = payment.error_reason !== null ? ` (${payment.error_reason})` : '';
    return `${event}: payment ${payment.id} is now ${payment.status}${reason}`;
  }

  if (event === 'order.paid') {
    const order = extractOrder(envelope);
    return order === null
      ? `${event}: no order entity in payload`
      : `${event}: order ${order.id} is now ${order.status}`;
  }

  if (event === 'payment_link.paid') {
    const link = extractPaymentLink(envelope);
    return link === null
      ? `${event}: no payment_link entity in payload`
      : `${event}: payment link ${link.id} is now ${link.status}`;
  }

  if (event.startsWith('payment.downtime.')) {
    // A bank or method is currently degraded: a policy input for
    // delaying retries, not noise (docs/API-BEHAVIOUR.md section 12).
    // The payload shape was not verified here, so it is only recorded
    // (events-store.ts), never parsed into a typed entity.
    return `${event}: downtime signal recorded`;
  }

  return `${event}: unrecognised event reached the dispatcher`;
};
