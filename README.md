# Revenant

**A payment recovery agent that measures whether its own actions caused the recovery.**

Most recovery tools tell you how much they recovered. None tell you how much
recovered *because of them*, versus what the customer would have retried
anyway. Gross recovery is a vanity metric: it counts payments that were never
lost. Revenant is built to refuse that dishonesty. It recovers failed payments
and then proves, with a randomised control arm and a calibrated estimator, how
much of that recovery it actually caused.

Razorpay AI Buildathon 2026 · AI Revenue Recovery track.

---

## The thesis in one line

Most recovery systems tell you how much they recovered. This one tells you how
much it recovered that would not have recovered anyway, and it is willing to
report "no evidence of value" about its own work.

## Three evidence layers, never conflated

The single rule the whole system is built around: an OBSERVED figure and an
ESTIMATED figure are different classes of evidence and are never summed.

**Layer 1 — OBSERVED.** Real payments driven against Razorpay test mode. The
agent diagnoses a failure by Razorpay's own `error_source` and `error_step`,
chooses a bounded recovery action from an inspectable policy grid, and executes
real retries through a real browser checkout, with real payment IDs. Every
figure here is what actually happened.

**Layer 2 — ESTIMATED.** A randomised holdout on a synthetic population whose
true recovery process is fixed in code and committed *before any experiment
runs*. Control arm and treatment arm are assigned by stratified 50/50
randomisation; the incremental lift is reported with a stratified bootstrap
confidence interval. This is where the honest number lives: on the current run
the recovery-rate difference clears zero while the protocol's primary estimate,
recovered value, straddles it, so the system reports **no evidence of value**
underneath a positive-looking number.

**Layer 3 — the calibration harness.** The part no competitor can build,
because it requires knowing the true answer. The estimator is run 2,000 times
against the world whose true lift was frozen in advance, to measure how often
its 95% interval actually contains the truth. It reports 93.8% coverage,
states plainly that the estimator is therefore slightly anti-conservative, and
does not tune the number to look clean. It caught its own bootstrap being 38%
too wide and corrected it, on the record.

## Safety: the AI never decides whether money moves

- A deterministic **policy** chooses the recovery action by expected value over
  an inspectable grid keyed on Razorpay's error attribution.
- An **LLM** maps *unfamiliar* decline reasons onto the grid, and only that. It
  returns a broad failure class; our own trusted code resolves the class to a
  specific cell using Razorpay's error fields, so a prompt injection cannot
  target a specific action. This closed a real injection path that shape
  validation structurally cannot catch, found by adversarial testing.
- A **guardrail layer** can veto the agent. Every veto is recorded as evidence,
  not swallowed as an error. Terminal declines are never retried, attempts are
  capped, and a circuit breaker halts a batch on genuine execution faults.
- The **audit log is a hash-chained, append-only record enforced by Postgres**,
  not by convention. Any attempt to alter a row is refused by the database.

## The evidence console (dashboard)

A dark, dense instrument panel. The whole system is driven live from one
command; the dashboard is the only URL you open.

- **Batch** — a live Razorpay run streaming transaction by transaction, vetoes
  arriving as interruptions, recovered value counting up. OBSERVED.
- **The Number** — the incremental lift as a giant figure sitting on its own
  bootstrap distribution, the interval bracketing it, the frozen reference
  cutting through, and the honest verdict beneath. Re-runnable with a new seed
  to watch the interval move while the reference stays fixed.
- **Decisions** — every diagnosis, proposed action, guardrail verdict and
  outcome, filterable to refusals alone. The policy grid and the live LLM
  classifier with its confidence gate.
- **Custody** — the audit log as a chain of custody. A **tamper** control runs a
  real `UPDATE` against the audit table and shows Postgres refusing it, with the
  verbatim error, SQLSTATE and trigger name. A **verify** control walks the real
  chain.
- **Instrument** — the calibration certificate: coverage, the null condition,
  the pooled-vs-stratified correction, all on record. Re-runnable live at a
  smaller replication count.

## Architecture

    apps/gateway    Node + TypeScript. Razorpay client with per-endpoint
                    throttling and Retry-After handling, idempotency store,
                    guardrail layer, hash-chained audit log, recovery state
                    machine, Playwright checkout driver, webhook handler,
                    batch runner. Postgres.

    apps/engine     Python + FastAPI. Synthetic population generator, frozen
                    ground truth, recovery probability model, deterministic
                    policy, open-world LLM classifier with a confidence gate,
                    randomised-holdout experiment, stratified bootstrap, and
                    the calibration harness.

    apps/dashboard  React + Vite. The evidence console.

    packages/contracts   Canonical JSON (policy grid, decline taxonomy, test
                    cards) read identically by the TypeScript and Python sides.

## Testing

Verification is tiered so a live failure can never hide behind a green unit run.

- **unit** — pure logic, no I/O. Guardrails, hash-chain verifier, estimators,
  policy, classifier.
- **db** — against a live Postgres, including the append-only guarantee, the
  audit chain over a real batch, and idempotency under concurrency.
- **live** — against real Razorpay and a real browser, including a contract
  test that drives a real payment and asserts the driver's reported outcome
  against the Razorpay API.

Roughly 700 tests across the two languages. Several of the most dangerous bugs
in the project were caught by verification and reasoning rather than by a test
going red, and each is recorded in `docs/DECISIONS.md`.

## What is real, stated honestly

- Layer 1 executes real payments against Razorpay test mode. Real payment IDs,
  real webhooks, real idempotency, real audit chain.
- Layer 2's population is synthetic and labelled ESTIMATED everywhere. Its true
  lift was computed in code and committed before any run, so it cannot have been
  fitted to a result.
- The test-mode mock bank collapses all card failures to one decline reason, so
  the richer decline taxonomy is exercised in the synthetic layer, sourced from
  Razorpay's own published error documentation. This is stated in the docs
  rather than papered over.
- The LLM classifier's accuracy is reported with its confidence interval and its
  small sample size, not as a robust figure.

## Running it

    npm run setup          # one-time: deps, database, migrations, engine venv
    npm run dev            # starts gateway, engine and dashboard together

Then open the dashboard and drive the whole system from it: run a live batch,
run the experiment, trigger the tamper, run the calibration.

Requires Node 20+, Python 3.11, Postgres, and Razorpay test-mode API keys. See
`.env.example`.

## Documentation

The `docs/` directory is the real build record, written from live observation
rather than after the fact:

- `PLAN.md` — the thesis and what the submission argues.
- `ARCHITECTURE.md` — layers, the policy grid, guardrails, the audit chain.
- `EXPERIMENT-PROTOCOL.md` — the frozen experiment protocol and ground truth.
- `API-BEHAVIOUR.md` and `CHECKOUT-FLOW.md` — Razorpay's real behaviour,
  verified live.
- `DECISIONS.md` — the full build log, including every bug found and how, and
  every design decision and why.

## Status

Core system complete and verified end to end: gateway, engine, calibration
harness, and the evidence console. Final polish in progress: live streaming of
the real Razorpay batch to the dashboard, configurable run parameters across all
controls, a backend connection-health indicator, and the recorded five-minute
walkthrough.
