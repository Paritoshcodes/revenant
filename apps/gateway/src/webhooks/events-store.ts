/**
 * Records a webhook delivery for deduplication and later inspection.
 *
 * Duplicate delivery is expected by design (docs/API-BEHAVIOUR.md section
 * 8), not exceptional: Razorpay retries on a slow or timed-out
 * acknowledgement, and the only stable identity across redeliveries is
 * x-razorpay-event-id. The unique constraint on webhook_events.event_id
 * is the enforcement point, exactly like attempts.idempotency_key: an
 * INSERT ... ON CONFLICT DO NOTHING makes the check atomic instead of a
 * separate SELECT two concurrent deliveries could both pass.
 */
import { err, ok } from '@revenant/contracts';
import type { Failure, Result } from '@revenant/contracts';

/** The slice of pg.Pool this module depends on. Keeps the store unit-testable. */
export interface Queryable {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export type RecordWebhookEventOutcome = 'recorded' | 'duplicate';

const toFailure = (cause: unknown, context: string): Failure => ({
  kind: 'internal',
  message: `${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
  cause,
});

export interface RecordWebhookEventInput {
  readonly eventId: string;
  readonly eventType: string;
  /** The full verified envelope, stored verbatim. */
  readonly payload: unknown;
}

export const recordWebhookEvent = async (
  db: Queryable,
  input: RecordWebhookEventInput,
): Promise<Result<RecordWebhookEventOutcome>> => {
  try {
    const result = await db.query(
      `INSERT INTO webhook_events (event_id, event_type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [input.eventId, input.eventType, JSON.stringify(input.payload)],
    );
    return ok(result.rows.length > 0 ? 'recorded' : 'duplicate');
  } catch (cause) {
    return err(toFailure(cause, `recordWebhookEvent ${input.eventId}`));
  }
};
