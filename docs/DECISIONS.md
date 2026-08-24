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

## 2026-08-24 Scaffold verification and a Windows env gotcha

**Append-only guarantee verified against a real database.** PostgreSQL 18.6,
migration applied, then all four cases exercised:

    INSERT   -> succeeded
    UPDATE   -> ERROR: audit_log is append only: UPDATE rejected on seq 1
    DELETE   -> ERROR: audit_log is append only: DELETE rejected on seq 1
    TRUNCATE -> ERROR: audit_log is append only: TRUNCATE rejected

Both the row-level trigger (revenant_append_only) and the statement-level
TRUNCATE trigger (revenant_no_truncate) fire correctly. Hard rule 3 is a
database guarantee, not a convention. This is demo material: showing Postgres
refuse a tamper attempt live is stronger than asserting tamper-evidence.

**`.env` is not found by npm workspace scripts.** `.env` lives at the repo
root, but npm runs workspace scripts with cwd set to the workspace directory
(e.g. apps/gateway), so `import 'dotenv/config'` looks in the wrong place and
silently finds nothing. Fixed in `scripts/migrate.mjs` by resolving the path
explicitly relative to the script location:

    loadEnv({ path: join(here, '..', '..', '..', '.env') })

Apply the same pattern anywhere else env is loaded, including
`apps/gateway/src/config.ts` and the engine. Do not create a second `.env`
inside a workspace; two copies will drift.

Related: `$DATABASE_URL` in the shell is separate from `.env`, which only
Node reads. Shell exports live in `~/.bashrc`.

**Password percent-encoding.** A password containing `@` breaks the
connection URL and must be encoded (`@` -> `%40`). Prefer alphanumeric
passwords for local development.

## 2026-08-24 Razorpay client and idempotency store

**Writes are never retried on a network error. Only on 429.**
Razorpay does not deduplicate for us, so a write that failed with a timeout
or a connection reset is unresolvable: we cannot tell whether it reached the
API and created an order. Retrying it risks a second order, which is the
exact failure the idempotency work exists to prevent. A 429 is different, as
a rate-limited request was rejected before doing any work, so replaying it is
safe. Reads retry on network, 5xx and 429 alike. Encoded in
`isRetryable(kind, isWrite)` in `src/razorpay/backoff.ts` and unit tested.

**Backoff treats the exponential term as a floor, not a mean.** The common
"full jitter" formula picks uniformly in `[0, delay]`, which for a 429 could
choose a 2-second wait. We observed that clearing a 429 needed about 40
seconds, so 2 seconds is known-wrong. The delay is therefore
`min(maxMs, base * 2^(n-1)) + random() * jitterMs`: the observed recovery
time is a hard minimum and jitter only adds. First retry on 429 waits 40s.
A server-sent `Retry-After` wins when it asks for longer.

**The write throttle is a sliding window, not a token bucket.** A token
bucket was written first, sized capacity 4 with one token per 10s. It failed
its own test: the bucket refills while the burst is draining, so 7 writes
landed inside one 40-second window against an observed limit of about 5. The
general form is unavoidable, a bucket admits `capacity + window/refill` in
any window. Replaced with an explicit sliding window: at most 4 writes per
40s, plus 4s minimum spacing, which states the observed constraint directly
and can be asserted against it. A 50-write batch now spans about 8 minutes,
which is the intended shape.

**`attempts.outcome` gains `pending`, via migration 0002.** The idempotency
store reserves the attempt row before the outbound call, because the unique
constraint on `idempotency_key` is only an enforcement point if the INSERT
is the check. A SELECT-then-write is not atomic and two workers could both
see no row. A reserved attempt has no outcome yet, and `blocked` already
means a guardrail refused the action, so reusing it would corrupt the
guardrail metric. This is the one-line migration that choosing CHECK
constraints over enum types was meant to make cheap.

**Reservation uses `ON CONFLICT (idempotency_key) DO NOTHING`.** A zero-row
insert signals the duplicate, so the collision path costs one round trip and
no exception handling. The 23505 branch is still kept, since the composite
`(transaction_id, attempt_number)` constraint can fire for a row written with
a differently shaped key.

Verified against the live database, not only the fakes: reserve returned
`reserved` then `duplicate` for the same key, settle wrote the raw
`BAD_REQUEST_ERROR` alongside the taxonomy triple, settling an unreserved key
gave `not_found`, and reserving against a nonexistent transaction gave
`not_found` from the foreign key. Test rows removed afterwards.

**`PSQL_BIN` escape hatch in the migrate runner.** psql is not on PATH in a
default Windows install. `PSQL_BIN` overrides the lookup, and the error
message now names the fix instead of just reporting ENOENT.

## 2026-08-24 Guardrail layer

**The two arms do not share a guardrail config.** EXPERIMENT-PROTOCOL.md
freezes the control arm as "retry immediately, up to 3 attempts, no grid
awareness". The agent's 60s attempt spacing applied to the baseline would
make the baseline something other than the protocol says it is, and the
measured lift would then be partly an artefact of our own configuration.
`CONTROL_ARM_GUARDRAIL_CONFIG` therefore sets `attemptSpacing.baseMs = 0`.
The attempt cap and the circuit breaker still apply to both arms: those are
safety bounds on real money, not part of the policy under measurement.

**Attempt spacing is not the outbound throttle.** The throttle in
`src/razorpay/throttle.ts` protects Razorpay's rate limit across every
transaction in a batch. The `minimum_backoff` guardrail protects one
customer's card from repeated presentment. They constrain different things
and share no configuration. Spacing starts at 60s and doubles, capped at 15
minutes.

**Spacing has no jitter.** The backoff on the Razorpay client jitters to
decorrelate concurrent callers. A guardrail must not: one that sometimes
allows and sometimes refuses identical inputs cannot be replayed from the
audit log or asserted in a test.

**`max_attempts` and `per_transaction_cap` are separate rules.**
ARCHITECTURE.md lists both. Read as one rule they are redundant, so they are
implemented as the global bound every transaction shares, and an optional
override for a single transaction. The override can only tighten: a
per-transaction cap looser than the global bound is clamped, so a
transaction can never buy itself a fourth attempt.

**An unmapped grid cell is vetoed, not allowed.** `lookupGridRow` returning
undefined means the failure landed somewhere the policy grid does not
describe. Absence of a terminal marking is not evidence of safety, so the
guardrail fails closed and the taxonomy gains a row instead.

**Guardrails restrain money actions, not messages.** `nudge_no_auto_retry`
and `never_retry` do not re-present the payment, so the terminal, cap and
spacing rules pass them through. Only the three retry actions are bounded.

**No guardrail short-circuits.** All five run on every evaluation and all
five decisions are recorded, so the audit log shows what the whole layer
thought rather than whichever rule happened to object first. The composed
verdict is a logical AND over the allows, and the output is sorted by
`GUARDRAIL_ORDER` rather than by evaluation order, which is what makes the
result order-independent. Asserted directly: every rotation of the guardrail
list produces an identical verdict, reason string and decision array.

## 2026-08-24 Guardrail layer, per_transaction_cap removed

**`per_transaction_cap` deleted.** It was redundant with `max_attempts`:
nothing in the codebase ever set `GuardrailContext.perTransactionCap`, so the
guardrail always took its `allow, no per-transaction cap set` branch and the
override path was dead from the day it was written. `max_attempts` already
is the per-transaction bound; there is no second, stricter cap anything
applies. Removed the guardrail, its field on `GuardrailContext`, its entry in
`GuardrailId` and `GUARDRAIL_ORDER`, and the corresponding line in
ARCHITECTURE.md's guardrail list, which had listed "max 3 attempts per
transaction" and "per-transaction attempt cap" as if they were two rules.
If a future policy needs a stricter bound on one transaction, the cleaner
shape is to have the caller pass a smaller `maxAttempts` into
`evaluateGuardrails`'s config for that call, not a second guardrail.

## 2026-08-24 Audit chain

**`appendAuditEvent` does not call BEGIN or COMMIT.** It takes a
transaction-scoped advisory lock (`pg_advisory_xact_lock`) around "read the
last hash, then insert on top of it", so two concurrent appends cannot both
read the same prev_hash. That lock is only meaningful if the caller already
has an open transaction: on a bare `Pool`, every `.query()` call gets its
own connection and auto-commits, so the lock would be released before the
next statement ran and the race would be back. The function is typed to take
a `TransactionClient`, not `Queryable`, to flag this at the call site. In
real use an audit write is normally one of several writes inside a larger
transaction (for example, alongside settling the attempt row), so the writer
has to join that transaction rather than own one.

**Canonical JSON sorts keys at every level, including inside arrays.**
Postgres's `jsonb` does not preserve object key order on storage, so a row
read back after an INSERT can have its keys in a different order than when
it was hashed. Sorting recursively on every serialization, both at write
time and at verify time, means the hash is reproducible regardless of what
order jsonb happens to return. `canonicalJson` throws rather than silently
mishandling `undefined`, `NaN`/`Infinity`, and `Date` (which would otherwise
serialize as `{}`, since `Date` has no own enumerable properties).

**The verifier is a pure function over an array of rows.** `verifyChain`
takes no database handle; a thin `fetchChain` + `verifyChainInDb` in
`reader.ts` supply rows from Postgres when needed. This is what makes the
tampered-chain cases unit-testable without a database: two independent
failure modes are checked per row — `prev_hash` not matching the previous
row's `hash` (the chain was cut, reordered, or a row is missing), and `hash`
not matching `sha256(prev_hash + canonical_json(payload))` (the payload or
the hash itself was altered). It reports the seq of the first broken row,
per ARCHITECTURE.md, and accepts an optional starting hash so a caller can
resume verification from a checkpoint instead of true genesis.

**The integration test runs inside a transaction that is always rolled
back.** `audit_log`'s append-only triggers reject DELETE as well as UPDATE
and TRUNCATE (verified in the scaffold session), so any row this test
committed would be permanent. Wrapping the whole test in BEGIN/ROLLBACK
exercises the real advisory lock, the real jsonb round trip, and the real
bigserial sequence, while leaving zero trace: confirmed by counting
`audit_log` and `transactions` after the run. Verification is scoped to only
the rows the test wrote, resuming from the chain's tail at the start of the
test rather than assuming the table starts empty or that any pre-existing
rows are valid — this test does not own or audit the rest of the table's
history. A second integration case reproduces the append-only guarantee
directly (INSERT then UPDATE, expect rejection) inside its own rolled-back
transaction, so the property the whole design depends on is asserted here
too, not only recorded as a manual finding.

