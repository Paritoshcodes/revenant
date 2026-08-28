"""Deterministic policy: given a diagnosis, proposes an action.

Replaces apps/gateway/src/recovery/policy-stub.ts's flat placeholder
(action from the grid, recovery_probability a constant 0.5, propensity a
constant 1) with a real model-driven estimate, while matching that stub's
exact ProposedAction shape (grid_cell, action, recovery_probability,
propensity) so a later session can wire the gateway to this engine without
a schema change. That wiring is NOT done in this session -- it is a
separate change with its own risks.

The LLM is not involved. CLAUDE.md hard rule 1: the policy function
decides whether money moves, and that decision must be inspectable as a
plain comparison of numbers -- here, expected recovered value
(probability x amount) for each candidate action, picking the largest.
Nothing about this function is a black box: every number that goes into
the comparison is one call to RecoveryModel.predict_proba away from being
read back out.

THE CANDIDATE-SET DESIGN CHOICE, made explicitly rather than silently,
because it changes what the treatment arm does. Two designs were
possible:

  (a) The grid constrains the policy to exactly one action per cell (its
      own `action` field). The model would then only ever ESTIMATE a
      probability for a foregone choice, never actually SELECT anything
      -- the "argmax" is over a singleton and the model is not
      load-bearing for the decision, only for the probability attached
      to it.
  (b) The grid supplies only the TERMINAL constraint (a terminal cell
      permits only never_retry) and the NUDGE constraint (a cell whose
      designated action is nudge_no_auto_retry stays locked to nudge --
      the grid's "do not auto-retry" judgement for customer-class
      failures is a policy decision this module does not second-guess).
      Everywhere else -- every transient/soft cell whose designated
      action is one of the three retries -- the policy genuinely ranks
      ALL THREE retry actions by the model's own expected-value estimate
      and may choose a DIFFERENT one than the grid's single "home" action
      names.

THIS MODULE IMPLEMENTS (b). It is the more defensible design: (a) makes
the model decorative (docs/DECISIONS.md's incident log records exactly
this happening once already, when a main-effects-only model produced flat
probabilities and (a)'s singleton candidate set meant the flaw was
invisible to any test that only checked "does the proposed action match
the grid" -- Fix 3 below only catches it because ranking is now real).
(b) makes the model's per-action estimates ACTUALLY DETERMINE what gets
proposed on 4 of the 7 cells (both gateway cells, bank/payment_authorization,
internal/*).

CONSEQUENCE, stated rather than discovered later: on today's frozen
ground-truth table, (b) happens to reproduce the grid's own designated
action on every one of those 4 flexible cells anyway (verified: the true,
realised single-attempt probability -- true_lift.realised_recovery_probability
with max_attempts=1 -- is highest for the grid's home action on all four,
so a correctly-fit model recovers the same ranking). It is NOT guaranteed
to stay that way if ground-truth.json is ever revised, and the two
customer cells and the terminal cell remain grid-locked exactly as before
(nudge and never_retry both have true probability 0.0 in this world by
construction -- ground-truth.json's RULE 1 -- and would never win an
unconstrained argmax against any retry action with positive probability;
locking them is what preserves "correctly declining to retry" as a real
policy option at all, not what breaks it). What this design change means
for a later session: docs/EXPERIMENT-PROTOCOL.md's true-lift calibration
(true_lift.py) assumes the treatment arm applies each cell's grid-named
action -- that assumption still holds for THIS ground-truth table under
design (b), but it holds because of a coincidence this docstring records,
not because (b) enforces it structurally. If ground-truth.json ever
changes such that a mismatched retry beats a cell's home action, (b)
means the policy would propose the mismatch, and true_lift.py's
calibration figure would need recomputing against what the policy
actually does rather than against the grid's static action.

PROPENSITY: DETERMINISTIC, propensity = 1.0, not epsilon-stochastic. Two
reasons.

  1. This matches policy-stub.ts's own existing contract exactly
     (STUB_PROPENSITY = 1). This session upgrades the probability
     ESTIMATE from a placeholder to a real model; it does not change what
     kind of policy this is.
  2. EXPERIMENT-PROTOCOL.md's epsilon-greedy requirement ("## Off-policy
     estimation") is scoped explicitly to the BASELINE/logging arm, for
     Layer 3 IPS propensity identifiability -- a different policy from
     the treatment/agent policy built here. Building a stochastic
     baseline is separate, later work. Design (b) above does now offer a
     genuine multi-candidate choice on 4 cells, which COULD support
     epsilon-exploration later; this session keeps the treatment policy
     itself deterministic regardless, since nothing here asks it to log
     propensities for off-policy estimation.

If this policy is ever made stochastic, propensity must become the actual
selection probability, logged per decision; leaving it at 1 would then be
silently wrong.
"""

from __future__ import annotations

from pydantic import BaseModel
from revenant_contracts import PolicyGridRow, grid_cell, lookup_grid_row

from .model import RecoveryModel, default_model

# Matches policy-stub.ts's UNMAPPED_ACTION exactly: a safe fallback for a
# cell the grid does not describe. The terminal_grid_cell guardrail vetoes
# an unmapped cell's proposed action unconditionally (fails closed), so
# whatever is proposed here never actually executes -- see
# apps/gateway/src/guardrails/rules.ts.
UNMAPPED_ACTION = "retry_with_backoff"

# Mirrors apps/gateway/src/guardrails/rules.ts's own RETRY_ACTIONS: actions
# that re-present the payment. These are the only actions design (b) above
# ever ranks against each other.
RETRY_ACTIONS: frozenset[str] = frozenset(
    {"retry_with_backoff", "retry_prompt_alternate", "retry_on_timing_window"}
)

# Actions that never re-present the payment (ground-truth.json's RULE 1):
# recovery_probability is forced to exactly 0.0 for these, bypassing the
# model entirely, rather than trusted to a learned near-zero estimate.
# This is a STRUCTURAL fact about the world (the attempt literally cannot
# happen), not a statistical one the model should be asked to approximate.
STRUCTURAL_ZERO_ACTIONS = frozenset({"nudge_no_auto_retry", "never_retry"})

# Defaults used when a caller supplies only error_source/error_step,
# matching today's minimal FailureDiagnosis on the TypeScript side.
# amount_paise defaults to population.py's own protocol median (49900);
# hour_ist to a neutral midday hour; attempt_number to the first attempt.
DEFAULT_AMOUNT_PAISE = 49_900
DEFAULT_HOUR_IST = 12
DEFAULT_ATTEMPT_NUMBER = 1


class Diagnosis(BaseModel):
    """Richer than today's TypeScript FailureDiagnosis ({error_source,
    error_step} only), because the model needs amount/hour/attempt-number
    features the gateway does not pass through yet. Defaults let a caller
    that only has error_source/error_step still get a sensible proposal;
    wiring the gateway to actually supply its own amount_paise, hour_ist
    and attempt_number is the separate, later integration work this
    session does not do."""

    error_source: str
    error_step: str
    amount_paise: int = DEFAULT_AMOUNT_PAISE
    hour_ist: int = DEFAULT_HOUR_IST
    attempt_number: int = DEFAULT_ATTEMPT_NUMBER


class ProposedAction(BaseModel):
    """Exact shape of apps/gateway/src/recovery/policy-stub.ts's
    ProposedAction (camelCase there, snake_case here per each language's
    own convention): grid_cell, action, recovery_probability, propensity."""

    grid_cell: str
    action: str
    recovery_probability: float
    propensity: float


def candidate_actions(row: PolicyGridRow) -> tuple[str, ...]:
    """The set of actions this cell permits -- design (b), see module
    docstring. A terminal cell (only never_retry is ever safe) or a cell
    whose grid-designated action is nudge_no_auto_retry (the grid's
    considered judgement not to auto-retry a customer-class failure)
    stays locked to that one action. Every other cell -- whose designated
    action is one of the three retries -- opens up to a genuine choice
    among all three, so the model's per-action estimate actually decides
    what gets proposed rather than only decorating a foregone choice."""
    if row.action not in RETRY_ACTIONS:
        return (row.action,)
    return tuple(sorted(RETRY_ACTIONS))


def propose_action(
    diagnosis: Diagnosis,
    model: RecoveryModel | None = None,
) -> ProposedAction:
    """Chooses the candidate action maximising expected recovered value
    (recovery_probability x amount_paise), constrained to
    candidate_actions(row) -- a genuine multi-way comparison on 4 of the 7
    grid cells, a locked singleton on the other 3 (terminal, and the two
    customer/nudge cells). See module docstring for why."""
    active_model = model if model is not None else default_model()

    cell = grid_cell(diagnosis.error_source, diagnosis.error_step)
    row = lookup_grid_row(diagnosis.error_source, diagnosis.error_step)

    if row is None:
        return ProposedAction(
            grid_cell=cell,
            action=UNMAPPED_ACTION,
            recovery_probability=0.0,
            propensity=1.0,
        )

    best_action: str | None = None
    best_probability = 0.0
    best_expected_value = -1.0  # any real candidate (>= 0.0) beats this sentinel

    for action in candidate_actions(row):
        probability = (
            0.0
            if action in STRUCTURAL_ZERO_ACTIONS
            else active_model.predict_proba(
                error_source=diagnosis.error_source,
                error_step=diagnosis.error_step,
                action=action,
                amount_paise=diagnosis.amount_paise,
                hour_ist=diagnosis.hour_ist,
                attempt_number=diagnosis.attempt_number,
            )
        )
        expected_value = probability * diagnosis.amount_paise

        if expected_value > best_expected_value:
            best_expected_value = expected_value
            best_action = action
            best_probability = probability

    assert best_action is not None, "candidate_actions must never be empty for a mapped grid row"

    return ProposedAction(
        grid_cell=cell,
        action=best_action,
        recovery_probability=best_probability,
        propensity=1.0,
    )
