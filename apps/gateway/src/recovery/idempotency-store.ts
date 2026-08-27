/**
 * Idempotency store.
 *
 * The unique constraint on attempts.idempotency_key is the enforcement
 * point, and it is checked BEFORE any outbound Razorpay write, never after
 * (CLAUDE.md hard rule 4, ARCHITECTURE.md data model).
 *
 * Why a reservation row rather than a SELECT:
 *
 *   Razorpay does not deduplicate for us. Two identical POST /orders with
 *   the same receipt created two distinct orders, while POST /payment_links
 *   rejects a duplicate reference_id: opposite semantics on the same account
 *   (docs/DECISIONS.md). A SELECT-then-write check is not atomic, so two
 *   concurrent workers could both see "no row" and both call the API. The
 *   INSERT is the check: whoever loses the race gets no row back and never
 *   makes the call.
 *
 * A reserved row carries outcome 'pending' until it settles. See migration
 * 0002_attempt_pending_outcome.sql.
 *
 * Nothing here throws. Postgres errors become typed Failures.
 */
import { err, ok } from '@revenant/contracts';
import type {
  ErrorSource,
  ErrorStep,
  Failure,
  Result,
  SettledOutcome,
} from '@revenant/contracts';

import { idempotencyKey } from './idempotency-key.js';

/** The slice of pg.Pool we depend on. Keeps the store unit-testable. */
export interface Queryable {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface ReservedAttempt {
  readonly attemptId: number;
  readonly transactionId: string;
  readonly attemptNumber: number;
  readonly idempotencyKey: string;
  readonly outcome: string;
  readonly rzpPaymentId: string | null;
  readonly createdAt: string;
}

export type Reservation =
  /** The caller owns this key and may proceed with the outbound write. */
  | { readonly status: 'reserved'; readonly key: string; readonly attemptId: number }
  /**
   * Someone already holds this key. The caller must NOT call Razorpay.
   * `existing` is the row that won, so the caller can report its outcome.
   */
  | {
      readonly status: 'duplicate';
      readonly key: string;
      readonly existing: ReservedAttempt | null;
    };

/**
 * The driver's own flow (state-machine.ts, right after an attempt executes)
 * and a reconciliation run (reconcile.ts, the realistic response to a
 * webhook or any other out-of-band signal) can both reach a settle for the
 * same attempt if the driver is still mid-flight when reconciliation runs.
 * `settled` means THIS call was the one that moved the row from `pending`
 * to a terminal outcome — the caller should write its own `attempt_settled`
 * audit event. `already_settled` means a racing caller already did that
 * (or this call is a harmless repeat): `attempt` is the row as it now
 * stands, not an error, and the caller must NOT write a second audit event
 * for it. See docs/DECISIONS.md, Build log entry 10.
 */
export type SettleResult =
  | { readonly status: 'settled'; readonly attempt: ReservedAttempt }
  | { readonly status: 'already_settled'; readonly attempt: ReservedAttempt };

export interface SettleInput {
  readonly outcome: SettledOutcome;
  readonly rzpPaymentId?: string | null;
  readonly errorCode?: string | null;
  readonly errorSource?: ErrorSource | null;
  readonly errorStep?: ErrorStep | null;
  readonly errorReason?: string | null;
  readonly authCode?: string | null;
}

export interface IdempotencyStore {
  /**
   * Claims the key for this (transaction, attempt) pair. Call this before
   * any outbound Razorpay write. A 'duplicate' result means do not call.
   */
  reserve(
    transactionId: string,
    attemptNumber: number,
  ): Promise<Result<Reservation>>;
  settle(key: string, input: SettleInput): Promise<Result<SettleResult>>;
  lookup(key: string): Promise<Result<ReservedAttempt | null>>;
}

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

const pgErrorCode = (cause: unknown): string | undefined =>
  typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code: unknown }).code)
    : undefined;

const toFailure = (cause: unknown, context: string): Failure => {
  const code = pgErrorCode(cause);
  const message = cause instanceof Error ? cause.message : String(cause);
  if (code === FOREIGN_KEY_VIOLATION) {
    return {
      kind: 'not_found',
      message: `${context}: transaction does not exist (${message})`,
      cause,
    };
  }
  if (code === CHECK_VIOLATION) {
    return { kind: 'validation', message: `${context}: ${message}`, cause };
  }
  return { kind: 'internal', message: `${context}: ${message}`, cause };
};

interface AttemptRow {
  id: string | number;
  transaction_id: string;
  attempt_number: number;
  idempotency_key: string;
  outcome: string;
  rzp_payment_id: string | null;
  created_at: string | Date;
}

const toReservedAttempt = (row: AttemptRow): ReservedAttempt => ({
  attemptId: Number(row.id),
  transactionId: row.transaction_id,
  attemptNumber: row.attempt_number,
  idempotencyKey: row.idempotency_key,
  outcome: row.outcome,
  rzpPaymentId: row.rzp_payment_id,
  createdAt:
    row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
});

const SELECT_COLUMNS =
  'id, transaction_id, attempt_number, idempotency_key, outcome, rzp_payment_id, created_at';

const SELECT_BY_KEY = `SELECT ${SELECT_COLUMNS} FROM attempts WHERE idempotency_key = $1`;

// ON CONFLICT DO NOTHING turns the collision into a zero-row insert rather
// than an exception, so both paths cost one round trip and neither needs a
// transaction wrapper.
const RESERVE_SQL = `INSERT INTO attempts (transaction_id, attempt_number, idempotency_key, outcome)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`;

// AND outcome = 'pending' is the guard that makes this call-again-safe: a
// racing settle() for the same key (docs/DECISIONS.md, Build log entry 10)
// finds 0 rows here rather than silently overwriting an already-settled
// row, and settle() below turns that into 'already_settled' rather than a
// second success.
const SETTLE_SQL = `UPDATE attempts
        SET outcome        = $2,
            rzp_payment_id = COALESCE($3, rzp_payment_id),
            error_code     = COALESCE($4, error_code),
            error_source   = COALESCE($5, error_source),
            error_step     = COALESCE($6, error_step),
            error_reason   = COALESCE($7, error_reason),
            auth_code      = COALESCE($8, auth_code)
      WHERE idempotency_key = $1 AND outcome = 'pending'
  RETURNING ${SELECT_COLUMNS}`;

export const createIdempotencyStore = (db: Queryable): IdempotencyStore => {
  const lookup = async (key: string): Promise<Result<ReservedAttempt | null>> => {
    try {
      const result = await db.query(SELECT_BY_KEY, [key]);
      const row = result.rows[0] as AttemptRow | undefined;
      return ok(row === undefined ? null : toReservedAttempt(row));
    } catch (cause) {
      return err(toFailure(cause, `lookup ${key}`));
    }
  };

  const asDuplicate = async (key: string): Promise<Result<Reservation>> => {
    const existing = await lookup(key);
    if (!existing.ok) return existing;
    return ok({ status: 'duplicate' as const, key, existing: existing.value });
  };

  return {
    lookup,

    async reserve(transactionId, attemptNumber) {
      let key: string;
      try {
        key = idempotencyKey(transactionId, attemptNumber);
      } catch (cause) {
        return err<Failure>({
          kind: 'validation',
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      }

      try {
        const result = await db.query(RESERVE_SQL, [
          transactionId,
          attemptNumber,
          key,
        ]);
        const inserted = result.rows[0] as { id: string | number } | undefined;
        if (inserted !== undefined) {
          return ok({
            status: 'reserved' as const,
            key,
            attemptId: Number(inserted.id),
          });
        }
        return await asDuplicate(key);
      } catch (cause) {
        // The (transaction_id, attempt_number) unique constraint can still
        // fire when a row was written with a differently shaped key.
        if (pgErrorCode(cause) === UNIQUE_VIOLATION) {
          return await asDuplicate(key);
        }
        return err(toFailure(cause, `reserve ${key}`));
      }
    },

    async settle(key, input) {
      try {
        const result = await db.query(SETTLE_SQL, [
          key,
          input.outcome,
          input.rzpPaymentId ?? null,
          input.errorCode ?? null,
          input.errorSource ?? null,
          input.errorStep ?? null,
          input.errorReason ?? null,
          input.authCode ?? null,
        ]);

        const row = result.rows[0] as AttemptRow | undefined;
        if (row !== undefined) {
          return ok({ status: 'settled' as const, attempt: toReservedAttempt(row) });
        }

        // 0 rows: either no reservation ever held this key, or it did but
        // is no longer 'pending' — most likely a racing caller (the
        // driver's own flow and a reconciliation run can both reach a
        // settle for the same attempt, docs/DECISIONS.md Build log entry
        // 10) already settled it. Distinguish the two rather than
        // assuming failure.
        const existing = await lookup(key);
        if (!existing.ok) return existing;
        if (existing.value === null) {
          return err<Failure>({
            kind: 'not_found',
            message: `settle ${key}: no reserved attempt with that key`,
          });
        }
        // Idempotent, not an error: the fact being recorded (this payment
        // settled) is still true, just already written. The caller must
        // not write a second attempt_settled audit event for it.
        return ok({ status: 'already_settled' as const, attempt: existing.value });
      } catch (cause) {
        return err(toFailure(cause, `settle ${key}`));
      }
    },
  };
};
