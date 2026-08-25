-- 0004_webhook_events.sql
--
-- Sixth table. Logged here per CLAUDE.md ("Postgres. Five tables. Do not
-- add more without logging it in DECISIONS.md") -- see docs/DECISIONS.md.
--
-- Duplicate webhook delivery is expected by design
-- (docs/API-BEHAVIOUR.md section 8): Razorpay retries on a slow or
-- timed-out acknowledgement, and the only stable identity across
-- redeliveries is x-razorpay-event-id. The unique constraint here is the
-- enforcement point, exactly like attempts.idempotency_key: an
-- INSERT ... ON CONFLICT DO NOTHING makes the dedup check atomic instead
-- of a racy SELECT-then-insert.
--
-- payload stores the full verified envelope verbatim, including
-- payment.downtime.* events, which report a bank or method as currently
-- degraded and are a policy input for delaying retries, not noise to
-- discard.

BEGIN;

CREATE TABLE IF NOT EXISTS webhook_events (
    id          bigserial PRIMARY KEY,
    event_id    text        NOT NULL UNIQUE,   -- x-razorpay-event-id
    event_type  text        NOT NULL,          -- e.g. payment.captured
    payload     jsonb       NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_events_event_type_idx ON webhook_events (event_type);

COMMIT;
