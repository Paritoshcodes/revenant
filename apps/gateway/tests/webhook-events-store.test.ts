import { describe, expect, it } from 'vitest';

import { recordWebhookEvent } from '../src/webhooks/events-store.js';
import type { Queryable } from '../src/webhooks/events-store.js';

interface Call {
  sql: string;
  params: readonly unknown[];
}

/** Records every query and replies from a queue of canned responses. */
const fakeDb = (
  responses: Array<{ rows: unknown[] } | Error>,
): Queryable & { calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const next = responses.shift();
      if (next === undefined) throw new Error(`unexpected query: ${sql}`);
      if (next instanceof Error) throw next;
      return { rows: next.rows, rowCount: next.rows.length };
    },
  };
};

describe('recordWebhookEvent', () => {
  it('records a new event and returns "recorded"', async () => {
    const db = fakeDb([{ rows: [{ id: 1 }] }]);

    const result = await recordWebhookEvent(db, {
      eventId: 'evt_1',
      eventType: 'payment.captured',
      payload: { event: 'payment.captured' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('recorded');
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.sql).toMatch(/INSERT INTO webhook_events/);
    expect(db.calls[0]!.sql).toMatch(/ON CONFLICT \(event_id\) DO NOTHING/);
    expect(db.calls[0]!.params[0]).toBe('evt_1');
    expect(db.calls[0]!.params[1]).toBe('payment.captured');
  });

  it('reports a duplicate when the insert matches nothing', async () => {
    // Duplicate delivery is expected by design, not exceptional
    // (docs/API-BEHAVIOUR.md section 8): Razorpay retries on a slow ack.
    const db = fakeDb([{ rows: [] }]);

    const result = await recordWebhookEvent(db, {
      eventId: 'evt_1',
      eventType: 'payment.captured',
      payload: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('duplicate');
  });

  it('serialises the full payload as JSON, verbatim', async () => {
    const db = fakeDb([{ rows: [{ id: 1 }] }]);
    const payload = { event: 'payment.downtime.started', payload: { foo: 'bar' } };

    await recordWebhookEvent(db, {
      eventId: 'evt_2',
      eventType: 'payment.downtime.started',
      payload,
    });

    expect(db.calls[0]!.params[2]).toBe(JSON.stringify(payload));
  });

  it('returns a typed failure instead of throwing on an unexpected db error', async () => {
    const db = fakeDb([new Error('connection terminated')]);

    const result = await recordWebhookEvent(db, {
      eventId: 'evt_1',
      eventType: 'payment.captured',
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
    expect(result.error.message).toMatch(/connection terminated/);
  });
});
