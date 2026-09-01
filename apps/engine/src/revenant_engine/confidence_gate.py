"""The gate between an open-world classification and the grid.

Below MARGIN_THRESHOLD, a classification is discarded in favour of an
explicit unmapped result -- the same shape ExactClassifier already
produces on a genuine miss, which flows into the gateway's existing
terminal_grid_cell veto path unchanged (apps/gateway/src/guardrails/rules.ts:
an unmapped cell is refused unconditionally, verified live on
bank/authentication). This module never guesses on the caller's behalf.

HISTORY: this used to gate on a single self-reported top-1 CONFIDENCE
number, threshold 0.8. The 2026-09-01 live evaluation showed that gate
did nothing: every one of the four wrong predictions that run scored
confidence >= 0.90, comfortably clearing the bar. A scalar self-reported
number cannot express "I see two plausible cells and cannot tell them
apart" -- so it was replaced, per docs/DECISIONS.md's "the classifier's
task, gate, and evaluation" entry, with a MARGIN between the classifier's
top two ranked candidates (classifier.RankedCandidate). Ambiguity is
measured, not self-reported: LlmClassifier.classify() now REQUIRES at
least two valid candidates whenever it returns a non-None grid_cell,
treating a response with fewer as malformed rather than confident (see
that module for why), which is what stops the old loophole -- a model
could not simply omit a runner-up to avoid being gated -- structurally,
not just by better prompting.

PROVENANCE OF `candidates`, updated when the injection vulnerability was
closed (docs/DECISIONS.md, "the first vulnerability found by adversarial
testing"): `RankedCandidate.grid_cell` used to be a cell the model named
directly. It is now always classifier.resolve_grid_cell()'s OWN,
deterministic output for one of the model's ranked failure_class
candidates -- the model never names a cell at all any more. This module's
mechanism is unchanged (margin is still candidates[0].score minus
candidates[1].score); what changed is that the margin now describes the
gap between the two best RESOLVABLE options, derived from a class choice
the model made, rather than two cells the model named directly.

THE ASYMMETRIC COST this gate exists to weigh, unchanged from the old
0.8 threshold's reasoning:

  - The cost of a WRONG mapping accepted through the gate: the downstream
    policy (policy.py) acts on a fabricated diagnosis. On a cell whose
    designated action is a retry, that means a REAL outbound attempt
    against a payment that may not actually be in that failure state at
    all -- a genuine money-adjacent mistake, not a data-quality nuisance.
    On a cell whose designated action is nudge_no_auto_retry, it means
    declining to retry a payment that might actually have recovered with
    one -- a quieter mistake, but still one made on a fabricated premise.
  - The cost of a REFUSAL (correctly gating a classification, right or
    wrong): a missed recovery. That is not a new risk this module
    introduces -- it is EXACTLY what happens today, right now, for every
    single unmapped cell, with zero classifier in the loop at all. Gating
    never makes the system worse than its current, already-accepted
    baseline; it can only make it better on the classifications that do
    clear the bar.

These are not symmetric, and a neutral cut would treat them as if they
were. MARGIN_THRESHOLD leans conservative for the same reason 0.8 did:
high enough that only genuinely unambiguous classifications ever reach
the policy, low enough that the classifier is not reduced to a decoration
that can never clear the bar.

MARGIN_THRESHOLD IS PROVISIONAL, NOT CALIBRATED -- state this every time
the number is cited, not just here. It was derived from
apps/engine/src/revenant_engine/classifier_eval.py's leave-one-out
evaluation at N=9 (6 accept-worthy cases, 3 should-refuse cases -- note
"should-refuse" here means not(achievable and correct), so it includes
both genuinely wrong achievable predictions AND the 3 singleton-class
cases where no correct answer was possible at all; see that module's own
docstring for why the set is this small and why it could not be safely
expanded further). Nine observations cannot fit a decision boundary that
generalises -- with only 6-vs-3 points, "the best-looking cut" is likely
to exist by chance alone. The live run (2026-09-01, gemini-3.6-flash,
docs/DECISIONS.md's matching entry) checked this BEFORE choosing anything:
an exact permutation test over all C(9,6)=84 ways to split the pooled
margins gave AUC=0.083 (separation was, if anything, in the WRONG
direction on this sample -- higher margins slightly favoured
should-refuse cases, not should-accept ones) with p=0.988, nowhere near
the 0.05 cut for "clearly above chance." **No data-driven cut was fit.**
MARGIN_THRESHOLD is therefore set from the asymmetric-cost argument
ALONE, as a stated, reasoned default -- 0.3, requiring a decisive gap
between the top two candidates before trusting the top one, chosen
because the alternative (a lower, more permissive number) has no basis at
all once the data-driven path was ruled out, and the asymmetric cost
above already argues for erring toward refusal.

Applied back to the same nine leave-one-out results at this threshold:
0/3 false refusals (no correct prediction wrongly gated -- good) but ALSO
0/6 true refusals (it caught NONE of the six should-refuse cases -- this
gate, at this threshold, currently does not separate right answers from
wrong ones on this sample, reported plainly rather than smoothed over,
per the explicit instruction that produced this design: "if it still
fails to separate them, say so plainly rather than adjusting the
threshold until it looks better"). This is a DIFFERENT finding than the
old top-1-confidence gate's failure (that one was fooled by inflated
self-reported confidence; this one has too little data to know whether
margin separates anything at all yet) but the practical result -- zero
wrong answers caught in this run -- is the same, and is recorded as such.
Revisit once real classification volume exists: tens of accept-worthy and
refuse-worthy cases each, not single digits, before a fitted cut -- or a
confident claim that margin separates outcomes at all -- would be worth
trusting.

A SECOND, INDEPENDENT refusal condition, added alongside the margin check
during the classifier's edge-case hardening sweep: a classification whose
`description_truncated` is True (classifier.MAX_DESCRIPTION_CHARS was
exceeded and error_description was cut before the model ever saw the
rest of it) is ALWAYS gated, regardless of how wide a margin the model
reports. The margin is still computed and returned for audit -- a reader
of the decision can see "the model reported a wide margin, but it was
refused anyway because the input was truncated" -- this is "more
conservative," never "silently discard the fact that truncation
happened." A classification reasoned over admittedly partial input is
exactly the kind of fabricated-premise risk the asymmetric-cost argument
above already weighs against.
"""

from __future__ import annotations

from pydantic import BaseModel

from .classifier import Classification

#: See this module's own docstring: derived from N=9 leave-one-out
#: observations on 2026-09-01 (gemini-3.6-flash). Separation was NOT
#: clearly above chance (AUC=0.083, p=0.988, exact permutation test), so
#: NO data-driven cut was fit -- this is the asymmetric-cost-argument-only
#: default. Provisional, not a calibrated cut. docs/DECISIONS.md's
#: matching entry has the full run.
MARGIN_THRESHOLD = 0.3


class GatedClassification(BaseModel):
    """`grid_cell=None` here means exactly what it means coming out of
    Classification: an explicit non-result, never a placeholder for "we
    didn't check." `gated=True` distinguishes "the classifier had no
    answer" from "the classifier had an answer we declined to trust" --
    both end up with grid_cell=None, but they are different facts worth
    keeping apart for anyone inspecting a decision later.

    `margin` is the observed gap between the top two ranked candidates'
    scores (classifier.RankedCandidate) -- what this module actually
    gates on. `None` when fewer than two candidates were available to
    compare -- in normal production/evaluation use (the real 7-cell grid)
    this is ExactClassifier's single-candidate exact-taxonomy hit; a
    single confident LlmClassifier candidate is also legitimate, but only
    in the single-cell-grid edge case (classifier.py's `required_min`
    relaxation), never on the real grid via one `exclude_grid_cell`. See
    apply_confidence_gate for why a genuinely margin-less answer is never
    gated for "ambiguity" it structurally cannot have. Exposed for audit
    -- the project's zero-abstraction ethos applies to a gate decision
    same as a dollar figure.

    `description_truncated` mirrors Classification's own field -- see
    this module's own docstring on why it is an independent,
    unconditional refusal condition, checked in ADDITION to the margin,
    never in place of computing it."""

    grid_cell: str | None
    confidence: float
    reasoning: str
    gated: bool
    margin: float | None
    description_truncated: bool


def apply_confidence_gate(
    classification: Classification,
    margin_threshold: float = MARGIN_THRESHOLD,
) -> GatedClassification:
    if classification.grid_cell is None:
        return GatedClassification(
            grid_cell=None,
            confidence=classification.confidence,
            reasoning=classification.reasoning,
            gated=True,
            margin=None,
            description_truncated=classification.description_truncated,
        )

    if len(classification.candidates) < 2:
        # A genuinely margin-less confident answer -- see
        # GatedClassification's own docstring for the two legitimate
        # sources. Never gated for ambiguity it structurally cannot have,
        # but STILL subject to the truncation veto below: an exact
        # taxonomy hit never truncates (ExactClassifier doesn't call the
        # API at all), but nothing prevents a future caller from wiring
        # truncation onto a margin-less path, so the check is unconditional
        # rather than assumed unreachable here.
        gated = classification.description_truncated
        return GatedClassification(
            grid_cell=None if gated else classification.grid_cell,
            confidence=classification.confidence,
            reasoning=classification.reasoning,
            gated=gated,
            margin=None,
            description_truncated=classification.description_truncated,
        )

    margin = classification.candidates[0].score - classification.candidates[1].score
    gated = margin < margin_threshold or classification.description_truncated
    return GatedClassification(
        grid_cell=None if gated else classification.grid_cell,
        confidence=classification.confidence,
        reasoning=classification.reasoning,
        gated=gated,
        margin=margin,
        description_truncated=classification.description_truncated,
    )
