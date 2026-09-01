"""Held-out evaluation of a Classifier's open-world generalisation.

decline-taxonomy.json documents 10 Razorpay decline reasons, each already
mapped to a grid cell -- but the taxonomy file itself carries no free-text
error_description, only the machine-readable error_reason key. Evaluating
a classifier by feeding it that key would just be testing whether it can
echo a lookup table, so every description used here was SOURCED from a
real Razorpay artifact, never invented. Two sources:

  - LIVE SAMPLE: an error_description actually captured from this
    project's own live Razorpay test-mode runs (data/samples/).
  - RAZORPAY DOCS: verbatim text from Razorpay's own published test-card
    documentation (github.com/razorpay/markdown-docs, the source that
    feeds razorpay.com/docs/payments/payments/test-card-details/),
    independently verified by matching every taxonomy test_cards number
    against the docs' own card numbers for that reason.

All 10 of decline-taxonomy.json's reasons were found this way -- there was
no need for an authored fallback (HeldOutCase.source keeps "authored" in
its type regardless, for a future reason the docs and this project's own
live samples never cover).

Only the classifier's judgement is evaluated: each case hands the
classifier ERROR_DESCRIPTION ALONE, never error_reason (that would just
hand back the answer through ExactClassifier's fast path this evaluation
exists to bypass) and never the true grid_cell.

WHAT payment_failed CANNOT TEST. Its real, live-captured description is
the two words "Payment failed" -- per docs/DECISIONS.md ("Razorpay
capability findings"), this is the exact generic string Razorpay's mock
bank Failure button emits for EVERY simulated decline in this project's
test mode, regardless of which specific reason was being simulated. Two
words carry no signal a classifier -- human or LLM -- could use to place
this on a 7-cell grid; scoring it as a hit or a miss would measure noise,
not classification ability, in either direction. It still runs through
the classifier and appears in the per-case table (excluding it from the
DATASET would hide a real, honestly-sourced result), but
HeldOutCase.generalisation_eligible is False for this one case alone, and
it is excluded from the Razorpay-sourced accuracy figure below.

N = 10 (9 generalisation-eligible). This is a SMALL evaluation set. Report
the accuracy figures as numbers with their sample sizes, never as evidence
of a robust, well-calibrated classifier -- a single flipped case moves the
generalisation-eligible figure by more than 11 points. Only the
Razorpay-sourced-and-generalisation-eligible figure is evidence of
open-world generalisation at all; the overall figure includes
payment_failed's unanswerable case and the (currently empty) authored
category exists only so a future addition to this set is forced to state
its provenance honestly rather than blend silently into the total.

WHY evaluate_classifier (above) MEASURES THE WRONG TASK, and what
evaluate_leave_one_out (below) measures instead. evaluate_classifier
withholds error_source and error_step, feeding the classifier
error_description ALONE. But LlmClassifier only ever runs in production
after the deterministic grid lookup already MISSED on a real
(error_source, error_step) pair -- every real Razorpay failure carries
both fields (see classifier.py's own module docstring). So the real job
is disambiguating an unmapped pair WITH the description's help, not
inferring Razorpay's own source attribution from prose alone. Two of the
four wrong answers in the 2026-09-01 run (against gemini-2.5-flash) were
exactly this kind of miss: authentication_failed's description
("incorrect OTP or verification details") is defensibly customer-side
from text alone, and was guessed customer/payment_authentication -- wrong
only because it actually came from the gateway, information the
description-only task never gave the model a chance to use.

evaluate_leave_one_out corrects this: for each grid cell, hide that
cell's row from the grid the classifier is shown, then classify that
cell's own held-out cases WITH their real (error_source, error_step)
still passed through -- which, with the cell's row hidden, no longer
identifies a valid answer, only tells the model "this failure is
bank-side, about authentication," the same honest disambiguating signal a
genuinely unmapped pair carries in production. This is a faithful stand-in
for the real trigger condition, not a different kind of leak; see that
function's own docstring for the full design, including why "correct" is
defined by failure_class match rather than literal cell recovery, and why
two of the seven cells (the ones whose failure_class has no other member)
report separately rather than folding into the headline accuracy.

evaluate_classifier's description-only figure is KEPT, unchanged, as a
second, clearly-labelled, DELIBERATELY HARDER comparison point -- "classify
from text alone with no source/step" is a real (if not the production)
capability worth reporting, and hiding a harder number just because a
corrected one exists would be its own kind of dishonesty. Neither
number replaces the other; see docs/DECISIONS.md's 2026-09-01 entry
("the classifier's task, gate, and evaluation") for both, side by side.

SINCE THE INJECTION FIX (docs/DECISIONS.md, "the first vulnerability
found by adversarial testing" and its "closing the canonical-fallback
targeting path" correction), evaluate_classifier's figure through the
REAL LlmClassifier is no longer merely pessimistic -- IT IS NOW A
CONSTANT NO-MATCH, and this is worth stating in full rather than glossed
over. LlmClassifier no longer names a cell at all, only a failure_class,
resolved via classifier.resolve_grid_cell() using the TRUSTED
error_source/error_step this evaluation deliberately withholds.
resolve_grid_cell now FAILS CLOSED whenever error_source matches no row
of the claimed class -- and error_source=None (this evaluation's own
design, by construction) matches no row of anything, always, so every
real LlmClassifier call through this path now returns grid_cell=None
unconditionally, regardless of which class the model reports. The
description-only comparison figure therefore can no longer be measured
against the real LlmClassifier at all; only FixtureClassifier-backed
reports (which bypass resolve_grid_cell entirely, answering with a
hand-authored grid_cell directly) still produce a real number through
this function. This is a genuine, load-bearing consequence of failing
closed rather than a bug -- absence of trusted context is treated the
same as contradicting it, on purpose, per the same security reasoning
that closed the canonical-fallback path -- and it is recorded here so a
future session does not rediscover it by getting a confusing constant
0.000 from a real run and wondering why.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel
from revenant_contracts import policy_grid

from .classifier import Classification, Classifier, LlmClassifier

#: Classifier implementations set this True to mark themselves as
#: fixtures -- hand-authored stand-ins, never a real measurement.
#: evaluate_classifier reads it via getattr(classifier, "IS_FIXTURE",
#: False), so a real classifier (ExactClassifier, LlmClassifier,
#: CascadingClassifier) needs no change; they simply don't define it and
#: default to False.

#: 1.96 to 12 significant figures -- the two-sided 97.5th percentile of
#: the standard normal, i.e. z for a 95% interval.
_Z_95 = 1.959963984540054


def wilson_interval(successes: int, n: int, z: float = _Z_95) -> tuple[float, float]:
    """95% Wilson score interval for a proportion `successes/n`.

    Preferred over the naive `p +/- z*sqrt(p(1-p)/n)` normal
    approximation at small N, where that formula can produce bounds
    outside [0, 1] and understates uncertainty near 0 or 1 -- exactly the
    regime this module's headline figures live in (N=6 to N=9). Every
    accuracy figure this small has NO business appearing without this
    interval attached; a bare "0.500" or "0.556" implies a precision six
    or nine observations cannot support.

    Hand-checkable sanity examples (also asserted in
    tests/test_classifier_eval.py): wilson_interval(3, 6) ~ (0.19, 0.81);
    wilson_interval(5, 9) ~ (0.27, 0.81). Both intervals span more than
    half the [0, 1] range -- the honest statement that six or nine
    observations cannot distinguish this classifier from chance in
    either direction.

    Returns (lo, hi). n=0 returns (0.0, 1.0) -- maximal uncertainty,
    never a divide-by-zero.
    """
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half_width = (z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5)) / denom
    return (max(0.0, center - half_width), min(1.0, center + half_width))


class HeldOutCase(BaseModel):
    error_reason: str
    error_description: str
    true_grid_cell: str
    source: Literal["live_sample", "razorpay_docs", "authored"]
    # "direct": the docs/sample entry is filed under this exact error_reason.
    # "cross_referenced_by_test_card": the docs use a different name for the
    # same scenario; linked via an identical test card number instead.
    match_method: Literal["direct", "cross_referenced_by_test_card"]
    provenance: str
    generalisation_eligible: bool = True


HELD_OUT_CASES: tuple[HeldOutCase, ...] = (
    HeldOutCase(
        error_reason="payment_failed",
        error_description="Payment failed",
        true_grid_cell="gateway/payment_authorization",
        source="live_sample",
        match_method="direct",
        provenance="data/samples/payment_pay_TTV3xEPvEdUptp.json",
        generalisation_eligible=False,
    ),
    HeldOutCase(
        error_reason="international_transaction_not_allowed",
        error_description=(
            "Your payment could not be completed as this business accepts domestic "
            "(Indian) card payments only. Try another payment method."
        ),
        true_grid_cell="business/payment_initiation",
        source="live_sample",
        match_method="direct",
        provenance="data/samples/failed_intl_01.json",
    ),
    HeldOutCase(
        error_reason="gateway_technical_error",
        error_description=(
            "Your payment did not go through due to a temporary issue. Any debited "
            "amount will be refunded in 4-5 business days."
        ),
        true_grid_cell="gateway/payment_authorization",
        source="razorpay_docs",
        match_method="direct",
        provenance="razorpay/markdown-docs, payments/payments/test-card-details.md, card 4100 2800 0002 0007",
    ),
    HeldOutCase(
        error_reason="authentication_failed",
        error_description=(
            "Your payment could not be completed due to incorrect OTP or verification "
            "details. Try another payment method or contact your bank for details."
        ),
        true_grid_cell="gateway/authentication",
        source="razorpay_docs",
        match_method="direct",
        provenance="razorpay/markdown-docs, payments/payments/test-card-details.md, card 4100 2800 0000 0009",
    ),
    HeldOutCase(
        error_reason="payment_timed_out",
        error_description="Your payment could not be completed due to a temporary issue. Try again later.",
        true_grid_cell="bank/payment_authorization",
        source="razorpay_docs",
        match_method="direct",
        provenance="razorpay/markdown-docs, payments/payments/test-card-details.md, card 4100 2800 0009 0000",
    ),
    HeldOutCase(
        error_reason="card_declined",
        error_description=(
            "Your payment did not go through as it was declined by the bank. Try "
            "another payment method or contact your bank."
        ),
        true_grid_cell="bank/payment_authorization",
        source="razorpay_docs",
        match_method="direct",
        provenance="razorpay/markdown-docs, payments/payments/test-card-details.md, card 4100 2800 0006 0003",
    ),
    HeldOutCase(
        error_reason="insufficient_fund",
        error_description=(
            "Your payment could not be completed due to insufficient account balance. "
            "Try another card or payment method."
        ),
        true_grid_cell="customer/payment_authorization",
        source="razorpay_docs",
        match_method="direct",
        provenance="razorpay/markdown-docs, payments/payments/test-card-details.md, card 4100 2800 0008 0001",
    ),
    HeldOutCase(
        error_reason="payment_cancelled",
        error_description="Your payment has been cancelled. Try again or complete the payment later.",
        true_grid_cell="customer/payment_authentication",
        source="razorpay_docs",
        match_method="direct",
        provenance=(
            "razorpay/markdown-docs, payments/payments/test-card-details.md; "
            "decline-taxonomy.json records no test card for this reason (a real "
            "abandonment path, not a card simulation), matched by error_reason name only"
        ),
    ),
    HeldOutCase(
        error_reason="card_disabled_online",
        error_description="Your card is disabled for online payments. Please reach to your bank or try with another card.",
        true_grid_cell="customer/payment_authorization",
        source="razorpay_docs",
        match_method="cross_referenced_by_test_card",
        provenance=(
            "razorpay/markdown-docs, payments/payments/test-card-details.md, filed there "
            "as 'card_disabled_for_online_payments' -- NOT the same string as this "
            "taxonomy's 'card_disabled_online'. Linked via the identical test card "
            "number 4100 2800 0003 0006 appearing under both names, not by name match."
        ),
    ),
    HeldOutCase(
        error_reason="card_number_invalid",
        error_description="You have entered an incorrect card number. Try again.",
        true_grid_cell="customer/payment_authorization",
        source="razorpay_docs",
        match_method="direct",
        provenance="razorpay/markdown-docs, payments/payments/test-card-details.md, card 4100 2800 0001 0008",
    ),
)


class CaseResult(BaseModel):
    error_reason: str
    true_grid_cell: str
    predicted_grid_cell: str | None
    confidence: float
    correct: bool
    gated: bool
    source: str
    generalisation_eligible: bool


class ConfusionPair(BaseModel):
    true_grid_cell: str
    predicted_grid_cell: str
    count: int


class EvaluationReport(BaseModel):
    """Three accuracy figures, never blended into one. See this module's
    own docstring for why only accuracy_razorpay_sourced_eligible is
    evidence of open-world generalisation, and why N=10 (9 for that
    figure) is too small to treat any of them as robust.

    `classifier_label` and `is_fixture` exist because a fixture-based
    report was once quoted in a session summary as if it were a real
    measurement (docs/DECISIONS.md records the correction). Every field
    on this model is now traceable to WHICH classifier produced it, and
    `render_report` below refuses to print a fixture's figures without an
    unmissable warning attached -- making that specific mistake
    structurally harder to repeat, not just documented against."""

    classifier_label: str
    is_fixture: bool
    results: tuple[CaseResult, ...]
    n_total: int
    accuracy_overall: float
    n_razorpay_sourced_eligible: int
    accuracy_razorpay_sourced_eligible: float
    #: 95% Wilson interval on accuracy_razorpay_sourced_eligible -- see
    #: wilson_interval()'s own docstring for why this must never be
    #: dropped when the figure is cited. render_report always prints it
    #: inline; no code path should print the bare accuracy alone.
    accuracy_razorpay_sourced_eligible_wilson_lo: float
    accuracy_razorpay_sourced_eligible_wilson_hi: float
    n_authored: int
    accuracy_authored: float | None
    confusion: tuple[ConfusionPair, ...]
    below_gate_count: int


def evaluate_classifier(
    classifier: Classifier,
    cases: tuple[HeldOutCase, ...] = HELD_OUT_CASES,
    gate_threshold: float | None = None,
) -> EvaluationReport:
    """Runs every case through `classifier.classify(error_description=...)`
    -- error_reason and the true cell are withheld -- and scores it.

    `gate_threshold`, if given, additionally marks each result `gated`
    against confidence_gate's rule (imported lazily to avoid a hard
    dependency for a caller that only wants raw classifications); `None`
    (the default) reports every result as not-gated, useful for measuring
    the classifier's raw judgement independent of where the gate is set.
    """
    results: list[CaseResult] = []
    confusion_counts: dict[tuple[str, str], int] = {}

    for case in cases:
        classification: Classification = classifier.classify(
            error_code="BAD_REQUEST_ERROR",
            error_description=case.error_description,
        )
        gated = False
        if gate_threshold is not None:
            gated = classification.grid_cell is None or classification.confidence < gate_threshold

        correct = classification.grid_cell == case.true_grid_cell
        results.append(
            CaseResult(
                error_reason=case.error_reason,
                true_grid_cell=case.true_grid_cell,
                predicted_grid_cell=classification.grid_cell,
                confidence=classification.confidence,
                correct=correct,
                gated=gated,
                source=case.source,
                generalisation_eligible=case.generalisation_eligible,
            )
        )
        if classification.grid_cell is not None and classification.grid_cell != case.true_grid_cell:
            key = (case.true_grid_cell, classification.grid_cell)
            confusion_counts[key] = confusion_counts.get(key, 0) + 1

    n_total = len(results)
    accuracy_overall = sum(r.correct for r in results) / n_total if n_total else 0.0

    eligible = [
        r for r, c in zip(results, cases) if c.source in ("live_sample", "razorpay_docs") and c.generalisation_eligible
    ]
    n_eligible = len(eligible)
    n_eligible_correct = sum(r.correct for r in eligible)
    accuracy_eligible = n_eligible_correct / n_eligible if n_eligible else 0.0
    eligible_wilson_lo, eligible_wilson_hi = wilson_interval(n_eligible_correct, n_eligible)

    authored = [r for r, c in zip(results, cases) if c.source == "authored"]
    n_authored = len(authored)
    accuracy_authored = (sum(r.correct for r in authored) / n_authored) if n_authored else None

    confusion = tuple(
        ConfusionPair(true_grid_cell=t, predicted_grid_cell=p, count=count)
        for (t, p), count in sorted(confusion_counts.items())
    )

    return EvaluationReport(
        classifier_label=type(classifier).__name__,
        is_fixture=bool(getattr(classifier, "IS_FIXTURE", False)),
        results=tuple(results),
        n_total=n_total,
        accuracy_overall=accuracy_overall,
        n_razorpay_sourced_eligible=n_eligible,
        accuracy_razorpay_sourced_eligible=accuracy_eligible,
        accuracy_razorpay_sourced_eligible_wilson_lo=eligible_wilson_lo,
        accuracy_razorpay_sourced_eligible_wilson_hi=eligible_wilson_hi,
        n_authored=n_authored,
        accuracy_authored=accuracy_authored,
        confusion=confusion,
        below_gate_count=sum(r.gated for r in results),
    )


class LeaveOneOutCaseResult(BaseModel):
    held_out_cell: str
    held_out_class: str
    error_reason: str
    predicted_grid_cell: str | None
    predicted_class: str | None
    top_score: float
    margin: float | None
    achievable: bool
    correct: bool | None


class LeaveOneOutCellSummary(BaseModel):
    held_out_cell: str
    failure_class: str
    n_cases: int
    achievable: bool
    accuracy: float | None


class ClassConfusionPair(BaseModel):
    true_class: str
    predicted_class: str
    count: int


class LeaveOneOutReport(BaseModel):
    """The corrected evaluation: for each grid cell, simulate it not
    existing and ask the classifier to place that cell's own held-out
    cases as if the true cell genuinely were not on the grid. Since the
    injection fix (docs/DECISIONS.md, "the first vulnerability found by
    adversarial testing"), the classifier's decision space (four failure
    classes) never actually shrinks -- the model is never shown, and
    never excludes, individual cells at all (classifier.py's
    _build_system_prompt is now identical every call). "Excluding a
    cell" here means classifier.resolve_grid_cell() is asked to map the
    model's chosen failure_class onto a cell EXCLUDING the true one, so a
    correct class guess is forced to land on a genuinely different,
    still-real cell of the same class -- the case's real (error_source,
    error_step) is passed through unchanged; see this module's own top
    docstring for why that is an honest disambiguating signal, not a leak.

    "Correct" is defined by FAILURE_CLASS match, not literal cell
    recovery: with the true cell excluded from resolution, the literal
    label is definitionally unrecoverable, so correctness is the model's
    OWN top-ranked failure_class matching the held-out cell's real class
    -- failure_class is what actually determines the downstream action's
    character, which is the whole point of open-world classification
    (docs/PLAN.md, "the open-world taxonomy"). Two cells --
    bank/payment_authorization (failure_class "soft") and
    business/payment_initiation (failure_class "terminal") -- are the
    SOLE member of their class, so no same-class alternative exists to
    resolve to even when the model's class guess is right: every answer
    there is class-wrong by construction. Their cases are marked `achievable=False`,
    `correct=None`, and are EXCLUDED from `accuracy_achievable_aggregate`
    -- reported separately (`per_cell`, `n_singleton_class_cases`), never
    silently averaged in, the same "never blend labelled figures"
    discipline CLAUDE.md hard rule 6 applies to OBSERVED/ESTIMATED
    figures. `n_skipped_cells` counts cells with zero held-out cases
    (internal/* has none in HELD_OUT_CASES) -- skipped and stated as
    such, not silently omitted.

    `class_confusion` is NOT an accuracy claim: it is built over EVERY
    case, achievable or not, because even a singleton-class cell's
    mispredicted class is real information (which class did the model
    default to when no correct answer was possible at all)."""

    results: tuple[LeaveOneOutCaseResult, ...]
    per_cell: tuple[LeaveOneOutCellSummary, ...]
    n_achievable_total: int
    accuracy_achievable_aggregate: float
    #: 95% Wilson interval on accuracy_achievable_aggregate -- see
    #: classifier_eval.wilson_interval()'s own docstring for why this
    #: must never be dropped when the figure is cited. At N=6 this
    #: interval typically spans roughly half of [0, 1]; that width IS
    #: the finding, not a caveat to shrink away.
    accuracy_achievable_wilson_lo: float
    accuracy_achievable_wilson_hi: float
    n_singleton_class_cases: int
    n_skipped_cells: int
    class_confusion: tuple[ClassConfusionPair, ...]


def evaluate_leave_one_out(
    llm: LlmClassifier,
    cases: tuple[HeldOutCase, ...] = HELD_OUT_CASES,
) -> LeaveOneOutReport:
    """Runs LlmClassifier directly (never CascadingClassifier): this
    evaluation is specifically about the LLM's mapping skill under a
    restricted grid, and ExactClassifier's fast-path lookup is orthogonal
    to that -- letting it short-circuit even one case (e.g. payment_failed,
    whose normalised description happens to equal its own error_reason)
    would understate how hard the real mapping task is for exactly that
    case. Only `generalisation_eligible` cases participate, same rule as
    evaluate_classifier (payment_failed's two-word description carries no
    signal regardless of task design)."""
    grid = policy_grid()

    results: list[LeaveOneOutCaseResult] = []
    per_cell: list[LeaveOneOutCellSummary] = []
    confusion_counts: dict[tuple[str, str], int] = {}
    n_skipped_cells = 0

    eligible_cases = [c for c in cases if c.generalisation_eligible]

    for row in grid:
        cell_cases = [c for c in eligible_cases if c.true_grid_cell == row.grid_cell]
        if not cell_cases:
            n_skipped_cells += 1
            per_cell.append(
                LeaveOneOutCellSummary(
                    held_out_cell=row.grid_cell,
                    failure_class=row.failure_class,
                    n_cases=0,
                    achievable=False,
                    accuracy=None,
                )
            )
            continue

        same_class_alternatives = {r.grid_cell for r in grid if r.grid_cell != row.grid_cell and r.failure_class == row.failure_class}
        achievable = bool(same_class_alternatives)

        cell_results: list[LeaveOneOutCaseResult] = []
        for case in cell_cases:
            classification = llm.classify(
                error_code="BAD_REQUEST_ERROR",
                error_description=case.error_description,
                error_source=row.error_source,
                error_step=row.error_step,
                exclude_grid_cell=row.grid_cell,
            )
            # Read straight off classification.failure_class -- the
            # model's own top-ranked belief, reported even when it could
            # not be resolved to a cell (e.g. the excluded cell was the
            # only member of that class). This is simpler and strictly
            # more informative than the old by_cell[grid_cell] reverse
            # lookup, which could not work at all when grid_cell is None.
            predicted_class = classification.failure_class
            # "Correct" now reduces to a direct class comparison: for an
            # achievable cell, resolve_grid_cell always succeeds when the
            # model's own top class matches the held-out cell's class
            # (some OTHER member of that class always exists), so this is
            # provably equivalent to the old "resolved cell lands among
            # the true class's other members" test, just simpler.
            correct = (predicted_class == row.failure_class) if achievable else None
            margin = (
                classification.candidates[0].score - classification.candidates[1].score
                if len(classification.candidates) >= 2
                else None
            )
            result = LeaveOneOutCaseResult(
                held_out_cell=row.grid_cell,
                held_out_class=row.failure_class,
                error_reason=case.error_reason,
                predicted_grid_cell=classification.grid_cell,
                predicted_class=predicted_class,
                top_score=classification.confidence,
                margin=margin,
                achievable=achievable,
                correct=correct,
            )
            cell_results.append(result)
            results.append(result)

            if predicted_class is not None:
                key = (row.failure_class, predicted_class)
                confusion_counts[key] = confusion_counts.get(key, 0) + 1

        n = len(cell_results)
        accuracy = (sum(bool(r.correct) for r in cell_results) / n) if achievable else None
        per_cell.append(
            LeaveOneOutCellSummary(
                held_out_cell=row.grid_cell,
                failure_class=row.failure_class,
                n_cases=n,
                achievable=achievable,
                accuracy=accuracy,
            )
        )

    achievable_results = [r for r in results if r.achievable]
    n_achievable_total = len(achievable_results)
    n_achievable_correct = sum(bool(r.correct) for r in achievable_results)
    accuracy_achievable_aggregate = n_achievable_correct / n_achievable_total if n_achievable_total else 0.0
    achievable_wilson_lo, achievable_wilson_hi = wilson_interval(n_achievable_correct, n_achievable_total)
    n_singleton_class_cases = len([r for r in results if not r.achievable])

    class_confusion = tuple(
        ClassConfusionPair(true_class=t, predicted_class=p, count=count)
        for (t, p), count in sorted(confusion_counts.items())
        if t != p
    )

    return LeaveOneOutReport(
        results=tuple(results),
        per_cell=tuple(per_cell),
        n_achievable_total=n_achievable_total,
        accuracy_achievable_aggregate=accuracy_achievable_aggregate,
        accuracy_achievable_wilson_lo=achievable_wilson_lo,
        accuracy_achievable_wilson_hi=achievable_wilson_hi,
        n_singleton_class_cases=n_singleton_class_cases,
        n_skipped_cells=n_skipped_cells,
        class_confusion=class_confusion,
    )


def render_loo_report(report: LeaveOneOutReport) -> str:
    """The leave-one-out counterpart to render_report -- see this module's
    top docstring for why this is the corrected task and evaluate_classifier's
    figure is kept as a deliberately harder comparison, not replaced."""
    lines: list[str] = []
    lines.append("=== Leave-one-cell-out evaluation: LlmClassifier ===")
    lines.append("")
    lines.append(
        f"{'held_out_cell':32s} {'class':10s} {'n':>3s} {'achievable':>10s} {'accuracy':>10s}"
    )
    for cell in report.per_cell:
        acc_str = f"{cell.accuracy:.3f}" if cell.accuracy is not None else "n/a"
        if cell.n_cases == 0:
            note = "SKIPPED (no held-out cases for this cell)"
        elif not cell.achievable:
            note = "not achievable -- no same-class cell exists among the other six"
        else:
            note = acc_str
        lines.append(f"{cell.held_out_cell:32s} {cell.failure_class:10s} {cell.n_cases:>3d} {str(cell.achievable):>10s} {note:>10s}")

    lines.append("")
    lines.append(
        f"achievable aggregate accuracy (N={report.n_achievable_total}): "
        f"{report.accuracy_achievable_aggregate:.3f} "
        f"(95% Wilson CI: {report.accuracy_achievable_wilson_lo:.2f}-{report.accuracy_achievable_wilson_hi:.2f})"
        f"  <-- the corrected, production-faithful figure"
    )
    lines.append(
        f"non-achievable (singleton-class) cases, excluded from the aggregate above "
        f"by construction: {report.n_singleton_class_cases}"
    )
    lines.append(f"cells skipped (zero held-out cases): {report.n_skipped_cells}")

    lines.append("")
    lines.append("Per-class confusion (true_class -> predicted_class, off-diagonal only):")
    if report.class_confusion:
        for pair in report.class_confusion:
            lines.append(f"  {pair.true_class} -> {pair.predicted_class}  (x{pair.count})")
    else:
        lines.append("  none")
    transient_to_customer = next(
        (p.count for p in report.class_confusion if p.true_class == "transient" and p.predicted_class == "customer"), 0
    )
    customer_to_transient = next(
        (p.count for p in report.class_confusion if p.true_class == "customer" and p.predicted_class == "transient"), 0
    )
    lines.append(
        f"  transient -> customer (would cause a MISSED recovery, nudge_no_auto_retry never re-presents): {transient_to_customer}"
    )
    lines.append(
        f"  customer -> transient (would cause an UNWARRANTED retry): {customer_to_transient}"
    )

    return "\n".join(lines)


_FIXTURE_WARNING = (
    "FIXTURE ARTEFACT -- NOT A MEASUREMENT. Every figure below comes from "
    "a hand-authored answer key (see FixtureClassifier), not a real model "
    "call. Its 'wrong' entries were placed deliberately so this report "
    "would not look like a suspicious 100% -- edit one line of the fixture "
    "and every number below changes. This exists to exercise "
    "evaluate_classifier's own plumbing, not to describe LlmClassifier's "
    "real skill. See docs/DECISIONS.md for the incident this guards against."
)


def render_report(report: EvaluationReport) -> str:
    """The one place this codebase turns an EvaluationReport into text --
    every code path that prints or logs a report should go through this,
    specifically so the fixture warning below cannot be forgotten by a
    caller that formats the numbers itself. If report.is_fixture, the
    warning is printed FIRST and every accuracy figure is prefixed with
    an inline [FIXTURE] marker; there is no way to call this function on
    a fixture report and get a clean, measurement-shaped table out."""
    lines: list[str] = []
    lines.append(f"=== Evaluation: {report.classifier_label} ===")
    if report.is_fixture:
        lines.append("")
        lines.append("!" * 78)
        for wrapped_line in _wrap(_FIXTURE_WARNING, 76):
            lines.append("! " + wrapped_line)
        lines.append("!" * 78)
    lines.append("")

    header = ("error_reason", "source", "true_cell", "predicted_cell", "conf", "correct", "gated", "gen_elig")
    lines.append(
        f"{header[0]:32s} {header[1]:13s} {header[2]:33s} {header[3]:33s} "
        f"{header[4]:>5s} {header[5]:>7s} {header[6]:>6s} {header[7]:>9s}"
    )
    for r in report.results:
        lines.append(
            f"{r.error_reason:32s} {r.source:13s} {r.true_grid_cell:33s} "
            f"{str(r.predicted_grid_cell):33s} {r.confidence:5.2f} {str(r.correct):>7s} "
            f"{str(r.gated):>6s} {str(r.generalisation_eligible):>9s}"
        )

    lines.append("")
    lines.append("Confusion (true -> predicted, off-diagonal only):")
    if report.confusion:
        for pair in report.confusion:
            lines.append(f"  {pair.true_grid_cell} -> {pair.predicted_grid_cell}  (x{pair.count})")
    else:
        lines.append("  none")

    marker = "[FIXTURE] " if report.is_fixture else ""
    lines.append("")
    lines.append(f"{marker}overall accuracy (N={report.n_total}): {report.accuracy_overall:.3f}")
    lines.append(
        f"{marker}Razorpay-sourced, generalisation-eligible accuracy "
        f"(N={report.n_razorpay_sourced_eligible}): {report.accuracy_razorpay_sourced_eligible:.3f} "
        f"(95% Wilson CI: {report.accuracy_razorpay_sourced_eligible_wilson_lo:.2f}-"
        f"{report.accuracy_razorpay_sourced_eligible_wilson_hi:.2f})"
        + ("  <-- the only figure that is evidence of open-world generalisation" if not report.is_fixture else "")
    )
    lines.append(f"{marker}authored accuracy (N={report.n_authored}): {report.accuracy_authored}")
    lines.append(f"below confidence gate: {report.below_gate_count} / {report.n_total}")

    if report.is_fixture:
        lines.append("")
        lines.append("!! ALL THREE FIGURES ABOVE ARE FIXTURE ARTEFACTS, NOT MEASUREMENTS. !!")

    return "\n".join(lines)


def _wrap(text: str, width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) > width and current:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


class FixtureClassifier:
    """A hand-authored, CLEARLY-NOT-REAL stand-in for LlmClassifier, used
    only when no GROQ_API_KEY is available to run the real evaluation.
    Its answers are plausible but invented by this codebase, not recorded
    from a real model call -- never present a report built from this
    classifier as evidence of the real classifier's behaviour without that
    caveat attached. IS_FIXTURE=True is what makes evaluate_classifier
    stamp EvaluationReport.is_fixture, which render_report then refuses to
    print cleanly -- see this module's docstring on classifier_eval.py's
    EvaluationReport for the incident this exists to prevent."""

    IS_FIXTURE = True

    #: error_reason -> (grid_cell, confidence, reasoning). A deliberately
    #: imperfect fixture (see the two "wrong" entries below) so a report
    #: built from it isn't a suspicious 100% -- these are still invented,
    #: not measured, values.
    _FIXTURE_ANSWERS: dict[str, tuple[str, float, str]] = {
        "payment_failed": ("gateway/payment_authorization", 0.4, "fixture: generic phrase, low-confidence guess"),
        "international_transaction_not_allowed": (
            "business/payment_initiation",
            0.95,
            "fixture: clearly a cross-border restriction",
        ),
        "gateway_technical_error": ("gateway/payment_authorization", 0.85, "fixture: gateway-side technical issue"),
        "authentication_failed": ("gateway/authentication", 0.9, "fixture: explicit OTP/verification failure"),
        "payment_timed_out": ("bank/payment_authorization", 0.7, "fixture: temporary issue, bank-side timing"),
        "card_declined": ("bank/payment_authorization", 0.85, "fixture: explicit bank decline"),
        "insufficient_fund": ("customer/payment_authorization", 0.9, "fixture: explicit customer-side funds issue"),
        "payment_cancelled": ("customer/payment_authentication", 0.6, "fixture: cancellation during authentication"),
        "card_disabled_online": ("customer/payment_authorization", 0.55, "fixture: card-level restriction, moderate confidence"),
        "card_number_invalid": ("bank/payment_authorization", 0.5, "fixture: deliberately wrong -- data entry issue misread as a bank-side problem"),
    }

    def classify(
        self,
        error_code: str,
        error_description: str,
        error_source: str | None = None,
        error_step: str | None = None,
        error_reason: str | None = None,
    ) -> Classification:
        for case in HELD_OUT_CASES:
            if case.error_description == error_description:
                grid_cell, confidence, reasoning = self._FIXTURE_ANSWERS[case.error_reason]
                return Classification(grid_cell=grid_cell, confidence=confidence, reasoning=reasoning)
        return Classification(grid_cell=None, confidence=0.0, reasoning="fixture: no canned answer for this input")
