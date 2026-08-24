-- 0001_init.sql
--
-- Five tables, as fixed in docs/ARCHITECTURE.md. Do not add a sixth without
-- an entry in docs/DECISIONS.md.
--
-- Enumerations are CHECK constraints rather than Postgres enum types: a new
-- value is then a one-line migration instead of a type rewrite, and the
-- allowed set stays readable in \d output.

BEGIN;

-- ---------------------------------------------------------------- transactions
CREATE TABLE IF NOT EXISTS transactions (
    id                  text PRIMARY KEY,               -- our id, not Razorpay's
    rzp_order_id        text,
    rzp_payment_link_id text,
    amount_paise        bigint      NOT NULL CHECK (amount_paise > 0),
    arm                 text        NOT NULL CHECK (arm IN ('control', 'treatment')),
    status              text        NOT NULL CHECK (status IN ('open', 'recovered', 'abandoned', 'terminal')),
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transactions_arm_status_idx ON transactions (arm, status);

-- -------------------------------------------------------------------- attempts
-- idempotency_key is the enforcement point. It is checked before any outbound
-- Razorpay write, never after: the gateway does not deduplicate for us, two
-- identical POST /orders create two orders (docs/DECISIONS.md).
--
-- error_code holds Razorpay's raw error_code. Both real failures returned
-- BAD_REQUEST_ERROR where the documentation implies GATEWAY_ERROR for
-- gateway_technical_error. The raw field is evidence of that mismatch, so it
-- is stored rather than derived.
CREATE TABLE IF NOT EXISTS attempts (
    id                  bigserial PRIMARY KEY,
    transaction_id      text        NOT NULL REFERENCES transactions (id),
    attempt_number      int         NOT NULL CHECK (attempt_number >= 1),
    idempotency_key     text        NOT NULL UNIQUE,    -- txn_id || ':' || attempt_number
    rzp_payment_id      text,
    error_code          text,
    error_source        text        CHECK (error_source IN ('gateway', 'bank', 'customer', 'business', 'internal')),
    error_step          text        CHECK (error_step IN ('payment_initiation', 'payment_authorization', 'authentication')),
    error_reason        text,
    auth_code           text,                           -- acquirer_data.auth_code, populated means it reached the bank
    outcome             text        NOT NULL CHECK (outcome IN ('captured', 'failed', 'blocked')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT attempts_txn_attempt_uniq UNIQUE (transaction_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS attempts_transaction_id_idx ON attempts (transaction_id);

-- ------------------------------------------------------------------- decisions
-- One row per policy invocation, including vetoed ones. propensity is logged
-- at decision time because IPS is biased without it and the bias is not
-- identifiable afterwards (docs/EXPERIMENT-PROTOCOL.md).
CREATE TABLE IF NOT EXISTS decisions (
    id                   bigserial PRIMARY KEY,
    transaction_id       text        NOT NULL REFERENCES transactions (id),
    attempt_number       int         NOT NULL CHECK (attempt_number >= 1),
    grid_cell            text        NOT NULL,          -- error_source || '/' || error_step
    recovery_probability numeric     NOT NULL CHECK (recovery_probability >= 0 AND recovery_probability <= 1),
    proposed_action      text        NOT NULL,
    propensity           numeric     NOT NULL CHECK (propensity > 0 AND propensity <= 1),
    guardrail_verdict    text        NOT NULL CHECK (guardrail_verdict IN ('allow', 'veto')),
    guardrail_reason     text,
    diagnosis            text,                          -- LLM output, never authoritative
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT decisions_veto_has_reason CHECK (guardrail_verdict = 'allow' OR guardrail_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS decisions_transaction_id_idx ON decisions (transaction_id);

-- ------------------------------------------------------------------- audit_log
-- Append only, hash chained. hash = sha256(prev_hash || canonical_json(payload)).
-- The genesis row carries prev_hash = 64 zeros and is written at runtime, not
-- seeded here.
CREATE TABLE IF NOT EXISTS audit_log (
    seq        bigserial PRIMARY KEY,
    prev_hash  char(64)    NOT NULL,
    hash       char(64)    NOT NULL UNIQUE,
    payload    jsonb       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at);

-- Hard rule 3 as a database guarantee, not a convention. Any UPDATE or DELETE
-- against audit_log raises, so a broken chain can only come from a broken
-- writer, never from a quiet edit.
CREATE OR REPLACE FUNCTION revenant_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'audit_log is append only: % rejected on seq %',
        TG_OP, OLD.seq
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION revenant_append_only();

-- Row-level triggers do not see TRUNCATE, so it gets its own statement-level
-- guard. Without this, the whole chain is one command away from vanishing.
CREATE OR REPLACE FUNCTION revenant_no_truncate() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append only: TRUNCATE rejected'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION revenant_no_truncate();

-- ------------------------------------------------------------- experiment_runs
-- params_hash pins the run to the frozen parameters in
-- docs/EXPERIMENT-PROTOCOL.md. A changed hash means a different experiment.
CREATE TABLE IF NOT EXISTS experiment_runs (
    id          text PRIMARY KEY,
    seed        bigint      NOT NULL,
    params_hash text        NOT NULL,
    results     jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;
