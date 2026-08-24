# Decisions log

Append only. Each entry: date, decision, reason. Never rewrite history.

## 2026-08-24 Razorpay test-mode capability findings

**Subscriptions / e-mandate are out of Layer 1.**
`GET /plans` returns `{"error":"Unauthorized"}` while all other endpoints
authenticate fine, so the Subscriptions product is not enabled on the account.
E-mandate lives in the synthetic layer only. Not revisiting.

**S2S is unavailable.** Server-side payment creation requires Razorpay to
enable it per account. Payments must originate from a browser. Batch
generation therefore goes through Payment Links plus Playwright.

**Idempotency is ours to own.** Two identical `POST /orders` with the same
`receipt` created two distinct orders. `POST /payment_links` rejects a
duplicate `reference_id`. Same account, opposite semantics on two endpoints.
We enforce idempotency in our own store before any outbound call.

**The API rate limits writes.** Roughly 5 payment-link creates before HTTP
429; needed ~40s backoff to clear. The gateway service needs a throttle and
exponential backoff. A 50-attempt batch cannot be fired in a tight loop.

**The documented decline taxonomy does not reproduce in test mode.**
Razorpay documents nine `error_reason` values via error-simulation cards.
Tested `gateway_technical_error` (4100 2800 0002 0007) and
`card_number_invalid` (4100 2800 0001 0008) through both the hosted Payment
Links page and checkout.js. Both collapsed to the same triple:

    payment_failed | gateway | payment_authorization

The mock bank page's Failure button appears to emit a generic gateway failure
that overrides the card's intended simulation. Confirmed across three
payments and two different frontends. Not chasing further.

Real observed taxonomy is two classes:

| error_reason                         | source   | step                 |
|--------------------------------------|----------|----------------------|
| payment_failed                       | gateway  | payment_authorization|
| international_transaction_not_allowed| business | payment_initiation   |

Consequence: the nine-way taxonomy moves to the synthetic population in
Layer 2, sourced from Razorpay's published error documentation. Layer 1
proves the mechanism on the two real classes. This must be stated plainly
in the README and the pitch, never papered over.

**`acquirer_data.auth_code` is the reached-the-acquirer signal.** Populated
on the captured payment (112693), null on every failure. More reliable than
string-matching `error_step`.

**Failure is a retry surface, not a terminal state.** After a failed attempt
the checkout shows `[data-testid="retry-surface"]` which re-exposes
`[data-testid="card"]`. One payment link therefore supports multiple
attempts, each creating a separate payment record. The agent's retry action
drives a real retry, not a simulated one.

## 2026-08-24 Scaffold decisions

**Contracts are canonical JSON, not generated code.** The policy grid and
decline taxonomy live in `packages/contracts/data/*.json`. The TypeScript
package and the Python package both read those files; neither owns the data
and there is no codegen step to forget to rerun. Alternative considered and
rejected: TS as source of truth with a generator emitting a Python module.

**`observed_in_test_mode` is stored, never inferred.** Exactly two entries in
`decline-taxonomy.json` are true, `payment_failed` and
`international_transaction_not_allowed`. Every other reason is false and
exists only in the Layer 2 synthetic population. Reading the flag is what
stops a synthetic figure ever being labelled OBSERVED, so it is data on the
row rather than a rule applied at read time.

**`attempts.error_code` added to the schema.** Not in the original table list
in ARCHITECTURE.md. Both real failures returned `BAD_REQUEST_ERROR` while
Razorpay's documentation implies `GATEWAY_ERROR` for
`gateway_technical_error`. The raw field is evidence of that mismatch, so it
is stored verbatim rather than derived from `error_reason`. No new table.

**CHECK constraints instead of Postgres enum types.** Adding a value to `arm`,
`status`, `outcome` or `guardrail_verdict` is then a one-line migration
rather than a type rewrite, and the allowed set stays visible in `\d` output.

**Append-only is enforced by the database, not by convention.** `audit_log`
carries a `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE`
statement trigger, both raising `restrict_violation`. Row-level triggers do
not see TRUNCATE, hence the second one. Hard rule 3 is now a guarantee: a
broken chain can only come from a broken writer, never from a quiet edit.

**Migrations are plain SQL applied with psql.** `apps/gateway/scripts/migrate.mjs`
is a cross-platform wrapper that shells out to `psql` in filename order. No
migration framework: the schema is five tables and the audit table forbids
rewrites, so a tool built around reversible mutations is the wrong shape.

**Playwright is declared but its browsers are not downloaded.** The scaffold
installed with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Run
`npx playwright install chromium` in `apps/gateway` before the browser
driver work starts.
