/**
 * Reads the audit chain from Postgres. Unlike the writer, a read needs no
 * transaction or lock: a bare Pool is fine here.
 */
import { GENESIS_PREV_HASH, err, ok } from '@revenant/contracts';
import type { AuditRow, Result } from '@revenant/contracts';

import { toAuditRow, toFailure } from './types.js';
import type { Queryable } from './types.js';
import { verifyChain } from './verify.js';
import type { ChainVerification } from './verify.js';

/** The full chain, in seq order. */
export const fetchChain = async (db: Queryable): Promise<Result<AuditRow[]>> => {
  try {
    const result = await db.query(
      'SELECT seq, prev_hash, hash, payload, created_at FROM audit_log ORDER BY seq ASC',
    );
    return ok(result.rows.map((row) => toAuditRow(row as Parameters<typeof toAuditRow>[0])));
  } catch (cause) {
    return err(toFailure(cause, 'fetchChain'));
  }
};

/** Fetches the whole chain and verifies it in one call. */
export const verifyChainInDb = async (
  db: Queryable,
  expectedGenesisPrevHash: string = GENESIS_PREV_HASH,
): Promise<Result<ChainVerification>> => {
  const chain = await fetchChain(db);
  if (!chain.ok) return chain;
  return ok(verifyChain(chain.value, expectedGenesisPrevHash));
};
