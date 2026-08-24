-- 0002_attempt_pending_outcome.sql
--
-- The idempotency store reserves an attempt row BEFORE the outbound Razorpay
-- write, because the unique constraint on attempts.idempotency_key is the
-- enforcement point and a SELECT-then-INSERT would not be atomic. A reserved
-- attempt has no outcome yet, and none of captured / failed / blocked
-- describes it honestly: 'blocked' means a guardrail refused the action.
--
-- So 'pending' joins the set. This is the one-line migration that the
-- CHECK-over-enum-type decision in DECISIONS.md was chosen to make cheap.

BEGIN;

ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_outcome_check;

ALTER TABLE attempts ADD CONSTRAINT attempts_outcome_check
    CHECK (outcome IN ('pending', 'captured', 'failed', 'blocked'));

COMMIT;
