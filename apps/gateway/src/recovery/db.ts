/**
 * Small writes the recovery state machine needs on `decisions` and
 * `transactions`, alongside what idempotency-store.ts already covers for
 * `attempts`. Same shape as that module: typed Queryable, no throws,
 * Postgres errors become typed Failures.
 */
import { err, ok } from '@revenant/contracts';
import type {
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
