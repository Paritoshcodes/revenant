/**
 * An in-memory fake of the slice of Postgres reconcile.ts depends on:
 * transactions, attempts, and audit_log, dispatched by matching on the SQL
 * text the real queries use. Modelled as actual mutable state rather than a
 * queued list of canned responses, because reconcile.ts's call sequence
 * branches on how many pending attempts there are and how they resolve —
 * a fixed queue would be as brittle as hardcoding the branch order.
 */
import type { TransactionClient } from '../../src/audit/types.js';

export interface FakeTransactionRow {
  id: string;
  rzp_order_id: string | null;
  rzp_payment_link_id: string | null;
  amount_paise: number;
  arm: string;
  status: string;
}

export interface FakeAttemptRow {
  id: number;
  transaction_id: string;
  attempt_number: number;
  idempotency_key: string;
  rzp_payment_id: string | null;
  error_code: string | null;
  error_source: string | null;
  error_step: string | null;
  error_reason: string | null;
  auth_code: string | null;
  outcome: string;
  created_at: string;
}

export interface FakeAuditRow {
  seq: number;
  prev_hash: string;
  hash: string;
  payload: string;
  created_at: string;
}

export interface FakeRecoveryDb extends TransactionClient {
  readonly transactions: Map<string, FakeTransactionRow>;
  readonly attempts: FakeAttemptRow[];
  readonly auditLog: FakeAuditRow[];
}

const GENESIS = '0'.repeat(64);

/** Cheap deterministic stand-in hash, not the real sha256 chain — these tests assert audit event KINDS and fields, not hash correctness (already covered by audit-hash.test.ts and audit-integration.test.ts). */
let hashCounter = 0;
const nextHash = (): string => `h${(hashCounter += 1)}`.padEnd(64, '0');

export const createFakeRecoveryDb = (
  seed: { transactions?: FakeTransactionRow[]; attempts?: FakeAttemptRow[] } = {},
): FakeRecoveryDb => {
  const transactions = new Map<string, FakeTransactionRow>();
  for (const t of seed.transactions ?? []) transactions.set(t.id, t);
  const attempts: FakeAttemptRow[] = [...(seed.attempts ?? [])];
  const auditLog: FakeAuditRow[] = [];

  const db: FakeRecoveryDb = {
    transactions,
    attempts,
    auditLog,
    async query(sql: string, params: readonly unknown[] = []) {
      if (sql.includes('SELECT pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('SELECT hash FROM audit_log')) {
        const last = auditLog[auditLog.length - 1];
        return { rows: last === undefined ? [] : [{ hash: last.hash }], rowCount: last ? 1 : 0 };
      }

      if (sql.includes('INSERT INTO audit_log')) {
        const [prevHash, , payloadJson] = params as [string, string, string];
        const row: FakeAuditRow = {
          seq: auditLog.length + 1,
          prev_hash: prevHash,
          hash: nextHash(),
          payload: payloadJson,
          created_at: new Date().toISOString(),
        };
        auditLog.push(row);
        return { rows: [row], rowCount: 1 };
      }

      if (sql.includes('FROM transactions WHERE id')) {
        const [id] = params as [string];
        const row = transactions.get(id);
        return { rows: row === undefined ? [] : [row], rowCount: row ? 1 : 0 };
      }

      if (sql.includes('UPDATE transactions SET rzp_order_id')) {
        const [id, orderId] = params as [string, string];
        const row = transactions.get(id);
        if (row === undefined) return { rows: [], rowCount: 0 };
        row.rzp_order_id = orderId;
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('UPDATE transactions SET status')) {
        const [id, status] = params as [string, string];
        const row = transactions.get(id);
        if (row === undefined) return { rows: [], rowCount: 0 };
        row.status = status;
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('FROM attempts WHERE transaction_id')) {
        const [transactionId] = params as [string];
        const rows = attempts
          .filter((a) => a.transaction_id === transactionId)
          .sort((a, b) => a.attempt_number - b.attempt_number);
        return { rows, rowCount: rows.length };
      }

      if (sql.includes('UPDATE attempts') && sql.includes('SET outcome')) {
        const [key, outcome, rzpPaymentId, errorCode, errorSource, errorStep, errorReason, authCode] =
          params as [string, string, string | null, string | null, string | null, string | null, string | null, string | null];
        const row = attempts.find((a) => a.idempotency_key === key);
        if (row === undefined) return { rows: [], rowCount: 0 };
        row.outcome = outcome;
        row.rzp_payment_id = rzpPaymentId ?? row.rzp_payment_id;
        row.error_code = errorCode ?? row.error_code;
        row.error_source = errorSource ?? row.error_source;
        row.error_step = errorStep ?? row.error_step;
        row.error_reason = errorReason ?? row.error_reason;
        row.auth_code = authCode ?? row.auth_code;
        return { rows: [row], rowCount: 1 };
      }

      throw new Error(`fake-recovery-db: unhandled query: ${sql}`);
    },
  };

  return db;
};

export const auditKinds = (db: FakeRecoveryDb): string[] =>
  db.auditLog.map((row) => (JSON.parse(row.payload) as { kind: string }).kind);

export { GENESIS };
