"""Computes the true incremental lift EXPERIMENT-PROTOCOL.md's calibration
check verifies an estimator against -- IN CODE, never by hand.

docs/DECISIONS.md (2026-08-27, "corrected true-lift figure") records why
this module exists: a hand-computed 6.82pp headline figure was wrong, for
two independent, compounding reasons, both of which this module accounts
for by construction rather than by another round of arithmetic:

1. Jensen's inequality on the modulation formula. outcomes.modulated_probability
   shifts logit(p_true) relative to logit(mean_prior) = logit(0.4) =
   -0.4055. But customer_prior ~ Beta(2, 3)'s actual mean LOG-ODDS is
   E[logit(X)] = psi(2) - psi(3) = -0.5 exactly (psi = digamma; verified
   both symbolically and by quadrature). Since logit is neither convex nor
   concave uniformly over Beta(2,3)'s support (concave below 0.5, convex
   above, and Beta(2,3)'s mass sits mostly below 0.5), E[logit(X)] !=
   logit(E[X]), so a config probability does NOT realise at its stated
   value on average across the population -- e.g. 0.55 realises lower.
   This module does not change modulated_probability (frozen, and correct
   as a per-customer formula); it correctly AVERAGES it over the real
   Beta(2, 3) distribution instead of assuming the average customer sees
   the average shift.

2. Multi-attempt compounding. EXPERIMENT-PROTOCOL.md's control arm makes
   up to MAX_ATTEMPTS retries, not one; a hand computation of "the true
   lift" that only ever looked at a single attempt's probability was
   silently answering a different, easier question. See
   ATTEMPTS_FOR_ACTION and realised_recovery_probability below for the
   pinned semantics.

Both of these move in the SAME direction on the two customer cells
(customer/payment_authorization, customer/payment_authentication): control
compounds its small blind-retry probability over up to 3 attempts while
treatment (nudge_no_auto_retry) never attempts at all, so the negative
drag from those two cells is materially larger than single-attempt
arithmetic suggested. See tests/test_true_lift.py for an independent
Monte Carlo simulation confirming this module's quadrature-based figures.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np
from pydantic import BaseModel
from revenant_contracts import PolicyGridRow, policy_grid
from scipy.integrate import quad
from scipy.stats import beta as beta_dist

from .outcomes import ground_truth_probability, modulated_probability
from .population import CUSTOMER_PRIOR_ALPHA, CUSTOMER_PRIOR_BETA, grid_cell_weights

# The attempt cap both arms share. Pinned in EXPERIMENT-PROTOCOL.md's
# ## Assignment section; sourced from apps/gateway/src/guardrails/config.ts,
# DEFAULT_GUARDRAIL_CONFIG.maxAttempts (== CONTROL_ARM_GUARDRAIL_CONFIG's,
# since the control arm only overrides attemptSpacing, not maxAttempts --
# docs/DECISIONS.md, "Guardrail layer": "the attempt cap ... still applies
# to both arms: those are safety bounds on real money, not part of the
# policy under measurement"). Not importable from Python; kept in sync by
# hand and cited here rather than duplicated silently.
MAX_ATTEMPTS = 3

CONTROL_ACTION = "retry_with_backoff"

# Actions that re-present the payment at all. nudge_no_auto_retry and
# never_retry are absent by construction (ground-truth.json RULE 1): they
# never attempt, so their attempt count is 0 regardless of MAX_ATTEMPTS.
_RETRY_ACTIONS = frozenset({"retry_with_backoff", "retry_prompt_alternate", "retry_on_timing_window"})


def attempts_for_action(action: str) -> int:
    """How many attempts `action` gets, per the pinned semantics above."""
    return MAX_ATTEMPTS if action in _RETRY_ACTIONS else 0


def realised_recovery_probability(
    grid_cell: str,
    action: str,
    ground_truth: dict[tuple[str, str], float] | None = None,
    max_attempts: int | None = None,
) -> float:
    """E over customer_prior ~ Beta(2, 3) of "recovers within K attempts".

    customer_prior is a LATENT PER-CUSTOMER trait (population.py's own
    description): one customer's reliability is fixed across every attempt
    on their own transaction, so the compounding "at least one success in
    K i.i.d. attempts" (1 - (1-p)^K) happens INSIDE the integral, per
    customer, before averaging over the population -- not on the
    population-average per-attempt probability. The two are not the same:
    1 - (1-p)^K is concave in p for K > 1, so by Jensen's inequality
    averaging first (a common shortcut) UNDERSTATES this figure. This is
    the second of the two corrections docs/DECISIONS.md's 2026-08-27 entry
    records.
    """
    p_true = ground_truth_probability(grid_cell, action, ground_truth)
    k = attempts_for_action(action) if max_attempts is None else max_attempts

    if p_true <= 0.0 or k == 0:
        return 0.0

    def integrand(prior: float) -> float:
        p_effective = modulated_probability(p_true, prior)
        p_within_k = 1.0 - (1.0 - p_effective) ** k
        return p_within_k * beta_dist.pdf(prior, CUSTOMER_PRIOR_ALPHA, CUSTOMER_PRIOR_BETA)

    value, _abserr = quad(integrand, 0.0, 1.0, limit=200)
    return float(value)


class CellLift(BaseModel):
    grid_cell: str
    weight: float
    control_action: str
    control_realised_probability: float
    treatment_action: str
    treatment_realised_probability: float
    gap: float
    weighted_contribution: float


class TrueLiftReport(BaseModel):
    """The computed true incremental lift, decomposed per cell and totalled.

    ``gross_positive_pp`` / ``negative_drag_pp`` / ``net_true_lift_pp`` are
    percentage points, matching how EXPERIMENT-PROTOCOL.md and
    ground-truth.json state the headline figure.
    """

    cells: list[CellLift]
    gross_positive_pp: float
    negative_drag_pp: float
    net_true_lift_pp: float


def compute_true_lift(
    grid_rows: Sequence[PolicyGridRow] | None = None,
    ground_truth: dict[tuple[str, str], float] | None = None,
) -> TrueLiftReport:
    """The realised (not raw-config) true incremental lift, computed by
    numerical integration over customer_prior and the pinned attempt
    counts -- never by hand. See the module docstring for why."""
    rows = list(grid_rows) if grid_rows is not None else list(policy_grid())
    weights = grid_cell_weights(rows)

    cells: list[CellLift] = []
    for row in rows:
        control_p = realised_recovery_probability(row.grid_cell, CONTROL_ACTION, ground_truth)
        treatment_p = realised_recovery_probability(row.grid_cell, row.action, ground_truth)
        weight = weights[row.grid_cell]
        gap = treatment_p - control_p
        cells.append(
            CellLift(
                grid_cell=row.grid_cell,
                weight=weight,
                control_action=CONTROL_ACTION,
                control_realised_probability=control_p,
                treatment_action=row.action,
                treatment_realised_probability=treatment_p,
                gap=gap,
                weighted_contribution=weight * gap,
            )
        )

    gross = sum(c.weighted_contribution for c in cells if c.weighted_contribution > 0)
    drag = sum(c.weighted_contribution for c in cells if c.weighted_contribution < 0)
    net = gross + drag

    return TrueLiftReport(
        cells=cells,
        gross_positive_pp=gross * 100,
        negative_drag_pp=drag * 100,
        net_true_lift_pp=net * 100,
    )
