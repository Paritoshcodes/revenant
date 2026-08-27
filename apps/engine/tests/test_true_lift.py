"""tests/test_true_lift.py

Cross-checks revenant_engine.true_lift's quadrature-based figures against
an INDEPENDENT Monte Carlo simulation of the same world -- a second,
separately-implemented numerical method, not a second call into the same
code path, so a bug in the quadrature integration (or in this test) cannot
hide behind agreement with itself. This is the test docs/DECISIONS.md's
2026-08-27 "corrected true-lift figure" entry promises: the two can never
silently diverge again.

N=400,000 matches the scale of the independent verification that caught
the original hand-computed figure being wrong.
"""

from __future__ import annotations

import numpy as np
import pytest
from revenant_contracts import policy_grid
from revenant_engine.outcomes import ground_truth_probability
from revenant_engine.true_lift import (
    CONTROL_ACTION,
    attempts_for_action,
    compute_true_lift,
)

N = 400_000
SEED = 20260827
_MEAN_PRIOR_LOGIT = np.log(0.4 / 0.6)


def _vectorized_modulated_probability(p_true: float, priors: np.ndarray) -> np.ndarray:
    """Independent numpy reimplementation of outcomes.modulated_probability's
    logit-shift formula -- deliberately NOT importing that function, so this
    test verifies the underlying math a second way rather than just
    re-running the same code."""
    if p_true <= 0.0 or p_true >= 1.0:
        return np.full_like(priors, p_true)
    eps = 1e-9
    clipped = np.clip(priors, eps, 1.0 - eps)
    logit = np.log(clipped / (1.0 - clipped))
    shift = logit - _MEAN_PRIOR_LOGIT
    p_true_logit = np.log(p_true / (1.0 - p_true))
    return 1.0 / (1.0 + np.exp(-(p_true_logit + shift)))


def _monte_carlo_realised_probability(
    grid_cell: str, action: str, rng: np.random.Generator, n: int = N
) -> tuple[float, float]:
    """Returns (estimate, standard_error) for P(recovers within K attempts),
    simulated directly: draw N customer_priors, draw K Bernoulli attempts
    per customer at that customer's own modulated probability, success if
    any attempt recovers."""
    p_true = ground_truth_probability(grid_cell, action)
    k = attempts_for_action(action)

    if p_true <= 0.0 or k == 0:
        return 0.0, 0.0

    priors = rng.beta(2.0, 3.0, size=n)
    p_effective = _vectorized_modulated_probability(p_true, priors)

    attempts = rng.random((n, k)) < p_effective[:, None]
    recovered = attempts.any(axis=1)

    estimate = float(recovered.mean())
    standard_error = float(np.sqrt(estimate * (1 - estimate) / n))
    return estimate, standard_error


@pytest.mark.parametrize("row", list(policy_grid()), ids=lambda row: row.grid_cell)
def test_quadrature_matches_independent_monte_carlo_per_cell(row):
    rng = np.random.default_rng(SEED)
    report = compute_true_lift()
    cell = next(c for c in report.cells if c.grid_cell == row.grid_cell)

    control_mc, control_se = _monte_carlo_realised_probability(row.grid_cell, CONTROL_ACTION, rng)
    treatment_mc, treatment_se = _monte_carlo_realised_probability(row.grid_cell, row.action, rng)

    # 5 standard errors is a wide, deliberately conservative band (a truly
    # random MC/quadrature disagreement would clear it well under 1% of
    # the time for a single comparison); the point is to catch a
    # methodology bug, not to chase Monte Carlo noise.
    control_tolerance = max(5 * control_se, 1e-4)
    treatment_tolerance = max(5 * treatment_se, 1e-4)

    assert cell.control_realised_probability == pytest.approx(control_mc, abs=control_tolerance)
    assert cell.treatment_realised_probability == pytest.approx(treatment_mc, abs=treatment_tolerance)


def test_net_true_lift_matches_independent_monte_carlo_total():
    """The whole-population figure, not just per-cell -- the number that
    actually goes in the docs."""
    rng = np.random.default_rng(SEED)
    report = compute_true_lift()

    weights = {c.grid_cell: c.weight for c in report.cells}
    mc_net = 0.0
    mc_variance = 0.0
    for row in policy_grid():
        control_mc, control_se = _monte_carlo_realised_probability(row.grid_cell, CONTROL_ACTION, rng)
        treatment_mc, treatment_se = _monte_carlo_realised_probability(row.grid_cell, row.action, rng)
        w = weights[row.grid_cell]
        mc_net += w * (treatment_mc - control_mc)
        mc_variance += (w * control_se) ** 2 + (w * treatment_se) ** 2

    mc_net_pp = mc_net * 100
    mc_tolerance_pp = 5 * (mc_variance**0.5) * 100

    assert report.net_true_lift_pp == pytest.approx(mc_net_pp, abs=max(mc_tolerance_pp, 0.05))


def test_naive_single_attempt_arithmetic_understates_the_negative_drag():
    """Documents, as a running regression check, WHY the hand-computed
    figure (docs/DECISIONS.md, 2026-08-27) was wrong: single-attempt,
    unmodulated arithmetic on the raw config values gives a materially
    smaller drag than the properly-computed one, because it misses both
    the modulation-averaging effect and the multi-attempt compounding."""
    report = compute_true_lift()

    # Raw config values, single attempt, no modulation -- exactly the
    # arithmetic the first (wrong) draft of ground-truth.json's
    # weighted_true_lift block did by hand.
    naive_gap_customer_1 = 0.0 - ground_truth_probability("customer/payment_authorization", CONTROL_ACTION)
    naive_gap_customer_2 = 0.0 - ground_truth_probability(
        "customer/payment_authentication", CONTROL_ACTION
    )
    weights = {c.grid_cell: c.weight for c in report.cells}
    naive_drag_pp = (
        weights["customer/payment_authorization"] * naive_gap_customer_1
        + weights["customer/payment_authentication"] * naive_gap_customer_2
    ) * 100

    computed_drag_pp = report.negative_drag_pp

    assert computed_drag_pp < naive_drag_pp, (
        "expected the properly-computed (modulated, multi-attempt) drag to be "
        "materially more negative than naive single-attempt config arithmetic"
    )
