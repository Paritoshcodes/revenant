"""Realised recovery for one synthetic attempt.

Given a Transaction (population.py), a proposed action, and the frozen
ground-truth table (apps/engine/config/ground-truth.json), decides whether
that one modelled attempt recovers. Nothing here decides policy -- it only
scores the outcome of an action a caller already chose, matching CLAUDE.md
hard rule 1 in spirit even though this is the synthetic layer, not the
gateway. Every figure produced through this module is ESTIMATED, never
OBSERVED (CLAUDE.md hard rule 6): the ground-truth table is a world we
authored, not a measurement of Razorpay traffic.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

from .population import CUSTOMER_PRIOR_ALPHA, CUSTOMER_PRIOR_BETA, Transaction

# outcomes.py -> revenant_engine/ -> src/ -> engine/ -> config/ground-truth.json
_DEFAULT_GROUND_TRUTH_PATH = Path(__file__).resolve().parents[2] / "config" / "ground-truth.json"

# Beta(2, 3)'s mean, matching population.py's customer_prior exactly -- the
# reference point modulation shifts a customer's odds relative to. Derived
# from the same constants population.py draws customer_prior from, rather
# than a separate literal, so the two can never silently drift apart.
_MEAN_PRIOR = CUSTOMER_PRIOR_ALPHA / (CUSTOMER_PRIOR_ALPHA + CUSTOMER_PRIOR_BETA)

# customer_prior ~ Beta(2, 3) has open support (0, 1); a float64 draw
# landing on an exact boundary is not realistically possible, but logit is
# undefined there, so clamp defensively rather than let a freak draw crash
# a batch run.
_PRIOR_EPS = 1e-9


@lru_cache(maxsize=1)
def _load_ground_truth(path: Path = _DEFAULT_GROUND_TRUTH_PATH) -> dict[tuple[str, str], float]:
    if not path.is_file():
        raise FileNotFoundError(
            f"ground truth config missing at {path}. "
            "apps/engine/config/ground-truth.json must exist -- see "
            "docs/EXPERIMENT-PROTOCOL.md, '## Ground truth'."
        )
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {
        (entry["grid_cell"], entry["action"]): float(entry["true_recovery_probability"])
        for entry in raw["entries"]
    }


def ground_truth_probability(
    grid_cell: str,
    action: str,
    ground_truth: dict[tuple[str, str], float] | None = None,
) -> float:
    """The TRUE probability for (grid_cell, action), before customer_prior modulation."""
    table = ground_truth if ground_truth is not None else _load_ground_truth()
    key = (grid_cell, action)
    if key not in table:
        raise KeyError(
            f"ground-truth.json has no entry for ({grid_cell!r}, {action!r}). "
            "The table must cover every (grid_cell, action) pair, per "
            "EXPERIMENT-PROTOCOL.md's '## Ground truth'."
        )
    return table[key]


def _logit(p: float) -> float:
    return math.log(p / (1.0 - p))


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def modulated_probability(true_probability: float, customer_prior: float) -> float:
    """Modulates a true recovery probability by one customer's latent reliability.

    The protocol says "modulated by customer_prior" without specifying the
    form; this is that choice, and it is part of the frozen world (any
    change here is a protocol change, same rule as everything else in
    EXPERIMENT-PROTOCOL.md). Implementation: a logit (log-odds) shift.

        effective_p = sigmoid( logit(true_probability)
                                + logit(customer_prior) - logit(mean_prior) )

    where mean_prior = 2/5 = 0.4 is Beta(2, 3)'s mean. This is the standard
    "random effect on the log-odds" form (the same idea as a mixed-effects
    or item-response model): a customer more reliable than average
    (customer_prior above 0.4) shifts recovery odds up multiplicatively in
    odds-space; a less reliable one shifts them down. It is symmetric and
    naturally bounded to (0, 1) -- no clipping is ever needed except at the
    true probability boundary itself, handled below.

    Special case, required by EXPERIMENT-PROTOCOL.md's "terminal cells have
    true probability 0 for every action" being unconditional: when
    true_probability is exactly 0.0 (or 1.0, symmetrically, though no
    config value reaches it), modulation is bypassed entirely and the input
    is returned unchanged. logit(0) is undefined, and more to the point, no
    customer, however reliable, can make a terminal cell recover, or an
    already-certain outcome more certain.
    """
    if true_probability <= 0.0 or true_probability >= 1.0:
        return true_probability

    prior = min(max(customer_prior, _PRIOR_EPS), 1.0 - _PRIOR_EPS)
    shift = _logit(prior) - _logit(_MEAN_PRIOR)
    return _sigmoid(_logit(true_probability) + shift)


def recovers(
    transaction: Transaction,
    action: str,
    ground_truth: dict[tuple[str, str], float] | None,
    rng: np.random.Generator,
) -> bool:
    """Whether one modelled attempt of ``action`` on ``transaction`` recovers.

    A single Bernoulli draw against the true probability for
    (transaction.grid_cell, action), modulated by transaction.customer_prior
    (see modulated_probability). ``rng`` must be a numpy Generator supplied
    by the caller -- this function draws no randomness of its own, so a
    caller simulating a whole population keeps every draw traceable to one
    seed, the same determinism discipline population.py uses. Pass
    ``ground_truth=None`` to use the real, on-disk config table.
    """
    if not isinstance(rng, np.random.Generator):
        raise TypeError("recovers() requires an explicit numpy.random.Generator as `rng`")

    true_p = ground_truth_probability(transaction.grid_cell, action, ground_truth)
    effective_p = modulated_probability(true_p, transaction.customer_prior)
    return bool(rng.random() < effective_p)
