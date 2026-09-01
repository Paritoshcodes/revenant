"""The randomised holdout experiment: control vs. treatment on one
synthetic population, per docs/EXPERIMENT-PROTOCOL.md -- FROZEN, read in
full before this module was written. Nothing here adjusts the protocol,
apps/engine/config/ground-truth.json, or any estimator to make a number
look better; see docs/DECISIONS.md for the session that built this.

TWO ESTIMATES, NEVER BLENDED, DIFFERENT UNITS -- read this before citing
either number anywhere:

  (a) recovery_rate_diff_pp -- a RATE difference, in PERCENTAGE POINTS.
      This is the estimand true_lift.compute_true_lift().net_true_lift_pp
      is ALSO expressed in, so calibration.py checks bootstrap coverage
      against (a), never against (b). Checking (b)'s rupee interval
      against a percentage-point target would silently produce near-zero
      coverage and look exactly like a broken estimator when nothing is
      wrong -- this mistake is closed structurally by keeping the two
      figures on ExperimentEstimates with names that state their own
      units, not by a comment alone.
  (b) recovered_value_diff_paise -- a VALUE difference, in PAISE per
      transaction. This is EXPERIMENT-PROTOCOL.md's own stated PRIMARY
      estimate ("## Primary estimate") and the dashboard's headline
      figure. It has no defined relationship to compute_true_lift()'s
      percentage-point figure and must never be compared against it.

RNG STREAMS, one input `seed`, each purpose offset from it -- matching
model.py's own established convention (`seed + 1` for its label draws,
distinct from population.py's own `seed`), never reusing one stream for
two purposes:

    seed        -> population.generate_population's own internal stream (delegated, untouched)
    seed + 1    -> arm-assignment shuffling within each stratum
    seed + 2    -> attempt-outcome Bernoulli draws, advanced across every
                   transaction's every attempt in population order
    seed + 3    -> bootstrap resampling (Part 2's own estimates)

Two calls to run_experiment with the same (n, seed, policy, model)
produce byte-identical output for every field EXCEPT
ExperimentEstimates.bootstrap_wall_time_s itself, which is a genuine
wall-clock measurement and is expected to vary run to run -- it is not
part of the simulation output, and comparing it as if it were is a test
bug, not a determinism bug (see tests/test_experiment.py, which excludes
it explicitly). Every other field, including every row and both
bootstrap intervals, is a deterministic function of `seed` alone --
nothing else here touches wall-clock time or an unseeded generator.
"""

from __future__ import annotations

import time
from typing import Callable, Literal

import numpy as np
from pydantic import BaseModel
from revenant_contracts import policy_grid
from scipy.stats import norm

from .model import RecoveryModel, default_model
from .outcomes import ground_truth_probability, modulated_probability, recovers
from .policy import Diagnosis, ProposedAction, propose_action
from .population import Transaction, generate_population
from .true_lift import attempts_for_action

#: Bootstrap resamples, percentile method, 95% -- EXPERIMENT-PROTOCOL.md's
#: own "## Primary estimate" section, verbatim.
N_BOOTSTRAP_RESAMPLES = 10_000
BOOTSTRAP_CI_PERCENTILES = (2.5, 97.5)

#: "If it exceeds ten seconds for one experiment, say so and stop rather
#: than silently reducing the resample count." -- checked live, every run.
BOOTSTRAP_TIME_BUDGET_S = 10.0

BootstrapMethod = Literal["pooled", "stratified"]

PolicyFn = Callable[[Diagnosis, "RecoveryModel | None"], ProposedAction]

#: Control's own action, never grid-aware -- EXPERIMENT-PROTOCOL.md's
#: "## Assignment": "retry immediately, up to 3 attempts, no grid
#: awareness." The SAME string true_lift.CONTROL_ACTION uses; imported
#: rather than re-declared would create a circular import (true_lift.py
#: does not import this module), so it is restated here as the one
#: literal this module owns, matching true_lift.py's own value exactly
#: (asserted in tests/test_experiment.py).
CONTROL_ACTION = "retry_with_backoff"

#: The arithmetic floor for run_experiment: both estimates need at least
#: 2 transactions per arm to mean anything -- a single-point "arm" has a
#: mean but a bootstrap resample of it is a degenerate constant, not an
#: estimate of variability. 2 per arm x 2 arms is the floor. Checked
#: BEFORE generate_population is ever called (2026-09-01 scale/robustness
#: pass, docs/DECISIONS.md) -- a silent nan or an empty interval flowing
#: downstream is worse than a loud refusal here. This alone does not
#: fully guarantee 2-per-arm for every n >= MIN_TRANSACTIONS, since
#: _assign_arms balances PER STRATUM (up to ~21 (grid_cell, band) groups),
#: not globally -- see the second, belt-and-braces check inside
#: run_experiment, right after real assignment.
MIN_TRANSACTIONS = 4


class TransactionRow(BaseModel):
    """One transaction's full simulated outcome -- the zero-abstraction
    layer every headline estimate in this module is computed FROM, per
    the dashboard's own requirement that every number be reducible to
    the rows behind it."""

    id: str
    grid_cell: str
    amount_paise: int
    amount_band: str
    arm: str  # "control" | "treatment"
    action: str
    attempts_made: int
    recovered: bool
    recovered_value_paise: int
    #: The ONE modulated probability (outcomes.modulated_probability)
    #: actually used for EVERY attempt on this transaction -- computed
    #: once from (grid_cell, action, customer_prior), reused unchanged
    #: across attempts_made attempts, never redrawn. This is what
    #: tests/test_experiment.py's customer_prior-fixed-across-attempts
    #: cases assert equality against directly.
    effective_recovery_probability: float


def _coupling_guard(model: RecoveryModel) -> None:
    """Runs first, unconditionally, on EVERY call to run_experiment --
    "a unit test does not protect a run." Checks propose_action's OWN
    fidelity to policy-grid.json's designated actions for this specific
    `model`, exactly matching
    tests/test_policy.py::test_policy_choice_matches_the_grid_true_lift_couples_the_two's
    own check (default Diagnosis amount/hour/attempt fields).

    Deliberately independent of whatever `policy` callable a caller
    passes to run_experiment for the actual per-transaction simulation:
    this guard protects true_lift.compute_true_lift()'s own assumption
    ("the treatment arm takes each cell's grid-designated action"),
    which is a property of propose_action + this model + the grid, not
    of any particular experiment's chosen simulation policy. The null
    condition (calibration.py) deliberately simulates a DIFFERENT policy
    and is correctly unaffected by this guard, which never inspects that
    substituted policy at all -- see docs/DECISIONS.md for the full
    reasoning this design resolves.
    """
    for row in policy_grid():
        proposed = propose_action(Diagnosis(error_source=row.error_source, error_step=row.error_step), model=model)
        if proposed.action != row.action:
            raise AssertionError(
                f"Runtime coupling guard failed: propose_action chose {proposed.action!r} "
                f"for grid cell {row.grid_cell!r}, but policy-grid.json names {row.action!r} "
                f"as that cell's designated action. true_lift.compute_true_lift()'s committed "
                f"true-lift figure assumes the treatment arm takes the GRID's action on every "
                f"cell -- that assumption no longer holds for this model, and the committed "
                f"true lift no longer describes the treatment arm. Do NOT silently proceed: "
                f"recompute compute_true_lift() against the policy's actual choice, update "
                f"ground-truth.json's weighted_true_lift block and "
                f"docs/EXPERIMENT-PROTOCOL.md's stated figures, and log the change in "
                f"docs/DECISIONS.md before treating any experiment run as valid."
            )


def _amount_bands(amounts_paise: np.ndarray) -> tuple[np.ndarray, tuple[int, int]]:
    """Tertile cut points of THIS RUN's own amount_paise -- distinct from
    model.AMOUNT_BAND_BOUNDARIES (fixed 30,000/100,000 paise cutoffs used
    only for model-training features; a different purpose, a different
    name, never conflated). Returns (band labels per transaction, the two
    cut points, recorded on ExperimentResult so they are auditable)."""
    cut_lo, cut_hi = np.quantile(amounts_paise, [1.0 / 3.0, 2.0 / 3.0])
    cut_lo_i, cut_hi_i = int(round(cut_lo)), int(round(cut_hi))
    bands = np.where(amounts_paise <= cut_lo_i, "low", np.where(amounts_paise <= cut_hi_i, "mid", "high"))
    return bands, (cut_lo_i, cut_hi_i)


def _assign_arms(grid_cells: np.ndarray, bands: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Stratified 50/50 on (grid_cell, band): within each stratum,
    shuffle then alternate control/treatment down the shuffled order --
    balanced to within one by construction for any stratum size. Strata
    are processed in a fixed sorted order so the SAME seed always
    consumes `rng` identically. Asserts the balance it just constructed,
    live, per stratum -- "a unit test does not protect a run" applies
    here exactly as it does to the coupling guard."""
    n = len(grid_cells)
    arms = np.empty(n, dtype=object)
    strata: dict[tuple[str, str], list[int]] = {}
    for i in range(n):
        strata.setdefault((str(grid_cells[i]), str(bands[i])), []).append(i)

    for key in sorted(strata.keys()):
        indices = np.array(strata[key])
        rng.shuffle(indices)
        for pos, idx in enumerate(indices):
            arms[idx] = "control" if pos % 2 == 0 else "treatment"

        n_control = int(np.sum(arms[indices] == "control"))
        n_treatment = len(indices) - n_control
        if abs(n_control - n_treatment) > 1:
            raise AssertionError(
                f"Stratum {key!r} imbalanced after assignment: {n_control} control vs. "
                f"{n_treatment} treatment (n={len(indices)}). Alternating assignment down a "
                f"shuffled stratum is balanced to within one by construction -- this can only "
                f"mean the assignment loop itself is broken."
            )

    return arms


def simulate_transaction(
    transaction: Transaction,
    action: str,
    arm: str,
    band: str,
    txn_id: str,
    rng: np.random.Generator,
) -> TransactionRow:
    """One transaction's full simulated outcome under `action`. Attempts
    = attempts_for_action(action) (true_lift.py's own pinned semantics:
    MAX_ATTEMPTS for a retry action, 0 for nudge_no_auto_retry/never_retry).
    transaction.customer_prior is read from the SAME Transaction object
    for every attempt -- never redrawn -- so effective_recovery_probability
    is computed ONCE and is, by construction, the same value every
    attempt would use; outcomes.recovers() independently recomputes it
    per call (harmlessly redundant) but always from the same inputs."""
    n_attempts = attempts_for_action(action)
    true_p = ground_truth_probability(transaction.grid_cell, action)
    effective_p = modulated_probability(true_p, transaction.customer_prior)

    recovered = False
    attempts_made = 0
    for _ in range(n_attempts):
        attempts_made += 1
        if recovers(transaction, action, None, rng):
            recovered = True
            break

    return TransactionRow(
        id=txn_id,
        grid_cell=transaction.grid_cell,
        amount_paise=transaction.amount_paise,
        amount_band=band,
        arm=arm,
        action=action,
        attempts_made=attempts_made,
        recovered=recovered,
        recovered_value_paise=transaction.amount_paise if recovered else 0,
        effective_recovery_probability=effective_p,
    )


class BootstrapInterval(BaseModel):
    point_estimate: float
    lo: float
    hi: float


class ZTestResult(BaseModel):
    """Two-proportion z-test on recovery rate -- EXPERIMENT-PROTOCOL.md's
    own "reported alongside as a secondary check." Never the primary
    claim; see ExperimentEstimates' own field ordering and naming."""

    z_statistic: float
    p_value: float


class ExperimentEstimates(BaseModel):
    #: (a) -- percentage points. Compared against
    #: true_lift.compute_true_lift().net_true_lift_pp in calibration.py.
    recovery_rate_diff_pp: BootstrapInterval
    #: (b) -- paise per transaction. EXPERIMENT-PROTOCOL.md's own stated
    #: PRIMARY estimate; the dashboard's headline figure. NEVER compared
    #: against (a) -- different quantity, different units. See this
    #: module's own top docstring.
    recovered_value_diff_paise: BootstrapInterval
    z_test_secondary: ZTestResult
    bootstrap_wall_time_s: float
    #: Which resampling method produced the two intervals above -- see
    #: _bootstrap_pooled/_bootstrap_stratified. Recorded on the result so
    #: a reader can tell which was used without re-deriving it, per the
    #: project's zero-abstraction ethos.
    bootstrap_method: BootstrapMethod


def _bootstrap_pooled(rows: tuple[TransactionRow, ...], seed: int) -> tuple[np.ndarray, np.ndarray]:
    """The ORIGINAL bootstrap: each arm's transactions resampled as one
    pooled group, with no awareness of the (grid_cell, amount_band)
    stratification the arms were actually assigned under. Kept available
    under the `bootstrap_method="pooled"` flag for comparison -- see
    docs/DECISIONS.md, "closing the over-coverage gap": this is the
    method the 2026-09-01 500-replication calibration run measured at
    99.40% coverage against a 95% nominal target, and diagnosed (bias
    ruled out via the sample-mean/estimand match) as a genuine
    stratification/resampling mismatch, not a bug in this function's own
    arithmetic -- confirmed quantitatively before anything was changed:
    five real experiments' bootstrap-implied SE (~2.19-2.25pp) was
    consistently ~1.38-1.42x the 500-replication empirical between-
    replication SE (1.5864pp), and inverting the observed 99.40%
    coverage independently implies the same ~1.40x ratio."""
    control = [r for r in rows if r.arm == "control"]
    treatment = [r for r in rows if r.arm == "treatment"]
    n_c, n_t = len(control), len(treatment)

    c_recovered = np.array([r.recovered for r in control], dtype=np.float64)
    t_recovered = np.array([r.recovered for r in treatment], dtype=np.float64)
    c_value = np.array([r.recovered_value_paise for r in control], dtype=np.float64)
    t_value = np.array([r.recovered_value_paise for r in treatment], dtype=np.float64)

    rng = np.random.default_rng(seed + 3)
    # Independent resampling per arm, each preserving its own original
    # size -- never pooled-and-resplit, never transaction-paired across
    # arms (EXPERIMENT-PROTOCOL.md's arms are independent by
    # construction). One 2D index draw per arm, reduced along axis=1 --
    # vectorised, no Python-level resample loop.
    c_idx = rng.integers(0, n_c, size=(N_BOOTSTRAP_RESAMPLES, n_c))
    t_idx = rng.integers(0, n_t, size=(N_BOOTSTRAP_RESAMPLES, n_t))

    c_rate_resampled = c_recovered[c_idx].mean(axis=1)
    t_rate_resampled = t_recovered[t_idx].mean(axis=1)
    rate_diffs_pp = (t_rate_resampled - c_rate_resampled) * 100.0

    c_value_resampled = c_value[c_idx].mean(axis=1)
    t_value_resampled = t_value[t_idx].mean(axis=1)
    value_diffs_paise = t_value_resampled - c_value_resampled
    return rate_diffs_pp, value_diffs_paise


def _bootstrap_stratified(rows: tuple[TransactionRow, ...], seed: int) -> tuple[np.ndarray, np.ndarray]:
    """The CORRECTED bootstrap for a stratified design: resamples WITHIN
    each (grid_cell, amount_band) stratum independently, preserving that
    stratum's own original size in each arm, then aggregates across
    strata using their real (fixed) sizes -- reproducing, for every
    resample, the exact per-stratum balance the actual random assignment
    guarantees every real experiment. This is what removes the
    between-cell compositional variance _bootstrap_pooled's uniform
    per-arm resampling reintroduces (grid cells have very different
    recovery rates -- e.g. gateway/authentication realises 0.45 control
    vs. 0.78 treatment -- so which cells a pooled resample happens to
    over/under-represent matters a great deal).

    Vectorised the same way as _bootstrap_pooled WITHIN each stratum (one
    (N_BOOTSTRAP_RESAMPLES, stratum_size) index draw per (stratum, arm)
    group); the only Python-level loop is over the strata THEMSELVES
    (<=21 (grid_cell, band) combinations today), not over resamples --
    negligible next to the vectorised 10,000-wide draws inside it.
    Strata are visited in a fixed sorted order so a given seed always
    consumes the RNG identically."""
    recovered = np.array([r.recovered for r in rows], dtype=np.float64)
    value = np.array([r.recovered_value_paise for r in rows], dtype=np.float64)

    groups: dict[tuple[str, str, str], list[int]] = {}
    for i, r in enumerate(rows):
        groups.setdefault((r.grid_cell, r.amount_band, r.arm), []).append(i)

    n_c = sum(1 for r in rows if r.arm == "control")
    n_t = sum(1 for r in rows if r.arm == "treatment")

    c_rate_sum = np.zeros(N_BOOTSTRAP_RESAMPLES)
    t_rate_sum = np.zeros(N_BOOTSTRAP_RESAMPLES)
    c_value_sum = np.zeros(N_BOOTSTRAP_RESAMPLES)
    t_value_sum = np.zeros(N_BOOTSTRAP_RESAMPLES)

    rng = np.random.default_rng(seed + 3)
    for key in sorted(groups.keys()):
        _cell, _band, arm = key
        idx = np.array(groups[key])
        size = len(idx)
        if size == 0:
            continue
        resample_idx = rng.integers(0, size, size=(N_BOOTSTRAP_RESAMPLES, size))
        group_recovered_sum = recovered[idx][resample_idx].sum(axis=1)
        group_value_sum = value[idx][resample_idx].sum(axis=1)
        if arm == "control":
            c_rate_sum += group_recovered_sum
            c_value_sum += group_value_sum
        else:
            t_rate_sum += group_recovered_sum
            t_value_sum += group_value_sum

    rate_diffs_pp = (t_rate_sum / n_t - c_rate_sum / n_c) * 100.0
    value_diffs_paise = t_value_sum / n_t - c_value_sum / n_c
    return rate_diffs_pp, value_diffs_paise


def _bootstrap_and_ztest(
    rows: tuple[TransactionRow, ...], seed: int, bootstrap_method: BootstrapMethod = "stratified"
) -> ExperimentEstimates:
    control = [r for r in rows if r.arm == "control"]
    treatment = [r for r in rows if r.arm == "treatment"]
    n_c, n_t = len(control), len(treatment)

    c_recovered = np.array([r.recovered for r in control], dtype=np.float64)
    t_recovered = np.array([r.recovered for r in treatment], dtype=np.float64)
    c_value = np.array([r.recovered_value_paise for r in control], dtype=np.float64)
    t_value = np.array([r.recovered_value_paise for r in treatment], dtype=np.float64)

    point_rate_pp = (t_recovered.mean() - c_recovered.mean()) * 100.0
    point_value_paise = t_value.mean() - c_value.mean()

    t0 = time.perf_counter()
    if bootstrap_method == "pooled":
        rate_diffs_pp, value_diffs_paise = _bootstrap_pooled(rows, seed)
    elif bootstrap_method == "stratified":
        rate_diffs_pp, value_diffs_paise = _bootstrap_stratified(rows, seed)
    else:
        raise ValueError(f"unknown bootstrap_method {bootstrap_method!r}, expected 'pooled' or 'stratified'")
    wall_time = time.perf_counter() - t0

    if wall_time > BOOTSTRAP_TIME_BUDGET_S:
        raise RuntimeError(
            f"Bootstrap for one experiment took {wall_time:.2f}s, exceeding the "
            f"{BOOTSTRAP_TIME_BUDGET_S:.0f}s budget. Per the task's own instruction: stop "
            f"rather than silently reducing N_BOOTSTRAP_RESAMPLES -- the calibration harness's "
            f"500-replication budget is not achievable at this rate and that must be reported, "
            f"not worked around."
        )

    rate_lo, rate_hi = np.percentile(rate_diffs_pp, BOOTSTRAP_CI_PERCENTILES)
    value_lo, value_hi = np.percentile(value_diffs_paise, BOOTSTRAP_CI_PERCENTILES)

    # The z-test is computed directly from the REAL per-arm counts, never
    # from either bootstrap's resampled distribution -- identical result
    # regardless of bootstrap_method, by construction.
    x1, x2 = t_recovered.sum(), c_recovered.sum()
    p1, p2 = x1 / n_t, x2 / n_c
    p_pool = (x1 + x2) / (n_t + n_c)
    se = np.sqrt(p_pool * (1 - p_pool) * (1.0 / n_t + 1.0 / n_c))
    z = 0.0 if se == 0 else (p1 - p2) / se
    p_value = 2.0 * norm.sf(abs(z))

    return ExperimentEstimates(
        recovery_rate_diff_pp=BootstrapInterval(point_estimate=float(point_rate_pp), lo=float(rate_lo), hi=float(rate_hi)),
        recovered_value_diff_paise=BootstrapInterval(
            point_estimate=float(point_value_paise), lo=float(value_lo), hi=float(value_hi)
        ),
        z_test_secondary=ZTestResult(z_statistic=float(z), p_value=float(p_value)),
        bootstrap_wall_time_s=wall_time,
        bootstrap_method=bootstrap_method,
    )


class ExperimentResult(BaseModel):
    seed: int
    n: int
    amount_band_cutpoints_paise: tuple[int, int]
    rows: tuple[TransactionRow, ...]
    estimates: ExperimentEstimates


def run_experiment(
    n: int = 2000,
    *,
    seed: int,
    policy: PolicyFn | None = None,
    model: RecoveryModel | None = None,
    bootstrap_method: BootstrapMethod = "stratified",
) -> ExperimentResult:
    """Runs one full randomised holdout experiment per
    docs/EXPERIMENT-PROTOCOL.md. `policy` defaults to policy.propose_action
    itself; calibration.py's null condition substitutes a different
    callable to force the true lift to exactly zero by construction (see
    that module and _coupling_guard's own docstring for why this is
    independent of the mandatory guard below).

    `bootstrap_method` defaults to "stratified" (the CORRECTED estimator,
    since 2026-09-01's scale/robustness pass -- respects the
    (grid_cell, amount_band) stratification the arms were actually
    assigned under). "pooled" (the ORIGINAL, unstratified resampling) is
    preserved, not removed, and stays selectable for direct comparison;
    see _bootstrap_pooled's own docstring for the measured over-coverage
    it carries (99.40% observed vs. 95% nominal at N=2000, 500
    replications) and docs/DECISIONS.md for the full diagnosis and the
    stratified fix's measured correction (93.80%). Nothing that reads
    this module's default -- including every dashboard consumer -- may
    assume "pooled" any more; that assumption flipped on this date.

    Raises ValueError immediately, before generate_population is ever
    called, if n < MIN_TRANSACTIONS -- see that constant's own docstring."""
    if n < MIN_TRANSACTIONS:
        raise ValueError(
            f"run_experiment requires n >= {MIN_TRANSACTIONS} (need at least 2 transactions "
            f"per arm to produce an estimate), got {n}"
        )

    active_model = model if model is not None else default_model()
    active_policy: PolicyFn = policy if policy is not None else propose_action

    _coupling_guard(active_model)

    population = generate_population(n, seed=seed)
    amounts = np.array([t.amount_paise for t in population.transactions], dtype=np.float64)
    bands, cutpoints = _amount_bands(amounts)
    grid_cells = np.array([t.grid_cell for t in population.transactions], dtype=object)

    assign_rng = np.random.default_rng(seed + 1)
    arms = _assign_arms(grid_cells, bands, assign_rng)

    n_control = int(np.sum(arms == "control"))
    n_treatment = int(np.sum(arms == "treatment"))
    if n_control < 2 or n_treatment < 2:
        raise RuntimeError(
            f"run_experiment(n={n}) produced {n_control} control / {n_treatment} treatment "
            f"transactions after stratified assignment -- below the 2-per-arm floor "
            f"MIN_TRANSACTIONS is meant to guarantee. _assign_arms balances PER STRATUM, not "
            f"globally, so a pathological small-n case can still fall below the floor even "
            f"above it; this is that case caught explicitly rather than flowing a degenerate "
            f"estimate downstream."
        )

    outcome_rng = np.random.default_rng(seed + 2)
    rows: list[TransactionRow] = []
    for i, txn in enumerate(population.transactions):
        arm = str(arms[i])
        if arm == "control":
            action = CONTROL_ACTION
        else:
            diagnosis = Diagnosis(
                error_source=txn.error_source,
                error_step=txn.error_step,
                amount_paise=txn.amount_paise,
                hour_ist=txn.hour_ist,
                attempt_number=txn.attempt_number,
            )
            action = active_policy(diagnosis, active_model).action

        row = simulate_transaction(txn, action, arm, str(bands[i]), f"{seed}-{i}", outcome_rng)
        rows.append(row)

    estimates = _bootstrap_and_ztest(tuple(rows), seed, bootstrap_method)

    return ExperimentResult(
        seed=seed,
        n=n,
        amount_band_cutpoints_paise=cutpoints,
        rows=tuple(rows),
        estimates=estimates,
    )
