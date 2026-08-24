/**
 * Audit chain writer.
 *
 * Every row stores prev_hash and hash = sha256(prev_hash + canonical_json
 * (payload)). The genesis row's prev_hash is 64 zeros (@revenant/contracts
 * GENESIS_PREV_HASH). See docs/ARCHITECTURE.md, Audit chain.
 */
import { GENESIS_PREV_HASH, err, ok } from '@revenant/contracts';
import type { AuditEvent, AuditRow, Result } from '@revenant/contracts';

import { hashPayload } from './hash.js';
import { toAuditRow, toFailure } from './types.js';
import type { TransactionClient } from './types.js';

/**
 * All writers contend on this one advisory lock, so "read the last hash,
 * then insert on top of it" is atomic across concurrent callers. hashtext()
 * turns the name into a stable lock key; the string itself is arbitrary.
 */
const ADVISORY_LOCK_NAME = 'revenant_audit_log';

interface LastHashRow {
  readonly hash: string;
}

/**
 * Appends one event to the chain and returns the row as written.
 *
 * `client` MUST already be inside an open transaction (see
 * TransactionClient). This function does not call BEGIN or COMMIT itself:
 * in real use, an audit write is normally one of several writes inside a
 * larger transaction (for example, alongside settling the attempt row), and
 * this function has to join that transaction rather than start its own. The
 * advisory lock it takes is transaction-scoped (`pg_advisory_xact_lock`)
 * and is released automatically when the caller commits or rolls back.
 */
export const appendAuditEvent = async (
  client: TransactionClient,
  payload: AuditEvent,
): Promise<Result<AuditRow>> => {
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
      ADVISORY_LOCK_NAME,
    ]);

    const last = await client.query(
      'SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1',
    );
    const prevHash =
      (last.rows[0] as LastHashRow | undefined)?.hash ?? GENESIS_PREV_HASH;

    const hash = hashPayload(prevHash, payload);

    const inserted = await client.query(
      `INSERT INTO audit_log (prev_hash, hash, payload)
       VALUES ($1, $2, $3)
       RETURNING seq, prev_hash, hash, payload, created_at`,
      [prevHash, hash, JSON.stringify(payload)],
    );

    const row = inserted.rows[0];
    if (row === undefined) {
      return err({
        kind: 'internal' as const,
        message: 'appendAuditEvent: INSERT ... RETURNING produced no row',
      });
    }

    return ok(toAuditRow(row as Parameters<typeof toAuditRow>[0]));
  } catch (cause) {
    return err(toFailure(cause, 'appendAuditEvent'));
  }
};
