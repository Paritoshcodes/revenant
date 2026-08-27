# Architecture

Revenant executes bounded recovery actions on failed payments and measures
whether those actions caused incremental recovery.

## Three evidence layers

Each layer answers a different question. Never blend their numbers.

**Layer 1, real execution.** Razorpay test mode. Real orders, payment links,
browser-driven attempts, real retries through the checkout retry surface,
real idempotency, real rate-limit backoff, hash-chained audit log.
Answers: can this system actually touch money correctly?
Reports: OBSERVED recovery, small N, real API outcomes.

**Layer 2, the controlled experiment.** Synthetic population with a
published generative model. Stratified randomization, baseline policy vs
agent policy, bootstrap CI on incremental recovered value, plus a
calibration check proving the estimator recovers a known true lift.
Answers: does the policy add value, and is our measurement instrument sound?
Reports: ESTIMATED incremental recovery with confidence bounds.

**Layer 3, off-policy estimation.** IPS and doubly-robust over the logged
stochastic policy. Secondary, clearly labelled. Cut if behind schedule.

## Services

    apps/gateway/     Node 20 + Express + TypeScript
                      Razorpay client, throttle, backoff, idempotency store,
                      recovery state machine, guardrails, audit chain,
                      Playwright driver
    apps/engine/      Python 3.11 + FastAPI
                      recovery probability model, policy function,
                      LLM diagnosis and messaging, synthetic generator,
                      estimators and calibration
    apps/dashboard/   React + Vite
    packages/contracts/  shared types, decline taxonomy, event schema

Three services. No more. No Kubernetes, no message broker, no agent framework.

## The policy grid

The policy switches on `(error_source, error_step)`, not on `error_reason`
strings. An unseen reason still lands somewhere on the grid.

| source   | step                  | class      | action                    |
|----------|-----------------------|------------|---------------------------|
| gateway  | payment_authorization | transient  | retry with backoff        |
| gateway  | authentication        | transient  | retry, prompt alternate   |
| bank     | payment_authorization | soft       | retry on timing window    |
| customer | payment_authorization | customer   | nudge, do not auto-retry  |
| business | payment_initiation    | terminal   | never retry               |
| internal | any                   | transient  | retry with backoff        |

Only rows 1 and 5 are observable in test mode (see DECISIONS.md). The rest
are exercised in the synthetic layer.

`acquirer_data.auth_code` is the reached-the-acquirer signal: populated means
the transaction got to the bank, null means it did not.

## Where the AI sits

The LLM never decides whether money moves.

- LLM: structured diagnosis from messy failure context, customer-facing
  message drafting, human-readable audit narrative.
- Learned model (logistic regression): recovery probability from source,
  step, amount band, hour, attempt number, card network and type.
- Policy function: deterministic, inspectable, switches on the grid and the
  probability estimate. This is what decides.
- Guardrails: pure functions, no I/O, can veto the policy. Fully unit tested.

## Guardrails

    max 3 attempts per transaction
    terminal grid rows never retried
    exponential backoff between attempts
    global circuit breaker on batch error rate
    outbound throttle honouring the observed 429 limit

Every veto is written to the audit log as a first-class event. The demo must
show a guardrail refusing an action the policy proposed.

## Audit chain

Append-only table. Each row stores `prev_hash` and
`hash = sha256(prev_hash + canonical_json(payload))`. Any edit breaks the
chain and the verifier reports the first broken row.

Every row: timestamp, transaction id, attempt number, grid cell, diagnosis,
proposed action, guardrail verdict, idempotency key, Razorpay request and
response ids, arm (control or treatment), outcome.

## Data model

Postgres. Five tables. Do not add more without logging it in DECISIONS.md.

    transactions
      id                  text primary key      our id, not Razorpay's
      rzp_order_id        text
      rzp_payment_link_id text
      amount_paise        bigint
      arm                 text                  control | treatment
      status              text                  open | recovered | abandoned | terminal
      created_at          timestamptz

    attempts
      id                  bigserial primary key
      transaction_id      text references transactions
      attempt_number      int
      idempotency_key     text unique           txn_id + ':' + attempt_number
      rzp_payment_id      text
      error_source        text
      error_step          text
      error_reason        text
      auth_code           text
      outcome             text                  pending | captured | failed | blocked
      created_at          timestamptz

    decisions
      id                  bigserial primary key
      transaction_id      text references transactions
      attempt_number      int
      grid_cell           text                  source/step pair
      recovery_probability numeric
      proposed_action     text
      propensity          numeric               logged for OPE, see protocol
      guardrail_verdict   text                  allow | veto
      guardrail_reason    text
      diagnosis           text                  LLM output, never authoritative
      created_at          timestamptz

    audit_log
      seq                 bigserial primary key
      prev_hash           text
      hash                text
      payload             jsonb
      created_at          timestamptz

    experiment_runs
      id                  text primary key
      seed                bigint
      params_hash         text                  hash of EXPERIMENT-PROTOCOL params
      results             jsonb
      created_at          timestamptz

`idempotency_key` unique constraint is the enforcement point. Check it before
any outbound Razorpay write, never after.

`attempts.outcome = pending` means reserved but unresolved: the row was
written before the outbound call and no result has come back yet. It is not
`blocked`, which means a guardrail refused the action.

A `pending` attempt older than the reconciliation threshold is resolved by
fetching the payment from Razorpay, never by assuming it failed.

`audit_log.hash` = sha256(prev_hash + canonical_json(payload)). Genesis row
has prev_hash = 64 zeros.

## Regression suite

`apps/gateway/tests/` is three tiers, each with its own vitest config and
npm script. A missing prerequisite for the db or live tier is always a
**failing** test with an actionable message, never a silent skip — a
silently skipped test is worse than no test.

    tests/unit/   requires nothing              npm test        (fast, the default)
    tests/db/     requires DATABASE_URL          npm run test:db
    tests/live/   requires RUN_LIVE_TESTS=1,      RUN_LIVE_TESTS=1 npm run test:live
                  live Razorpay creds, Playwright,
                  and (webhook-delivery only) a
                  reachable public tunnel

`npm run test:all` runs all three in order, stopping at the first failure.

**tests/unit/** — pure, no I/O, no network, no database. Every guardrail,
the hash chain verifier, the estimators, the backoff/retry policy. Run on
every change.

**tests/db/** — a live Postgres. Every file rolls back its own transaction
and leaves zero rows behind, with one deliberate exception:
`audit-concurrency.test.ts` proves `appendAuditEvent`'s advisory lock
serialises genuinely separate connections, which needs each connection to
really commit for the others to see its row — and `audit_log`'s
append-only trigger means those rows can never be deleted afterward either.
Small (5 rows) and tagged, documented in the file itself. A second file,
`idempotency-concurrency.test.ts`, and `settle-race.test.ts` /
`reconcile-race.test.ts`'s concurrent cases similarly need a real committed
winner to prove "exactly one succeeds" against a real unique constraint or
a real racing settle — those clean up explicitly (`DELETE`, verified by a
zero-row follow-up `SELECT`) since `attempts`/`transactions` carry no
append-only trigger. Run before merging anything touching `src/recovery`
or `src/audit`.

**tests/live/** — live Razorpay test mode and a real Playwright browser.
`checkout-outcome.live.test.ts` compares the driver's reported outcome
against Razorpay's own recorded payment status for a first attempt, a
success, and a same-session fail-then-retry sequence — the one test that
checks the driver against Razorpay itself rather than a fixture.
`webhook-delivery.live.test.ts` additionally needs the public tunnel
(`WEBHOOK_PUBLIC_URL`) actually reachable: it starts the gateway and a
zrok share itself if neither is already running (reusing either one it
finds already up), releasing a stale share left over from a prior session
the same way `scripts/webhooks-up.mts` does, and fails loudly if the
tunnel never comes up rather than skipping. Real browser-driven test-mode
payments and real network calls to Razorpay and zrok mean this tier is
occasionally flaky for reasons outside the code's control (a slow popup
navigation, a transient connection timeout) — that is a property of
testing against real third-party infrastructure, the same lesson
DECISIONS.md's build log draws from nine driver bugs found only by live
runs, not a reason to add a retry that could mask a real regression. Run
before a demo, or after touching `src/browser` or `src/webhooks`.

**New features add their test to the tier matching what they touch.** Pure
logic goes in `tests/unit/`. Anything that reads or writes Postgres goes in
`tests/db/`. Anything that drives a real browser or calls the real Razorpay
API goes in `tests/live/`.

**A sharp edge this suite closed, not just documented:** `settle()`
(idempotency-store.ts) and `closeTransaction()` (recovery/db.ts) used to
have no guard against being called twice for the same attempt or
transaction — a real risk once anything besides the driver's own flow
(reconciliation, most plausibly triggered by a webhook) can reach a settle
for the same attempt. Both now return a discriminated result
(`settled`/`already_settled`, `closed`/`already_closed`) so a racing
caller finds out it was the loser rather than silently double-writing an
`attempt_settled` or `transaction_closed` audit event. See
docs/DECISIONS.md, Build log entry 10, and
`tests/db/settle-race.test.ts` / `tests/db/reconcile-race.test.ts`.
