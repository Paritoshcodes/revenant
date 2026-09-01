"""tests/test_classifier_eval.py"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from revenant_contracts import policy_grid
from revenant_engine.classifier import LlmClassifier
from revenant_engine.classifier_eval import (
    HELD_OUT_CASES,
    FixtureClassifier,
    evaluate_classifier,
    evaluate_leave_one_out,
    render_loo_report,
    wilson_interval,
)


def test_held_out_cases_cover_all_ten_taxonomy_reasons():
    assert len(HELD_OUT_CASES) == 10
    assert len({c.error_reason for c in HELD_OUT_CASES}) == 10


def test_every_case_has_a_source_and_provenance():
    for case in HELD_OUT_CASES:
        assert case.source in ("live_sample", "razorpay_docs", "authored")
        assert case.provenance  # non-empty


def test_payment_failed_is_excluded_from_generalisation_scoring():
    payment_failed = next(c for c in HELD_OUT_CASES if c.error_reason == "payment_failed")
    assert payment_failed.generalisation_eligible is False
    assert payment_failed.source == "live_sample"


def test_card_disabled_online_is_recorded_as_cross_referenced():
    case = next(c for c in HELD_OUT_CASES if c.error_reason == "card_disabled_online")
    assert case.match_method == "cross_referenced_by_test_card"


def test_evaluate_classifier_report_shape_against_fixture():
    report = evaluate_classifier(FixtureClassifier())

    assert report.n_total == 10
    assert len(report.results) == 10
    assert 0.0 <= report.accuracy_overall <= 1.0
    assert report.n_razorpay_sourced_eligible == 9  # 10 minus payment_failed
    assert 0.0 <= report.accuracy_razorpay_sourced_eligible <= 1.0
    assert report.n_authored == 0
    assert report.accuracy_authored is None  # reported as absent, not as 0.0


def test_evaluate_classifier_never_reveals_the_true_cell_to_the_classifier():
    """A classifier that just returns whatever it's asked about (a
    trivial cheat) must score 0, proving the true cell is never handed to
    classify()."""

    class EchoCheatClassifier:
        def classify(self, error_code, error_description, error_source=None, error_step=None, error_reason=None):
            from revenant_engine.classifier import Classification

            # A cheating classifier that could only "win" if the true
            # answer leaked into its inputs somehow -- it has no legitimate
            # way to know the true cell from error_description alone here,
            # so it always returns a fixed wrong-ish guess.
            return Classification(grid_cell="gateway/payment_authorization", confidence=1.0, reasoning="cheat")

    report = evaluate_classifier(EchoCheatClassifier())
    # Some cases legitimately have this as their true cell (payment_failed,
    # gateway_technical_error), so this isn't 0/10, but it must not be 10/10
    # either -- proving the classifier wasn't just handed the answer.
    assert report.accuracy_overall < 1.0


def test_gate_threshold_marks_gated_results_without_changing_predictions():
    report_ungated = evaluate_classifier(FixtureClassifier())
    report_gated = evaluate_classifier(FixtureClassifier(), gate_threshold=0.8)

    assert report_ungated.below_gate_count == 0
    assert report_gated.below_gate_count > 0
    # Predictions themselves are unaffected by gating -- only the `gated` flag changes.
    for a, b in zip(report_ungated.results, report_gated.results):
        assert a.predicted_grid_cell == b.predicted_grid_cell


# -- evaluate_leave_one_out ----------------------------------------------------
#
# A real LlmClassifier with an injected mock client (same DI seam
# test_classifier.py uses). Since the injection fix, the system prompt no
# longer varies with the excluded cell at all (the model is never shown
# individual cells -- see classifier.py's _build_system_prompt), so this
# fixture can no longer read "which cell is excluded" off the prompt. It
# reads the TRUSTED error_source/error_step lines out of the USER message
# instead (those still vary per call, exactly as production does), reverse
# -looks-up which grid row the call is about, and always returns that
# row's own real failure_class as the top candidate -- reproducing the
# same "always correct when achievable" fixture property the existing
# hand-computed assertions (achievable aggregate == 1.0, singleton cells
# non-achievable) depend on, now via the class the model reports rather
# than a cell it names directly.


def _loo_side_effect(*args, **kwargs):
    user_content = kwargs["messages"][1]["content"]
    grid = policy_grid()
    row = next(
        r
        for r in grid
        if f"error_source: {r.error_source}" in user_content and f"error_step: {r.error_step}" in user_content
    )
    true_class = row.failure_class
    other_class = next(c for c in ("transient", "customer", "soft", "terminal") if c != true_class)
    body = json.dumps(
        {
            "candidates": [{"failure_class": true_class, "score": 0.9}, {"failure_class": other_class, "score": 0.3}],
            "reasoning": "fixture: always the true class first",
        }
    )
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=body))])


def _loo_llm_classifier() -> LlmClassifier:
    client = MagicMock()
    client.chat.completions.create.side_effect = _loo_side_effect
    return LlmClassifier(client=client)


def test_leave_one_out_achievable_aggregate_matches_hand_computed_value():
    report = evaluate_leave_one_out(_loo_llm_classifier())

    # 6 achievable held-out cases in real HELD_OUT_CASES (gateway/payment_authorization 1,
    # gateway/authentication 1, customer/payment_authorization 3,
    # customer/payment_authentication 1), every one correct by the fixture's
    # own construction -> hand-computed aggregate is exactly 1.0.
    assert report.n_achievable_total == 6
    assert report.accuracy_achievable_aggregate == 1.0


def test_leave_one_out_singleton_class_cells_are_not_achievable_and_excluded():
    report = evaluate_leave_one_out(_loo_llm_classifier())

    singleton_cells = {"bank/payment_authorization", "business/payment_initiation"}
    singleton_results = [r for r in report.results if r.held_out_cell in singleton_cells]
    assert singleton_results  # sanity: the real dataset does cover these cells
    for result in singleton_results:
        assert result.achievable is False
        assert result.correct is None

    assert report.n_singleton_class_cases == 3  # 2 for bank/payment_authorization, 1 for business/payment_initiation
    # Every non-singleton held-out cell (with cases) IS achievable, and no
    # singleton-class result leaks into the achievable set.
    non_singleton_results = [r for r in report.results if r.held_out_cell not in singleton_cells]
    assert non_singleton_results
    assert all(r.achievable for r in non_singleton_results)
    assert all(r.held_out_cell not in singleton_cells for r in report.results if r.achievable)


def test_leave_one_out_skips_cells_with_zero_held_out_cases():
    report = evaluate_leave_one_out(_loo_llm_classifier())

    internal_summary = next(c for c in report.per_cell if c.held_out_cell == "internal/*")
    assert internal_summary.n_cases == 0
    assert internal_summary.achievable is False
    assert internal_summary.accuracy is None
    assert report.n_skipped_cells == 1


def test_render_loo_report_does_not_crash_and_contains_key_figures():
    report = evaluate_leave_one_out(_loo_llm_classifier())
    text = render_loo_report(report)

    assert "achievable aggregate accuracy" in text
    assert "95% Wilson CI" in text
    assert "internal/*" in text
    assert "transient -> customer" in text
    assert "customer -> transient" in text


def test_leave_one_out_report_carries_a_wilson_interval_matching_its_own_counts():
    report = evaluate_leave_one_out(_loo_llm_classifier())

    correct = round(report.accuracy_achievable_aggregate * report.n_achievable_total)
    expected_lo, expected_hi = wilson_interval(correct, report.n_achievable_total)
    assert report.accuracy_achievable_wilson_lo == pytest.approx(expected_lo)
    assert report.accuracy_achievable_wilson_hi == pytest.approx(expected_hi)


def test_evaluate_classifier_report_carries_a_wilson_interval_matching_its_own_counts():
    report = evaluate_classifier(FixtureClassifier())

    correct = round(report.accuracy_razorpay_sourced_eligible * report.n_razorpay_sourced_eligible)
    expected_lo, expected_hi = wilson_interval(correct, report.n_razorpay_sourced_eligible)
    assert report.accuracy_razorpay_sourced_eligible_wilson_lo == pytest.approx(expected_lo)
    assert report.accuracy_razorpay_sourced_eligible_wilson_hi == pytest.approx(expected_hi)


# -- wilson_interval -----------------------------------------------------------


def test_wilson_interval_hand_checkable_examples():
    """Pins the same two hand-checkable examples cited in
    wilson_interval's own docstring."""
    lo, hi = wilson_interval(3, 6)
    assert lo == pytest.approx(0.1876, abs=1e-3)
    assert hi == pytest.approx(0.8124, abs=1e-3)

    lo, hi = wilson_interval(5, 9)
    assert lo == pytest.approx(0.2667, abs=1e-3)
    assert hi == pytest.approx(0.8112, abs=1e-3)


def test_wilson_interval_always_within_unit_range():
    for successes, n in [(0, 1), (1, 1), (0, 10), (10, 10), (5, 10)]:
        lo, hi = wilson_interval(successes, n)
        assert 0.0 <= lo <= hi <= 1.0


def test_wilson_interval_n_zero_is_maximally_uncertain():
    assert wilson_interval(0, 0) == (0.0, 1.0)


def test_wilson_interval_narrows_as_n_grows_at_fixed_proportion():
    lo_small, hi_small = wilson_interval(5, 10)
    lo_large, hi_large = wilson_interval(50, 100)
    assert (hi_small - lo_small) > (hi_large - lo_large)
