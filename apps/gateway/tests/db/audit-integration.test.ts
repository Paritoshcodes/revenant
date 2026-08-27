/**
 * Integration test against a real Postgres database.
 *
 * audit_log cannot be cleaned up after the fact: the append-only triggers
 * from migration 0001 reject DELETE as well as UPDATE and TRUNCATE, so any
 * row this test commits would sit in the table forever. Everything here
 * therefore runs inside one transaction that is rolled back at the end,
 * which exercises the real advisory lock, the real jsonb round trip, and
 * the real bigserial sequence, while leaving no permanent row behind.
 *
 * db tier: requires a real Postgres. FAILS LOUDLY (not skipped) when
 * DATABASE_URL is not configured — see docs/ARCHITECTURE.md, "Regression
 * suite". Run via `npm run test:db`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appendAuditEvent } from '../../src/audit/writer.js';
import { fetchChain } from '../../src/audit/reader.js';
import { verifyChain } from '../../src/audit/verify.js';
import type { TransactionClient } from '../../src/audit/types.js';
import type { AuditEvent, AuditRow } from '@revenant/contracts';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '..', '.env') });

const databaseUrl = process.env['DATABASE_URL'];

describe('audit chain against a live database', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error(
        'tests/db/audit-integration.test.ts requires DATABASE_URL to be set ' +
          '(it runs against a real Postgres). Run `npm run test:db` with a ' +
          'reachable database instead of skipping this file.',
      );
    }
    pool = new pg.Pool({ connectionString: databaseUrl });
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it('writes a chain, reads it back through jsonb, and verifies it — then rolls back', async () => {
    await client.query('BEGIN');
    try {
      // Whatever the table already holds, good or bad, is not this test's
      // concern: scope verification to only the rows written here by
      // resuming from the chain's current tail instead of true genesis.
      const before = await fetchChain(client as TransactionClient);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const startingPrevHash =
        before.value.length > 0
          ? before.value[before.value.length - 1]!.hash
          : '0'.repeat(64);

      const events: AuditEvent[] = [
        {
          kind: 'transaction_opened',
          timestamp: '2026-08-24T10:00:00.000Z',
          transaction_id: 'txn_audit_integration_test',
          arm: 'treatment',
          amount_paise: 49900,
          rzp_order_id: null,
          rzp_payment_link_id: null,
        },
        {
          kind: 'guardrail_veto',
          timestamp: '2026-08-24T10:00:01.000Z',
          transaction_id: 'txn_audit_integration_test',
          arm: 'treatment',
          attempt_number: 1,
          grid_cell: 'business/payment_initiation',
          proposed_action: 'retry_with_backoff',
          guardrail_verdict: 'veto',
          guardrail_reason: 'terminal_grid_cell: business/payment_initiation is terminal',
        },
      ];

      for (const event of events) {
        const written = await appendAuditEvent(client as TransactionClient, event);
        expect(written.ok).toBe(true);
      }

      const after = await fetchChain(client as TransactionClient);
      expect(after.ok).toBe(true);
      if (!after.ok) return;

      const newRows = after.value.slice(before.value.length);
      expect(newRows).toHaveLength(events.length);

      // Proves the round trip: canonicalJson must defeat jsonb's key
      // reordering, or this would fail even though nothing was tampered.
      const verification = verifyChain(newRows, startingPrevHash);
      expect(verification).toEqual({ ok: true, rowsVerified: events.length });

      // Chain-of-custody: each row's prev_hash is the row before it, and
      // the second row's payload really did round-trip through jsonb.
      expect(newRows[0]!.prev_hash).toBe(startingPrevHash);
      expect(newRows[1]!.prev_hash).toBe(newRows[0]!.hash);
      expect(newRows[1]!.payload).toMatchObject({
        kind: 'guardrail_veto',
        guardrail_verdict: 'veto',
      });

      // Tamper detection against real Postgres-shaped rows, not just the
      // synthetic fixtures in audit-verify.test.ts. Mutation happens only
      // in this in-memory array; nothing is written back to the database.
      const tampered: AuditRow[] = [
        newRows[0]!,
        { ...newRows[1]!, payload: { ...(newRows[1]!.payload as object), guardrail_verdict: 'allow' } },
      ];
      const tamperedResult = verifyChain(tampered, startingPrevHash);
      expect(tamperedResult.ok).toBe(false);
      if (tamperedResult.ok) return;
      expect(tamperedResult.brokenSeq).toBe(newRows[1]!.seq);
    } finally {
      // Leaves zero trace: audit_log rows cannot be deleted once committed,
      // so this test must never COMMIT.
      await client.query('ROLLBACK');
    }
  });

  it('confirms the append-only trigger still rejects UPDATE on a committed row', async () => {
    // A direct, minimal reproduction of the guarantee migration 0001 adds,
    // run here rather than only asserted by hand: proves the guard the
    // whole chain design depends on is still wired up on this database.
    await client.query('BEGIN');
    try {
      const genesisPayload = JSON.stringify({ kind: 'transaction_opened' });
      const genesisHash = 'f'.repeat(64);
      const inserted = await client.query(
        `INSERT INTO audit_log (prev_hash, hash, payload)
         VALUES ($1, $2, $3::jsonb) RETURNING seq`,
        ['0'.repeat(64), genesisHash, genesisPayload],
      );
      const seq = (inserted.rows[0] as { seq: string }).seq;

      await expect(
        client.query('UPDATE audit_log SET payload = $1 WHERE seq = $2', [
          '{}',
          seq,
        ]),
      ).rejects.toThrow(/append only/i);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
