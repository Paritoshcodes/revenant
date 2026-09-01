"""The calibration harness: the one claim in this project no competitor
can make, because it requires authoring the world and knowing the true
answer in advance. Runs the whole randomised holdout experiment
(experiment.py) `replications` times under two conditions and checks
whether the bootstrap interval behaves the way a correctly-calibrated
95% interval should -- per docs/EXPERIMENT-PROTOCOL.md's "## Calibration
check", FROZEN, read in full before this module was written.

NOTHING HERE IS TUNED TOWARD 95%. If observed coverage departs from
nominal, that is reported as a finding about the estimator -- see
run_calibration's own docstring and docs/DECISIONS.md for the measured
result. Adjusting the bootstrap method, resample count, interval type,
or replication count to move a number toward 95% would invalidate the
entire exercise; nothing in this module does that.

SAME SEEDS FOR BOTH CONDITIONS, on purpose. The `replications` experiment
seeds are derived once from `master_seed` and reused, unchanged, for both
the coverage condition (the real treatment policy) and the null condition
(treatment forced to equal control). This means both conditions run over
the IDENTICAL populations and the IDENTICAL arm assignments -- the only
thing that differs between them is the policy substitution itself. Any
difference in behaviour between the two conditions is therefore
attributable to that one change, not to two different sets of sampled
worlds. This costs nothing and is strictly more informative than fresh
seeds per condition would be.
"""

from __future__ import annotations

import time

import numpy as np
from pydantic import BaseModel
from revenant_contracts import grid_cell as build_grid_cell

from .classifier_eval import wilson_interval
from .experiment import CONTROL_ACTION, BootstrapMethod, run_experiment
from .model import RecoveryModel, default_model
from .policy import Diagnosis, ProposedAction
from .true_lift import compute_true_lift


def _derive_seeds(master_seed: int, replications: int) -> list[int]:
    """`replications` deterministic seeds from one master seed -- the
    whole calibration run re-derives from `master_seed` alone. Collision
    probability across `replications` draws from a ~2**62 space is
    astronomically small and is not specially guarded against; a
    collision would just duplicate one replication, not break
    determinism."""
    rng = np.random.default_rng(master_seed)
    return [int(s) for s in rng.integers(1, 2**62, size=replications)]


def _null_policy(diagnosis: Diagnosis, model: RecoveryModel | None = None) -> ProposedAction:
    """The null condition's treatment policy: ALWAYS retry_with_backoff,
    matching control's own action exactly, on every cell, so the true
    lift is exactly zero BY CONSTRUCTION -- not by estimation, and not by
    setting ground-truth.json values to anything artificial. Arm
    assignment stays fully randomised; only the treatment arm's chosen
    action changes. `recovery_probability` is set to 0.0 unused here --
    experiment.py's simulation only ever reads `.action` off a policy's
    return value; the real outcome comes from outcomes.recovers against
    the frozen ground truth, never from this field. Skipping a real
    model.predict_proba call here also matters at scale: this function
    runs once per treatment-arm transaction, across 500 replications."""
    cell = build_grid_cell(diagnosis.error_source, diagnosis.error_step)
    return ProposedAction(grid_cell=cell, action=CONTROL_ACTION, recovery_probability=0.0, propensity=1.0)


class CalibrationCondition(BaseModel):
    replications: int
    master_seed: int
    #: coverage: true_lift.compute_true_lift().net_true_lift_pp, called
    #: once, never hardcoded. null: exactly 0.0, by construction.
    estimand: float
    #: Fraction of `replications` 95% bootstrap intervals for estimate
    #: (a) containing `estimand` -- coverage condition's "coverage,"
    #: null condition's "contains zero" rate. Same field, same meaning
    #: either way: "did the interval contain the truth."
    coverage_rate: float
    coverage_wilson_lo: float
    coverage_wilson_hi: float
    #: Null condition only: fraction of replications where the
    #: two-proportion z-test rejects at the 5% level. None for coverage.
    rejection_rate: float | None
    rejection_wilson_lo: float | None
    rejection_wilson_hi: float | None
    #: Mean and standard deviation of the `replications` individual point
    #: estimates of (a) -- collected for BOTH conditions. Separates "the
    #: bootstrap under/over-covers" from "the simulation itself is
    #: biased": if sample_mean_estimate_pp sits materially away from
    #: `estimand`, that is bias in the simulation, not a property of the
    #: bootstrap, and the two failure modes look identical from
    #: coverage_rate alone.
    sample_mean_estimate_pp: float
    sample_std_estimate_pp: float
    #: Bootstrap-implied standard error, per replication (interval
    #: half-width / 1.96), averaged across `replications` -- compared
    #: against sample_std_estimate_pp (the EMPIRICAL between-replication
    #: SD, i.e. the ground truth) in docs/DECISIONS.md's diagnosis. A
    #: well-calibrated bootstrap's mean implied SE should approach the
    #: empirical SD; _bootstrap_pooled's did not, _bootstrap_stratified's
    #: is what this field exists to check.
    mean_bootstrap_implied_se_pp: float
    bootstrap_method: BootstrapMethod
    #: Per-replication diagnostics, exposed for exactly the kind of
    #: question this project's own zero-abstraction ethos demands being
    #: answerable: "are the replications whose interval excluded the
    #: estimand the SAME replications where the z-test rejected, or is
    #: an equal rate a coincidence at this N?" `z_rejected` is all-None
    #: for the coverage condition (check_rejection=False there).
    per_replication_contains: tuple[bool, ...]
    per_replication_z_rejected: tuple[bool | None, ...]
    wall_time_s: float


class CalibrationResult(BaseModel):
    master_seed: int
    replications: int
    coverage: CalibrationCondition
    null: CalibrationCondition


def _run_condition(
    seeds: list[int],
    model: RecoveryModel,
    estimand: float,
    bootstrap_method: BootstrapMethod,
    policy=None,
    check_rejection: bool = False,
) -> CalibrationCondition:
    point_estimates: list[float] = []
    implied_ses: list[float] = []
    per_contains: list[bool] = []
    per_z_rejected: list[bool | None] = []
    contains = 0
    rejections = 0

    t0 = time.perf_counter()
    for s in seeds:
        result = run_experiment(n=2000, seed=s, policy=policy, model=model, bootstrap_method=bootstrap_method)
        est = result.estimates.recovery_rate_diff_pp
        point_estimates.append(est.point_estimate)
        implied_ses.append((est.hi - est.lo) / 2.0 / 1.959963984540054)
        did_contain = est.lo <= estimand <= est.hi
        per_contains.append(did_contain)
        if did_contain:
            contains += 1
        if check_rejection:
            did_reject = result.estimates.z_test_secondary.p_value < 0.05
            per_z_rejected.append(did_reject)
            if did_reject:
                rejections += 1
        else:
            per_z_rejected.append(None)
    wall_time = time.perf_counter() - t0

    n = len(seeds)
    cov_lo, cov_hi = wilson_interval(contains, n)
    arr = np.array(point_estimates, dtype=np.float64)

    rejection_rate = rejection_lo = rejection_hi = None
    if check_rejection:
        rejection_rate = rejections / n
        rejection_lo, rejection_hi = wilson_interval(rejections, n)

    condition = CalibrationCondition(
        replications=n,
        master_seed=0,  # filled in by the caller
        estimand=estimand,
        coverage_rate=contains / n,
        coverage_wilson_lo=cov_lo,
        coverage_wilson_hi=cov_hi,
        rejection_rate=rejection_rate,
        rejection_wilson_lo=rejection_lo,
        rejection_wilson_hi=rejection_hi,
        sample_mean_estimate_pp=float(arr.mean()),
        sample_std_estimate_pp=float(arr.std(ddof=1)) if n > 1 else 0.0,
        mean_bootstrap_implied_se_pp=float(np.mean(implied_ses)),
        bootstrap_method=bootstrap_method,
        per_replication_contains=tuple(per_contains),
        per_replication_z_rejected=tuple(per_z_rejected),
        wall_time_s=wall_time,
    )
    return condition


def run_calibration(
    replications: int = 500,
    *,
    master_seed: int,
    model: RecoveryModel | None = None,
    bootstrap_method: BootstrapMethod = "pooled",
) -> CalibrationResult:
    """Runs both calibration conditions per docs/EXPERIMENT-PROTOCOL.md's
    "## Calibration check", over the SAME `replications` seeds (see this
    module's own top docstring for why). The model is trained ONCE and
    passed into every one of the `2 * replications` experiment calls --
    retraining per replication would be wasteful and would make each
    replication's policy differ, which is not what calibration measures.

    `bootstrap_method` (default "pooled", matching experiment.py's own
    default) selects which of experiment.py's two bootstrap
    implementations every one of those `2 * replications` calls uses --
    see docs/DECISIONS.md for the measured pooled-vs-stratified
    comparison this parameter exists to reproduce on demand.

    NO TUNING TOWARD 95% happens anywhere in this function or in
    experiment.py's own bootstrap. If coverage_rate or the null
    condition's rates depart from nominal, that is the measured result --
    report it as a finding (docs/DECISIONS.md), never adjust the method
    to chase 95%.
    """
    active_model = model if model is not None else default_model()
    seeds = _derive_seeds(master_seed, replications)
    estimand = compute_true_lift().net_true_lift_pp

    coverage = _run_condition(seeds, active_model, estimand, bootstrap_method, policy=None, check_rejection=False)
    coverage = coverage.model_copy(update={"master_seed": master_seed})

    null = _run_condition(seeds, active_model, 0.0, bootstrap_method, policy=_null_policy, check_rejection=True)
    null = null.model_copy(update={"master_seed": master_seed})

    return CalibrationResult(master_seed=master_seed, replications=replications, coverage=coverage, null=null)
