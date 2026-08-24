# Experiment protocol

FROZEN. Committed before the generator was written. Changing any parameter
after seeing a result invalidates the experiment. If a change is genuinely
required, log it in DECISIONS.md with the reason, and rerun from scratch.

The purpose of the synthetic layer is NOT to prove the policy is good on real
traffic. It cannot do that. Its purpose is to prove the measurement
instrument is sound, on a world where the true answer is known.

## Population

N = 2000 failed payments per run. Each draws:

    grid_cell        categorical over the six policy-grid rows
    amount_paise     lognormal, median 49900, clipped [9900, 5000000]
    hour_ist         categorical, business-hours weighted
    attempt_number   starts at 1
    customer_prior   Beta(2, 3), latent per-customer reliability

Grid-cell weights are taken from Razorpay's published error documentation,
not invented. Source cited in README.

## Ground truth

For each (grid_cell, action) there is a TRUE recovery probability, set in
config. Realised recovery is a Bernoulli draw against it, modulated by
`customer_prior`. Terminal cells have true probability 0 for every action.

Because we set these, the true incremental lift of any policy is computable
in closed form. That is the whole point.

## Assignment

Stratified 50/50 on `grid_cell` crossed with amount band (three bands).
Control arm: baseline policy, retry immediately, up to 3 attempts, no
grid awareness. Treatment arm: agent policy.

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
