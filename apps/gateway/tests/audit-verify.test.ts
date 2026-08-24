import { describe, expect, it } from 'vitest';

import { hashPayload } from '../src/audit/hash.js';
import { verifyChain } from '../src/audit/verify.js';
import type { AuditRow } from '@revenant/contracts';

const GENESIS = '0'.repeat(64);

/**
 * Builds a valid chain of `payloads.length` rows, each correctly hashed on
 * top of the one before it. Real seq numbers, gapless, starting at 1.
 */
const buildChain = (
  payloads: readonly unknown[],
  genesisPrevHash: string = GENESIS,
): AuditRow[] => {
  const rows: AuditRow[] = [];
  let prevHash = genesisPrevHash;

  payloads.forEach((payload, index) => {
    const hash = hashPayload(prevHash, payload);
    rows.push({
      seq: index + 1,
      prev_hash: prevHash,
      hash,
      payload,
      created_at: new Date(2026, 7, 24, 10, 0, index).toISOString(),
    });
    prevHash = hash;
  });

  return rows;
};

describe('verifyChain, valid chains', () => {
  it('verifies an empty chain as ok', () => {
    expect(verifyChain([])).toEqual({ ok: true, rowsVerified: 0 });
  });

  it('verifies a single genesis row', () => {
    const rows = buildChain([{ kind: 'transaction_opened' }]);
    expect(verifyChain(rows)).toEqual({ ok: true, rowsVerified: 1 });
  });

  it('verifies a multi-row chain', () => {
    const rows = buildChain([
      { kind: 'transaction_opened' },
      { kind: 'decision_made', attempt_number: 1 },
      { kind: 'attempt_started', attempt_number: 1 },
      { kind: 'attempt_settled', attempt_number: 1, outcome: 'failed' },
      { kind: 'transaction_closed', final_status: 'abandoned' },
    ]);
    expect(verifyChain(rows)).toEqual({ ok: true, rowsVerified: 5 });
  });

  it('resumes from a checkpoint hash instead of true genesis', () => {
    const full = buildChain([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const checkpointHash = full[0]!.hash;
    const tail = full.slice(1);

    expect(verifyChain(tail, checkpointHash)).toEqual({
      ok: true,
      rowsVerified: 2,
    });
  });
});

describe('verifyChain, tampered chains', () => {
  it('reports the genesis row when its prev_hash is not the expected start', () => {
    const rows = buildChain([{ a: 1 }, { a: 2 }]);
    const corrupted = [{ ...rows[0]!, prev_hash: '9'.repeat(64) }, rows[1]!];

    const result = verifyChain(corrupted);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.brokenSeq).toBe(1);
    expect(result.rowsVerified).toBe(0);
    expect(result.reason).toContain('does not match the expected starting hash');
  });

  it('reports a middle row whose prev_hash was overwritten, breaking the link', () => {
    const rows = buildChain([{ a: 1 }, { a: 2 }, { a: 3 }]);
    // Row 3's prev_hash no longer matches row 2's hash: the link is cut.
    const corrupted = [rows[0]!, rows[1]!, { ...rows[2]!, prev_hash: 'f'.repeat(64) }];

    const result = verifyChain(corrupted);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.brokenSeq).toBe(3);
    expect(result.rowsVerified).toBe(2);
    expect(result.reason).toContain('seq 2');
  });

  it('reports a row whose payload was altered without recomputing the hash', () => {
    // This is the case the append-only trigger exists to prevent, exercised
    // here as data rather than as a live UPDATE: if a row's payload were
    // ever changed and its hash left untouched, this is what catches it.
    const rows = buildChain([{ amount: 100 }, { amount: 200 }]);
    const corrupted = [rows[0]!, { ...rows[1]!, payload: { amount: 9_999 } }];

    const result = verifyChain(corrupted);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.brokenSeq).toBe(2);
    expect(result.rowsVerified).toBe(1);
    expect(result.reason).toContain('does not match sha256');
  });

  it('reports a row whose hash was overwritten directly', () => {
    const rows = buildChain([{ a: 1 }, { a: 2 }]);
    const corrupted = [rows[0]!, { ...rows[1]!, hash: '0'.repeat(64) }];

    const result = verifyChain(corrupted);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.brokenSeq).toBe(2);
  });

  it('reports the FIRST broken row when several are broken', () => {
    const rows = buildChain([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
    const corrupted = [
      rows[0]!,
      { ...rows[1]!, payload: { a: 999 } }, // breaks at seq 2
      { ...rows[2]!, hash: 'e'.repeat(64) }, // also broken, later
      rows[3]!,
    ];

    const result = verifyChain(corrupted);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.brokenSeq).toBe(2);
  });

  it('detects two rows silently swapped, even though each hash independently recomputes', () => {
    const rows = buildChain([{ a: 1 }, { a: 2 }, { a: 3 }]);
    // Swapping rows 2 and 3: each row's own hash still matches its own
    // prev_hash + payload, but the sequence no longer chains.
    const swapped = [rows[0]!, rows[2]!, rows[1]!];

    const result = verifyChain(swapped);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // rows[2] (originally seq 3) now sits at position 1, and its prev_hash
    // (rows[1]'s hash) does not match rows[0]'s hash.
    expect(result.brokenSeq).toBe(rows[2]!.seq);
  });

  it('detects a row deleted from the middle, even though the trigger normally forbids it', () => {
    const rows = buildChain([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const withGap = [rows[0]!, rows[2]!];

    const result = verifyChain(withGap);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.brokenSeq).toBe(rows[2]!.seq);
  });
});

describe('verifyChain, purity', () => {
  it('does not mutate its input', () => {
    const rows = buildChain([{ a: 1 }, { a: 2 }]);
    const snapshot = JSON.stringify(rows);

    verifyChain(rows);

    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it('gives the same verdict on repeated calls', () => {
    const rows = buildChain([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const runs = Array.from({ length: 5 }, () => verifyChain(rows));
    expect(new Set(runs.map((r) => JSON.stringify(r))).size).toBe(1);
  });
});
