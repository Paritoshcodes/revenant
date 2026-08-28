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


## Build log: design errors caught by tests, not by review

Keep this list current. It is Build Quality evidence for the README and the
pitch: the tests caught logic errors that would have moved money
incorrectly, which is a stronger claim than a passing badge.

**1. Token bucket admitted more writes than the observed rate limit.**
The first throttle was a token bucket (capacity 4, one token per 10s). Its
own test failed: the bucket refills while the burst drains, so 7 writes
landed inside a 40s window against an observed limit near 5. The flaw is
general, a bucket admits `capacity + window/refill` in any window. Replaced
with an explicit sliding window (4 writes per 40s, 4s minimum spacing).
Consequence had it shipped: rate-limit failures mid-batch.

**2. "Guardrail allowed" did not mean "make an attempt".**
The `terminal_grid_cell` guardrail only vetoes when the proposed action is
itself a retry. When the policy correctly proposes `never_retry` on a
terminal cell there is nothing to refuse, so the guardrail allows it. The
state machine had assumed allowed implies attempt, so it would have fired an
outbound Razorpay call on exactly the transactions that must never be
retried, slipping underneath the layer built to prevent that. Fixed by
deriving closure from the action itself (`requiresAttempt`) rather than from
the absence of a veto.

**3. `Promise.race` on the two outcome probes would reject spuriously.**
Outcome detection races `div.Payment-Completed` against
`[data-testid="retry-surface"]`. A real `Promise.race` rejects as soon as
the losing selector times out, even though the winning one had already
resolved correctly. Replaced with non-rejecting probes.

**4. Sixteen passing driver tests missed all four DOM bugs.** The first
`src/browser/` driver queried the top-level page instead of
`iframe.razorpay-checkout-frame`, waited for popup load instead of the
mocksharp navigation, keyed success on `div.Payment-Completed` (which does
not exist anywhere), and assumed the card fields existed before the card
method was clicked. It shipped with 16 passing unit tests, and every one of
them passed regardless, because the structural `PageLike`/`LocatorLike`
fakes answered every query on every document and every URL
unconditionally — they modelled what the driver assumed, not what the page
actually does. Code review missed it too. Only a headed run against a real
browser (docs/CHECKOUT-FLOW.md, CORRECTION and VERIFIED sections) surfaced
the actual DOM shape. Rebuilt the fakes to enforce the frame boundary
(`frameLocator` on the wrong selector returns a locator that rejects every
call), the popup's staged URL (the bank button rejects until `waitForURL`
resolves the mocksharp navigation), and staged element availability (the
card fields reject until the card method is clicked, the method list
rejects until contact is filled), so a regression to any of the four bugs
now fails the suite instead of only a live run.

**5. A second live run found a further five bugs, all missed by the first rebuild's own tests.**
The driver rebuilt against the CORRECTION/VERIFIED sections of
CHECKOUT-FLOW.md (entry 4) still shipped with five more assumptions a
fuller live run, success and failure paths and a fail-then-retry
sequence, disproved:

  1. It captured no payment id at all. The popup's initial URL
     (`/v1/payments/<id>/authenticate`) is the only reliable source, and
     `popup.url()` loses it once the popup has navigated on to mocksharp
     — a real risk headless, where that navigation can complete before
     the handle is even read.
  2. Outcome detection still keyed on the frame heading's mere existence.
     `[data-testid="payment-status-heading"]` reads "Processing your
     payment" then "Confirming Payment" on the FAILURE path for several
     seconds before the retry surface appears; only its EXACT text,
     "Payment Successful", means anything. On success the frame is torn
     down mid-transition, throwing "Frame was detached" — a success
     signal, not an error, and the driver had no path that tolerated it.
  3. It never checked whether a link was already paid before driving it.
     Re-attempting a paid link risks a phantom attempt against a checkout
     that can no longer accept one.
  4. It never accounted for retained field values on a retry. Card fields
     keep their previous attempt's value in the DOM; a native setter
     would append onto it rather than replace it.
  5. The tokenisation dialog guard was already present but unverified
     against the fact that it is independent of which card is used, only
     of attempt number within the session — worth pinning down explicitly
     rather than leaving as an assumption.

None of the first four were caught by the rebuild's own test suite,
because the fakes still modelled what the driver assumed rather than what
the page does: nothing exercised a captured-id race, nothing modelled the
heading's transient text over time, nothing modelled frame detachment, and
nothing modelled an already-paid link. Rebuilt again: the fixture now
advances outcome state per POLL TICK (driven only by the driver's own
`sleep`, so it moves exactly when the driver actually waits, never on a
wall clock), fires the popup's `/authenticate` request on a real deferred
macrotask so a driver that reads the captured list synchronously gets
nothing, and models frame detachment as a distinct, catchable failure
mode. A dedicated test proves each of the five is now structurally
caught, not merely avoided by the current code happening to be correct.

## 2026-08-24 Playwright driver notes

- `PageLike` / `LocatorLike` structural interfaces rather than importing the
  `playwright` types, matching the existing `Queryable` pattern, so the flow
  logic is unit-testable with plain fakes.
- The popup listener is registered BEFORE the submit click that triggers it.
  Registering after is a race. Asserted by a call-order test.
- The DOM only distinguishes captured from failed. The richer taxonomy
  fields (`error_source`, `error_step`, `auth_code`) belong to the Razorpay
  payment record and are fetched from the API, never inferred from the page.
  Left null in the browser layer rather than guessed.
- `CheckoutSessionProvider` seam: `execute()` receives no link URL, card
  number or target outcome, because choosing those is a batch-orchestration
  decision, not a browser-automation one.

## 2026-08-24 Full live reconnaissance: CHECKOUT-FLOW.md rewritten

Drove both outcome paths and a complete fail-then-retry sequence in a real
browser, confirming every outcome against the payments API. CHECKOUT-FLOW.md
was rewritten from scratch and now supersedes all prior versions.

New facts not previously known, each of which would have caused a bug:

**On success the checkout frame DETACHES.** Polling it across the transition
throws "Frame was detached". That error is a success signal, not a failure.
The terminal marker is `div.Payment-Completed` on the PARENT page. An
earlier correction in this log claimed that element did not exist; it does,
on the parent, after the frame is torn down.

**The popup's initial URL carries the payment ID**
(`/v1/payments/<ID>/authenticate`). This is how a browser attempt is
correlated with its API payment record. Verified twice. Without it the
driver has no way to know which payment it created, which would have made
the contract test impossible to write.

**The tokenisation dialog is conditional, not unconditional.** Present on
attempt 1, absent on the retry in the same session. It is NOT controlled by
the `save` checkbox, which is unchecked by default while the dialog still
appears. Guarding it is required, not defensive.

**Card fields retain values across a retry.** Switching instrument on a
recovery attempt requires clearing them first. `fill()` clears; a native
setter appends.

**The checkout frame is cross-origin.** `contentDocument` from the parent is
null. Reachable only via the frame API.

## Build log entry 5: outcome detection reported captured on a failed payment

`payment-status-heading` exists on the failure path for ~5 seconds reading
"Processing your payment" then "Confirming Payment", clearing at ~6s when
retry-surface appears. The driver waited on its existence, resolved at
~400ms, and reported `captured` for a payment the API recorded as `failed`.

Severity: this is the worst bug so far. A driver reporting every attempt as
recovered makes the recovery figure fiction while the dashboard looks
healthy. It would have invalidated the one number the project exists to
produce.

Found by a live smoke run. 178 tests passed.

## The pattern, stated honestly

Five driver bugs. All five found by running a real browser. Zero found by
the test suite, including the fixture-fidelity block written specifically to
catch bugs one through four.

This is not a failure of the tests. It is a property of testing against a
third party: a hand-built fixture encodes what the author already believes,
so it can only confirm those beliefs. When the belief was wrong the fixture
was wrong identically, and the suite passed with full confidence.

The logic tests remain load-bearing and caught three genuine design errors
(see entries 1 to 3). The division is: unit tests guard known behaviour
against regression; live reconnaissance is the only thing that discovers it.

Mitigation: a contract test that drives one real payment and asserts the
driver's reported outcome equals the API's recorded status. That is the only
test that compares our model against reality rather than against itself.

## 2026-08-24 Open questions closed, and a warning about auto-conclusions

All three remaining unknowns resolved (see CHECKOUT-FLOW.md section 10).

- Abandonment creates NO payment record. Detect via payment_link.status.
- No OTP page exists on this account. OTP-based recovery actions are out.
- One link supports at least 3 attempts (fail, fail, capture, verified).
- A paid link does not offer a payable checkout; it renders
  `.Payment-Completed` on load. Check before attempting.
- Payment id capture from the popup URL is timing-sensitive and must happen
  before the mocksharp navigation.

**Warning worth keeping.** The probe script computed its own `conclusion`
strings and two of four were WRONG:

1. It reported "abandonment DOES create a payment record" because its
   baseline filter held only one prior payment id, so payments from an
   earlier session leaked into the "new" list. The link-scoped fields
   (orderPaymentCount 0, status "created") said the opposite.
2. It reported "a PAID link still opens checkout" because it keyed on the
   iframe element existing. The element is a leftover; `.Payment-Completed`
   was present and the body read "You have successfully paid".

Both would have been believed if the raw fields had not been read. The rule
this establishes: a probe script may COLLECT evidence, it must never
CONCLUDE. Conclusions belong in review, against the raw fields. Any script
that prints a verdict is a script that can lie convincingly.

This is the same failure mode as the test fixtures, one layer up: a tool
that encodes the author's expectation will confirm it.

## 2026-08-24 Final gap closure: a third taxonomy class, and the pending state

Four remaining uncertainties closed by driving a real browser by hand rather
than trusting a script. Full detail in CHECKOUT-FLOW.md section 12.

**A THIRD real taxonomy class exists.** A payment abandoned after submit
resolves to `payment_cancelled | customer | payment_authentication`. The
observed taxonomy is now three classes, not two:

    payment_failed                        gateway   payment_authorization
    payment_cancelled                     customer  payment_authentication
    international_transaction_not_allowed business  payment_initiation

The `customer` row of the policy grid is REAL, not synthetic. It maps to
"nudge, do not auto-retry". Update the grid's
`observable_in_test_mode` flags: that row becomes true, and
decline-taxonomy.json now has THREE entries with
`observed_in_test_mode: true`, not two. Any test asserting exactly two
observed reasons must be updated.

**`status: "created"` is the real-world `pending` state.** While the bank
page sits unanswered the payment is `created` with no error fields, then
transitions to `failed`/`payment_cancelled` within about a minute of the
popup closing. This is direct validation of the `pending` schema decision
and of reconciling stale pending attempts by fetching from Razorpay rather
than assuming failure.

**Two distinct abandonment cases, and only one is visible at /payments.**
Abandoning BEFORE submit creates no payment record at all (detect via
payment_link.status). Abandoning AFTER submit creates one. The earlier note
in this log saying "abandonment is invisible at /payments" was true only of
the before-submit case and is hereby narrowed.

**`.Payment-Completed` on the parent must be the primary success signal.**
The frame heading does reach "Payment Successful", but the window is about
five seconds and a probe caught it with one second remaining before the
frame detached. The parent marker is permanent and raceless. Treat the
heading as an optional early exit only.

Also resolved: the tokenisation dialog is once per session and independent
of the card (present on attempt 1 with card A, absent on attempt 2 with card
B). A paid link's iframe exists but is 0x0 with null offsetParent, so its
presence is not evidence the checkout is usable. The popup has three
observed intermediate states including an `about:blank` "Processing, Please
Wait..." page.

**Method note.** These were found by hand, not by the probe script, and two
of that script's own auto-conclusions had already been shown wrong. The rule
stands: scripts collect evidence, humans conclude.

## 2026-08-24 API and webhook behaviour verified; THROTTLE MUST CHANGE

Full detail in docs/API-BEHAVIOUR.md. Raw evidence in tmp/api-probe.json and
tmp/webhook-events.jsonl.

**The sliding-window throttle is wrong and must be reworked.** It was built
from one observation on /payment_links (~5 writes, ~40s to clear) and applied
globally. Measured reality:

    GET /payments   25 consecutive reads, zero 429s
    POST /orders    7 writes ok, 429 on the 8th, Retry-After: 3
    reads stayed 200 while /orders was limited

So limits are PER ENDPOINT, reads are effectively unthrottled, and Razorpay
returns a `Retry-After` header that must be honoured. A fixed 40s backoff is
about 13x too slow for /orders. Required changes:
  - do not throttle reads
  - throttle writes per endpoint, not one shared window
  - honour Retry-After; keep exponential backoff only as a fallback

Build-log note: the throttle already failed its own test once (entry 1, token
bucket). This is its second correction, and this time from live measurement
rather than reasoning. The lesson is the same one as the fixtures: a limit we
inferred from one endpoint was applied as if it were universal.

**Webhooks work end to end.** payment.failed delivered, HMAC over the raw
body matched, x-razorpay-event-id present. No polling fallback needed. The
webhook payment entity is byte-identical in shape to the REST payment object,
so one contract type covers both and the existing data/samples fixtures are
valid for webhook tests.

**Other confirmed behaviour, each with a design consequence:**

  - Orders are created at FIRST ATTEMPT, not at link creation. Fresh links
    have `order_id: null`; correlation must tolerate that.
  - `payment_link.payments` is ALWAYS EMPTY even when attempts exist. Use
    `GET /orders/<id>/payments` to enumerate attempts. This is the only
    reliable path.
  - `order.attempts` is a free server-side attempt counter. Cross-check the
    max_attempts guardrail against it; divergence means a lost local record.
  - Duplicate `reference_id` on payment links returns 400 with a specific
    description, and its `metadata` is an ARRAY, not an object. Treat this
    400 as "already exists, fetch it", not a hard failure.
  - `count` caps at 100; `skip` works; no cursor.
  - Link cancel works and is the clean way to retire a link. Cancelling an
    already-cancelled or a paid link returns 400 with a terminal-state
    description. Those are expected responses, not retryable errors.
  - Unsigned requests DO reach the webhook endpoint. Signature verification
    is the only defence against forged payment events.

## 2026-08-24 End of reconnaissance. State and next steps.

### Done
Gateway logic complete and tested: Razorpay client, idempotency store,
guardrails, hash-chained audit log, recovery state machine. Postgres
migration verified against a live database including the append-only
triggers. Browser and API surfaces fully characterised from live runs.
Webhooks verified end to end over a stable zrok tunnel.

### Known-incomplete, do not mistake for finished
`src/browser/` was written against an earlier version of CHECKOUT-FLOW.md
and still carries the outcome-detection and payment-id bugs. It is
committed as a checkpoint, not a release. Rebuilding it is the next
substantial task.

### Next four sessions, in order (each depends on the previous)
1. Throttle rework: per-endpoint, honour Retry-After, do not throttle reads.
2. Browser rebuild against CHECKOUT-FLOW.md as specification, plus fixtures
   that model the frame boundary, popup URL sequence, transient heading
   text, and frame detachment.
3. Webhook handler in src/webhooks/, and update decline-taxonomy.json to
   THREE observed classes.
4. Reconciliation (stale pending via API fetch, attempts via
   /orders/<id>/payments, cross-check order.attempts) and the contract test.

Then the Python engine: synthetic generator, randomised holdout, bootstrap
CI, calibration check. That is the part carrying the project's argument and
none of it exists yet.

### Standing lesson from this phase
Five driver bugs, all found by running a real browser, none by 178 passing
tests. Two probe-script auto-conclusions were also wrong. Both failures have
the same shape: a tool that encodes the author's expectation will confirm
it. Scripts collect evidence; conclusions come from reading raw fields.
The contract test exists to keep model and reality aligned from here on.

## Build log entry 6: `textContent()` auto-waits and hangs the failure path

Found by a live smoke run. 206 tests passed.

`pollOutcomeOnce` probed the heading with:

    const headingText = await frame.locator(SELECTORS.paymentStatusHeading).textContent();

Playwright's `textContent()` AUTO-WAITS for the element to exist, using the
default 30s timeout. On the failure path the heading is present for ~5s
("Processing your payment", "Confirming Payment") and then disappears at ~6s
when the retry surface renders. From that moment the call blocks for the
full timeout waiting for an element that will never return, so the
retry-surface check on the next line is never reached and the whole attempt
fails with a TimeoutError.

Check ORDER compounded it: the blocking heading probe sits in front of the
branch that would have resolved.

Fix: every probe inside a poll tick must be non-blocking. Use `count()`
first and only read `textContent()` when the element is known to exist, or
pass a very short per-probe timeout (a few hundred ms) so a missing element
fails the tick rather than the attempt.

Why the fixture missed it: the fake `textContent()` returns immediately for
a missing element. Playwright's does not. The fixture encoded an API
behaviour that differs from the real library, which is a new variant of the
same failure: previously the fixtures mismodelled Razorpay's DOM, here they
mismodelled Playwright itself.

This is the second bug in `pollOutcomeOnce` (see entry 5, resolving on
heading existence). Both were caught by running a browser, neither by tests.

## 2026-08-24 Webhook handler promoted to real source; taxonomy now three classes

**`scripts/webhook-receiver.mts` promoted to `src/webhooks/`.** The probe
script's approach (acknowledge before processing, HMAC over the raw body,
timing-safe compare) was already correct and is now real source, split for
testability: `verify.ts` (signature only), `events-store.ts` (DB dedup and
record), `dispatch.ts` (pure description of one envelope, no ordering
assumptions), `handler.ts` (Express wiring). `handleWebhookRequest` returns
the HTTP response to send and a separate `settled` promise for the
asynchronous work, so the 5-second acknowledgement rule
(docs/API-BEHAVIOUR.md section 8) is provable in a test without mocking
Express request/response objects at all: call it with a Buffer and a fake
db, assert the response is decided before `await`ing `settled`.

**`webhook_events` is a sixth table.** Logged here per CLAUDE.md ("Postgres.
Five tables. Do not add more without logging it in DECISIONS.md"), migration
0004. Duplicate delivery is expected by design, not exceptional: Razorpay
retries on a slow or timed-out ack, and x-razorpay-event-id is the only
stable identity across redeliveries. The unique constraint on `event_id` is
the enforcement point, exactly like `attempts.idempotency_key`: `INSERT ...
ON CONFLICT DO NOTHING` makes the dedup check atomic rather than a racy
SELECT-then-insert. `payment.downtime.*` events are stored here too, not
discarded: they report a bank or method as currently degraded, a policy
input for delaying retries that no dunning product surveyed uses.

**Payment entity reused, not re-typed.** `RzpPayment` in
`src/razorpay/types.ts` already matches the webhook payload's payment
entity byte-for-byte (docs/API-BEHAVIOUR.md section 8), so
`src/webhooks/types.ts` imports it directly rather than defining a second
type. `extractOrder`/`extractPaymentLink` reuse `RzpOrder`/`RzpPaymentLink`
the same way, on the reasonable but NOT independently verified assumption
that Razorpay wraps every entity the same way it was confirmed to wrap
payment. `payment.downtime.*`'s payload key and shape were not observed in
the material this was built against, so it is stored verbatim and never
parsed into a typed entity.

**Middleware order matters for raw-body verification.** The webhook route's
`express.raw({type:'application/json'})` is mounted in `createApp()` BEFORE
the global `express.json()`. A request body stream can only be consumed
once; had the global JSON parser run first, it would have already parsed
and drained the body, leaving nothing for the webhook route's raw-body
middleware to hash. `createApp()` now takes an explicit `AppDeps` (a
`Queryable` db and the webhook secret) instead of being parameterless.

**Decline taxonomy is three observed classes, not two: `payment_cancelled`
moved to a new `payment_authentication` step.** A payment abandoned after
submit (popup opened, neither bank button clicked) resolves to
`payment_cancelled | customer | payment_authentication`
(docs/DECISIONS.md, "Final gap closure", pay_TTf77VQJupE6KI). That step
value is distinct from both `payment_authorization` (the generic
`payment_failed` row) and `authentication` (the gateway/OTP-style row) and
did not previously exist in the `ErrorStep` union, the policy grid, or the
`attempts.error_step` CHECK constraint. Added a `payment_authentication`
grid row (`customer/payment_authentication`, same `nudge_no_auto_retry`
action as its `payment_authorization` sibling), widened the constraint
(migration 0003), and moved `decline-taxonomy.json`'s `payment_cancelled`
entry onto the new grid cell with `observed_in_test_mode: true`. Its
`test_cards` list was cleared rather than left at the previously-documented
`4100 2800 0007 0002`: the documented decline taxonomy does not reproduce
via test cards in this account (this same log, "Razorpay test-mode
capability findings"), and the real reproduction path is abandonment, a
user action, not a card simulation. No TypeScript or Python test asserted
an exact count of two observed reasons, so none needed fixing; the
`decline-taxonomy.json` note and `is_observed_in_test_mode`'s Python
docstring, which did assert "two", were updated to "three".

## Build log entry 7: waitForValueStable auto-waits on a destroyed element

Found by a live run after a session that added `waitForValueStable()` to fix
a React state-timing issue. 245 tests passed.

`input[name="contact"]` is REMOVED from the DOM the moment its value
registers and the checkout advances to the payment-method screen (the header
becomes "Using as +91 90000 90000"). `waitForValueStable` fills the field and
then polls `inputValue()` until the value stops changing, so it auto-waits
30s for an element that was destroyed by its own fill.

This is entry 6 repeating: an auto-waiting Playwright call on a TRANSIENT
element. The fix written after entry 6 reintroduced the same class of bug in
a new place.

Standing rule, now twice earned: inside any poll or stabilisation loop,
probe existence with `count()` first and never call an auto-waiting method
(`textContent`, `inputValue`, `waitFor`) on an element that can disappear.

### What was NOT the problem

A session had concluded that PerimeterX / hCaptcha risk-scoring was gating
the flow, and that only a guessed delay or an adversarial workaround would
clear it. Verified live: the hosted checkout renders and advances normally,
the method list appears from the fill alone, and nothing blocks. The
inconsistent pass/fail pattern is explained by the destroyed-element race,
not by bot detection.

Keep this: the refusal to build around bot detection was correct regardless.
But the diagnosis was wrong, and it was reached by reasoning from a pattern
across runs rather than by inspecting the DOM.

### Selector status, verified 2026-08-26

Checkout build hash changed (f2a87944... -> 6afcc725...), so Razorpay did
ship an update, but the flow is intact:

    input[name="contact"]              present on load, DESTROYED on fill
    [data-testid="card"]               present after the fill
    [data-testid="bottom-cta-button"]  present, STILL CORRECT
    [data-testid="add-card-cta"]       NOT present on the method screen

The rename to `add-card-cta` reported in that session belongs to a different
screen (likely card entry), not the method list. `bottom-cta-button` was
never stale on this screen.

A visible "Contact details ... Continue" screen now renders on load, but
filling the field auto-advances without clicking Continue; the click is a
no-op. Do not add a Continue step.

## Build log entry 8: the order-page "freeze" was a click on a 0x0 element

Root-caused by live DOM inspection 2026-08-26, not by reasoning from run
patterns. The previous session's diagnosis was wrong in both directions.

### What is actually true

BOTH buttons exist SIMULTANEOUSLY on the card-entry screen, on BOTH
integration surfaces. They are not per-surface variants:

    [data-test-id="add-card-cta"]     hyphenated attr, 0x0, offsetParent null,
                                      elementFromPoint at its centre = BODY
    [data-testid="bottom-cta-button"] 346x44, visible, hit-tests to itself

`add-card-cta` is a collapsed element. Clicking it does nothing: no dialog,
no popup, no DOM change. That is exactly the reported "freeze", and it
explains the screenshot showing a normal ready-to-submit state, because the
click never landed.

The intermittency is which element a combined selector happens to match as
the DOM settles.

Proven: clicking `[data-testid="bottom-cta-button"]` on the order-based
local page produced `dialog-TokenisationBenefits` and
`button[name="pay_without_saving_card"]`, identical to the hosted flow.

### Corrections to the previous session

- The combined selector added to "support both surfaces" is the CAUSE of the
  freeze, not a fix. Remove it. `bottom-cta-button` alone is correct on both.
- `add-card-cta` is not an order-page variant of the submit button. It is a
  collapsed element present on both surfaces and must never be a click
  target.
- Note the attribute differs too: `data-test-id` (hyphenated) versus
  `data-testid`. A selector written for one does not match the other, which
  is how a 0x0 element became a click target unnoticed.
- The order-based path is NOT blocked and does not need shelving. It works.

### Standing rule

Never select a click target by attribute alone when duplicates can exist.
Require visibility: a non-zero bounding box and a hit test that returns the
element itself. Playwright's actionability checks do this for `.click()`;
any JS-dispatched click bypasses them and must check explicitly.

## Correction to build log entry 8: it does NOT alternate, and is not "both surfaces simultaneously"

Entry 8's central claim — "BOTH buttons exist SIMULTANEOUSLY on the
card-entry screen, on BOTH integration surfaces... not per-surface
variants" — does not hold up. Re-verified 2026-08-26 with a direct
bounding-box + hit-test dump of both candidates, across 5 FRESH page loads
on each surface, no combined selector involved:

    hosted payment-link (5/5 loads):
      bottom-cta-button   real, visible, ~216x44, hits itself
      add-card-cta        count=1, box=null, isVisible=false, offsetParent
                          null, hits a DIV, not itself

    order-based/embedded (5/5 loads):
      bottom-cta-button   count=0 — DOES NOT EXIST on this surface at all
      add-card-cta        real, visible, 390x44, hits itself

Zero variation across 10 total loads. This is a deterministic PER-SURFACE
split, not randomness and not two simultaneous elements on one screen.
Entry 8's own supporting observation ("clicking bottom-cta-button on the
order-based local page produced dialog-TokenisationBenefits") does not
reproduce: `bottom-cta-button` has zero matches on that surface in every
one of 5 fresh loads just run. That single earlier observation was very
likely made against the hosted surface while believing it was the
order-based one, or against a since-changed build — either way it does not
hold now and should not be trusted over this reproducible result.

Consequence: the FIRST session's original finding (add-card-cta is the
real, correct button on the order-based page; bottom-cta-button is the
real, correct button on the hosted page; these are per-surface variants of
the same submit control) was right. Entry 8's "correction" of it was
itself the wrong diagnosis, reached from one click succeeding once rather
than from bounding boxes on both surfaces.

This does not change the selector. `[data-testid="bottom-cta-button"]:visible,
[data-test-id="add-card-cta"]:visible` (src/browser/selectors.ts) is
correct either way: a per-surface split and a per-session coin flip both
call for the same fix, letting Playwright's own visibility engine pick
whichever candidate is actually there and actually visible, rather than
hardcoding an assumption about which surface is in play.

The standing rule from entry 8 is unaffected and, if anything, reinforced:
a raw bounding-box + hit-test dump, repeated across fresh loads, is what
actually settles a DOM-shape question. A single successful click is not
evidence about what would happen on a different surface, and "it worked
once" was believed here for two sessions running before a repeat,
multi-load dump caught it. Same rule as always: scripts collect evidence,
and a claim that generalizes from one observation to "on both surfaces"
needs the second surface actually measured, not assumed.

## 2026-08-26 Payment-link quota lifted; batch primitive moves back to payment links

Razorpay has lifted the test-mode 30-link cap on this account (the support
ticket referenced in API-BEHAVIOUR.md's 2026-08-24 quota entry). Payment
links are no longer capped, which removes the entire reason the batch
primitive moved to orders + a locally-served checkout page in the first
place.

**Consequence: the batch primitive moves back to the hosted payment-link
surface.** It is the surface that has passed `npm run smoke` cleanly and
repeatably across this whole project, including today. The order-based
surface, meanwhile, still has an unexplained intermittent stall (submit
click succeeds, the save-card dialog / popup never appears, and — per live
investigation — with no failed request, no stalled request, and no console
error at the moment it happens; ruled out as the destroyed-contact-field
bug, the collapsed-decoy-click bug, and diagnosable network failure in
turn). With the quota justification gone, there is no reason to keep
shipping a real, unresolved intermittency in the batch primitive when a
proven-reliable alternative exists.

**`src/browser/checkout-page.ts` and `src/recovery/create-batch.ts` are
parked, not deleted.** Both are correct, tested code for a real, working
surface (order-based checkout does work — most runs of it succeed; see
prior entries) that simply is not the one the batch primitive uses now.
Deleting them would throw away a second, independently-verified execution
path against live Razorpay test mode, and the intermittent stall on that
surface is still unexplained, meaning it might resurface in a form that
affects the hosted surface too, in which case this work is where that
investigation resumes. Left on disk, unused, with this entry as the
record of why.

**Not yet fully understood: why the order-based surface renders different
markup at all** (see the correction entry above — `bottom-cta-button` does
not exist there, only `add-card-cta` does, deterministically). The
`:visible`-scoped combined selector in `src/browser/selectors.ts` handles
this correctly regardless, and is left as-is: it is still exercised by
whichever code drives the order-based surface, parked or not.

## 2026-08-26 Repo cleanup, and the order path deleted

Razorpay lifted the payment-link cap on this account. That removed the only
reason the order-based local checkout page existed, so it was deleted rather
than parked: unused code in a public repo is noise, and git history has it if
the constraint ever returns.

Deleted: `src/browser/checkout-page.ts`, `src/recovery/create-batch.ts`, the
`scratch/checkout.html` prototype, ~20 one-off debug scripts and their
screenshots from the submit-stall investigation, `scripts/webhook-receiver.mts`
(superseded by the real handler in `src/webhooks/`), `scripts/frames.mts`
(superseded by `recon.mts`), the taxonomy-era `scripts/capture.py` and
`scripts/make_links.py`, a stray `p.json`, and a nested
`apps/gateway/apps/gateway/tests/contract` directory created by a bad path.

Kept and moved to `apps/gateway/scripts/recon/`: `recon.mts`, `probe-api.mts`,
`probe-open-questions.mts`, `probe-payments.mts`. These produced everything in
API-BEHAVIOUR.md and CHECKOUT-FLOW.md and are cited by name in this log. A
reader who sees "verified live" and can find the script that verified it is
better served than a tidier tree.

`apps/gateway/scripts/` is now four operational entries: `migrate.mjs`,
`smoke-checkout.mts`, `webhooks-up.mts`, and `recon/`.

254 tests pass after the deletions; no dangling imports.

## UNRESOLVED CONTRADICTION: the two submit buttons

Two live observations conflict and neither should be treated as settled.

Entry 8 (this log, 2026-08-26 morning) recorded, from a direct
bounding-box dump on the ORDER-BASED local page: `add-card-cta` at 0x0 with
`offsetParent` null, AND `bottom-cta-button` at 346x44 visible and
hit-testing to itself. A click on `bottom-cta-button` on that same page then
produced `dialog-TokenisationBenefits` and `pay_without_saving_card`.

A later session reported, from 5 fresh loads on the same surface, that
`bottom-cta-button` does not exist at all (count=0) and `add-card-cta` is the
real 390x44 button.

Both claim direct measurement. They cannot both describe the same page state.
Possible explanations not investigated: the checkout renders differently
depending on which stage the dump was taken at, or checkout.js is served
live from Razorpay's CDN and changed between the two runs.

This is NOT resolved and must not be cited as fact in either direction. It
does not need resolving: the order-based path is deleted, and the
`:visible`-scoped selector is correct under either explanation because it
defers to Playwright's own actionability check rather than to our belief
about which button is real.

## SUPERSEDED: the "parked, not deleted" entry above

The entry at line ~902 says `src/browser/checkout-page.ts` and
`src/recovery/create-batch.ts` are "parked, not deleted, left on disk,
unused". That was true when written and is now WRONG. Both files were
deleted later the same day in the cleanup entry below. This log is
append-only, so the earlier entry stays as history; this note is the
correction.

Current truth: both files no longer exist. Git history has them. The batch
primitive is `src/recovery/create-link-batch.ts` on the hosted payment-link
surface. `docs/API-BEHAVIOUR.md` has been corrected to match.

The line about the `:visible`-scoped selector still standing "regardless,
parked or not" also holds for a different reason now: nothing drives the
order-based surface any more, and the selector is correct on the hosted
surface on its own merits.

## Standing rule: contradictions get resolved, not accumulated

Three have now appeared in this log (the PerimeterX misdiagnosis, the
two-submit-buttons observation, and this parked-vs-deleted drift). Two were
caught only because someone re-read the file.

When a later finding contradicts an earlier entry, append a correction that
names the earlier entry explicitly and states which is current. Never leave
two entries that a future reader could act on in opposite directions. The
append-only rule preserves history; it does not license leaving the record
ambiguous about the present.

One contradiction remains OPEN by design and is marked as such: the two
conflicting live observations of `add-card-cta` versus `bottom-cta-button`.
Neither is cited as fact anywhere, and no code depends on resolving it.

## Build log entry 9: a retry's submit click has no effect headless, masked by slowMo the whole project

Found by the first live Layer 1 batch run (src/recovery/run-batch.ts),
which is also the first thing in this project to drive a real RETRY
headless with no `slowMo`. 8/8 real batch transactions failed identically:
seed attempt fails correctly, the retry re-fills the card fields
correctly, `[data-testid="bottom-cta-button"]` is confirmed real, visible,
and hit-testing to itself (ruling out entry 8's decoy-click class), the
click resolves without error — and the popup never opens.

`smoke-checkout.mts`, which has passed this exact fail-then-retry sequence
every time it has ever been run in this project, was cloned with only
`headless: false, slowMo: 300` changed to `headless: true`. It reproduced
the same failure. Every other line was identical. This isolates the cause
to headless-without-pacing specifically, on the RETRY click alone — every
first attempt in this project's history, headless or not, has been
reliable.

**A real-condition substitute was tried and rejected before falling back
to a duration.** `page.waitForLoadState('networkidle', {timeout: 5000})`
right before the retry's submit click: one run resolved after 1559ms and
the click then succeeded; the next resolved after 1ms (network was already
idle) and the click still failed. Whatever needs to settle after a retry's
card-method click and re-fill is not network activity, and nothing else
observable from outside the page was found. A flat wait was tested
directly against this: the identical click failed 8/8 times at 0ms delay
and succeeded 3/3 times after a 1000ms wait, nothing else changed. Shipped
as `PRE_SUBMIT_SETTLE_MS = 1500` in `attempt()` (checkout-flow.ts), routed
through the existing injectable `sleep` so the unit suite (which uses a
non-real fake sleep) pays nothing for it.

This is the one duration-based wait in the driver, and it is labelled as
exactly that in code rather than dressed up as a condition. Every other
wait in this file gates on something real; this one does not, because nine
attempts across two different experiments (networkidle, flat sleep) turned
up no real signal to gate on instead.

**Why `slowMo` hid this for the whole project.** Every prior live
verification in this project — `npm run smoke`, the contract test's own
retry-adjacent paths, every manual investigation — either drove a single
attempt or drove smoke-checkout.mts, which has run headed with
`slowMo: 300` since it was written. Playwright's `slowMo` pads every
low-level input action by that many milliseconds, which incidentally
supplied exactly the settling time this bug needed, on every action, for
the whole life of the project. Headless, with no padding anywhere, is what
finally forced a retry through fast enough to hit it. Consistent with the
project's standing pattern: this was found by a live run, not by the 274
tests that were passing at the time.

## 2026-08-26 The batch runner gets a labelled stand-in outcome model, a forced veto, and a concurrency-4 stress test

Three problems with the batch runner as it stood after entry 9.

**Every transaction captured in both arms, by construction.** The runner
chose Success on every agent retry, so control and treatment were
indistinguishable — Layer 1 could execute the mechanism but could not even
in principle show a difference between arms, since there was nothing
random or arm-dependent about the retry outcome at all.

**Fix: `OutcomeModel` in run-batch.ts, a labelled stand-in, not real bank
behaviour.** A seeded, deterministic Bernoulli draw per agent-driven
attempt (mulberry32, not Math.random, so a run is reproducible from its
logged seed alone), parameterised per arm via `recoveryRateByArm`
(defaults 0.4 control / 0.9 treatment — illustrative, not derived from
anything). Each transaction gets its OWN independently-seeded model
(`deriveTransactionSeed(masterSeed, index)`) rather than sharing one RNG
across the worker pool: a shared RNG's draw SEQUENCE would still be
reproducible, but which transaction consumes which draw depends on real
async interleaving, which is not reproducible across runs once
concurrency > 1. Per-transaction seeding sidesteps that entirely.

**This must never be read as evidence the policy works, and both the CLI
and the report say so on every run** (`RunBatchReport.caveat`,
`LAYER1_CAVEAT`): Layer 1 proves the mechanism — real attempts, real
guardrails, real audit chain — executes correctly against real Razorpay.
A difference between arms produced with this model is a property of the
`recoveryRateByArm` parameters the run was given, not incremental recovery.
That claim is Layer 2's, on synthetic data where the true lift is known by
construction and the calibration check proves the estimator sound.

**No batch run had ever produced a veto.** Every real test-mode diagnosis
in this account maps to a transient, retryable grid cell — there is no
organic way to reach an unsafe cell through real Razorpay data alone, so
the code path that refuses an action had never executed end to end.

**Fix: `forceGuardrailVetoOn`, transaction index 0 of every run.** After
its real seed failure (still against real Razorpay — the override changes
nothing about how that attempt happened), its diagnosis is deliberately
overridden to `bank/authentication`, an unmapped grid cell, logged plainly
as a diagnostic override rather than a real observed diagnosis
(`diagnosis_overridden` progress event, `TransactionResult.diagnosisOverridden`).
`terminal_grid_cell` vetoes an unmapped cell unconditionally, same
mechanism already covered by recovery-integration.test.ts's fake-executor
test, now exercised for real. Verified directly against the live database
after a run: `guardrail_veto` recorded as its own audit event
(`guardrail_verdict: "veto"`, `proposed_action: "retry_with_backoff"`),
followed by `transaction_closed` with `attempts_made: 0` — confirming no
outbound Razorpay call was made for the vetoed decision. `TransactionResult.executorCalls`
makes this checkable from every run's own report, not just this one.

**Concurrency-4 stress test on `PRE_SUBMIT_SETTLE_MS` (entry 9): held.**
`npm run batch -- --count 10 --concurrency 4`, four browser contexts
genuinely concurrent on one CPU — exactly the condition that would expose
a fixed settle time tuned at concurrency 1 on an idle machine. 12 real
agent attempts across 10 transactions, zero retry-submit failures. The
constant was not raised; there was nothing to raise it for.

**That run also organically exercised two more veto reasons never seen
before, on top of the forced one**, purely from the outcome model
producing real failures for the first time:

  - `minimum_backoff`: a treatment-arm transaction's attempt 1 failed
    (per the model), attempt 2 was proposed immediately, and the 60s
    spacing guardrail correctly refused it (`lastAttemptAtMs` was no
    longer null once a real agent attempt had happened) — the treatment
    arm's own spacing schedule, doing exactly what DECISIONS.md's earlier
    guardrail entry says it exists to do.
  - `circuit_breaker`: the run's real failure rate reached 6/11 (54.5%),
    past the 50% threshold, and the breaker correctly halted the two
    transactions still in flight rather than letting them retry into a
    run that had already gone bad.

Full run: 10 links, 12 attempts, 6 captures, 2 failures, 4 guardrail
vetoes (1 forced, 1 minimum_backoff, 2 circuit_breaker), recovered
149700 paise control / 149700 paise treatment, elapsed 300.5s (seed
1051283054, reproducible with `--seed 1051283054`). All figures OBSERVED
per the caveat above.

## 2026-08-26 Three bugs from the count=20 run: the circuit breaker measured itself, a probe killed a transaction, and the exit code lied

A `--count 20 --control-rate 0.2 --treatment-rate 0.95` run surfaced arm
divergence working as intended (control ₹998 from 2/7, treatment ₹2495
from 5/5) alongside three real bugs, none caught by the unit suite.

**The circuit breaker tripped on the experiment working, not a fault.**
At control-rate 0.2, most control-arm attempts are SUPPOSED to fail —
that is the whole point of giving the two arms different rates. The
breaker's input, `batchStats.failed`, counted exactly those designed
failures, so a 53% "failure" rate tripped it and halted 8 of 20
transactions before they ever got an attempt. Worse, which 8 was not
random: whichever transactions happened to be later in the queue when the
threshold crossed, silently biasing any arm comparison drawn from that
run (a queue-position confound, not a data quality problem the report
would show).

Options considered: raise the threshold or `minSettled` (arbitrary,
still couples a safety mechanism to whatever `recoveryRateByArm` is
configured this run, and the next `--control-rate` still breaks it);
disable the breaker for batch runs (loses the actual protection it exists
for — a genuine credential/account/network fault mid-run); make the
breaker grid-cell-aware so it only counts UNEXPECTED failures (couples a
guardrail meant to be a pure function of `{settled, failed}` to an
outcome-model concept, `recoveryRateByArm`, that only run-batch.ts knows
about).

**Fix: redefine what run-batch.ts feeds the breaker, not the breaker
itself.** `ExecutionHealth {attempted, errored}` tracks genuine execution
faults — a `Result` coming back `err` from `openCheckout`, `attempt()`,
`fetchPayment`, or `runRecoveryStep` itself — completely separate from
`TransactionResult`'s own `finalOutcome` (captured/failed), which still
drives the summary's capture/failure counts exactly as before. A payment
settling as `failed` is not recorded in `ExecutionHealth` at all: the
attempt worked exactly as intended, the mock bank just declined it per
the model. `runRecoveryStep`'s `batch:` argument is now
`{settled: errorStats.attempted, failed: errorStats.errored}` — an error
rate, not a decline rate. `guardrails/rules.ts`, `types.ts`, and
`config.ts` are UNCHANGED: the breaker's own threshold (0.5) and arming
point (`minSettled` 10) still mean exactly what they always meant, "half
of at least ten operations came back a hard error" — a real production
caller with no outcome model gets identical behaviour to before. Only
this caller's definition of "failed" changed, because only this caller
introduced a reason payment-outcome failure and system failure could
diverge.

**A probe's own bounded timeout killed a transaction outright.**
`txn_10` errored with `locator.textContent: Timeout 250ms exceeded
waiting for payment-status-heading`. `pollOutcomeOnce`'s heading probe
already guarded with `count()` before calling `textContent()`
(`PROBE_TIMEOUT_MS`, added for exactly this reason — see Build log entry
6), but the two calls are not atomic: the element can exist at `count()`
and be gone by the time `textContent()` resolves, and that gap surfaces
as a plain "Timeout ... exceeded" rejection, not "Frame was detached".
The old catch only swallowed detachment (`isFrameDetachedError`), so this
timeout re-threw and killed the whole attempt — one in twenty
transactions at concurrency 4. Same bug class as entries 6 and 7 in a
third place: a non-authoritative probe inside a poll loop must be fully
non-fatal, not fatal-except-for-one-known-message. Fixed by swallowing
EVERY error from this specific probe, unconditionally: the heading is
documented as an optional early exit only (`.Payment-Completed` and
`retry-surface`, checked earlier in the same function, are what the
caller actually trusts), so there is no case where propagating its
failure is more correct than just trying again next tick. A fixture
config (`headingTextContentAlwaysTimesOut`) reproduces the exact race —
count() present, textContent() always times out — and a test confirms it
against the pre-fix code first (reverted locally, confirmed red, restored)
before confirming the fix green.

**The script exited non-zero on a successful run.** Any transaction with
a recorded `.error` made `run-batch.mts` exit 1, even though vetoes,
declines, and even a handful of processing errors are all things a Layer
1 batch run exists to observe and report, not reasons the SCRIPT failed.
Fixed: exit non-zero only when `runBatch()` itself returns `!ok` (link
creation failed outright, or similar) — a completed run that printed its
summary is a success regardless of what happened inside it. Per-transaction
errors are still counted and printed, just no longer fatal to the process.

## Build log entry 10: double-settle on a race between the driver and reconciliation, found before it ever ran

`idempotency-store.ts`'s `settle()` was `UPDATE attempts SET outcome=...
WHERE idempotency_key=$1` — no check the row was still `pending`.
`recovery/db.ts`'s `closeTransaction` was `UPDATE transactions SET
status=$2 WHERE id=$1` — no check it was still `open`. Both are
call-again-safe only by accident, if nothing ever calls them twice for the
same key. Something can: the driver's own flow (`state-machine.ts`, right
after `executor.execute()` returns) and a reconciliation run
(`reconcile.ts` — the realistic response when a webhook or any other
out-of-band signal says it's worth checking Razorpay's own record for a
transaction) can both reach a settle for the same attempt if the driver is
still mid-flight when that reconciliation runs. Whichever arrives second
still finds a matching `idempotency_key`, and neither `WHERE` clause
checked the row's current state, so it still succeeded. Both callers then
unconditionally wrote their own `attempt_settled` audit event, and if the
second racer's settle also closed the transaction, a second
`transaction_closed` too.

**Why it mattered.** CLAUDE.md hard rule 6 is never to report a recovery
figure without knowing exactly what it counts. A double `attempt_settled`
for one real attempt is a double-counted recovery for anything downstream
that sums audit events rather than re-querying `attempts` directly — and
even before any such consumer exists, it makes the audit log itself, the
thing this project's tamper-evidence and narrative claims both lean on,
describe an event that happened once as if it happened twice.

**How it was found.** Not by a live run, and not by an existing test going
red — every bug in this log through entry 9 was found one of those two
ways. This one was found by writing a test that didn't exist yet: closing
a gap in the regression suite ("assert a webhook-driven settle and a
driver-driven settle for the same payment produce exactly one settled
attempt, not two") required first asking what actually stops two settles
from both succeeding, and reading `SETTLE_SQL` and `closeTransaction`'s
`UPDATE` answered: nothing did. The project's first bug found by reasoning
about a race directly, rather than by reproducing one.

**Fix.** `idempotency-store.ts`: `SETTLE_SQL` gained `AND outcome =
'pending'`; `settle()` now returns `{status:'settled', attempt} |
{status:'already_settled', attempt}` instead of a bare `ReservedAttempt` —
a race's loser gets the row back as it now stands, not an error, the same
idempotent shape `reserve()` already used for its own `reserved`/
`duplicate` split. `recovery/db.ts`: `closeTransaction`'s `UPDATE` gained
`AND status = 'open'`; it returns `Result<'closed' | 'already_closed'>`
(was `Result<void>`). The two call sites — `state-machine.ts` (1 settle, 3
closeTransaction) and `reconcile.ts` (1 settle, 1 closeTransaction),
confirmed the only ones in the repo by grepping every `.settle(`/
`closeTransaction(` call including `scripts/run-batch.mts`, which sits
outside `tsc -b`'s coverage and was checked by hand (it calls only
`runBatch()`, which itself imports nothing from `idempotency-store.ts` and
never calls `closeTransaction` directly) — now write `attempt_settled`/
`transaction_closed` only on the variant that actually did the work.
`tests/db/settle-race.test.ts` and `tests/db/reconcile-race.test.ts`
exercise both call orderings and real concurrent racers against the fix;
`tests/unit/idempotency-store.test.ts` gained a case for the
`already_settled` path directly.

## 2026-08-27 EXPERIMENT-PROTOCOL.md corrected from six to seven grid rows; ground-truth.json committed

`packages/contracts/data/policy-grid.json` gained its seventh row
(`customer/payment_authentication` → `nudge_no_auto_retry`) on 2026-08-26,
from the live abandonment finding this same log already records
(`docs/CHECKOUT-FLOW.md` section 12: a payment abandoned after submit
resolves to `payment_cancelled | customer | payment_authentication`).
`docs/EXPERIMENT-PROTOCOL.md`'s `## Population` section still said "six
policy-grid rows" — the protocol doc was never updated when the grid was,
so it silently disagreed with the canonical contracts data it's supposed
to govern.

Per the protocol's own rule ("if a change is genuinely required, log it in
DECISIONS.md with the reason, and rerun from scratch"): corrected to
"seven policy-grid rows". **No experiment run has ever executed** — the
synthetic generator this protocol governs did not exist until this same
session — so no result is invalidated by this correction. This is closing
a gap between two documents, not a post-hoc edit to a result anyone has
seen.

Alongside the fix, `apps/engine/config/ground-truth.json` is committed:
the frozen per-(grid_cell, action) true recovery probability table the
protocol promised but never had. Full reasoning lives in the file itself
and is referenced from EXPERIMENT-PROTOCOL.md's `## Ground truth` section;
briefly: the table is the full 7×5 grid_cell × action cross product, not
just each cell's one designated action, because the control arm is
explicitly grid-unaware (always `retry_with_backoff`, per `## Assignment`)
and can apply a mismatched action to any cell. Those mismatched-retry
values are what give the treatment arm (grid-aware) any true lift at all,
and were tuned once: a first draft implied only ≈3.9pp of weighted true
lift, discovered too weak against the protocol's own "N=2000 gives ~80%
power to detect 6pp" line — the CI would rarely come near zero and the
calibration check would be uninformative. On inspection the draft had
quietly credited the control arm with "waiting it out" benefit it
structurally cannot get: `CONTROL_ARM_GUARDRAIL_CONFIG.attemptSpacing.baseMs
= 0` (gateway guardrails config) means control retries with zero delay.
Lowering the control-arm value specifically on the two time/method-dependent
cells (`gateway/authentication`, `bank/payment_authorization`) to reflect
that honestly moved the weighted true lift to ≈6.82pp — a reasoning
correction, not a fit to the target.

That total decomposes as +7.82pp gross from the two mismatched-retry cells
above, minus -1.00pp from the two customer cells (`customer/payment_authorization`,
`customer/payment_authentication`), where the grid-aware treatment action
is `nudge_no_auto_retry`. The negative drag is structural, not an error:
this population scores only whether the one modelled attempt recovers, and
`nudge_no_auto_retry` never re-presents the payment, so correctly declining
to retry cannot register as a recovery in this world — even though
control's blind, zero-delay retry occasionally gets lucky on the same
cell. The measured true lift therefore UNDERSTATES whatever a full
multi-attempt policy simulation would show, and the bias runs against the
treatment arm, never for it. Worth remembering when a later session
interprets the calibration check's headline number.

## 2026-08-27 Corrected true-lift figure: 6.82pp was wrong, 5.47pp is computed and cross-checked

The entry directly above this one stated the ground-truth table's weighted
true lift as +7.82pp gross / -1.00pp drag / +6.82pp net, computed by hand
from the raw config probabilities as a single-attempt calculation. That
figure was wrong, for two independent reasons, caught by independent
verification (a Monte Carlo simulation over 400,000 `Beta(2, 3)` draws)
before any experiment ran — this is the second bug in this project found
by reasoning about the world rather than by running something, after the
double-settle race (this log, entry 10), and like that one it would have
corrupted a headline number rather than failing loudly.

**Cause 1: a Jensen's-inequality gap in the modulation formula's
centering, not a bug in the formula itself.**
`outcomes.modulated_probability` shifts `logit(p_true)` by
`logit(customer_prior) - logit(mean_prior)`, where `mean_prior = 0.4` is
`Beta(2, 3)`'s mean. That formula is correct and unchanged — it is the
right shift for one customer. But averaged across the whole population, a
config probability does not realise at its stated value: `E[logit(X)]` for
`X ~ Beta(2, 3)` is `psi(2) - psi(3) = -0.5` exactly (`psi` = digamma;
confirmed both symbolically and by quadrature), not `logit(E[X]) =
logit(0.4) = -0.4055`. Because `logit` is neither convex nor concave over
the whole of `Beta(2, 3)`'s support (concave below 0.5, convex above, and
most of the mass sits below 0.5), `E[logit(X)] != logit(E[X])`, so every
transaction receives a systematic downward log-odds shift the hand
calculation never accounted for. Concretely: a configured 0.55 (
`gateway/payment_authorization`'s home probability) does not realise as
0.55 across the population.

**Cause 2: the hand calculation silently assumed one attempt per arm.**
EXPERIMENT-PROTOCOL.md's control arm makes "up to 3 attempts," and the
attempt cap applies equally to the treatment arm's own retry actions (the
same `MAX_ATTEMPTS = 3` guardrail bound, `apps/gateway/src/guardrails/config.ts`
`DEFAULT_GUARDRAIL_CONFIG.maxAttempts` / `CONTROL_ARM_GUARDRAIL_CONFIG`'s —
only `attemptSpacing` differs between the two arms). The protocol never
stated this attempt count anywhere near the ground-truth table, and the
lift arithmetic was computed as if it didn't matter. It matters a great
deal: `customer_prior` is a LATENT PER-CUSTOMER trait, fixed across all of
one customer's own attempts, so the correct compounding
(`1 - (1-p)^K`, "at least one success in K i.i.d. attempts") has to happen
INSIDE the integral over `customer_prior`, per customer, before averaging
— not on the population-average per-attempt probability. `1 - (1-p)^K` is
concave in `p` for `K > 1`, so averaging first (the easy shortcut)
understates the compounded figure by Jensen's inequality a second time.
Both effects push in the SAME direction on the two customer cells: control
compounds its small blind-retry probability over up to 3 tries
(`customer/payment_authorization`'s configured 0.03 realises 0.1145), while
treatment (`nudge_no_auto_retry`) stays exactly 0.0 regardless of attempt
count (RULE 1, ground-truth.json) — so the negative drag from those two
cells grew from the hand-computed -1.00pp to a properly-computed -3.85pp.

**Fix, per the instruction that produced it: change how the lift is
stated, not the world.** Neither `ground-truth.json`'s probability values
nor `modulated_probability`'s form changed — both were already
well-reasoned and are frozen. Three things were added instead:

1. Attempt semantics are now pinned explicitly in
   EXPERIMENT-PROTOCOL.md's `## Assignment` section: control makes up to
   `MAX_ATTEMPTS = 3` attempts of `retry_with_backoff`; treatment makes up
   to the same cap for a retry action, or 0 attempts for
   `nudge_no_auto_retry` / `never_retry`. The lift figure is meaningless
   without this and it was previously unstated.
2. `apps/engine/src/revenant_engine/true_lift.py` computes the true lift
   IN CODE: `realised_recovery_probability` integrates
   `1 - (1-modulated_probability(p_true, prior))^K` over `customer_prior
   ~ Beta(2, 3)` by numerical quadrature (`scipy.integrate.quad`), per
   cell, reading `p_true` from `ground-truth.json` and `K` from the pinned
   attempt semantics; `compute_true_lift` weights each cell by
   `population.grid_cell_weights` and sums. A hand-computed figure in a
   JSON comment can drift from the code silently; this cannot, because
   there is no longer a hand-computed figure — only this function's
   output.
3. `tests/test_true_lift.py` cross-checks every cell's computed figure,
   and the net total, against an INDEPENDENTLY reimplemented (not
   imported) Monte Carlo simulation at `N = 400,000` — matching the scale
   of the verification that caught the original error — within 5 standard
   errors. A regression test
   (`test_naive_single_attempt_arithmetic_understates_the_negative_drag`)
   pins the direction of the original error permanently: naive
   single-attempt config arithmetic must always show a smaller-magnitude
   drag than the properly-computed figure, or the fix itself has
   regressed.

**Corrected figures**, computed by `compute_true_lift()` and confirmed
against the independent Monte Carlo cross-check: **+9.32pp gross**
(`gateway/authentication` +2.98pp, `bank/payment_authorization` +6.34pp)
minus **-3.85pp drag** (`customer/payment_authorization` -3.12pp,
`customer/payment_authentication` -0.73pp), netting **+5.47pp** — close to
the independent verification's own "about 5.5pp" and still within
EXPERIMENT-PROTOCOL.md's stated 5-8pp target, now at the lower edge rather
than mid-range. `ground-truth.json`'s `weighted_true_lift` block and
EXPERIMENT-PROTOCOL.md's `## Ground truth` section both carry the
corrected figures and state plainly that they are realised expectations
under modulation and the pinned attempt counts, never raw single-attempt
config arithmetic — with at least one explicit example
(`gateway/payment_authorization`: configured 0.55, realises 0.8289) so a
reader cannot mistake a config value for a population rate again.

No experiment has ever run against this table, so — same as the six-to-seven
grid correction above — no result is invalidated. This entry exists so the
error, why it happened, and how it was caught are on record before one
ever does.

## 2026-08-28 The recovery model was main-effects-only: flat probabilities across actions, caught before the policy shipped

`apps/engine/src/revenant_engine/model.py`'s first version fit a logistic
regression over `error_source`, `error_step` and `action` as separate
one-hot features, no interaction between them. A pure main-effects model
cannot represent an action's effectiveness DEPENDING on the failure
class — the coefficient for `action=retry_prompt_alternate` is a single
number added identically regardless of cell. Verified directly: the
backoff-vs-alternate log-odds gap was **+0.0020 in every one of the four
non-terminal, non-customer cells, identical to four decimals** — the
unmistakable signature of a main-effects-only fit. The model's predicted
probabilities were correspondingly nearly flat within a cell (e.g.
`gateway/authentication`: 0.2601 / 0.2605 / 0.2723 across the three retry
actions) while the realised ground truth varies enormously (0.2061 /
0.4663 / 0.1459 for the same three) — the model had no way to know that
`retry_prompt_alternate` is the right tool for an authentication failure
and a poor one for a timing-sensitive bank decline, because
ground-truth.json's whole design (see the 2026-08-27 entries above)
depends on exactly that interaction reversing between cells.

**Why it mattered, twice over.** First, the reported held-out
accuracy/log-loss looked fine (0.86 / 0.25) despite the model being
badly wrong about WHICH action to prefer — accuracy on a five-action
label set dominated by the always-zero nudge/never_retry rows and by
cells where any retry beats no-retry hides an interaction failure that
only shows up when you compare actions WITHIN a cell, which no test did.
Second, and more seriously: the session that built policy.py had
deliberately kept `candidate_actions` a singleton (one action per cell,
taken directly from the grid) specifically because a flat model made a
genuine multi-way argmax pointless and risked the policy always
preferring a blind retry over `nudge_no_auto_retry` (which is exactly
`0.0` by construction, RULE 1 — see the 2026-08-27 entry above — and can
never win against a retry action with ANY positive probability). The
singleton design meant the model's flaw was invisible to every existing
test: `propose_action` always returned the grid's own action regardless
of what the model estimated, so "the policy never proposes an action the
grid forbids" passed trivially whether the model was right or wrong.

**An earlier, incorrect explanation.** Before the interaction gap was
found, the flat-looking probabilities were attributed (in conversation,
not committed to this file) to the same modulation downward bias the
2026-08-27 true-lift correction records. That explanation is WRONG and
is recorded here as wrong rather than left ambiguous: modulation bias
predicts every action's probability shifting down together, not the
relative ordering between actions within a cell going flat. It explains
part of `gateway/payment_authorization`'s gap (model 0.5028 vs realised
0.5242) but nothing about `gateway/authentication` (model 0.2610 vs
realised 0.4663 for the actually-best action) — a difference of kind,
not degree, that modulation cannot produce. No DECISIONS.md entry ever
stated the wrong explanation, so there is nothing to retract in an
earlier entry, only this note not to repeat it.

**Fix, three parts.**

1. `feature_dict` gained a `cell_action` feature (`grid_cell + "|" +
   action`, one-hot encoded like everything else) — an explicit
   interaction term. Still a plain logistic regression with readable
   coefficients, never a black-box learner: the fix is one more feature,
   not a different model family. Re-verified directly: the same
   `gateway/authentication` gap is now model 0.2141 / 0.4578 / 0.1237
   against realised 0.2061 / 0.4663 / 0.1459 — same ranking, closely
   tracking magnitude, for all six non-terminal cells.
2. `policy.py`'s `candidate_actions` was redesigned (its own module
   docstring calls this "design (b)", stated as a deliberate, non-silent
   choice per the instruction that produced it): a terminal cell or a
   cell whose grid action is `nudge_no_auto_retry` stays locked to that
   one action (the grid's "do not auto-retry" judgement for
   customer-class and terminal failures is not second-guessed), but the
   four cells whose grid action is one of the three retries now get a
   genuine three-way comparison, with the model's own per-action
   estimate deciding the winner. On today's ground-truth table this
   happens to reproduce the grid's own action on all four flexible
   cells — a fact about today's numbers, stated as such, not a guarantee
   the code enforces. If ground-truth.json ever changes such that a
   mismatched retry beats a cell's home action, the policy would now
   propose the mismatch, and `true_lift.py`'s calibration figure (which
   assumes treatment follows the grid's static action) would need
   recomputing against what the policy actually does.
3. `tests/test_model.py::test_model_ranks_actions_correctly_within_each_non_terminal_cell`
   compares the model's chosen action, per non-terminal cell, against
   `true_lift.realised_recovery_probability(cell, action,
   max_attempts=1)` — the single-attempt realised truth, matching what
   the model is actually trained to predict. Confirmed to fail on the
   pre-fix model (reproduced directly: `gateway/authentication` alone
   misses by a 0.32 gap, the tolerance is 0.05) and pass after. Uses a
   value tolerance rather than exact action-name equality specifically
   because `customer/payment_authentication`'s three retry actions are
   configured identically in ground-truth.json (all 0.02 — "no automated
   action re-engages an absent customer" applies equally to all three),
   a genuine near-tie where a strict name match would make the test
   flaky on sampling noise rather than testing ranking correctness.

This is the third bug in this project found by reasoning about the
system rather than by a failing test going red on its own (after the
double-settle race and the true-lift correction, both above) — and like
the true-lift correction, it was caught before the policy this model
feeds was ever wired to the gateway (still not done — see policy.py's
own module docstring), so nothing downstream needed to be re-run.
