# Experiment protocol

FROZEN. Committed before the generator was written. Changing any parameter
after seeing a result invalidates the experiment. If a change is genuinely
required, log it in DECISIONS.md with the reason, and rerun from scratch.

The purpose of the synthetic layer is NOT to prove the policy is good on real
traffic. It cannot do that. Its purpose is to prove the measurement
instrument is sound, on a world where the true answer is known.

## Population

N = 2000 failed payments per run. Each draws:

    grid_cell        categorical over the seven policy-grid rows
    amount_paise     lognormal, median 49900, clipped [9900, 5000000]
    hour_ist         categorical, business-hours weighted
    attempt_number   starts at 1
    customer_prior   Beta(2, 3), latent per-customer reliability

Grid-cell weights are taken from Razorpay's published error documentation,
not invented. Source cited in README.

## Ground truth

For each (grid_cell, action) there is a TRUE recovery probability, set in
config: apps/engine/config/ground-truth.json, frozen alongside this
protocol and subject to the same change rule. Realised recovery is a
Bernoulli draw against it, modulated by `customer_prior`. Terminal cells
have true probability 0 for every action.

Because we set these, the true incremental lift of any policy is computable
in closed form. That is the whole point.

**The true incremental lift is a REALISED expectation under modulation and
the pinned attempt counts (below), computed in code
(apps/engine/src/revenant_engine/true_lift.py), never by hand.** A
hand-computed first draft (+7.82pp gross / -1.00pp drag / +6.82pp net,
single-attempt, ignoring how modulation actually averages over
`customer_prior`'s real distribution) was wrong on both counts and is
corrected in docs/DECISIONS.md, 2026-08-27. Do not confuse a raw
ground-truth.json config value with what a population of customers
actually realises: `retry_with_backoff` on `gateway/payment_authorization`
is configured at 0.55 per attempt, but realises 0.83 once compounded over
up to 3 attempts and averaged over `customer_prior`'s real distribution
-- modulation does NOT preserve a config value's mean, in either
direction, and the gap can be large.

The current table's computed true lift (control always retry_with_backoff
vs. treatment the grid's own action, both under the attempt semantics
pinned in `## Assignment`, weighted by grid-cell population share) is
**+9.32pp gross** from gateway/authentication and bank/payment_authorization,
where control's zero-delay blind retry is a poor substitute for the
targeted action even compounded over 3 attempts, minus **-3.85pp** from the
two customer cells, netting **+5.47pp**. The customer-cell drag is
structural, not a modelling error, and it is LARGER than single-attempt
arithmetic suggests: this world scores only whether an attempt recovers,
`nudge_no_auto_retry` never re-presents the payment (ground-truth.json's
RULE 1), so correctly declining to retry can never register as a recovery
here across any number of attempts, while control's blind retry gets up to
3 tries to get lucky. The measured lift therefore UNDERSTATES the policy
by construction, and the bias runs against the treatment arm, never for
it. Reproduce with `revenant_engine.true_lift.compute_true_lift()`; see
ground-truth.json's own `weighted_true_lift` block and
tests/test_true_lift.py (an independent Monte Carlo cross-check) for the
full per-cell numbers and verification.

## Assignment

Stratified 50/50 on `grid_cell` crossed with amount band (three bands).
Control arm: baseline policy, retry immediately, up to 3 attempts, no
grid awareness. Treatment arm: agent policy.

**Attempt semantics, pinned** (the true-lift figure above is meaningless
without this): control arm makes up to MAX_ATTEMPTS = 3 attempts of
`retry_with_backoff` per transaction, stopping at the first recovery
(`apps/gateway/src/guardrails/config.ts`, `DEFAULT_GUARDRAIL_CONFIG.maxAttempts`
/ `CONTROL_ARM_GUARDRAIL_CONFIG`'s -- same cap, only `attemptSpacing`
differs between the arms). Treatment arm makes up to the SAME
MAX_ATTEMPTS = 3 attempts of its grid-designated action when that action
is a retry (`retry_with_backoff`, `retry_prompt_alternate`,
`retry_on_timing_window`) -- the attempt cap is a safety bound on real
money applying equally to both arms, not part of the policy under
measurement (docs/DECISIONS.md, "Guardrail layer"). When the
grid-designated action is `nudge_no_auto_retry` or `never_retry`, the
treatment arm makes 0 attempts: neither action re-presents the payment
even once.

Randomisation seed is logged per run and stored with the results.

## Primary estimate

Incremental recovered value = mean recovered rupees per transaction in
treatment minus control. Confidence interval by bootstrap, 10000 resamples,
percentile method, 95%. Two-proportion z-test on recovery rate reported
alongside as a secondary check.

Power: at a control recovery rate near 0.25, N = 2000 total gives roughly
80% power to detect a 6 percentage point absolute difference. Do not report
a positive finding below that resolution.

## Calibration check (the thing no vendor can do)

Run the whole experiment 500 times with fresh seeds, under two conditions.

**Coverage.** Set a known non-zero true lift. Across the 500 replications,
the 95% bootstrap CI should contain the true lift about 95% of the time.
Report the observed coverage. Anything outside roughly 92 to 98 percent
means the estimator is broken and the headline number cannot be trusted.

**Null.** Set the agent policy equal to the baseline policy so the true lift
is exactly zero. The CI should contain zero about 95% of the time, and the
significance test should reject at about the 5% rate. If it rejects far more
often, the estimator manufactures effects that do not exist.

Both results go on the dashboard next to the headline number. On real
merchant data nobody knows the true lift, so nobody can run this check.
We can, because we wrote the world.

## Off-policy estimation (Layer 3, secondary)

The logging policy must be stochastic and its propensities logged, otherwise
IPS is biased and the bias is not identifiable. The baseline arm therefore
uses epsilon-greedy action selection with epsilon = 0.1, and the true
propensity of each chosen action is written to the log at decision time.

Estimators: IPS, self-normalised IPS, and doubly-robust, via Open Bandit
Pipeline. Report all three. If they disagree materially, say so rather than
picking the flattering one.

This number is always labelled ESTIMATED and never appears without the
primary holdout result beside it.

## Reporting rules

Three numbers, never merged, always labelled:

1. OBSERVED, Layer 1, real Razorpay test-mode outcomes, small N.
2. ESTIMATED, Layer 2, synthetic randomised holdout, with CI and the
   calibration result.
3. ESTIMATED (OPE), Layer 3, secondary, with its assumptions stated.

If the Layer 2 lift is not significant, report that. "No evidence of
incremental value, do not deploy" is a valid and honest output, and the
system must be able to emit it.
