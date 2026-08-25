import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { handleWebhookRequest } from '../src/webhooks/handler.js';
import type { WebhookHandlerDeps } from '../src/webhooks/handler.js';

const SECRET = 'test_webhook_secret';

const sign = (body: Buffer): string => createHmac('sha256', SECRET).update(body).digest('hex');

interface Call {
  sql: string;
  params: readonly unknown[];
}

const fakeDb = (): { db: WebhookHandlerDeps['db']; calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    db: {
      async query(sql, params = []) {
        calls.push({ sql, params });
        // Every insert "succeeds" (returns one row): a fresh event id per test.
        return { rows: [{ id: calls.length }], rowCount: 1 };
      },
    },
  };
};

const envelope = (event: string, extra: Record<string, unknown> = {}): Buffer =>
  Buffer.from(
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_test',
      event,
      contains: ['payment'],
      payload: { payment: { entity: { id: 'pay_test', status: 'captured', error_reason: null } } },
      created_at: 1_787_558_000,
      ...extra,
    }),
    'utf8',
  );

const silentDeps = (db: WebhookHandlerDeps['db']): WebhookHandlerDeps => ({
  db,
  secret: SECRET,
  log: () => {}, // tests assert on db.calls / logs, not console output
});

describe('handleWebhookRequest: signature verification gates everything', () => {
  it('rejects a request with no signature before touching the database', async () => {
    const { db, calls } = fakeDb();
    const rawBody = envelope('payment.captured');

    const { response, settled } = handleWebhookRequest(silentDeps(db), {
      rawBody,
      signatureHeader: undefined,
      eventIdHeader: 'evt_1',
    });
    await settled;

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects a request with a mismatched signature before touching the database', async () => {
    const { db, calls } = fakeDb();
    const rawBody = envelope('payment.captured');

    const { response, settled } = handleWebhookRequest(silentDeps(db), {
      rawBody,
      signatureHeader: sign(Buffer.from('a different body', 'utf8')),
      eventIdHeader: 'evt_1',
    });
    await settled;

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('acknowledges with 200 immediately once the signature verifies, before the db write resolves', async () => {
    const { db } = fakeDb();
    const rawBody = envelope('payment.captured');

    const { response } = handleWebhookRequest(silentDeps(db), {
      rawBody,
      signatureHeader: sign(rawBody),
      eventIdHeader: 'evt_1',
    });

    // No `await settled` here: the response must already be decided.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});

describe('handleWebhookRequest: recording and deduplication', () => {
  it('records a handled event exactly once, keyed on the event id', async () => {
    const { db, calls } = fakeDb();
    const rawBody = envelope('payment.captured');

    const { settled } = handleWebhookRequest(silentDeps(db), {
      rawBody,
      signatureHeader: sign(rawBody),
      eventIdHeader: 'evt_TTjjr4s10FcIqM',
    });
    await settled;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[0]).toBe('evt_TTjjr4s10FcIqM');
    expect(calls[0]!.params[1]).toBe('payment.captured');
  });

  it('drops an event with no x-razorpay-event-id, since it cannot be deduplicated', async () => {
    const { db, calls } = fakeDb();
    const rawBody = envelope('payment.captured');

    const { response, settled } = handleWebhookRequest(silentDeps(db), {
      rawBody,
      signatureHeader: sign(rawBody),
      eventIdHeader: undefined,
    });
    await settled;

    // Still acknowledged: a missing event id is not a signature failure.
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('ignores an event type outside the handled set, without recording it', async () => {
    // Ignore the invoice, settlement, fund_account, refund and engage
    // families deliberately (docs/API-BEHAVIOUR.md section 12).
    const { db, calls } = fakeDb();
    const rawBody = envelope('refund.created');

    const { response, settled } = handleWebhookRequest(silentDeps(db), {
      rawBody,
      signatureHeader: sign(rawBody),
      eventIdHeader: 'evt_ignored',
    });
    await settled;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('never throws when the body is not valid JSON despite a valid signature', async () => {
    const { db } = fakeDb();
    const rawBody = Buffer.from('not json', 'utf8');

    const { response, settled } = handleWebhookRequest(silentDeps(db), {
      rawBody,
      signatureHeader: sign(rawBody),
      eventIdHeader: 'evt_bad_json',
    });

    await expect(settled).resolves.toBeUndefined();
    expect(response.status).toBe(200);
  });
});

describe('handleWebhookRequest: each of the eight handled event types is recorded', () => {
  const eventTypes = [
    'payment.authorized',
    'payment.failed',
    'payment.captured',
    'order.paid',
    'payment_link.paid',
    'payment.downtime.started',
    'payment.downtime.updated',
    'payment.downtime.resolved',
  ];

  for (const eventType of eventTypes) {
    it(`records ${eventType}`, async () => {
      const { db, calls } = fakeDb();
      const rawBody = envelope(eventType);

      const { settled } = handleWebhookRequest(silentDeps(db), {
        rawBody,
        signatureHeader: sign(rawBody),
        eventIdHeader: `evt_${eventType}`,
      });
      await settled;

      expect(calls).toHaveLength(1);
      expect(calls[0]!.params[1]).toBe(eventType);
    });
  }
});

describe('handleWebhookRequest: order independence', () => {
  it('processes two events correctly regardless of which one arrives first', async () => {
    // order.paid was observed arriving before payment.captured even
    // though captured was generated first (docs/API-BEHAVIOUR.md section
    // 10). Each call only ever depends on its own event.
    const { db, calls } = fakeDb();
    const paymentBody = envelope('payment.captured');
    const orderBody = envelope('order.paid');

    const first = handleWebhookRequest(silentDeps(db), {
      rawBody: orderBody,
      signatureHeader: sign(orderBody),
      eventIdHeader: 'evt_order',
    });
    const second = handleWebhookRequest(silentDeps(db), {
      rawBody: paymentBody,
      signatureHeader: sign(paymentBody),
      eventIdHeader: 'evt_payment',
    });
    await Promise.all([first.settled, second.settled]);

    const recordedTypes = calls.map((call) => call.params[1]).sort();
    expect(recordedTypes).toEqual(['order.paid', 'payment.captured']);
  });
});
