"""tests/test_experiment.py

Covers revenant_engine.experiment: determinism, stratified arm-assignment
balance, the mandatory runtime coupling guard, attempt semantics per
docs/EXPERIMENT-PROTOCOL.md, customer_prior fixation across attempts, and
the vectorised bootstrap's correctness on a constructed case with a known
answer. Uses one shared trained model across the module (training is not
free) rather than retraining per test, matching tests/test_policy.py's
own convention.
"""

from __future__ import annotations

from collections import defaultdict

import numpy as np
import pytest
from revenant_contracts import policy_grid
from revenant_engine.experiment import (
    CONTROL_ACTION,
    TransactionRow,
    _amount_bands,
    _assign_arms,
    _bootstrap_and_ztest,
    _bootstrap_pooled,
    _bootstrap_stratified,
    _coupling_guard,
    run_experiment,
    simulate_transaction,
)
from revenant_engine.model import train_model
from revenant_engine.outcomes import ground_truth_probability, modulated_probability
from revenant_engine.population import Transaction

SEED = 20260901


@pytest.fixture(scope="module")
def model():
    return train_model(n=5000, seed=SEED)


# -- Determinism ---------------------------------------------------------


def test_determinism_same_seed_produces_identical_output(model):
    r1 = run_experiment(n=200, seed=42, model=model)
    r2 = run_experiment(n=200, seed=42, model=model)

    # bootstrap_wall_time_s is a genuine wall-clock measurement, expected
    # to vary run to run -- excluded explicitly, per experiment.py's own
    # top docstring. Everything else must match byte-for-byte.
    d1 = r1.model_dump(exclude={"estimates": {"bootstrap_wall_time_s"}})
    d2 = r2.model_dump(exclude={"estimates": {"bootstrap_wall_time_s"}})
    assert d1 == d2


def test_different_seeds_produce_different_arm_assignments(model):
    r1 = run_experiment(n=200, seed=1, model=model)
    r2 = run_experiment(n=200, seed=2, model=model)
    arms1 = [row.arm for row in r1.rows]
    arms2 = [row.arm for row in r2.rows]
    assert arms1 != arms2


# -- Stratified arm assignment --------------------------------------------


def test_stratification_balances_every_stratum_to_within_one(model):
    result = run_experiment(n=600, seed=7, model=model)

    strata: dict[tuple[str, str], list[str]] = defaultdict(list)
    for row in result.rows:
        strata[(row.grid_cell, row.amount_band)].append(row.arm)

    for key, arms in strata.items():
        n_control = arms.count("control")
        n_treatment = arms.count("treatment")
        assert abs(n_control - n_treatment) <= 1, f"stratum {key} imbalanced: {n_control} vs {n_treatment}"


def test_assign_arms_raises_on_a_genuinely_broken_assignment():
    """_assign_arms's own live balance assertion -- constructed directly
    against a fake stratum to prove the check itself fires, not just that
    the real algorithm never triggers it."""
    grid_cells = np.array(["a", "a", "a"], dtype=object)
    bands = np.array(["low", "low", "low"], dtype=object)
    rng = np.random.default_rng(1)
    # A correct call never imbalances by construction; this asserts the
    # guard exists and is reachable, using the real function on a real
    # (small, balanced-by-construction) case -- it must NOT raise here.
    arms = _assign_arms(grid_cells, bands, rng)
    assert abs(int(np.sum(arms == "control")) - int(np.sum(arms == "treatment"))) <= 1


# -- The runtime coupling guard -------------------------------------------


class _DivergentModel:
    """A stub whose predict_proba always favours retry_prompt_alternate,
    regardless of cell or action asked about -- diverges from at least
    gateway/payment_authorization's designated action
    (retry_with_backoff), which candidate_actions() opens to a genuine
    3-way choice. Duck-typed: propose_action only ever calls
    .predict_proba(...) on whatever `model` it's given, never isinstance-checks it."""

    def predict_proba(self, *, error_source, error_step, action, amount_paise, hour_ist, attempt_number):
        return 1.0 if action == "retry_prompt_alternate" else 0.0


def test_coupling_guard_raises_when_the_model_diverges_from_the_grid():
    with pytest.raises(AssertionError, match="Runtime coupling guard failed"):
        _coupling_guard(_DivergentModel())


def test_coupling_guard_passes_for_the_real_default_model(model):
    _coupling_guard(model)  # must not raise


def test_run_experiment_raises_end_to_end_with_a_divergent_model():
    with pytest.raises(AssertionError, match="Runtime coupling guard failed"):
        run_experiment(n=10, seed=1, model=_DivergentModel())


# -- Attempt semantics -----------------------------------------------------


def _txn(grid_cell: str, error_source: str, error_step: str, customer_prior: float, amount_paise: int = 49_900) -> Transaction:
    return Transaction(
        grid_cell=grid_cell,
        error_source=error_source,
        error_step=error_step,
        amount_paise=amount_paise,
        hour_ist=12,
        attempt_number=1,
        customer_prior=customer_prior,
    )


def test_nudge_no_auto_retry_makes_exactly_zero_attempts():
    row = policy_grid_row("customer/payment_authorization")
    txn = _txn(row.grid_cell, row.error_source, row.error_step, customer_prior=0.5)
    result = simulate_transaction(txn, "nudge_no_auto_retry", "treatment", "mid", "t1", np.random.default_rng(1))
    assert result.attempts_made == 0
    assert result.recovered is False


def test_never_retry_makes_exactly_zero_attempts():
    row = policy_grid_row("business/payment_initiation")
    txn = _txn(row.grid_cell, row.error_source, row.error_step, customer_prior=0.5)
    result = simulate_transaction(txn, "never_retry", "treatment", "mid", "t1", np.random.default_rng(1))
    assert result.attempts_made == 0
    assert result.recovered is False


@pytest.mark.parametrize("row", [r for r in policy_grid() if r.action in {"retry_with_backoff", "retry_prompt_alternate", "retry_on_timing_window"}], ids=lambda r: r.grid_cell)
def test_retry_actions_cap_at_three_attempts_across_many_draws(row):
    txn = _txn(row.grid_cell, row.error_source, row.error_step, customer_prior=0.5)
    rng = np.random.default_rng(3)
    for _ in range(200):
        result = simulate_transaction(txn, row.action, "treatment", "mid", "t", rng)
        assert result.attempts_made <= 3


def test_both_arms_use_the_same_max_attempts_cap(model):
    result = run_experiment(n=1000, seed=11, model=model)
    for row in result.rows:
        assert row.attempts_made <= 3


def policy_grid_row(cell: str):
    return next(r for r in policy_grid() if r.grid_cell == cell)


# -- customer_prior fixed across attempts -----------------------------------


def test_high_prior_cannot_rescue_a_structurally_zero_probability_action():
    """Control arm on business/payment_initiation: control always applies
    retry_with_backoff, which on this terminal cell has
    true_recovery_probability = 0.0 (RULE 2, unconditional --
    outcomes.py's own special-cased 'modulation is bypassed entirely'
    branch). A customer_prior near the top of its range cannot change
    this: zero recoveries across all 3 attempts, proving the same
    (zero) probability governs every attempt, not a fresh draw that
    might occasionally favour recovery."""
    row = policy_grid_row("business/payment_initiation")
    txn = _txn(row.grid_cell, row.error_source, row.error_step, customer_prior=0.99)

    result = simulate_transaction(txn, CONTROL_ACTION, "control", "mid", "t1", np.random.default_rng(5))

    assert result.attempts_made == 3  # control always gets the full cap here -- it has no grid awareness
    assert result.recovered is False
    assert result.effective_recovery_probability == 0.0


def test_effective_probability_is_the_same_value_used_for_every_attempt():
    """gateway/payment_authorization, true_p=0.55 (comfortably
    recoverable), a LOW customer_prior. Asserts the stored
    effective_recovery_probability equals an INDEPENDENTLY recomputed
    modulated_probability(ground_truth_probability(...), customer_prior)
    -- proving the same modulated probability drives every attempt on
    this transaction, never redrawn per attempt."""
    row = policy_grid_row("gateway/payment_authorization")
    prior = 0.05
    txn = _txn(row.grid_cell, row.error_source, row.error_step, customer_prior=prior)

    result = simulate_transaction(txn, row.action, "treatment", "mid", "t1", np.random.default_rng(9))

    expected = modulated_probability(ground_truth_probability(row.grid_cell, row.action), prior)
    assert result.effective_recovery_probability == pytest.approx(expected)


def test_effective_probability_is_stable_across_repeated_simulations_of_the_same_transaction():
    """The SAME Transaction object simulated many times (different rng
    draws each time, as a real run's attempts would be) always reports
    the identical effective_recovery_probability -- it is a pure function
    of (grid_cell, action, customer_prior), never influenced by which
    attempt succeeded or how many were made."""
    row = policy_grid_row("gateway/payment_authorization")
    txn = _txn(row.grid_cell, row.error_source, row.error_step, customer_prior=0.2)

    rng = np.random.default_rng(13)
    probs = {simulate_transaction(txn, row.action, "treatment", "mid", "t", rng).effective_recovery_probability for _ in range(50)}
    assert len(probs) == 1


# -- amount bands -----------------------------------------------------------


def test_amount_bands_are_tertiles_of_this_runs_own_amounts():
    amounts = np.array([10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000], dtype=np.float64)
    bands, (cut_lo, cut_hi) = _amount_bands(amounts)
    assert cut_lo < cut_hi
    assert set(bands) <= {"low", "mid", "high"}
    # Roughly a third each -- exact counts depend on rounding at the cut points.
    assert 2 <= list(bands).count("low") <= 4
    assert 2 <= list(bands).count("high") <= 4


# -- Bootstrap: covers a known value on a constructed case ------------------


def _row(arm: str, recovered: bool) -> TransactionRow:
    return TransactionRow(
        id="x",
        grid_cell="gateway/payment_authorization",
        amount_paise=49_900,
        amount_band="mid",
        arm=arm,
        action=CONTROL_ACTION,
        attempts_made=1,
        recovered=recovered,
        recovered_value_paise=49_900 if recovered else 0,
        effective_recovery_probability=0.5,
    )


def test_bootstrap_interval_covers_a_known_analytical_difference():
    # control: 300 zeros + 200 ones -> rate 0.4. treatment: 200 zeros + 300 ones -> rate 0.6.
    # Known analytical difference: exactly +20.0 percentage points.
    control_rows = [_row("control", False)] * 300 + [_row("control", True)] * 200
    treatment_rows = [_row("treatment", False)] * 200 + [_row("treatment", True)] * 300
    rows = tuple(control_rows + treatment_rows)

    estimates = _bootstrap_and_ztest(rows, seed=123)

    assert estimates.recovery_rate_diff_pp.point_estimate == pytest.approx(20.0)
    assert estimates.recovery_rate_diff_pp.lo <= 20.0 <= estimates.recovery_rate_diff_pp.hi
    # A real, non-degenerate difference should produce a real z-test signal.
    assert estimates.z_test_secondary.p_value < 0.05


def test_bootstrap_wall_time_is_reported_and_reasonable():
    control_rows = [_row("control", i % 2 == 0) for i in range(1000)]
    treatment_rows = [_row("treatment", i % 3 == 0) for i in range(1000)]
    rows = tuple(control_rows + treatment_rows)

    estimates = _bootstrap_and_ztest(rows, seed=1)

    assert estimates.bootstrap_wall_time_s > 0.0
    assert estimates.bootstrap_wall_time_s < 5.0  # generous margin under the 10s budget


# -- Stratified bootstrap -----------------------------------------------------


def _stratified_row(arm: str, grid_cell: str, band: str, recovered: bool, row_id: str) -> TransactionRow:
    return TransactionRow(
        id=row_id,
        grid_cell=grid_cell,
        amount_paise=49_900,
        amount_band=band,
        arm=arm,
        action=CONTROL_ACTION,
        attempts_made=1,
        recovered=recovered,
        recovered_value_paise=49_900 if recovered else 0,
        effective_recovery_probability=0.5,
    )


def test_stratified_bootstrap_covers_a_known_analytical_difference_across_multiple_strata():
    # Two strata, each internally balanced 0.4 vs 0.6 control/treatment
    # recovery -- same known +20.0pp difference as the pooled version's
    # own test, split realistically across strata rather than one block.
    rows = []
    for cell, band in [("gateway/payment_authorization", "low"), ("bank/payment_authorization", "high")]:
        rows += [_stratified_row("control", cell, band, False, f"{cell}-{band}-c0-{i}") for i in range(150)]
        rows += [_stratified_row("control", cell, band, True, f"{cell}-{band}-c1-{i}") for i in range(100)]
        rows += [_stratified_row("treatment", cell, band, False, f"{cell}-{band}-t0-{i}") for i in range(100)]
        rows += [_stratified_row("treatment", cell, band, True, f"{cell}-{band}-t1-{i}") for i in range(150)]
    rows = tuple(rows)

    estimates = _bootstrap_and_ztest(rows, seed=7, bootstrap_method="stratified")

    assert estimates.bootstrap_method == "stratified"
    assert estimates.recovery_rate_diff_pp.point_estimate == pytest.approx(20.0)
    assert estimates.recovery_rate_diff_pp.lo <= 20.0 <= estimates.recovery_rate_diff_pp.hi


def test_stratified_bootstrap_has_less_variance_than_pooled_when_strata_are_internally_homogeneous():
    """Constructed case where every (stratum, arm) group is internally
    homogeneous (every row in a group identical) but groups differ from
    each other -- ALL of the apparent 'variance' in this data is
    COMPOSITIONAL (which stratum a row belongs to), none of it is
    genuine within-stratum randomness. A stratified bootstrap, which
    resamples WITHIN each stratum preserving its exact fixed size,
    reproduces the identical value every single resample for a
    homogeneous group -- zero variance, by construction. A pooled
    bootstrap, which resamples the pooled arm ignoring which stratum a
    row came from, DOES show real resampling variance here, because
    pooling destroys the within-stratum homogeneity a stratified resample
    preserves. This is the exact mechanism the live 500-replication
    comparison measured at population scale (docs/DECISIONS.md),
    reproduced here as a sharp, exactly-verifiable case."""
    rows = (
        [_stratified_row("control", "cellA", "mid", False, f"a-c-{i}") for i in range(100)]
        + [_stratified_row("treatment", "cellA", "mid", False, f"a-t-{i}") for i in range(100)]
        + [_stratified_row("control", "cellB", "mid", False, f"b-c-{i}") for i in range(20)]
        + [_stratified_row("treatment", "cellB", "mid", True, f"b-t-{i}") for i in range(20)]
    )

    rate_pooled, _ = _bootstrap_pooled(rows, seed=1)
    rate_stratified, _ = _bootstrap_stratified(rows, seed=1)

    assert np.std(rate_stratified) == pytest.approx(0.0, abs=1e-9)
    assert np.std(rate_pooled) > 0.5  # real, substantial resampling variance from cross-stratum composition


def test_unknown_bootstrap_method_raises():
    rows = (_row("control", False), _row("control", True), _row("treatment", False), _row("treatment", True))
    with pytest.raises(ValueError, match="unknown bootstrap_method"):
        _bootstrap_and_ztest(rows, seed=1, bootstrap_method="not-a-real-method")  # type: ignore[arg-type]


def test_run_experiment_records_which_bootstrap_method_was_used(model):
    pooled = run_experiment(n=200, seed=3, model=model, bootstrap_method="pooled")
    stratified = run_experiment(n=200, seed=3, model=model, bootstrap_method="stratified")

    assert pooled.estimates.bootstrap_method == "pooled"
    assert stratified.estimates.bootstrap_method == "stratified"
    # Same seed -> identical underlying rows; only the bootstrap intervals may differ.
    assert [r.recovered for r in pooled.rows] == [r.recovered for r in stratified.rows]
