"""tests/test_model.py

Covers revenant_engine.model: the no-customer_prior-leakage guarantee
(the one thing this module's docstring insists on), reproducibility, and
that held-out accuracy/log-loss/calibration come back as real numbers.
Per the module's own docstring, these numbers are expected to look good
BECAUSE training data shares a generator with the evaluation population --
this test suite checks the numbers are computed correctly and reported,
never that they are "good enough to trust on real traffic" (a claim this
module explicitly disclaims).
"""

from __future__ import annotations

from revenant_contracts import policy_grid
from revenant_engine.model import (
    ALL_ACTIONS,
    FEATURE_KEYS,
    amount_band,
    default_model,
    feature_dict,
    train_model,
)
from revenant_engine.policy import RETRY_ACTIONS
from revenant_engine.true_lift import realised_recovery_probability

SEED = 20260828
N = 2000


def test_customer_prior_is_never_a_feature_key():
    assert "customer_prior" not in FEATURE_KEYS


def test_customer_prior_never_appears_in_a_feature_dict():
    row = feature_dict(
        error_source="gateway",
        error_step="payment_authorization",
        action="retry_with_backoff",
        amount_paise=49_900,
        hour_ist=12,
        attempt_number=1,
    )
    assert "customer_prior" not in row
    assert set(row.keys()) == set(FEATURE_KEYS)


def test_customer_prior_never_appears_in_the_fitted_vectorizers_feature_names():
    """The strongest version of the leakage check: not just that we never
    hand it customer_prior, but that nothing resembling it survives into
    the actual fitted model's feature space."""
    model = train_model(n=N, seed=SEED)
    assert not any("customer_prior" in name for name in model.feature_names)


def test_amount_band_boundaries():
    assert amount_band(9_900) == "small"
    assert amount_band(29_999) == "small"
    assert amount_band(30_000) == "medium"
    assert amount_band(99_999) == "medium"
    assert amount_band(100_000) == "large"
    assert amount_band(5_000_000) == "large"


def test_training_is_deterministic_given_the_same_seed():
    first = train_model(n=N, seed=SEED)
    second = train_model(n=N, seed=SEED)

    assert first.metrics.accuracy == second.metrics.accuracy
    assert first.metrics.log_loss == second.metrics.log_loss

    sample = dict(
        error_source="bank", error_step="payment_authorization", action="retry_on_timing_window",
        amount_paise=49_900, hour_ist=14, attempt_number=1,
    )
    assert first.predict_proba(**sample) == second.predict_proba(**sample)


def test_held_out_metrics_are_reported_as_numbers():
    model = train_model(n=N, seed=SEED)
    m = model.metrics

    assert m.n_train > 0
    assert m.n_test > 0
    assert m.n_train + m.n_test == N * len(ALL_ACTIONS)
    assert 0.0 <= m.accuracy <= 1.0
    assert m.log_loss >= 0.0
    assert len(m.calibration) > 0
    for b in m.calibration:
        assert 0.0 <= b.predicted_mean <= 1.0
        assert 0.0 <= b.observed_rate <= 1.0
        assert b.count > 0


def test_predicted_probability_is_always_a_valid_probability():
    model = train_model(n=N, seed=SEED)
    for action in ALL_ACTIONS:
        p = model.predict_proba(
            error_source="customer", error_step="payment_authorization", action=action,
            amount_paise=49_900, hour_ist=10, attempt_number=1,
        )
        assert 0.0 <= p <= 1.0


def test_structural_zero_actions_score_low_after_training():
    """nudge_no_auto_retry and never_retry are ALWAYS labelled unrecovered
    in training data (ground-truth.json RULE 1: they never re-present the
    payment), so a correctly-fit model should score them near zero on any
    input -- not the exact 0.0 policy.py forces structurally, since this
    is the model's own learned estimate, but close."""
    model = train_model(n=N, seed=SEED)
    for action in ("nudge_no_auto_retry", "never_retry"):
        p = model.predict_proba(
            error_source="gateway", error_step="payment_authorization", action=action,
            amount_paise=49_900, hour_ist=12, attempt_number=1,
        )
        assert p < 0.1


# The regression test for the interaction-term bug (see model.py's module
# docstring and docs/DECISIONS.md). A main-effects-only model produces
# nearly flat probabilities across actions within a cell -- verified
# directly before the fix: the backoff-vs-alternate log-odds gap was
# +0.0020, identical to four decimals, on every one of the four
# non-terminal, non-customer cells. This test fails on that model and
# must pass after model.py's cell_action interaction feature.
#
# Compared over RETRY_ACTIONS only (not nudge/never_retry, which
# test_structural_zero_actions_score_low_after_training already covers
# and which trivially never win against a positive-probability retry
# action anyway), using max_attempts=1 -- true_lift's SINGLE-attempt
# realised figure, matching what this model is actually trained to
# predict (one Bernoulli draw per row), not the multi-attempt-compounded
# figure true_lift.py otherwise reports.
#
# Acceptance uses a value tolerance, not exact action-name equality:
# customer/payment_authentication's three retry actions are configured
# IDENTICALLY in ground-truth.json (all 0.02, "no automated action
# re-engages an absent customer" applies equally to all three), so their
# realised probabilities are a genuine near-tie and any of the three is a
# legitimate answer -- a strict name match there would make the test
# flaky on sampling noise rather than testing ranking correctness.
RANKING_TOLERANCE = 0.05


def test_model_ranks_actions_correctly_within_each_non_terminal_cell():
    model = default_model()

    for row in policy_grid():
        if row.failure_class == "terminal":
            continue

        true_by_action = {
            action: realised_recovery_probability(row.grid_cell, action, max_attempts=1)
            for action in RETRY_ACTIONS
        }
        model_by_action = {
            action: model.predict_proba(
                error_source=row.error_source,
                error_step=row.error_step,
                action=action,
                amount_paise=49_900,
                hour_ist=12,
                attempt_number=1,
            )
            for action in RETRY_ACTIONS
        }

        true_best_value = max(true_by_action.values())
        model_choice = max(model_by_action, key=model_by_action.get)
        model_choice_true_value = true_by_action[model_choice]

        assert model_choice_true_value >= true_best_value - RANKING_TOLERANCE, (
            f"{row.grid_cell}: model chose {model_choice} (true value "
            f"{model_choice_true_value:.4f}), but the best true value was "
            f"{true_best_value:.4f} -- gap exceeds {RANKING_TOLERANCE}. "
            f"true={true_by_action} model={model_by_action}"
        )
