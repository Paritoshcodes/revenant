"""tests/test_outcomes.py

Covers revenant_engine.outcomes: the ground-truth lookup, customer_prior
modulation, and the terminal-cell invariant EXPERIMENT-PROTOCOL.md states
unconditionally ("Terminal cells have true probability 0 for every
action").
"""

from __future__ import annotations

import numpy as np
import pytest
from revenant_engine.outcomes import (
    ground_truth_probability,
    modulated_probability,
    recovers,
)
from revenant_engine.population import Transaction

ALL_ACTIONS: tuple[str, ...] = (
    "retry_with_backoff",
    "retry_prompt_alternate",
    "retry_on_timing_window",
    "nudge_no_auto_retry",
    "never_retry",
)

TERMINAL_CELL = "business/payment_initiation"


def _transaction(grid_cell: str, customer_prior: float = 0.4, amount_paise: int = 49_900) -> Transaction:
    source, step = grid_cell.split("/")
    return Transaction(
        grid_cell=grid_cell,
        error_source=source,
        error_step=step,
        amount_paise=amount_paise,
        hour_ist=12,
        attempt_number=1,
        customer_prior=customer_prior,
    )


def test_terminal_cell_true_probability_is_zero_for_every_action():
    for action in ALL_ACTIONS:
        assert ground_truth_probability(TERMINAL_CELL, action) == 0.0


def test_terminal_cell_never_recovers_across_many_draws_and_every_action():
    rng = np.random.default_rng(1234)
    txn = _transaction(TERMINAL_CELL, customer_prior=0.99)  # even a maximally reliable customer

    for action in ALL_ACTIONS:
        outcomes = [recovers(txn, action, None, rng) for _ in range(2000)]
        assert not any(outcomes), f"terminal cell recovered under {action}"


def test_non_retry_actions_never_recover_on_any_non_terminal_cell_either():
    """nudge_no_auto_retry / never_retry are 0.0 everywhere by construction
    (ground-truth.json's RULE 1) -- a modelling choice, not a claim about
    real nudge effectiveness. Asserted here as behaviour, the reasoning
    documented in the config file itself."""
    rng = np.random.default_rng(5678)
    txn = _transaction("gateway/payment_authorization", customer_prior=0.9)

    for action in ("nudge_no_auto_retry", "never_retry"):
        outcomes = [recovers(txn, action, None, rng) for _ in range(500)]
        assert not any(outcomes)


def test_modulated_probability_is_identity_at_the_population_mean_prior():
    # Beta(2, 3)'s mean is 0.4; at exactly the mean, modulation is a no-op.
    assert modulated_probability(0.5, 0.4) == pytest.approx(0.5)


def test_modulated_probability_moves_up_for_a_more_reliable_customer():
    baseline = modulated_probability(0.4, 0.4)
    more_reliable = modulated_probability(0.4, 0.9)
    less_reliable = modulated_probability(0.4, 0.1)

    assert more_reliable > baseline > less_reliable


def test_modulated_probability_never_leaves_the_unit_interval():
    for true_p in (0.01, 0.1, 0.5, 0.9, 0.99):
        for prior in (0.001, 0.1, 0.5, 0.9, 0.999):
            effective = modulated_probability(true_p, prior)
            assert 0.0 < effective < 1.0


def test_modulated_probability_bypasses_modulation_at_zero_and_one():
    assert modulated_probability(0.0, 0.99) == 0.0
    assert modulated_probability(1.0, 0.01) == 1.0


def test_recovery_rate_over_many_draws_is_higher_for_high_prior_customers():
    """The direction test: over many independent transactions on the same
    grid cell/action, a population of high-customer_prior customers must
    recover strictly more often than a population of low-customer_prior
    customers, on average."""
    rng_high = np.random.default_rng(42)
    rng_low = np.random.default_rng(42)  # same seed: isolates the prior's effect, not the RNG stream
    n = 3000
    cell, action = "bank/payment_authorization", "retry_on_timing_window"

    high_prior_outcomes = [
        recovers(_transaction(cell, customer_prior=0.85), action, None, rng_high) for _ in range(n)
    ]
    low_prior_outcomes = [
        recovers(_transaction(cell, customer_prior=0.05), action, None, rng_low) for _ in range(n)
    ]

    high_rate = sum(high_prior_outcomes) / n
    low_rate = sum(low_prior_outcomes) / n

    assert high_rate > low_rate


def test_recovers_requires_an_explicit_numpy_generator():
    txn = _transaction("gateway/payment_authorization")
    with pytest.raises(TypeError):
        recovers(txn, "retry_with_backoff", None, rng=None)  # type: ignore[arg-type]


def test_ground_truth_probability_raises_on_unknown_pair():
    with pytest.raises(KeyError):
        ground_truth_probability("not/a-real-cell", "retry_with_backoff")
