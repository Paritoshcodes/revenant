"""tests/test_policy.py

Covers revenant_engine.policy: the grid-permitted-actions constraint
(design (b) -- see policy.py's own module docstring: terminal and
customer/nudge cells stay locked, the four retry-designated cells get a
genuine 3-way comparison), terminal-cell handling, propensity, and
determinism. Uses one shared trained model across the whole module
(training is not free) rather than retraining per test.
"""

from __future__ import annotations

import pytest
from revenant_contracts import policy_grid
from revenant_engine.model import train_model
from revenant_engine.policy import (
    RETRY_ACTIONS,
    STRUCTURAL_ZERO_ACTIONS,
    UNMAPPED_ACTION,
    Diagnosis,
    candidate_actions,
    propose_action,
)

SEED = 20260828


@pytest.fixture(scope="module")
def model():
    # n=5000, matching default_model's own size: the 3-way retry
    # comparison needs enough training data per (cell, action) pair for
    # the interaction term (model.py's cell_action feature) to be fitted
    # reliably, unlike the old singleton design where any model would do.
    return train_model(n=5000, seed=SEED)


@pytest.mark.parametrize("row", list(policy_grid()), ids=lambda row: row.grid_cell)
def test_policy_never_proposes_an_action_outside_candidate_actions_for_that_cell(row, model):
    """The structural invariant design (b) actually guarantees: whatever
    the policy proposes, it is always a member of candidate_actions(row)
    -- never an action the grid doesn't even offer as a candidate for
    that cell (e.g. never a retry on the terminal cell, never anything
    but nudge on a customer cell)."""
    diagnosis = Diagnosis(error_source=row.error_source, error_step=row.error_step)
    proposed = propose_action(diagnosis, model=model)

    assert proposed.grid_cell == row.grid_cell
    assert proposed.action in candidate_actions(row)


@pytest.mark.parametrize("row", list(policy_grid()), ids=lambda row: row.grid_cell)
def test_policy_choice_matches_the_grid_true_lift_couples_the_two(row, model):
    """COUPLING GUARD between policy.py and true_lift.py, not a claim that
    the policy should always follow the grid -- design (b) (see policy.py's
    own module docstring) deliberately allows a genuine argmax on the four
    retry-designated cells to diverge from the grid's own action, and today
    it does not, purely as an empirical fact about the current
    ground-truth.json values.

    docs/EXPERIMENT-PROTOCOL.md's '## Ground truth' section and
    ground-truth.json's own weighted_true_lift block state a computed true
    lift (net +5.47pp) that is defined as control (always
    retry_with_backoff) versus TREATMENT TAKING EACH CELL'S GRID-DESIGNATED
    ACTION -- true_lift.compute_true_lift() literally reads `row.action`
    from the grid, never propose_action's own output. That figure silently
    stops describing what the treatment arm actually does the moment this
    test's assertion fails. A docstring recording that coupling cannot
    itself fail; this test exists so the divergence is loud instead of
    silent -- see the assertion message below for exactly what to do if it
    fires."""
    diagnosis = Diagnosis(error_source=row.error_source, error_step=row.error_step)
    proposed = propose_action(diagnosis, model=model)

    assert proposed.action == row.action, (
        f"policy.propose_action chose {proposed.action!r} for {row.grid_cell!r}, "
        f"but policy-grid.json names {row.action!r} as that cell's designated "
        f"action. docs/EXPERIMENT-PROTOCOL.md's '## Ground truth' section and "
        f"apps/engine/config/ground-truth.json's weighted_true_lift block "
        f"(net +5.47pp) assume the treatment arm takes the GRID'S action on "
        f"every cell -- that assumption no longer holds. Do NOT silently "
        f"accept this divergence: recompute true_lift.compute_true_lift() "
        f"against the POLICY's actual choice (not row.action) for this cell, "
        f"update ground-truth.json's weighted_true_lift block and "
        f"EXPERIMENT-PROTOCOL.md's stated figures to match, and log the "
        f"change and its reason in docs/DECISIONS.md before treating the new "
        f"figure as valid, per the protocol's own frozen-config change rule."
    )


def test_candidate_actions_is_a_genuine_three_way_choice_on_retry_designated_cells():
    retry_designated = [r for r in policy_grid() if r.action in RETRY_ACTIONS]
    assert len(retry_designated) == 4  # both gateway cells, bank, internal

    for row in retry_designated:
        assert set(candidate_actions(row)) == RETRY_ACTIONS


def test_candidate_actions_stays_locked_on_terminal_and_nudge_cells():
    locked = [r for r in policy_grid() if r.action not in RETRY_ACTIONS]
    assert len(locked) == 3  # the terminal cell, plus the two customer cells

    for row in locked:
        assert candidate_actions(row) == (row.action,)


def test_terminal_cell_always_gets_never_retry_with_probability_zero(model):
    terminal_row = next(r for r in policy_grid() if r.failure_class == "terminal")
    diagnosis = Diagnosis(error_source=terminal_row.error_source, error_step=terminal_row.error_step)

    proposed = propose_action(diagnosis, model=model)

    assert proposed.action == "never_retry"
    assert proposed.recovery_probability == 0.0


@pytest.mark.parametrize("row", list(policy_grid()), ids=lambda row: row.grid_cell)
def test_structural_zero_actions_always_report_exactly_zero_probability(row, model):
    """nudge_no_auto_retry / never_retry are forced to exactly 0.0,
    bypassing the model, regardless of what it might have learned -- a
    structural fact about the world, not a statistical estimate."""
    diagnosis = Diagnosis(error_source=row.error_source, error_step=row.error_step)
    proposed = propose_action(diagnosis, model=model)

    if proposed.action in STRUCTURAL_ZERO_ACTIONS:
        assert proposed.recovery_probability == 0.0


def test_propensity_is_always_exactly_one():
    """Deterministic policy, per policy.py's own stated choice: every
    proposal's propensity is exactly 1, for every cell, mapped or not."""
    model_local = train_model(n=500, seed=1)
    for row in policy_grid():
        diagnosis = Diagnosis(error_source=row.error_source, error_step=row.error_step)
        proposed = propose_action(diagnosis, model=model_local)
        assert proposed.propensity == 1.0

    unmapped = Diagnosis(error_source="bank", error_step="authentication")
    assert propose_action(unmapped, model=model_local).propensity == 1.0


def test_unmapped_cell_falls_back_safely(model):
    # bank/authentication has no grid row and no wildcard
    # (apps/gateway/tests/unit/guardrails.test.ts asserts the same on the
    # TypeScript side).
    diagnosis = Diagnosis(error_source="bank", error_step="authentication")
    proposed = propose_action(diagnosis, model=model)

    assert proposed.action == UNMAPPED_ACTION
    assert proposed.recovery_probability == 0.0
    assert proposed.grid_cell == "bank/authentication"


def test_policy_is_deterministic_given_the_same_input(model):
    diagnosis = Diagnosis(error_source="gateway", error_step="authentication", amount_paise=75_000, hour_ist=15, attempt_number=2)

    results = [propose_action(diagnosis, model=model) for _ in range(5)]

    assert all(r == results[0] for r in results)


def test_different_amounts_can_change_the_estimated_probability_but_not_which_action_wins_here(model):
    """amount_paise is a model feature, so the probability estimate may
    shift with it, and the CANDIDATE SET never depends on amount -- only
    on the grid cell (candidate_actions takes just the row). On today's
    ground-truth table the winning action's RANKING is also stable across
    amount for this cell; that stability is empirical (design (b) allows
    it to differ in principle), not guaranteed by the code."""
    row = next(r for r in policy_grid() if r.failure_class == "transient")
    small = propose_action(Diagnosis(error_source=row.error_source, error_step=row.error_step, amount_paise=9_900), model=model)
    large = propose_action(Diagnosis(error_source=row.error_source, error_step=row.error_step, amount_paise=4_000_000), model=model)

    assert small.action == large.action == row.action
