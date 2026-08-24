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
