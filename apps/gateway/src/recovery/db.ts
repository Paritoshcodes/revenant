/**
 * Small writes the recovery state machine needs on `decisions` and
 * `transactions`, alongside what idempotency-store.ts already covers for
 * `attempts`. Same shape as that module: typed Queryable, no throws,
 * Postgres errors become typed Failures.
 */
import { err, ok } from '@revenant/contracts';
import type {
  Arm,
  AttemptOutcome,
  ErrorSource,
  ErrorStep,
  Failure,
  GridCell,
  GuardrailVerdict,
  RecoveryAction,
  Result,
  TransactionStatus,
} from '@revenant/contracts';

import type { Queryable } from './idempotency-store.js';

const toFailure = (cause: unknown, context: string): Failure => ({
  kind: 'internal',
  message: `${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
  cause,
});

export interface InsertDecisionInput {
  readonly transactionId: string;
  readonly attemptNumber: number;
  readonly gridCell: GridCell;
  readonly recoveryProbability: number;
  readonly proposedAction: RecoveryAction;
  readonly propensity: number;
  readonly guardrailVerdict: GuardrailVerdict;
  /** Required by the decisions_veto_has_reason CHECK when verdict is 'veto'. */
  readonly guardrailReason: string | null;
}

/**
 * One row per policy invocation, including vetoed ones
 * (docs/ARCHITECTURE.md, data model). `diagnosis` is omitted from the
 * column list and defaults to NULL: the LLM narrative layer is not built
 * yet.
 */
export const insertDecision = async (
  db: Queryable,
  input: InsertDecisionInput,
): Promise<Result<{ id: number }>> => {
  try {
    const result = await db.query(
      `INSERT INTO decisions
         (transaction_id, attempt_number, grid_cell, recovery_probability,
          proposed_action, propensity, guardrail_verdict, guardrail_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.transactionId,
        input.attemptNumber,
        input.gridCell,
        input.recoveryProbability,
        input.proposedAction,
        input.propensity,
        input.guardrailVerdict,
        input.guardrailReason,
      ],
    );
    const row = result.rows[0] as { id: string | number } | undefined;
    if (row === undefined) {
      return err<Failure>({
        kind: 'internal',
        message: 'insertDecision: INSERT ... RETURNING produced no row',
      });
    }
    return ok({ id: Number(row.id) });
  } catch (cause) {
    return err(toFailure(cause, 'insertDecision'));
  }
};

type ClosingStatus = Extract<TransactionStatus, 'recovered' | 'abandoned' | 'terminal'>;

export const closeTransaction = async (
  db: Queryable,
  transactionId: string,
  status: ClosingStatus,
): Promise<Result<void>> => {
  try {
    const result = await db.query('UPDATE transactions SET status = $2 WHERE id = $1', [
      transactionId,
      status,
    ]);
    if (result.rowCount === 0) {
      return err<Failure>({
        kind: 'not_found',
        message: `closeTransaction: no transaction ${transactionId}`,
      });
    }
    return ok(undefined);
  } catch (cause) {
    return err(toFailure(cause, 'closeTransaction'));
  }
};

// -- reconciliation reads/writes --------------------------------------------

export interface TransactionRow {
  readonly id: string;
  readonly rzpOrderId: string | null;
  readonly rzpPaymentLinkId: string | null;
  readonly amountPaise: number;
  readonly arm: Arm;
  readonly status: TransactionStatus;
}

interface RawTransactionRow {
  id: string;
  rzp_order_id: string | null;
  rzp_payment_link_id: string | null;
  amount_paise: string | number;
  arm: string;
  status: string;
}

const toTransactionRow = (row: RawTransactionRow): TransactionRow => ({
  id: row.id,
  rzpOrderId: row.rzp_order_id,
  rzpPaymentLinkId: row.rzp_payment_link_id,
  amountPaise: Number(row.amount_paise),
  arm: row.arm as Arm,
  status: row.status as TransactionStatus,
});

export const fetchTransaction = async (
  db: Queryable,
  transactionId: string,
): Promise<Result<TransactionRow | null>> => {
  try {
    const result = await db.query(
      `SELECT id, rzp_order_id, rzp_payment_link_id, amount_paise, arm, status
         FROM transactions WHERE id = $1`,
      [transactionId],
    );
    const row = result.rows[0] as RawTransactionRow | undefined;
    return ok(row === undefined ? null : toTransactionRow(row));
  } catch (cause) {
    return err(toFailure(cause, `fetchTransaction ${transactionId}`));
  }
};

/**
 * Orders are created at the first attempt, not at link creation
 * (docs/API-BEHAVIOUR.md section 2), so `transactions.rzp_order_id` can
 * still be null for a transaction that has already attempted once. This
 * persists it once discovered, so later reconciliation runs do not need to
 * re-fetch the payment link just to learn its order id again.
 */
export const setTransactionOrderId = async (
  db: Queryable,
  transactionId: string,
  orderId: string,
): Promise<Result<void>> => {
  try {
    const result = await db.query(
      'UPDATE transactions SET rzp_order_id = $2 WHERE id = $1',
      [transactionId, orderId],
    );
    if (result.rowCount === 0) {
      return err<Failure>({
        kind: 'not_found',
        message: `setTransactionOrderId: no transaction ${transactionId}`,
      });
    }
    return ok(undefined);
  } catch (cause) {
    return err(toFailure(cause, `setTransactionOrderId ${transactionId}`));
  }
};

export interface AttemptRow {
  readonly id: number;
  readonly transactionId: string;
  readonly attemptNumber: number;
  readonly idempotencyKey: string;
  readonly rzpPaymentId: string | null;
  readonly errorSource: ErrorSource | null;
  readonly errorStep: ErrorStep | null;
  readonly outcome: AttemptOutcome;
  readonly createdAt: string;
}

interface RawAttemptRow {
  id: string | number;
  transaction_id: string;
  attempt_number: number;
  idempotency_key: string;
  rzp_payment_id: string | null;
  error_source: string | null;
  error_step: string | null;
  outcome: string;
  created_at: string | Date;
}

const toAttemptRow = (row: RawAttemptRow): AttemptRow => ({
  id: Number(row.id),
  transactionId: row.transaction_id,
  attemptNumber: row.attempt_number,
  idempotencyKey: row.idempotency_key,
  rzpPaymentId: row.rzp_payment_id,
  errorSource: row.error_source as ErrorSource | null,
  errorStep: row.error_step as ErrorStep | null,
  outcome: row.outcome as AttemptOutcome,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
});

/** Oldest first: attempt_number ascending is the same order the attempts actually happened in. */
export const listAttempts = async (
  db: Queryable,
  transactionId: string,
): Promise<Result<readonly AttemptRow[]>> => {
  try {
    const result = await db.query(
      `SELECT id, transaction_id, attempt_number, idempotency_key, rzp_payment_id,
              error_source, error_step, outcome, created_at
         FROM attempts WHERE transaction_id = $1 ORDER BY attempt_number ASC`,
      [transactionId],
    );
    return ok((result.rows as RawAttemptRow[]).map(toAttemptRow));
  } catch (cause) {
    return err(toFailure(cause, `listAttempts ${transactionId}`));
  }
};
