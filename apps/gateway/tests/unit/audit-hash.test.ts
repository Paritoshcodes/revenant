import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../src/audit/canonical-json.js';
import { hashPayload } from '../../src/audit/hash.js';

const GENESIS = '0'.repeat(64);

describe('hashPayload', () => {
  it('matches an independently computed sha256(prev_hash + canonical_json(payload))', () => {
    const prevHash = GENESIS;
    const payload = { kind: 'transaction_opened', amount_paise: 49900 };

    const expected = createHash('sha256')
      .update(prevHash + canonicalJson(payload), 'utf8')
      .digest('hex');

    expect(hashPayload(prevHash, payload)).toBe(expected);
  });

  it('is a 64-character lowercase hex string', () => {
    const hash = hashPayload(GENESIS, { a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    const payload = { a: 1, b: [1, 2, 3] };
    const runs = Array.from({ length: 10 }, () => hashPayload(GENESIS, payload));
    expect(new Set(runs).size).toBe(1);
  });

  it('is unaffected by the payload object key order', () => {
    const a = hashPayload(GENESIS, { x: 1, y: 2 });
    const b = hashPayload(GENESIS, { y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it('changes when prev_hash changes and the payload does not', () => {
    const payload = { a: 1 };
    const first = hashPayload(GENESIS, payload);
    const second = hashPayload('1'.repeat(64), payload);
    expect(first).not.toBe(second);
  });

  it('changes when the payload changes and prev_hash does not', () => {
    const first = hashPayload(GENESIS, { a: 1 });
    const second = hashPayload(GENESIS, { a: 2 });
    expect(first).not.toBe(second);
  });

  it('is sensitive to every field, not just the first one compared', () => {
    const base = { source: 'gateway', step: 'payment_authorization', amount: 100 };
    const changed = { ...base, amount: 101 };
    expect(hashPayload(GENESIS, base)).not.toBe(hashPayload(GENESIS, changed));
  });
});
