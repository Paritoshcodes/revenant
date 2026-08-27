import { describe, expect, it } from 'vitest';

import { appendAuditEvent } from '../../src/audit/writer.js';
import type { TransactionClient } from '../../src/audit/types.js';
import { hashPayload } from '../../src/audit/hash.js';
import type { AuditEvent } from '@revenant/contracts';

const GENESIS = '0'.repeat(64);

interface Call {
  sql: string;
  params: readonly unknown[];
}

const fakeClient = (
  responses: Array<{ rows: unknown[] } | Error>,
): TransactionClient & { calls: Call[] } => {
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

const event: AuditEvent = {
  kind: 'transaction_opened',
  timestamp: '2026-08-24T10:00:00.000Z',
  transaction_id: 'txn_abc',
  arm: 'treatment',
  amount_paise: 49900,
  rzp_order_id: null,
  rzp_payment_link_id: null,
};

const attemptRow = (seq: number, prevHash: string, hash: string, payload: unknown) => ({
  seq,
  prev_hash: prevHash,
  hash,
  payload,
  created_at: '2026-08-24T10:00:00.000Z',
});

describe('appendAuditEvent', () => {
  it('takes the advisory lock before reading the last hash', async () => {
    const hash = hashPayload(GENESIS, event);
    const client = fakeClient([
      { rows: [] }, // advisory lock
      { rows: [] }, // no existing rows: genesis
      { rows: [attemptRow(1, GENESIS, hash, event)] },
    ]);

    await appendAuditEvent(client, event);

    expect(client.calls[0]!.sql).toMatch(/pg_advisory_xact_lock/);
    expect(client.calls[1]!.sql).toMatch(/SELECT hash FROM audit_log/);
    expect(client.calls[2]!.sql).toMatch(/INSERT INTO audit_log/);
  });

  it('uses the genesis hash as prev_hash when the chain is empty', async () => {
    const hash = hashPayload(GENESIS, event);
    const client = fakeClient([
      { rows: [] },
      { rows: [] },
      { rows: [attemptRow(1, GENESIS, hash, event)] },
    ]);

    const result = await appendAuditEvent(client, event);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prev_hash).toBe(GENESIS);
    expect(result.value.hash).toBe(hash);

    const insertParams = client.calls[2]!.params;
    expect(insertParams[0]).toBe(GENESIS);
    expect(insertParams[1]).toBe(hash);
  });

  it('chains onto the existing last hash when the table is not empty', async () => {
    const existingHash = 'a'.repeat(64);
    const expectedHash = hashPayload(existingHash, event);
    const client = fakeClient([
      { rows: [] },
      { rows: [{ hash: existingHash }] },
      { rows: [attemptRow(5, existingHash, expectedHash, event)] },
    ]);

    const result = await appendAuditEvent(client, event);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prev_hash).toBe(existingHash);
    expect(result.value.hash).toBe(expectedHash);
  });

  it('writes a hash matching hashPayload(prevHash, payload), not something ad hoc', async () => {
    const existingHash = 'b'.repeat(64);
    const client = fakeClient([
      { rows: [] },
      { rows: [{ hash: existingHash }] },
      {
        rows: [
          attemptRow(2, existingHash, hashPayload(existingHash, event), event),
        ],
      },
    ]);

    await appendAuditEvent(client, event);

    const [, , insertCall] = client.calls;
    expect(insertCall!.params[1]).toBe(hashPayload(existingHash, event));
  });

  it('serializes the payload as JSON for the jsonb column', async () => {
    const hash = hashPayload(GENESIS, event);
    const client = fakeClient([
      { rows: [] },
      { rows: [] },
      { rows: [attemptRow(1, GENESIS, hash, event)] },
    ]);

    await appendAuditEvent(client, event);

    const insertParams = client.calls[2]!.params;
    expect(insertParams[2]).toBe(JSON.stringify(event));
  });

  it('normalizes a bigserial seq delivered as a string', async () => {
    const hash = hashPayload(GENESIS, event);
    const client = fakeClient([
      { rows: [] },
      { rows: [] },
      { rows: [attemptRow('9007199254740991' as unknown as number, GENESIS, hash, event)] },
    ]);

    const result = await appendAuditEvent(client, event);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.seq).toBe(9007199254740991);
  });

  it('returns a typed failure instead of throwing when the insert fails', async () => {
    const client = fakeClient([
      { rows: [] },
      { rows: [] },
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      }),
    ]);

    const result = await appendAuditEvent(client, event);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
  });

  it('maps a rejected append-only trigger to a validation failure', async () => {
    const client = fakeClient([
      { rows: [] },
      { rows: [] },
      Object.assign(new Error('audit_log is append only: UPDATE rejected on seq 3'), {
        code: '23001',
      }),
    ]);

    const result = await appendAuditEvent(client, event);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('does not call BEGIN or COMMIT itself', async () => {
    const hash = hashPayload(GENESIS, event);
    const client = fakeClient([
      { rows: [] },
      { rows: [] },
      { rows: [attemptRow(1, GENESIS, hash, event)] },
    ]);

    await appendAuditEvent(client, event);

    for (const call of client.calls) {
      expect(call.sql).not.toMatch(/^\s*BEGIN\b/i);
      expect(call.sql).not.toMatch(/^\s*COMMIT\b/i);
    }
  });
});
