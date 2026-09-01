"""tests/test_confidence_gate.py

Margin-based gating -- see confidence_gate.py's own docstring for why
this replaced a top-1 scalar-confidence threshold (it caught none of
four wrong answers in the 2026-09-01 live run)."""

from __future__ import annotations

import pytest
from revenant_engine.classifier import Classification, RankedCandidate
from revenant_engine.confidence_gate import MARGIN_THRESHOLD, apply_confidence_gate


def _classification(
    candidates: list[tuple[str, float]], reasoning: str = "x", description_truncated: bool = False
) -> Classification:
    ranked = tuple(RankedCandidate(grid_cell=cell, score=score) for cell, score in candidates)
    grid_cell = ranked[0].grid_cell if ranked else None
    confidence = ranked[0].score if ranked else 0.0
    return Classification(
        grid_cell=grid_cell,
        confidence=confidence,
        reasoning=reasoning,
        candidates=ranked,
        description_truncated=description_truncated,
    )


def test_margin_below_threshold_gates():
    classification = _classification(
        [("gateway/authentication", 0.9), ("customer/payment_authentication", 0.9 - (MARGIN_THRESHOLD - 0.01))]
    )
    result = apply_confidence_gate(classification)
    assert result.gated is True
    assert result.grid_cell is None
    assert result.margin == pytest.approx(MARGIN_THRESHOLD - 0.01)


def test_margin_above_threshold_passes_through():
    # Comfortably above, not exactly at, the threshold: float subtraction
    # near a boundary (e.g. 0.9 - 0.3) is not guaranteed to land exactly
    # on MARGIN_THRESHOLD, so this avoids a flaky boundary comparison.
    classification = _classification(
        [("gateway/authentication", 0.95), ("customer/payment_authentication", 0.95 - MARGIN_THRESHOLD - 0.1)]
    )
    result = apply_confidence_gate(classification)
    assert result.gated is False
    assert result.grid_cell == "gateway/authentication"
    assert result.margin > MARGIN_THRESHOLD


def test_fewer_than_two_candidates_passes_through_with_no_margin():
    """Reachable only via ExactClassifier's single-candidate exact hit
    (LlmClassifier itself never returns a confident grid_cell with fewer
    than two candidates -- see classifier.py). A genuine exact-taxonomy
    match is a different, legitimate kind of certainty and is never
    gated for ambiguity it structurally cannot have."""
    classification = _classification([("customer/payment_authorization", 1.0)])
    result = apply_confidence_gate(classification)
    assert result.gated is False
    assert result.grid_cell == "customer/payment_authorization"
    assert result.margin is None


def test_explicit_no_match_always_gates_regardless_of_margin():
    # grid_cell=None must still gate even with candidates present -- the
    # None is authoritative.
    classification = Classification(
        grid_cell=None,
        confidence=0.99,
        reasoning="x",
        candidates=(RankedCandidate(grid_cell="a/b", score=0.99), RankedCandidate(grid_cell="c/d", score=0.98)),
    )
    result = apply_confidence_gate(classification)
    assert result.gated is True
    assert result.grid_cell is None
    assert result.margin is None


def test_custom_threshold_is_honoured():
    classification = _classification([("gateway/authentication", 0.9), ("bank/payment_authorization", 0.6)])
    assert apply_confidence_gate(classification, margin_threshold=0.2).gated is False
    assert apply_confidence_gate(classification, margin_threshold=0.4).gated is True


def test_truncated_description_is_gated_regardless_of_wide_margin():
    """A truncated error_description is an independent, unconditional
    refusal condition -- the classifier reasoned over PARTIAL input, so
    it is refused even when the margin is wide and would otherwise pass.
    The margin is still computed and returned (for audit -- a reader can
    see "wide margin, refused anyway because of truncation"), not
    discarded."""
    classification = _classification(
        [("gateway/authentication", 0.95), ("bank/payment_authorization", 0.05)],
        description_truncated=True,
    )
    result = apply_confidence_gate(classification)
    assert result.gated is True
    assert result.grid_cell is None
    assert result.margin == pytest.approx(0.9)  # still computed, not None
    assert result.description_truncated is True


def test_truncated_description_gates_even_the_margin_less_passthrough():
    """The fewer-than-two-candidates passthrough (normally never gated)
    is still subject to the truncation veto."""
    classification = _classification([("customer/payment_authorization", 1.0)], description_truncated=True)
    result = apply_confidence_gate(classification)
    assert result.gated is True
    assert result.grid_cell is None
    assert result.description_truncated is True


def test_untruncated_description_is_unaffected():
    classification = _classification(
        [("gateway/authentication", 0.95), ("bank/payment_authorization", 0.05)],
        description_truncated=False,
    )
    result = apply_confidence_gate(classification)
    assert result.gated is False
    assert result.description_truncated is False
