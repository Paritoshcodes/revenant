"""Layer 2 synthetic population generator.

Produces the population EXPERIMENT-PROTOCOL.md's ``## Population`` section
describes: N failed payments, each drawing a grid cell, an amount, an hour,
an attempt number, and a latent per-customer reliability prior. This module
does not decide anything and does not simulate outcomes -- see outcomes.py
for the Bernoulli draw against apps/engine/config/ground-truth.json. Never
labelled OBSERVED: everything produced here is synthetic, so every figure
derived from it downstream is ESTIMATED, per CLAUDE.md hard rule 6.

Determinism is the whole point of the calibration argument this population
eventually feeds (EXPERIMENT-PROTOCOL.md's "## Calibration check"): a world
has to be re-derivable from its seed alone, or a replicated run proves
nothing. One ``numpy.random.default_rng(seed)`` instance drives every draw
in this module, in exactly this order, for a given call:

    1. grid_cell   (rng.choice, weighted, size=n)
    2. amount_paise (rng.lognormal, size=n, then clipped)
    3. hour_ist    (rng.choice, weighted, size=n)
    4. customer_prior (rng.beta, size=n)

Two calls with the same seed and the same n produce byte-identical output
(asserted in tests/test_population.py by comparing serialized JSON, not
just Python object equality). Changing the draw order, the distribution
family, or adding a draw between two existing ones changes every downstream
value for every existing seed -- treat this order itself as part of the
frozen protocol.

Grid rows are read from revenant_contracts.policy_grid() by default, never
hardcoded here: if packages/contracts/data/policy-grid.json gains an eighth
row, this module picks it up with no code change. The one parameter that
exists purely for testability is ``grid_rows`` -- inject a modified copy
(e.g. with a row removed) to prove that adaptation without touching the
real contracts file or fighting its lru_cache.

Grid-cell weights: NOT invented. Derived from
revenant_contracts.decline_taxonomy() by counting how many documented
decline reasons map to each grid cell (see ``grid_cell_weights`` below for
the exact rule, including the one documented gap: ``internal/*`` has zero
taxonomy entries, since it is our own wildcard for internal failures, not
a Razorpay-published decline category).
"""

from __future__ import annotations

import math
from collections import Counter
from typing import Sequence

import numpy as np
from pydantic import BaseModel
from revenant_contracts import PolicyGridRow, decline_taxonomy, policy_grid

# -- amount_paise: lognormal, median 49900, clipped [9900, 5_000_000] ------

AMOUNT_MEDIAN_PAISE = 49_900
AMOUNT_MIN_PAISE = 9_900
AMOUNT_MAX_PAISE = 5_000_000
# A lognormal's median is exp(mu), so mu = ln(median) reproduces the
# protocol's stated median exactly. Sigma is not specified by the protocol;
# 0.8 is a documented default chosen to give a plausible right-skewed spread
# of payment amounts (a handful of small transactions, most mid-range, a
# long tail toward the clip ceiling) without needing most draws to actually
# hit the clip bounds.
_AMOUNT_MU = math.log(AMOUNT_MEDIAN_PAISE)
_AMOUNT_SIGMA = 0.8

# -- hour_ist: categorical, business-hours weighted -------------------------

# Not pinned by the protocol beyond "business-hours weighted". Documented
# default: 10:00-21:00 IST inclusive (Indian e-commerce's typical active
# window) gets 3x the weight of every other hour, then normalized.
_BUSINESS_HOURS = range(10, 22)
_BUSINESS_HOUR_WEIGHT = 3.0
_OFF_HOUR_WEIGHT = 1.0

# -- customer_prior: Beta(2, 3), latent per-customer reliability ------------

CUSTOMER_PRIOR_ALPHA = 2.0
CUSTOMER_PRIOR_BETA = 3.0


def _hour_weights() -> np.ndarray:
    weights = np.array(
        [_BUSINESS_HOUR_WEIGHT if h in _BUSINESS_HOURS else _OFF_HOUR_WEIGHT for h in range(24)],
        dtype=np.float64,
    )
    return weights / weights.sum()


def grid_cell_weights(
    grid_rows: Sequence[PolicyGridRow],
    taxonomy: Sequence[object] | None = None,
) -> dict[str, float]:
    """Derives a categorical weight per grid cell from decline-taxonomy.json.

    Rule: the weight is proportional to how many documented decline reasons
    (revenant_contracts.decline_taxonomy()) map to that grid cell, e.g.
    customer/payment_authorization has 3 (insufficient_fund,
    card_disabled_online, card_number_invalid), gateway/authentication has
    1 (authentication_failed).

    Documented gap: ``internal/*`` has ZERO taxonomy entries by design --
    it is not a Razorpay-published decline category, it is our own
    wildcard for internal failures, so it can never appear in
    decline-taxonomy.json. A pure count would give it weight zero and it
    could never be drawn, which would both contradict
    EXPERIMENT-PROTOCOL.md's "categorical over the seven policy-grid rows"
    and make it impossible for a caller to ever observe that row. Fix:
    any grid cell with a zero count is floored at the minimum non-zero
    count found among the OTHER cells actually present in ``grid_rows``
    (currently 1, from decline-taxonomy.json's own numbers) -- so the
    floor value is still read off the file, not invented from nothing.
    """
    reasons = taxonomy if taxonomy is not None else decline_taxonomy()
    counts = Counter(r.grid_cell for r in reasons)
    cells = [row.grid_cell for row in grid_rows]
    raw = {cell: counts.get(cell, 0) for cell in cells}

    nonzero = [c for c in raw.values() if c > 0]
    floor = min(nonzero) if nonzero else 1
    filled = {cell: (count if count > 0 else floor) for cell, count in raw.items()}

    total = sum(filled.values())
    return {cell: count / total for cell, count in filled.items()}


class Transaction(BaseModel):
    """One synthetic failed payment. Never labelled OBSERVED -- see module docstring."""

    grid_cell: str
    error_source: str
    error_step: str
    amount_paise: int
    hour_ist: int
    attempt_number: int
    customer_prior: float


class Population(BaseModel):
    """A full generated world, reproducible from ``seed`` alone."""

    seed: int
    n: int
    transactions: list[Transaction]


def generate_population(
    n: int = 2000,
    *,
    seed: int,
    grid_rows: Sequence[PolicyGridRow] | None = None,
) -> Population:
    """Generates one synthetic population, per EXPERIMENT-PROTOCOL.md's ``## Population``.

    ``grid_rows`` defaults to ``revenant_contracts.policy_grid()`` -- pass a
    modified copy only to prove the generator adapts to a different grid
    (tests/test_population.py does exactly this), never in production use.
    """
    if n < 1:
        raise ValueError(f"n must be a positive integer, got {n}")

    rows = list(grid_rows) if grid_rows is not None else list(policy_grid())
    if not rows:
        raise ValueError("generate_population: grid_rows is empty, nothing to draw from")

    weights = grid_cell_weights(rows)
    probabilities = [weights[row.grid_cell] for row in rows]

    rng = np.random.default_rng(seed)

    # 1. grid_cell -- indices into `rows`, so `rows[idx]` recovers the row.
    row_indices = rng.choice(len(rows), size=n, p=probabilities)

    # 2. amount_paise
    raw_amounts = rng.lognormal(mean=_AMOUNT_MU, sigma=_AMOUNT_SIGMA, size=n)
    amounts = np.clip(raw_amounts, AMOUNT_MIN_PAISE, AMOUNT_MAX_PAISE)

    # 3. hour_ist
    hours = rng.choice(24, size=n, p=_hour_weights())

    # 4. customer_prior
    priors = rng.beta(CUSTOMER_PRIOR_ALPHA, CUSTOMER_PRIOR_BETA, size=n)

    transactions = []
    for i in range(n):
        row = rows[row_indices[i]]
        transactions.append(
            Transaction(
                grid_cell=row.grid_cell,
                error_source=row.error_source,
                error_step=row.error_step,
                amount_paise=int(round(amounts[i])),
                hour_ist=int(hours[i]),
                attempt_number=1,
                customer_prior=float(priors[i]),
            )
        )

    return Population(seed=seed, n=n, transactions=transactions)
