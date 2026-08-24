/**
 * Chain verification.
 *
 * `verifyChain` is a pure function: rows in, a verdict out, no I/O. Given
 * that, it is unit-testable without a database, including the tampered-chain
 * case, and the same function backs both a one-off audit and a recurring
 * verifier job. Reports the sequence number of the FIRST broken row, per
 * docs/ARCHITECTURE.md.
 */
import { GENESIS_PREV_HASH } from '@revenant/contracts';
import type { AuditRow } from '@revenant/contracts';

import { hashPayload } from './hash.js';

export interface ChainVerificationOk {
  readonly ok: true;
  readonly rowsVerified: number;
}

export interface ChainVerificationBroken {
  readonly ok: false;
  /** The seq of the first row that failed to verify. */
  readonly brokenSeq: number;
  readonly reason: string;
  /** Rows before the break that verified cleanly. */
  readonly rowsVerified: number;
}

export type ChainVerification = ChainVerificationOk | ChainVerificationBroken;

/**
 * Walks `rows` in the order given, which must be ascending by seq (the
 * caller reading from Postgres is expected to `ORDER BY seq ASC`; this
 * function does not re-sort, so a caller that hands it rows out of order
 * gets a "does not match" verdict rather than a silently wrong pass).
 *
 * Two independent things can break a row:
 *   - its prev_hash does not match the hash of the row before it (the chain
 *     was cut, reordered, or a row is missing)
 *   - its hash does not match sha256(prev_hash + canonical_json(payload))
 *     (the payload or the hash itself was altered after the row was written)
 *
 * `expectedGenesisPrevHash` lets a caller resume verification from a
 * checkpoint: pass the hash of the last row already known-good as the
 * starting point instead of the true genesis value.
 */
export const verifyChain = (
  rows: readonly AuditRow[],
  expectedGenesisPrevHash: string = GENESIS_PREV_HASH,
): ChainVerification => {
  let expectedPrevHash = expectedGenesisPrevHash;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;

    if (row.prev_hash !== expectedPrevHash) {
      return {
        ok: false,
        brokenSeq: row.seq,
        reason:
          index === 0
            ? `prev_hash '${row.prev_hash}' does not match the expected starting hash '${expectedGenesisPrevHash}'`
            : `prev_hash '${row.prev_hash}' does not match the hash of the preceding row (seq ${rows[index - 1]!.seq})`,
        rowsVerified: index,
      };
    }

    const recomputed = hashPayload(row.prev_hash, row.payload);
    if (recomputed !== row.hash) {
      return {
        ok: false,
        brokenSeq: row.seq,
        reason:
          'hash does not match sha256(prev_hash + canonical_json(payload)): the payload or the hash was altered after this row was written',
        rowsVerified: index,
      };
    }

    expectedPrevHash = row.hash;
  }

  return { ok: true, rowsVerified: rows.length };
};
