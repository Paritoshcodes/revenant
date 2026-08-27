import { describe, expect, it } from 'vitest';

import {
  idempotencyKey,
  parseIdempotencyKey,
} from '../../src/recovery/idempotency-key.js';
import { createIdempotencyStore } from '../../src/recovery/idempotency-store.js';
import type { Queryable } from '../../src/recovery/idempotency-store.js';

/** A Postgres error carries `code`; pg surfaces SQLSTATE that way. */
const pgError = (code: string, message = 'pg error'): Error & { code: string } =>
  Object.assign(new Error(message), { code });

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

const attemptRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  transaction_id: 'txn_abc',
  attempt_number: 2,
  idempotency_key: 'txn_abc:2',
  outcome: 'pending',
  rzp_payment_id: null,
  created_at: '2026-08-24T10:00:00.000Z',
  ...over,
});

describe('idempotencyKey', () => {
  it('is transaction_id + colon + attempt_number', () => {
    expect(idempotencyKey('txn_abc', 1)).toBe('txn_abc:1');
    expect(idempotencyKey('txn_abc', 3)).toBe('txn_abc:3');
  });

  it('rejects a transaction id containing the separator', () => {
    // Otherwise ('a:1', 2) and ('a', '1:2') could collide on one key.
    expect(() => idempotencyKey('txn:abc', 1)).toThrow(RangeError);
  });

  it('rejects an empty transaction id', () => {
    expect(() => idempotencyKey('', 1)).toThrow(RangeError);
  });

  it('rejects attempt numbers below 1 or non-integer', () => {
    expect(() => idempotencyKey('txn_abc', 0)).toThrow(RangeError);
    expect(() => idempotencyKey('txn_abc', -2)).toThrow(RangeError);
    expect(() => idempotencyKey('txn_abc', 1.5)).toThrow(RangeError);
  });

  it('round-trips through parseIdempotencyKey', () => {
    expect(parseIdempotencyKey(idempotencyKey('txn_abc', 3))).toEqual({
      transactionId: 'txn_abc',
      attemptNumber: 3,
    });
  });

  it('returns null for a malformed key', () => {
    expect(parseIdempotencyKey('txn_abc')).toBeNull();
    expect(parseIdempotencyKey('txn_abc:')).toBeNull();
    expect(parseIdempotencyKey(':1')).toBeNull();
    expect(parseIdempotencyKey('txn_abc:zero')).toBeNull();
    expect(parseIdempotencyKey('txn_abc:0')).toBeNull();
  });
});

describe('createIdempotencyStore.reserve', () => {
  it('claims the key and returns the new attempt id', async () => {
    const db = fakeDb([{ rows: [{ id: 41 }] }]);
    const store = createIdempotencyStore(db);

    const result = await store.reserve('txn_abc', 1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      status: 'reserved',
      key: 'txn_abc:1',
      attemptId: 41,
    });
  });

  it('writes the key and a pending outcome in a single insert', async () => {
    const db = fakeDb([{ rows: [{ id: 41 }] }]);
    await createIdempotencyStore(db).reserve('txn_abc', 1);

    expect(db.calls).toHaveLength(1);
    const [insert] = db.calls;
    expect(insert!.sql).toMatch(/INSERT INTO attempts/);
    expect(insert!.sql).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
    expect(insert!.sql).toMatch(/'pending'/);
    expect(insert!.params).toEqual(['txn_abc', 1, 'txn_abc:1']);
  });

  it('reports a duplicate when the key is already held', async () => {
    // The insert matches nothing, so the store reads back the winning row.
    const db = fakeDb([{ rows: [] }, { rows: [attemptRow({ outcome: 'failed' })] }]);
    const store = createIdempotencyStore(db);

    const result = await store.reserve('txn_abc', 2);

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'duplicate') {
      throw new Error('expected a duplicate reservation');
    }
    expect(result.value.key).toBe('txn_abc:2');
    expect(result.value.existing?.outcome).toBe('failed');
    expect(result.value.existing?.attemptId).toBe(7);
  });

  it('reports a duplicate when the composite unique constraint fires instead', async () => {
    const db = fakeDb([pgError('23505'), { rows: [attemptRow()] }]);
    const store = createIdempotencyStore(db);

    const result = await store.reserve('txn_abc', 2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('duplicate');
  });

  it('maps an unknown transaction to a not_found failure', async () => {
    const db = fakeDb([pgError('23503', 'violates foreign key constraint')]);
    const store = createIdempotencyStore(db);

    const result = await store.reserve('txn_missing', 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_found');
  });

  it('rejects an invalid key without touching the database', async () => {
    const db = fakeDb([]);
    const store = createIdempotencyStore(db);

    const result = await store.reserve('txn:abc', 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
    expect(db.calls).toHaveLength(0);
  });

  it('returns a typed failure instead of throwing on an unexpected pg error', async () => {
    const db = fakeDb([pgError('08006', 'connection terminated')]);
    const store = createIdempotencyStore(db);

    const result = await store.reserve('txn_abc', 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
    expect(result.error.message).toMatch(/connection terminated/);
  });
});

describe('createIdempotencyStore.settle', () => {
  it('records the settled outcome and returns the updated row', async () => {
    const db = fakeDb([
      {
        rows: [
          attemptRow({ outcome: 'captured', rzp_payment_id: 'pay_TTUB0ZHEqSrFAc' }),
        ],
      },
    ]);
    const store = createIdempotencyStore(db);

    const result = await store.settle('txn_abc:2', {
      outcome: 'captured',
      rzpPaymentId: 'pay_TTUB0ZHEqSrFAc',
      authCode: '112693',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('settled');
    expect(result.value.attempt.outcome).toBe('captured');
    expect(result.value.attempt.rzpPaymentId).toBe('pay_TTUB0ZHEqSrFAc');
    expect(db.calls[0]!.params[0]).toBe('txn_abc:2');
    expect(db.calls[0]!.params[1]).toBe('captured');
  });

  it('stores the raw error_code alongside the taxonomy triple', async () => {
    // Both real failures returned BAD_REQUEST_ERROR where the docs imply
    // GATEWAY_ERROR, so the raw value is evidence and is written verbatim.
    const db = fakeDb([{ rows: [attemptRow({ outcome: 'failed' })] }]);
    const store = createIdempotencyStore(db);

    await store.settle('txn_abc:2', {
      outcome: 'failed',
      errorCode: 'BAD_REQUEST_ERROR',
      errorSource: 'gateway',
      errorStep: 'payment_authorization',
      errorReason: 'payment_failed',
      authCode: null,
    });

    const params = db.calls[0]!.params;
    expect(params[3]).toBe('BAD_REQUEST_ERROR');
    expect(params[4]).toBe('gateway');
    expect(params[5]).toBe('payment_authorization');
    expect(params[6]).toBe('payment_failed');
  });

  it('fails when no reservation holds the key', async () => {
    // Two canned responses: the UPDATE matches nothing (0 rows), so settle()
    // falls back to lookup() to distinguish "never reserved" from "already
    // settled by a racer" — that lookup also finds nothing here.
    const db = fakeDb([{ rows: [] }, { rows: [] }]);
    const store = createIdempotencyStore(db);

    const result = await store.settle('txn_abc:9', { outcome: 'failed' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_found');
  });

  it('returns already_settled, not an error, when the key was already settled by a racing caller', async () => {
    // The UPDATE matches nothing because outcome is no longer 'pending'
    // (docs/DECISIONS.md, Build log entry 10: the driver's own flow and a
    // reconciliation run can both reach a settle for the same attempt).
    // The fallback lookup() finds the row exactly as the winning racer left
    // it.
    const db = fakeDb([
      { rows: [] },
      { rows: [attemptRow({ outcome: 'captured', rzp_payment_id: 'pay_winner' })] },
    ]);
    const store = createIdempotencyStore(db);

    const result = await store.settle('txn_abc:2', {
      outcome: 'captured',
      rzpPaymentId: 'pay_different_value_this_caller_saw',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('already_settled');
    // The row as it actually stands (the winner's data), not this caller's
    // own input — settle() never overwrote it.
    expect(result.value.attempt.outcome).toBe('captured');
    expect(result.value.attempt.rzpPaymentId).toBe('pay_winner');
  });
});

describe('createIdempotencyStore.lookup', () => {
  it('returns null when the key was never reserved', async () => {
    const db = fakeDb([{ rows: [] }]);
    const result = await createIdempotencyStore(db).lookup('txn_abc:1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('normalises a Date created_at to an ISO string', async () => {
    const db = fakeDb([
      { rows: [attemptRow({ created_at: new Date('2026-08-24T10:00:00Z') })] },
    ]);
    const result = await createIdempotencyStore(db).lookup('txn_abc:2');

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.createdAt).toBe('2026-08-24T10:00:00.000Z');
  });

  it('coerces a bigserial id delivered as a string', async () => {
    const db = fakeDb([{ rows: [attemptRow({ id: '9007199254740991' })] }]);
    const result = await createIdempotencyStore(db).lookup('txn_abc:2');

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.attemptId).toBe(9007199254740991);
  });
});

describe('the check happens before the outbound write', () => {
  it('a duplicate reservation yields no Razorpay call', async () => {
    // Stands in for the client. If the guard is wrong, this counter moves.
    let razorpayCalls = 0;
    const callRazorpay = async (): Promise<void> => {
      razorpayCalls += 1;
    };

    const db = fakeDb([
      { rows: [{ id: 1 }] }, // first reserve wins
      { rows: [] }, // second reserve conflicts
      { rows: [attemptRow({ id: 1, outcome: 'pending' })] }, // read back winner
    ]);
    const store = createIdempotencyStore(db);

    for (const _ of [1, 2]) {
      const reservation = await store.reserve('txn_abc', 1);
      if (reservation.ok && reservation.value.status === 'reserved') {
        await callRazorpay();
      }
    }

    expect(razorpayCalls).toBe(1);
  });
});
