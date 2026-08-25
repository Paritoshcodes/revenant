-- 0003_attempts_error_step_payment_authentication.sql
--
-- A payment abandoned after submit (popup opened, neither bank button
-- clicked) resolves to payment_cancelled | customer | payment_authentication
-- (docs/DECISIONS.md, "Final gap closure"), a real observed error_step
-- distinct from both payment_authorization and authentication. The
-- attempts.error_step CHECK constraint predates that finding and rejects
-- it. Widen it, per the same CHECK-over-enum-type reasoning migration
-- 0002 used for attempts.outcome: a new observed value is then a
-- one-line migration rather than a type rewrite.

BEGIN;

ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_error_step_check;

ALTER TABLE attempts ADD CONSTRAINT attempts_error_step_check
    CHECK (error_step IN ('payment_initiation', 'payment_authorization', 'authentication', 'payment_authentication'));

COMMIT;
