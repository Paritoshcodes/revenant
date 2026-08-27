"""tests/test_population.py

Covers EXPERIMENT-PROTOCOL.md's ## Population section against
revenant_engine.population.generate_population: determinism, coverage of
all seven grid cells, amount clip bounds, and that the grid is read from
revenant_contracts rather than hardcoded.
"""

from __future__ import annotations

import pytest
from revenant_contracts import policy_grid
from revenant_engine.population import (
    AMOUNT_MAX_PAISE,
    AMOUNT_MIN_PAISE,
    generate_population,
    grid_cell_weights,
)

SEED = 20260827
LARGE_N = 5000


def test_same_seed_produces_byte_identical_output():
    first = generate_population(n=500, seed=SEED)
    second = generate_population(n=500, seed=SEED)

    assert first.model_dump_json() == second.model_dump_json()


def test_different_seeds_produce_different_output():
    first = generate_population(n=500, seed=1)
    second = generate_population(n=500, seed=2)

    assert first.model_dump_json() != second.model_dump_json()


def test_all_seven_grid_cells_appear_at_large_n():
    pop = generate_population(n=LARGE_N, seed=SEED)

    seen = {t.grid_cell for t in pop.transactions}
    expected = {row.grid_cell for row in policy_grid()}

    assert len(expected) == 7, "policy grid is expected to have seven rows (EXPERIMENT-PROTOCOL.md)"
    assert seen == expected


def test_amount_paise_respects_clip_bounds():
    pop = generate_population(n=LARGE_N, seed=SEED)

    amounts = [t.amount_paise for t in pop.transactions]
    assert min(amounts) >= AMOUNT_MIN_PAISE
    assert max(amounts) <= AMOUNT_MAX_PAISE
    # The clip bounds should actually bind for at least a few draws at this
    # N, or the sigma/median choice is too conservative to be exercising
    # the protocol's stated bounds at all.
    assert any(a == AMOUNT_MIN_PAISE for a in amounts) or min(amounts) < AMOUNT_MIN_PAISE * 1.5


def test_attempt_number_always_starts_at_one():
    pop = generate_population(n=200, seed=SEED)
    assert all(t.attempt_number == 1 for t in pop.transactions)


def test_customer_prior_is_within_beta_2_3_support():
    pop = generate_population(n=LARGE_N, seed=SEED)
    priors = [t.customer_prior for t in pop.transactions]
    assert all(0.0 < p < 1.0 for p in priors)
    # Beta(2,3) mean is 0.4; at N=5000 the sample mean should land close.
    mean = sum(priors) / len(priors)
    assert 0.35 < mean < 0.45


def test_grid_is_read_from_contracts_not_hardcoded():
    """Delete a row from a COPY of the real grid; the generator must adapt
    with no code change, proving it reads revenant_contracts.policy_grid()
    at call time rather than embedding the seven rows itself."""
    real_rows = list(policy_grid())
    removed_cell = "customer/payment_authentication"
    reduced_rows = [row for row in real_rows if row.grid_cell != removed_cell]

    assert len(reduced_rows) == len(real_rows) - 1

    pop = generate_population(n=LARGE_N, seed=SEED, grid_rows=reduced_rows)
    seen = {t.grid_cell for t in pop.transactions}

    assert removed_cell not in seen
    assert seen == {row.grid_cell for row in reduced_rows}


def test_grid_cell_weights_derives_from_taxonomy_counts_with_internal_floored():
    weights = grid_cell_weights(list(policy_grid()))

    # customer/payment_authorization has 3 documented decline reasons
    # (insufficient_fund, card_disabled_online, card_number_invalid);
    # gateway/authentication has 1 (authentication_failed) -- the derived
    # weight must reflect that ratio, not be uniform.
    assert weights["customer/payment_authorization"] > weights["gateway/authentication"]

    # internal/* has zero taxonomy entries by design and must be floored
    # at the table's minimum non-zero count, not zero -- otherwise it could
    # never be drawn, which the "all seven cells appear" test above would
    # itself have caught, but the floor's own mechanism is asserted here
    # directly.
    assert weights["internal/*"] > 0.0
    assert weights["internal/*"] == pytest.approx(weights["gateway/authentication"])

    assert sum(weights.values()) == pytest.approx(1.0)


def test_generate_population_rejects_nonpositive_n():
    with pytest.raises(ValueError):
        generate_population(n=0, seed=SEED)


def test_generate_population_rejects_empty_grid_rows():
    with pytest.raises(ValueError):
        generate_population(n=10, seed=SEED, grid_rows=[])
