import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { describeWebhookEvent } from '../../src/webhooks/dispatch.js';
import { extractOrder, extractPayment, extractPaymentLink } from '../../src/webhooks/types.js';
import type { WebhookEnvelope } from '../../src/webhooks/types.js';

// docs/API-BEHAVIOUR.md section 8: "The redacted samples in data/samples
// are valid webhook fixtures", because the payload's payment entity is
// byte-identical to the REST payment object these were captured from.
const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, '..', '..', '..', '..', 'data', 'samples');

const loadSample = (name: string): unknown =>
  JSON.parse(readFileSync(join(samplesDir, name), 'utf8'));

const envelopeFor = (event: string, entityKey: string, entity: unknown): WebhookEnvelope => ({
  entity: 'event',
  account_id: 'acc_test',
  event,
  contains: [entityKey],
  payload: { [entityKey]: { entity } },
  created_at: 1_787_558_000,
});

describe('extractPayment', () => {
  it('reads the redacted sample payment straight through, no second type needed', () => {
    const captured = loadSample('payment_pay_TTUB0ZHEqSrFAc.json');
    const envelope = envelopeFor('payment.captured', 'payment', captured);

    const payment = extractPayment(envelope);

    expect(payment).not.toBeNull();
    expect(payment?.id).toBe('pay_TTUB0ZHEqSrFAc');
    expect(payment?.status).toBe('captured');
    expect(payment?.acquirer_data?.auth_code).toBe('112693');
  });

  it('returns null when the payload has no payment key', () => {
    const envelope = envelopeFor('order.paid', 'order', { id: 'order_1' });
    expect(extractPayment(envelope)).toBeNull();
  });
});

describe('describeWebhookEvent', () => {
  it('describes a captured payment from the redacted success fixture', () => {
    const captured = loadSample('payment_pay_TTUB0ZHEqSrFAc.json');
    const envelope = envelopeFor('payment.captured', 'payment', captured);

    expect(describeWebhookEvent(envelope)).toBe(
      'payment.captured: payment pay_TTUB0ZHEqSrFAc is now captured',
    );
  });

  it('describes a failed payment with its error_reason, from the redacted international-decline fixture', () => {
    const failed = loadSample('failed_intl_01.json');
    const envelope = envelopeFor('payment.failed', 'payment', failed);

    expect(describeWebhookEvent(envelope)).toBe(
      'payment.failed: payment pay_TTLe97SBwIwQra is now failed (international_transaction_not_allowed)',
    );
  });

  it('describes order.paid via extractOrder', () => {
    const order = { id: 'order_TTf6ZnUNK63FnK', entity: 'order', status: 'paid' };
    const envelope = envelopeFor('order.paid', 'order', order);

    expect(extractOrder(envelope)?.id).toBe('order_TTf6ZnUNK63FnK');
    expect(describeWebhookEvent(envelope)).toBe(
      'order.paid: order order_TTf6ZnUNK63FnK is now paid',
    );
  });

  it('describes payment_link.paid via extractPaymentLink', () => {
    const link = { id: 'plink_TTTcWTyo5HbDMZ', entity: 'payment_link', status: 'paid' };
    const envelope = envelopeFor('payment_link.paid', 'payment_link', link);

    expect(extractPaymentLink(envelope)?.id).toBe('plink_TTTcWTyo5HbDMZ');
    expect(describeWebhookEvent(envelope)).toBe(
      'payment_link.paid: payment link plink_TTTcWTyo5HbDMZ is now paid',
    );
  });

  it('records rather than discards a downtime event, without a verified payload shape', () => {
    // docs/API-BEHAVIOUR.md section 12: "not decoration... the strongest
    // available argument for delaying a retry". The exact payload key and
    // shape were not observed in the material this was built against, so
    // this only asserts it is recognised and described, not parsed.
    for (const event of [
      'payment.downtime.started',
      'payment.downtime.updated',
      'payment.downtime.resolved',
    ]) {
      const envelope: WebhookEnvelope = {
        entity: 'event',
        account_id: 'acc_test',
        event,
        contains: ['payment.downtime'],
        payload: {},
        created_at: 1_787_558_000,
      };
      expect(describeWebhookEvent(envelope)).toBe(`${event}: downtime signal recorded`);
    }
  });

  it('is order-independent: describing two events depends only on each one, never on the other', () => {
    // payment.captured was observed generated before order.paid but
    // delivered after it (docs/API-BEHAVIOUR.md section 10). Describing
    // them in either order must produce the same two facts.
    const captured = loadSample('payment_pay_TTUB0ZHEqSrFAc.json');
    const paymentEnvelope = envelopeFor('payment.captured', 'payment', captured);
    const orderEnvelope = envelopeFor('order.paid', 'order', {
      id: 'order_TTf6ZnUNK63FnK',
      entity: 'order',
      status: 'paid',
    });

    const forward = [describeWebhookEvent(orderEnvelope), describeWebhookEvent(paymentEnvelope)];
    const reverse = [describeWebhookEvent(paymentEnvelope), describeWebhookEvent(orderEnvelope)];

    expect(forward).toEqual([reverse[1], reverse[0]]);
  });

  it('describes an event outside the handled set without guessing at its shape', () => {
    const envelope: WebhookEnvelope = {
      entity: 'event',
      account_id: 'acc_test',
      event: 'refund.created',
      contains: ['refund'],
      payload: {},
      created_at: 1_787_558_000,
    };
    expect(describeWebhookEvent(envelope)).toBe('refund.created: unrecognised event reached the dispatcher');
  });
});
