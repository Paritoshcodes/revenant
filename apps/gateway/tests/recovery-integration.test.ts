/**
 * Integration test against a real Postgres database.
 *
 * Same technique as audit-integration.test.ts: audit_log rejects DELETE as
 * well as UPDATE and TRUNCATE, so anything committed here would sit in the
 * table forever. Everything runs inside one transaction that is rolled
 * back at the end, and verification resumes from the chain's tail at the
 * start of the test rather than assuming the table starts empty.
 *
 * Skipped when DATABASE_URL is not configured, so the rest of the suite
 * still runs on a machine without a local Postgres.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ok } from '@revenant/contracts';
import type { Result } from '@revenant/contracts';

import { fetchChain } from '../src/audit/reader.js';
import type { TransactionClient } from '../src/audit/types.js';
import { verifyChain } from '../src/audit/verify.js';
import { DEFAULT_GUARDRAIL_CONFIG } from '../src/guardrails/config.js';
import { runRecoveryStep } from '../src/recovery/state-machine.js';
import type {
  AttemptExecutionResult,
  AttemptExecutor,
  RecoveryStepDeps,
} from '../src/recovery/types.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '.env') });

const databaseUrl = process.env['DATABASE_URL'];

const NOW = Date.parse('2026-08-24T10:00:00.000Z');

const capturingExecutor: AttemptExecutor = {
  execute: async (): Promise<Result<AttemptExecutionResult>> =>
    ok({
      outcome: 'captured',
      rzpPaymentId: 'pay_recoveryIntegrationTest',
      rzpRequestId: null,
      rzpResponseId: 'req_recoveryIntegrationTest',
      errorCode: null,
      errorSource: null,
      errorStep: null,
      errorReason: null,
      authCode: '112693',
    }),
};

const insertTransaction = (client: TransactionClient, id: string) =>
  client.query(
    `INSERT INTO transactions (id, amount_paise, arm, status) VALUES ($1, $2, 'treatment', 'open')`,
    [id, 49_900],
  );

describe.skipIf(!databaseUrl)('recovery state machine against a live database', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it('runs a transaction through to a settled, recovered attempt with a verifiable audit chain', async () => {
    await client.query('BEGIN');
    try {
      const transactionId = 'txn_recovery_integration_captured';
      await insertTransaction(client as TransactionClient, transactionId);

      const before = await fetchChain(client as TransactionClient);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const startingPrevHash =
        before.value.length > 0 ? before.value[before.value.length - 1]!.hash : '0'.repeat(64);

      const deps: RecoveryStepDeps = {
        executor: capturingExecutor,
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
      expect(result.value).toMatchObject({
        status: 'settled',
        outcome: 'captured',
        decision: 'stop',
        transactionStatus: 'recovered',
      });

      // -- the underlying rows really changed -----------------------------

      const decisionRows = await client.query(
        'SELECT guardrail_verdict, proposed_action FROM decisions WHERE transaction_id = $1',
        [transactionId],
      );
      expect(decisionRows.rows).toEqual([
        { guardrail_verdict: 'allow', proposed_action: 'retry_with_backoff' },
      ]);

      const attemptRows = await client.query(
        'SELECT outcome, auth_code FROM attempts WHERE transaction_id = $1',
        [transactionId],
      );
      expect(attemptRows.rows).toEqual([{ outcome: 'captured', auth_code: '112693' }]);

      const txnRows = await client.query('SELECT status FROM transactions WHERE id = $1', [
        transactionId,
      ]);
      expect(txnRows.rows).toEqual([{ status: 'recovered' }]);

      // -- and the audit chain is a verifiable extension of the tail ------

      const after = await fetchChain(client as TransactionClient);
      expect(after.ok).toBe(true);
      if (!after.ok) return;

      const newRows = after.value.slice(before.value.length);
      expect(newRows.map((row) => (row.payload as { kind: string }).kind)).toEqual([
        'decision_made',
        'attempt_started',
        'attempt_settled',
        'transaction_closed',
      ]);

      const verification = verifyChain(newRows, startingPrevHash);
      expect(verification).toEqual({ ok: true, rowsVerified: newRows.length });

      expect(newRows[3]!.payload).toMatchObject({
        kind: 'transaction_closed',
        final_status: 'recovered',
        attempts_made: 1,
      });
    } finally {
      // audit_log rows cannot be deleted once committed, so this test must
      // never COMMIT.
      await client.query('ROLLBACK');
    }
  });

  it('allows a terminal cell whose action is never_retry, closes the transaction, and makes no outbound call', async () => {
    // business/payment_initiation: the policy itself proposes never_retry,
    // so the guardrail layer allows it (it only vetoes a RETRY proposed on
    // a terminal cell). Closing the transaction has to come from the
    // action, not from a veto — this is the real observed-in-test-mode
    // terminal case (docs/DECISIONS.md).
    await client.query('BEGIN');
    try {
      const transactionId = 'txn_recovery_integration_terminal';
      await insertTransaction(client as TransactionClient, transactionId);

      const before = await fetchChain(client as TransactionClient);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const startingPrevHash =
        before.value.length > 0 ? before.value[before.value.length - 1]!.hash : '0'.repeat(64);

      let executed = false;
      const refusingExecutor: AttemptExecutor = {
        execute: async () => {
          executed = true;
          return capturingExecutor.execute({
            transactionId,
            attemptNumber: 1,
            idempotencyKey: `${transactionId}:1`,
            action: 'never_retry',
          });
        },
      };

      const deps: RecoveryStepDeps = {
        executor: refusingExecutor,
        guardrailConfig: DEFAULT_GUARDRAIL_CONFIG,
        now: () => NOW,
      };

      const result = await runRecoveryStep(client as TransactionClient, deps, {
        transactionId,
        arm: 'treatment',
        attemptNumber: 1,
        diagnosis: { errorSource: 'business', errorStep: 'payment_initiation' },
        lastAttemptAtMs: null,
        batch: { settled: 0, failed: 0 },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        status: 'no_attempt',
        proposedAction: 'never_retry',
        transactionStatus: 'terminal',
      });
      expect(executed).toBe(false);

      const attemptRows = await client.query(
        'SELECT * FROM attempts WHERE transaction_id = $1',
        [transactionId],
      );
      expect(attemptRows.rows).toHaveLength(0);

      const txnRows = await client.query('SELECT status FROM transactions WHERE id = $1', [
        transactionId,
      ]);
      expect(txnRows.rows).toEqual([{ status: 'terminal' }]);

      const after = await fetchChain(client as TransactionClient);
      expect(after.ok).toBe(true);
      if (!after.ok) return;

      const newRows = after.value.slice(before.value.length);
      expect(newRows.map((row) => (row.payload as { kind: string }).kind)).toEqual([
        'decision_made',
        'transaction_closed',
      ]);

      const verification = verifyChain(newRows, startingPrevHash);
      expect(verification).toEqual({ ok: true, rowsVerified: newRows.length });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('vetoes an unmapped cell, closes the transaction, and makes no outbound call', async () => {
    // The demo case ARCHITECTURE.md asks for: a guardrail refusing an
    // action the policy proposed. bank/authentication has no grid row and
    // no wildcard, so the stub's fallback (retry_with_backoff) is a real
    // retry — the terminal_grid_cell guardrail vetoes it unconditionally
    // rather than assuming an unmapped cell is safe.
    await client.query('BEGIN');
    try {
      const transactionId = 'txn_recovery_integration_unmapped';
      await insertTransaction(client as TransactionClient, transactionId);

      const before = await fetchChain(client as TransactionClient);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const startingPrevHash =
        before.value.length > 0 ? before.value[before.value.length - 1]!.hash : '0'.repeat(64);

      let executed = false;
      const refusingExecutor: AttemptExecutor = {
        execute: async () => {
          executed = true;
          return capturingExecutor.execute({
            transactionId,
            attemptNumber: 1,
            idempotencyKey: `${transactionId}:1`,
            action: 'retry_with_backoff',
          });
        },
      };

      const deps: RecoveryStepDeps = {
        executor: refusingExecutor,
        guardrailConfig: DEFAULT_GUARDRAIL_CONFIG,
        now: () => NOW,
      };

      const result = await runRecoveryStep(client as TransactionClient, deps, {
        transactionId,
        arm: 'treatment',
        attemptNumber: 1,
        diagnosis: { errorSource: 'bank', errorStep: 'authentication' },
        lastAttemptAtMs: null,
        batch: { settled: 0, failed: 0 },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({ status: 'vetoed', transactionStatus: 'terminal' });
      expect(executed).toBe(false);

      const attemptRows = await client.query(
        'SELECT * FROM attempts WHERE transaction_id = $1',
        [transactionId],
      );
      expect(attemptRows.rows).toHaveLength(0);

      const txnRows = await client.query('SELECT status FROM transactions WHERE id = $1', [
        transactionId,
      ]);
      expect(txnRows.rows).toEqual([{ status: 'terminal' }]);

      const after = await fetchChain(client as TransactionClient);
      expect(after.ok).toBe(true);
      if (!after.ok) return;

      const newRows = after.value.slice(before.value.length);
      expect(newRows.map((row) => (row.payload as { kind: string }).kind)).toEqual([
        'guardrail_veto',
        'transaction_closed',
      ]);

      const verification = verifyChain(newRows, startingPrevHash);
      expect(verification).toEqual({ ok: true, rowsVerified: newRows.length });
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
