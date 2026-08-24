/**
 * Audit module vocabulary and the small pieces shared between the writer
 * and the reader.
 */
import type { AuditRow, Failure } from '@revenant/contracts';

/** The slice of a pg connection this module depends on. */
export interface Queryable {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/**
 * A client already checked out of the pool, inside an open transaction (the
 * caller has issued BEGIN and will COMMIT or ROLLBACK). Structurally
 * identical to Queryable; the distinct name exists to flag at the call site
 * that appendAuditEvent must NOT be handed a bare Pool. A Pool's `.query()`
 * acquires a fresh connection and auto-commits per call, which would release
 * the advisory lock taken inside appendAuditEvent before the following
 * statements ran, and two concurrent appends could both read the same
 * prev_hash and each build a row on top of it.
 */
export interface TransactionClient extends Queryable {}

interface RawAuditRow {
  readonly seq: string | number;
  readonly prev_hash: string;
  readonly hash: string;
  readonly payload: unknown;
  readonly created_at: string | Date;
}

/** bigserial arrives as a string over the wire; timestamptz as a Date. */
export const toAuditRow = (row: RawAuditRow): AuditRow => ({
  seq: Number(row.seq),
  prev_hash: row.prev_hash,
  hash: row.hash,
  payload: row.payload,
  created_at:
    row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
});

const pgErrorCode = (cause: unknown): string | undefined =>
  typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code: unknown }).code)
    : undefined;

/**
 * The trigger from migration 0001 rejects UPDATE/DELETE/TRUNCATE with
 * SQLSTATE 23001 (restrict_violation). Surfaced distinctly so a caller can
 * tell "the append-only guard fired" apart from an ordinary connection
 * failure. The message match is a belt-and-braces fallback in case the
 * driver ever surfaces the exception without its code attached.
 */
const RESTRICT_VIOLATION = '23001';
const APPEND_ONLY_MESSAGE = /append only/i;

export const toFailure = (cause: unknown, context: string): Failure => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = pgErrorCode(cause);

  if (code === RESTRICT_VIOLATION || APPEND_ONLY_MESSAGE.test(message)) {
    return { kind: 'validation', message: `${context}: ${message}`, cause };
  }
  return { kind: 'internal', message: `${context}: ${message}`, cause };
};
