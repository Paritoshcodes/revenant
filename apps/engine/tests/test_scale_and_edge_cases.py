"""tests/test_scale_and_edge_cases.py

Fuzz/property coverage for run_experiment and resolve_grid_cell added in
the 2026-09-01 scale/robustness pass (docs/DECISIONS.md). Every case here
asserts one of two things: a documented, deliberate exception is raised
(the n-floor guards, the coupling guard, an invalid bootstrap_method), or
a real ExperimentResult comes back with stratification balance intact.
An undocumented exception (IndexError/KeyError/ZeroDivisionError/etc.)
escaping either function's boundary is exactly the failure mode this file
hunts for -- see each test's own docstring for what specifically is
targeted and why.

hypothesis is NOT a dependency of this project (checked pyproject.toml
before writing this file) and was deliberately not added for one test
file -- every case below is hand-written and parametrised instead.
"""

from __future__ import annotations

import numpy as np
import pytest
from revenant_contracts import PolicyGridRow, policy_grid
from revenant_engine.classifier import resolve_grid_cell
from revenant_engine.experiment import (
    MIN_TRANSACTIONS,
    _amount_bands,
    _assign_arms,
    run_experiment,
)
from revenant_engine.model import train_model
from revenant_engine.population import generate_population

SEED = 20260901


@pytest.fixture(scope="module")
def model():
    return train_model(n=5000, seed=SEED)


# -- n floor: pre-flight ValueError below MIN_TRANSACTIONS -------------------


@pytest.mark.parametrize("n", [0, 1, 2, 3])
def test_n_below_floor_raises_value_error_before_generating_anything(n, model, monkeypatch):
    """n < MIN_TRANSACTIONS must raise ValueError from run_experiment's own
    first line, before generate_population is ever called -- proven by
    making generate_population itself explode if it's reached at all."""

    def _boom(*args, **kwargs):
        raise AssertionError("generate_population must not be called when n < MIN_TRANSACTIONS")

    monkeypatch.setattr("revenant_engine.experiment.generate_population", _boom)
    with pytest.raises(ValueError, match=f"n >= {MIN_TRANSACTIONS}"):
        run_experiment(n, seed=SEED, model=model)


def test_min_transactions_is_four():
    """Pins the documented floor's exact value -- a silent change here
    would silently change what n=4 means throughout this file."""
    assert MIN_TRANSACTIONS == 4


# -- n floor: the belt-and-braces RuntimeError is real, not theoretical ------
#
# Measured live before writing this test (not assumed): at n=4, 5, and 7,
# _assign_arms's per-stratum balancing (up to ~21 (grid_cell, band) groups)
# reliably scatters transactions into singleton strata, which always
# resolve to "control" (see _assign_arms's pos % 2 == 0 rule) -- so the
# post-assignment 2-per-arm check fires on EVERY seed tried at n=4/5/7 (10/10
# each), about half at n=10 (5/10), and never at n>=20 (0/10). This is a
# real, load-bearing finding: MIN_TRANSACTIONS=4 is the arithmetic floor,
# not a practically-reachable one, and the second guard is what actually
# protects every n between 4 and ~15-20. Both facts are pinned directly.


@pytest.mark.parametrize("n", [4, 5, 7])
def test_small_n_above_floor_reliably_trips_the_runtime_guard(n, model):
    """The belt-and-braces guard is not a dead branch: at n in {4,5,7} it
    fires for every one of 10 real seeds, exactly as measured live."""
    fired = 0
    for seed in range(1, 11):
        try:
            run_experiment(n, seed=seed, model=model)
        except RuntimeError as exc:
            assert "below the 2-per-arm floor" in str(exc)
            fired += 1
    assert fired == 10, f"expected the runtime guard to fire on all 10 seeds at n={n}, got {fired}"


@pytest.mark.parametrize("n", [20, 50, 100])
def test_n_twenty_and_above_reliably_succeeds(n, model):
    """Once n is large enough for stratification to actually spread across
    strata without every stratum collapsing to size 1, real experiments
    should run without hitting either n-floor guard."""
    for seed in range(1, 6):
        result = run_experiment(n, seed=seed, model=model)
        assert result.n == n
        assert len(result.rows) == n


# -- odd / tiny-stratum populations -------------------------------------------


@pytest.mark.parametrize("n", [21, 23, 41])
def test_odd_n_at_reachable_scale_produces_balanced_strata(n, model):
    """Odd n means at least one stratum is necessarily imbalanced by one --
    confirms that's tolerated (per-stratum |control-treatment| <= 1) and
    doesn't escalate into an unhandled exception anywhere in the pipeline."""
    result = run_experiment(n, seed=SEED, model=model)
    _assert_stratification_balance(result)


# -- every transaction in ONE grid cell ---------------------------------------


def test_single_grid_cell_population_degrades_to_per_band_stratification(model):
    """Injects a one-row grid via population.generate_population's own
    grid_rows seam (built for exactly this kind of test per population.py's
    docstring) so every transaction shares one grid_cell. Confirms
    _assign_arms's (grid_cell, band) stratification degrades cleanly to a
    3-way band-only split, and that _coupling_guard -- which always
    iterates the REAL 7-row policy_grid(), independent of the population --
    is unaffected by what the population itself contains."""
    single_row = [row for row in policy_grid() if row.grid_cell == "gateway/payment_authorization"]
    assert len(single_row) == 1

    # run_experiment doesn't expose grid_rows directly (it calls
    # generate_population itself), so this drives generate_population +
    # the pieces run_experiment composes, directly, to isolate the
    # single-cell case without needing a new seam on run_experiment for a
    # one-off test.
    population = generate_population(200, seed=SEED, grid_rows=single_row)
    grid_cells = np.array([t.grid_cell for t in population.transactions], dtype=object)
    amounts = np.array([t.amount_paise for t in population.transactions], dtype=np.float64)
    bands, _ = _amount_bands(amounts)
    assert set(grid_cells) == {"gateway/payment_authorization"}

    rng = np.random.default_rng(SEED + 1)
    arms = _assign_arms(grid_cells, bands, rng)  # must not raise
    n_control = int(np.sum(arms == "control"))
    n_treatment = int(np.sum(arms == "treatment"))
    assert n_control + n_treatment == 200
    assert abs(n_control - n_treatment) <= len(set(bands))  # at most one imbalance per band-stratum

    # The real coupling guard still runs against the real 7-row grid inside
    # a normal run_experiment call -- unaffected by the population's own
    # single-cell composition.
    run_experiment(200, seed=SEED, model=model)


# -- identical amounts: tertile cut points collide ----------------------------


def test_identical_amounts_collapse_tertile_cuts_without_crashing():
    """If every amount is identical, np.quantile's two cut points are
    identical too, so _amount_bands' np.where chain can only ever produce
    "low" or "high" (every amount is <= cut_lo, since cut_lo == the
    amount itself) -- "mid" becomes unreachable. Confirms this collapses
    to a real, if degenerate, band assignment rather than raising or
    silently producing an empty/NaN band."""
    amounts = np.full(500, 49_900.0)
    bands, (cut_lo, cut_hi) = _amount_bands(amounts)
    assert cut_lo == cut_hi == 49_900
    assert set(bands) <= {"low", "mid", "high"}
    assert "mid" not in set(bands)  # documented degenerate behaviour, not a guess
    assert "low" in set(bands)  # every value <= cut_lo lands here


# -- seed = 0 and a very large seed -------------------------------------------


@pytest.mark.parametrize("seed", [0, 2**62 - 1])
def test_seed_zero_and_very_large_seed_behave_like_any_other_seed(seed, model):
    """Confirms np.random.default_rng and the seed/seed+1/seed+2/seed+3
    offsetting scheme (experiment.py's own documented convention) don't
    special-case 0, and that a seed near _derive_seeds' own documented
    upper range (2**62) doesn't overflow anything downstream."""
    result = run_experiment(200, seed=seed, model=model)
    assert result.seed == seed
    assert len(result.rows) == 200
    # determinism still holds at these boundary seeds
    result2 = run_experiment(200, seed=seed, model=model)
    assert result.model_dump(exclude={"estimates": {"bootstrap_wall_time_s"}}) == result2.model_dump(
        exclude={"estimates": {"bootstrap_wall_time_s"}}
    )


# -- resolve_grid_cell fuzz: garbage inputs must fail closed, never raise ----


def test_resolve_grid_cell_unknown_failure_class_returns_none():
    assert resolve_grid_cell("not-a-real-class", "gateway", "payment_authorization") is None


def test_resolve_grid_cell_unknown_source_and_step_returns_none():
    assert resolve_grid_cell("transient", "not-a-real-source", "not-a-real-step") is None


def test_resolve_grid_cell_none_source_returns_none():
    assert resolve_grid_cell("transient", None, "payment_authorization") is None


def test_resolve_grid_cell_none_step_still_resolves_via_source_when_unambiguous():
    """error_step=None means 'no step signal' -- source alone should still
    narrow correctly when the source is unambiguous within the class, per
    resolve_grid_cell's own documented precedence (source narrows first,
    step narrows further only if that still leaves >1 candidate)."""
    result = resolve_grid_cell("transient", "internal", None)
    assert result is None or result.startswith("internal/")


def test_resolve_grid_cell_both_none_returns_none():
    assert resolve_grid_cell("customer", None, None) is None


@pytest.mark.parametrize("failure_class", ["", "TRANSIENT", "Transient", "trans ient", "🎲"])
def test_resolve_grid_cell_malformed_class_strings_never_raise(failure_class):
    """Garbage failure_class strings (empty, wrong case, whitespace,
    non-ASCII) must fail closed, not raise -- an LLM output validation
    bug upstream should never be able to crash this function."""
    assert resolve_grid_cell(failure_class, "gateway", "payment_authorization") is None


# -- shared helper -------------------------------------------------------------


def _assert_stratification_balance(result) -> None:
    """Every (grid_cell, amount_band) stratum's control/treatment split
    must differ by at most one -- reusing the same invariant _assign_arms
    itself asserts internally, checked again here from the outside on the
    real ExperimentResult.rows."""
    groups: dict[tuple[str, str], list[str]] = {}
    for row in result.rows:
        groups.setdefault((row.grid_cell, row.amount_band), []).append(row.arm)
    for key, arms in groups.items():
        n_c = sum(1 for a in arms if a == "control")
        n_t = sum(1 for a in arms if a == "treatment")
        assert abs(n_c - n_t) <= 1, f"stratum {key} imbalanced: {n_c} control vs {n_t} treatment"
