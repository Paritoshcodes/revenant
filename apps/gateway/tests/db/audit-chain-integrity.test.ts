/**
 * Integration test against a real Postgres database.
 *
 * verifyChain is unit tested (audit-verify.test.ts) but had never run over
 * a chain produced by the real state machine. Runs several transactions
 * through runRecoveryStep with a fake AttemptExecutor against the live db
 * client, then verifies every row those transactions wrote is a clean,
 * unbroken extension of the chain's tail. Then tampers by INSERTing (the
 * append-only trigger from migration 0001 blocks UPDATE, DELETE and
 * TRUNCATE, so an update-based tamper is not available even to this test)
 * a new row whose hash is internally self-consistent but whose prev_hash
 * does not match the real preceding row's hash — isolating exactly the
 * "chain was cut" failure mode — and asserts verifyChain reports that
 * row's seq as the first break.
 *
 * Same technique as the other db-tier integration tests: everything runs
 * inside one transaction, rolled back at the end, leaving zero permanent
 * rows.
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

import { ok } from '@revenant/contracts';
import type { Result } from '@revenant/contracts';

import { fetchChain } from '../../src/audit/reader.js';
import { hashPayload } from '../../src/audit/hash.js';
import type { TransactionClient } from '../../src/audit/types.js';
import { verifyChain } from '../../src/audit/verify.js';
import { DEFAULT_GUARDRAIL_CONFIG } from '../../src/guardrails/config.js';
import { runRecoveryStep } from '../../src/recovery/state-machine.js';
import type {
  AttemptExecutionResult,
  AttemptExecutor,
  RecoveryStepDeps,
} from '../../src/recovery/types.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '..', '.env') });

const databaseUrl = process.env['DATABASE_URL'];

const NOW = Date.parse('2026-08-26T14:00:00.000Z');

const insertTransaction = (client: TransactionClient, id: string) =>
  client.query(
    `INSERT INTO transactions (id, amount_paise, arm, status) VALUES ($1, $2, 'treatment', 'open')`,
    [id, 49_900],
  );

/** One captured attempt, distinguished per transaction so results don't collide. */
const capturingExecutor = (paymentId: string): AttemptExecutor => ({
  execute: async (): Promise<Result<AttemptExecutionResult>> =>
    ok({
      outcome: 'captured',
      rzpPaymentId: paymentId,
      rzpRequestId: null,
      rzpResponseId: `req_${paymentId}`,
      errorCode: null,
      errorSource: null,
      errorStep: null,
      errorReason: null,
      authCode: '112693',
    }),
});

describe('audit chain integrity over a real batch of transactions', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error(
        'tests/db/audit-chain-integrity.test.ts requires DATABASE_URL to be set ' +
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

  it('runs several transactions through the real state machine and verifies an unbroken chain, then detects an inserted row with a wrong prev_hash', async () => {
    await client.query('BEGIN');
    try {
      const before = await fetchChain(client as TransactionClient);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const startingPrevHash =
        before.value.length > 0 ? before.value[before.value.length - 1]!.hash : '0'.repeat(64);

      const transactionIds = ['txn_chain_1', 'txn_chain_2', 'txn_chain_3'];

      for (const transactionId of transactionIds) {
        await insertTransaction(client as TransactionClient, transactionId);

        const deps: RecoveryStepDeps = {
          executor: capturingExecutor(`pay_${transactionId}`),
          guardrailConfig: DEFAULT_GUARDRAIL_CONFIG,
          now: () => NOW,
        };

        const result = await runRecoveryStep(client as TransactionClient, deps, {
          transactionId,
          arm: 'treatment',
          attemptNumber: 1,
          diagnosis: { errorSource: 'gateway', errorStep: 'payment_authorization' },
          lastAttemptAtMs: null,
          batch: { settled: 0, failed: 0 },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.status).toBe('settled');
      }

      // -- every row these three transactions wrote is a clean chain -------

      const afterReal = await fetchChain(client as TransactionClient);
      expect(afterReal.ok).toBe(true);
      if (!afterReal.ok) return;

      const realNewRows = afterReal.value.slice(before.value.length);
      // decision_made, attempt_started, attempt_settled, transaction_closed
      // per transaction (recovery-integration.test.ts already pins this
      // exact sequence for one transaction; three transactions is 4x3).
      expect(realNewRows).toHaveLength(transactionIds.length * 4);

      const cleanVerification = verifyChain(realNewRows, startingPrevHash);
      expect(cleanVerification).toEqual({ ok: true, rowsVerified: realNewRows.length });

      // -- now tamper: insert a row with an internally self-consistent
      //    hash, but a prev_hash that does not match the real tail -------

      const realTailHash = realNewRows[realNewRows.length - 1]!.hash;
      const wrongPrevHash = '1'.repeat(64);
      const tamperedPayload = {
        kind: 'attempt_settled',
        timestamp: new Date(NOW).toISOString(),
        transaction_id: 'txn_chain_tamper',
        arm: 'treatment',
        attempt_number: 1,
        idempotency_key: 'txn_chain_tamper:1',
        rzp_payment_id: 'pay_tamper',
        rzp_response_id: null,
        error_code: null,
        error_source: null,
        error_step: null,
        error_reason: null,
        auth_code: null,
        outcome: 'captured',
      };
      // Self-consistent: this row's own hash correctly matches
      // sha256(wrongPrevHash + canonical_json(payload)), so verifyChain's
      // SECOND check (payload/hash tamper) would pass. Only the FIRST check
      // — prev_hash matching the actual preceding row's hash — fails, which
      // is exactly the "chain was cut" mode this test isolates.
      const tamperedHash = hashPayload(wrongPrevHash, tamperedPayload);

      const inserted = await client.query(
        `INSERT INTO audit_log (prev_hash, hash, payload)
         VALUES ($1, $2, $3::jsonb) RETURNING seq`,
        [wrongPrevHash, tamperedHash, JSON.stringify(tamperedPayload)],
      );
      const tamperedSeq = Number((inserted.rows[0] as { seq: string | number }).seq);
      expect(tamperedSeq).toBeGreaterThan(0);

      const afterTamper = await fetchChain(client as TransactionClient);
      expect(afterTamper.ok).toBe(true);
      if (!afterTamper.ok) return;

      const rowsIncludingTamper = afterTamper.value.slice(before.value.length);
      expect(rowsIncludingTamper[rowsIncludingTamper.length - 1]!.seq).toBe(tamperedSeq);
      // Sanity: the row really did land right after the real tail, so a
      // pass here could only be explained by the prev_hash check itself.
      expect(rowsIncludingTamper[rowsIncludingTamper.length - 2]!.hash).toBe(realTailHash);

      const tamperVerification = verifyChain(rowsIncludingTamper, startingPrevHash);
      expect(tamperVerification.ok).toBe(false);
      if (tamperVerification.ok) return;
      expect(tamperVerification.brokenSeq).toBe(tamperedSeq);
      expect(tamperVerification.reason).toContain('does not match the hash of the preceding row');
      expect(tamperVerification.rowsVerified).toBe(realNewRows.length);
    } finally {
      // audit_log rows cannot be deleted once committed (append-only
      // trigger), so this test must never COMMIT — including the
      // deliberately tampered row.
      await client.query('ROLLBACK');
    }
  });
});
