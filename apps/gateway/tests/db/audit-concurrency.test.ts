/**
 * Integration test against a real Postgres database.
 *
 * appendAuditEvent's mutual exclusion is a transaction-scoped advisory lock
 * (`pg_advisory_xact_lock`), and until now it had only ever run
 * single-threaded — every existing caller (state-machine.ts, reconcile.ts,
 * and every db-tier test) is one connection making one call at a time.
 * This fires N appends from N genuinely separate `pg.PoolClient`s at once
 * and asserts the lock actually serialised them: an unbroken chain,
 * exactly N new rows, no duplicate seq, no duplicate hash.
 *
 * THIS TEST DOES NOT LEAVE ZERO ROWS BEHIND, unlike every other file in
 * this tier — flagged here and in docs/ARCHITECTURE.md's "Regression
 * suite" section, not hidden. `pg_advisory_xact_lock` is released only at
 * COMMIT or ROLLBACK of the transaction holding it, so proving it
 * serialises N *separate connections* requires each connection to run its
 * own real `BEGIN` ... `appendAuditEvent` ... `COMMIT` — a bare `.query()`
 * against a pool hands out a different connection per statement and would
 * make the lock meaningless (acquired and released between the SELECT and
 * the INSERT). And `audit_log` has no DELETE path at all: the append-only
 * trigger from migration 0001 blocks it, by design — that permanence is
 * the entire point of the table. Rolling back instead would mean no
 * connection ever sees another's row, so there would be nothing for
 * verifyChain to run over together. This is the direct, unavoidable
 * consequence of testing a guarantee that is *supposed* to be permanent,
 * not a shortcut. Mitigated by keeping N small (5) and tagging every
 * payload with this run's own id so the rows stay identifiable in the
 * table forever, same as any other genuine audit event would be.
 *
 * db tier: requires a real Postgres. FAILS LOUDLY (not skipped) when
 * DATABASE_URL is not configured — see docs/ARCHITECTURE.md, "Regression
 * suite".
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditEvent } from '@revenant/contracts';

import { fetchChain } from '../../src/audit/reader.js';
import type { TransactionClient } from '../../src/audit/types.js';
import { verifyChain } from '../../src/audit/verify.js';
import { appendAuditEvent } from '../../src/audit/writer.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '..', '.env') });

const databaseUrl = process.env['DATABASE_URL'];

const N = 5;

describe('appendAuditEvent under genuine cross-connection concurrency', () => {
  let pool: pg.Pool;
  let readClient: pg.PoolClient;

  beforeAll(async () => {
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error(
        'tests/db/audit-concurrency.test.ts requires DATABASE_URL to be set ' +
          '(it runs against a real Postgres). Run `npm run test:db` with a ' +
          'reachable database instead of skipping this file.',
      );
    }
    pool = new pg.Pool({ connectionString: databaseUrl });
    readClient = await pool.connect();
  });

  afterAll(async () => {
    readClient.release();
    await pool.end();
  });

  it(`serialises ${N} concurrent appends from ${N} separate connections into one unbroken chain`, async () => {
    const runTag = `audit_concurrency_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    const before = await fetchChain(readClient as TransactionClient);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const tailBefore = before.value.length > 0 ? before.value[before.value.length - 1]!.hash : null;

    const appendOnOwnConnection = async (index: number): Promise<void> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const payload: AuditEvent = {
          kind: 'transaction_opened',
          timestamp: new Date().toISOString(),
          transaction_id: `txn_${runTag}_${index}`,
          arm: 'treatment',
          amount_paise: 49_900,
          rzp_order_id: null,
          rzp_payment_link_id: null,
        };
        const written = await appendAuditEvent(client as TransactionClient, payload);
        if (!written.ok) throw new Error(`appendAuditEvent failed: ${written.error.message}`);
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw cause;
      } finally {
        client.release();
      }
    };

    // Genuinely concurrent: N separate connections, N separate
    // transactions, racing the same advisory lock.
    await Promise.all(Array.from({ length: N }, (_, i) => appendOnOwnConnection(i)));

    const after = await fetchChain(readClient as TransactionClient);
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    const newRows = after.value.filter(
      (row) => (row.payload as { transaction_id?: string }).transaction_id?.startsWith(`txn_${runTag}_`),
    );

    expect(newRows).toHaveLength(N);

    const seqs = newRows.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(N);

    const hashes = newRows.map((r) => r.hash);
    expect(new Set(hashes).size).toBe(N);

    // The chain as a whole — from the tail before this test to the tail
    // after — verifies cleanly, proving the lock produced a genuine total
    // order across N connections, not just N rows with no duplicates.
    const allNewRows = after.value.slice(before.value.length);
    const verification = verifyChain(allNewRows, tailBefore ?? '0'.repeat(64));
    expect(verification).toEqual({ ok: true, rowsVerified: allNewRows.length });

    console.log(
      `[audit-concurrency.test.ts] ${N} rows permanently added to audit_log, ` +
        `seq ${Math.min(...seqs)}..${Math.max(...seqs)}, tag ${runTag} — ` +
        `expected and documented, see this file's module doc.`,
    );
  });
});
