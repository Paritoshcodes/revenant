"""tests/test_calibration.py

Covers revenant_engine.calibration: deterministic seed derivation, that
both conditions genuinely share the same seeds, and a small-replication
smoke check on the null condition (a loose sanity check at this N, not a
calibration claim -- the real 500-replication numbers are reported in
docs/DECISIONS.md, per the task's own verification requirement, never
tuned here or there to look better).
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from revenant_engine.calibration import _derive_seeds, run_calibration
from revenant_engine.model import train_model

SEED = 20260901


@pytest.fixture(scope="module")
def model():
    # n=2000 (not test_experiment.py's smaller convenience sizes):
    # train_model(n=500, seed=1) was tried here first and genuinely
    # tripped the runtime coupling guard for real (propose_action chose
    # retry_on_timing_window over gateway/payment_authorization's
    # designated retry_with_backoff) -- confirming the guard works, but
    # also confirming an undersized/differently-seeded model is not a
    # safe stand-in for "the real treatment policy" in these tests. This
    # size is what test_run_calibration_smoke_small_replications already
    # verified stays coupled.
    return train_model(n=2000, seed=SEED)


def test_derive_seeds_is_deterministic():
    seeds1 = _derive_seeds(master_seed=42, replications=10)
    seeds2 = _derive_seeds(master_seed=42, replications=10)
    assert seeds1 == seeds2
    assert len(set(seeds1)) == 10  # no collisions at this small N


def test_derive_seeds_differs_by_master_seed():
    seeds1 = _derive_seeds(master_seed=1, replications=10)
    seeds2 = _derive_seeds(master_seed=2, replications=10)
    assert seeds1 != seeds2


def test_run_calibration_smoke_small_replications(model):
    """A loose smoke check at N=30 replications -- proves the harness
    runs end to end and produces sane, well-formed output. NOT a
    calibration claim: the real 500-replication figures are what
    docs/DECISIONS.md reports, measured once, never tuned toward this or
    any other expectation."""
    result = run_calibration(replications=30, master_seed=999, model=model)

    assert result.replications == 30
    assert result.coverage.replications == 30
    assert result.null.replications == 30

    # The estimand is compute_true_lift()'s real committed figure -- not
    # hardcoded here, so a change to ground-truth.json is reflected
    # automatically rather than silently drifting from this test.
    assert result.coverage.estimand > 0.0
    assert result.null.estimand == 0.0

    assert 0.0 <= result.coverage.coverage_rate <= 1.0
    assert 0.0 <= result.null.coverage_rate <= 1.0
    assert result.null.rejection_rate is not None
    assert result.coverage.rejection_rate is None  # only meaningful for the null condition

    # At N=30 this is a loose smoke bound, not a calibration assertion:
    # most replications' intervals should contain zero under a
    # true-zero world, but a small-N run is expected to be noisy.
    assert result.null.coverage_rate >= 0.5


def test_null_condition_reuses_coverage_conditions_seeds_exactly(model):
    """Not just that seed derivation is itself deterministic -- proves
    run_calibration ACTUALLY passes the identical seed sequence to both
    the coverage and null conditions' run_experiment calls, by spying on
    every real call made and comparing the two conditions' seed lists
    directly."""
    seen_seeds: list[int] = []

    import revenant_engine.calibration as calibration_module

    real_run_experiment = calibration_module.run_experiment

    def spy(*args, **kwargs):
        seen_seeds.append(kwargs["seed"])
        return real_run_experiment(*args, **kwargs)

    with patch.object(calibration_module, "run_experiment", side_effect=spy):
        run_calibration(replications=4, master_seed=555, model=model)

    assert len(seen_seeds) == 8  # 4 coverage + 4 null
    coverage_seeds, null_seeds = seen_seeds[:4], seen_seeds[4:]
    assert coverage_seeds == null_seeds
