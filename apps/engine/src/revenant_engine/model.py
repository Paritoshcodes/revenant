"""Recovery probability model: P(recovers | error_source, error_step, action,
amount_band, hour_ist, attempt_number).

A logistic regression, deliberately simple and inspectable -- CLAUDE.md
hard rule 1 says the policy decides, never the LLM, and policy.py's
decision has to be explainable as a comparison of numbers this model
produces, not a black box.

INTERACTION TERM, added after a real bug. The first version of this module
used error_source, error_step and action as separate main-effect one-hot
features only. A logistic regression over pure main effects cannot
represent an action's effectiveness DEPENDING on the failure class -- the
coefficient for "action=retry_prompt_alternate" was a single number added
identically regardless of cell, so its predicted probabilities were nearly
flat across actions within a cell (verified: the backoff-vs-alternate
log-odds gap was +0.0020 in all four non-terminal, non-customer cells,
identical to four decimals -- the signature of a main-effects-only fit)
even though ground-truth.json deliberately encodes the opposite: which
retry action is best REVERSES between cells (gateway/authentication's
best action is retry_prompt_alternate at a realised 0.4663; the same
action on bank/payment_authorization realises only 0.1245, where
retry_on_timing_window wins at 0.4166 instead). `cell_action` below
(grid_cell + "|" + action, one-hot encoded like everything else) is the
fix: an explicit interaction feature lets the model learn a genuinely
different coefficient per (cell, action) pair while remaining a plain
logistic regression with readable coefficients, never a black-box learner.
See docs/DECISIONS.md for the full incident. tests/test_model.py's
`test_model_ranks_actions_correctly_within_each_non_terminal_cell` is the
regression test that catches a return to main-effects-only.

FEATURES, and the one deliberate omission. The feature set is exactly
what the real gateway has at decision time: error_source, error_step, the
proposed action, the cell/action interaction, an amount band, hour of
day, and attempt number (see FEATURE_KEYS below). `customer_prior` is
NEVER a feature, on purpose. It is a latent per-customer trait
(population.py's own description) that the real system cannot observe --
Razorpay never tells us how reliable a customer is. Training on it would
be exactly the label leakage this whole project exists to catch: a model
that secretly uses the thing that generated the label to predict the
label looks perfect and means nothing. tests/test_model.py asserts this
directly, not just by omission here.

CIRCULARITY, stated plainly, because it is easy to misread the metrics
below as more than they are. Training data comes from THIS SAME
generator (population.py) and THIS SAME ground-truth table
(outcomes.recovers) that also produce the Layer 2 evaluation population.
The model can therefore learn the true generative process almost exactly,
and the held-out accuracy/log-loss/calibration figures reported here will
look excellent. That is EXPECTED, not evidence of a good real-world model:
Layer 2's claim is about whether the measurement instrument (the
estimator) is sound, not about whether this particular model would perform
well on real Razorpay traffic, which no synthetic evaluation can show. A
figure from this module must never be cited as evidence of real-world
skill -- CLAUDE.md hard rule 6, docs/PRIOR-ART.md's honesty commitments.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from revenant_contracts import grid_cell as _grid_cell
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss as sk_log_loss
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .outcomes import recovers
from .population import generate_population

# Every action the model may be asked to score. Training data covers all
# five for every generated transaction, not just each cell's own grid
# action -- the model has to be able to answer "what if THIS action were
# tried here" for policy.py's comparison to mean anything.
ALL_ACTIONS: tuple[str, ...] = (
    "retry_with_backoff",
    "retry_prompt_alternate",
    "retry_on_timing_window",
    "nudge_no_auto_retry",
    "never_retry",
)

# Not pinned by any protocol document -- a documented modelling choice for
# this feature only. Paise. "small" below a typical everyday purchase,
# "large" above a clearly high-ticket one, "medium" the broad middle;
# chosen as fixed, sample-independent cutoffs (not empirical terciles) so
# the band a given amount falls into never shifts as training data changes.
AMOUNT_BAND_BOUNDARIES: tuple[int, int] = (30_000, 100_000)

FEATURE_KEYS: tuple[str, ...] = (
    "error_source",
    "error_step",
    "action",
    "cell_action",
    "amount_band",
    "hour_ist",
    "attempt_number",
)

DEFAULT_TRAIN_N = 5000
# Frozen so the module-level cached default model (default_model(), used by
# policy.py/main.py) is reproducible across processes without being
# re-derived from anything else's seed.
DEFAULT_TRAIN_SEED = 20260828
DEFAULT_TEST_SIZE = 0.2


def amount_band(amount_paise: int) -> str:
    small_max, medium_max = AMOUNT_BAND_BOUNDARIES
    if amount_paise < small_max:
        return "small"
    if amount_paise < medium_max:
        return "medium"
    return "large"


def feature_dict(
    error_source: str,
    error_step: str,
    action: str,
    amount_paise: int,
    hour_ist: int,
    attempt_number: int,
) -> dict[str, object]:
    """One row of model input. String values are one-hot encoded by
    DictVectorizer below; numeric values (hour_ist, attempt_number) pass
    through as-is -- see model training's own note on why attempt_number
    carries no real signal in this frozen world despite being a feature.

    `cell_action` is the interaction term (see module docstring): without
    it, error_source/error_step/action are pure main effects and the
    model cannot represent an action's effectiveness depending on the
    cell, which is exactly the shape ground-truth.json encodes."""
    return {
        "error_source": error_source,
        "error_step": error_step,
        "action": action,
        "cell_action": f"{_grid_cell(error_source, error_step)}|{action}",
        "amount_band": amount_band(amount_paise),
        "hour_ist": float(hour_ist),
        "attempt_number": float(attempt_number),
    }


def _build_training_rows(
    n: int,
    seed: int,
    ground_truth: dict[tuple[str, str], float] | None = None,
) -> tuple[list[dict[str, object]], list[int]]:
    """One row per (transaction, action) pair: every generated transaction
    is paired with EVERY one of the five actions, so the model sees the
    full action space at every point in feature space, not just each
    cell's own grid-designated action.

    Labels are drawn via outcomes.recovers, which DOES use customer_prior
    internally (to modulate the draw) -- that is legitimate, since
    customer_prior is what makes the label noisy/realistic. It is never
    written into the feature dict itself. A separate RNG stream (seed + 1)
    drives the label draws, kept apart from generate_population's own
    stream so this function's own randomness is independently traceable.
    """
    population = generate_population(n=n, seed=seed)
    rng = np.random.default_rng(seed + 1)

    rows: list[dict[str, object]] = []
    labels: list[int] = []
    for txn in population.transactions:
        for action in ALL_ACTIONS:
            rows.append(
                feature_dict(txn.error_source, txn.error_step, action, txn.amount_paise, txn.hour_ist, txn.attempt_number)
            )
            labels.append(int(recovers(txn, action, ground_truth, rng)))
    return rows, labels


@dataclass(frozen=True)
class CalibrationBin:
    """One bucket of a reliability diagram: among predictions that fell in
    [bin_lower, bin_upper), how often did the label actually recover
    (observed_rate) versus what the model predicted on average
    (predicted_mean)? A well-calibrated model has the two close for every
    bin with enough count to be meaningful."""

    bin_lower: float
    bin_upper: float
    predicted_mean: float
    observed_rate: float
    count: int


@dataclass(frozen=True)
class TrainingMetrics:
    n_train: int
    n_test: int
    accuracy: float
    log_loss: float
    calibration: tuple[CalibrationBin, ...]


def _calibration_table(y_true: np.ndarray, y_prob: np.ndarray, n_bins: int = 10) -> tuple[CalibrationBin, ...]:
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    table: list[CalibrationBin] = []
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (y_prob >= lo) & (y_prob <= hi if i == n_bins - 1 else y_prob < hi)
        count = int(mask.sum())
        if count == 0:
            continue
        table.append(
            CalibrationBin(
                bin_lower=float(lo),
                bin_upper=float(hi),
                predicted_mean=float(y_prob[mask].mean()),
                observed_rate=float(y_true[mask].mean()),
                count=count,
            )
        )
    return tuple(table)


class RecoveryModel:
    """A fitted pipeline plus the held-out metrics it was scored on. See
    this module's own docstring for why those metrics are not evidence of
    real-world skill."""

    def __init__(self, pipeline: Pipeline, metrics: TrainingMetrics) -> None:
        self._pipeline = pipeline
        self.metrics = metrics

    def predict_proba(
        self,
        *,
        error_source: str,
        error_step: str,
        action: str,
        amount_paise: int,
        hour_ist: int,
        attempt_number: int,
    ) -> float:
        row = feature_dict(error_source, error_step, action, amount_paise, hour_ist, attempt_number)
        proba = self._pipeline.predict_proba([row])[0]
        # class 1 = recovered. LogisticRegression's classes_ is sorted, so
        # for binary {0, 1} labels index 1 is always the "recovered" column,
        # asserted once at fit time in train_model rather than trusted here.
        return float(proba[1])

    @property
    def feature_names(self) -> list[str]:
        """The vectorizer's learned feature names, post one-hot-encoding
        -- e.g. 'action=retry_with_backoff', 'hour_ist'. Exposed so a test
        can assert 'customer_prior' never appears among them, not just
        that FEATURE_KEYS omits it."""
        vectorizer: DictVectorizer = self._pipeline.named_steps["vectorize"]
        return list(vectorizer.get_feature_names_out())


def train_model(
    n: int = DEFAULT_TRAIN_N,
    seed: int = DEFAULT_TRAIN_SEED,
    test_size: float = DEFAULT_TEST_SIZE,
    ground_truth: dict[tuple[str, str], float] | None = None,
) -> RecoveryModel:
    """Trains one RecoveryModel from freshly generated synthetic data.
    Same `seed` drives both the train/test split and (offset by +1 inside
    _build_training_rows) the label draws, so a given seed reproduces the
    exact same trained model."""
    rows, labels = _build_training_rows(n, seed, ground_truth)

    X_train, X_test, y_train, y_test = train_test_split(
        rows, labels, test_size=test_size, random_state=seed, stratify=labels
    )

    pipeline = Pipeline(
        [
            ("vectorize", DictVectorizer(sparse=False)),
            ("scale", StandardScaler()),
            ("clf", LogisticRegression(max_iter=1000)),
        ]
    )
    pipeline.fit(X_train, y_train)

    assert list(pipeline.named_steps["clf"].classes_) == [0, 1], (
        "RecoveryModel.predict_proba assumes class index 1 is 'recovered'"
    )

    y_prob = pipeline.predict_proba(X_test)[:, 1]
    y_pred = (y_prob >= 0.5).astype(int)
    y_test_arr = np.asarray(y_test)

    metrics = TrainingMetrics(
        n_train=len(X_train),
        n_test=len(X_test),
        accuracy=float(accuracy_score(y_test_arr, y_pred)),
        log_loss=float(sk_log_loss(y_test_arr, y_prob)),
        calibration=_calibration_table(y_test_arr, y_prob),
    )

    return RecoveryModel(pipeline, metrics)


@lru_cache(maxsize=1)
def default_model() -> RecoveryModel:
    """The one trained model policy.py and main.py share, so a request
    doesn't retrain from scratch. Frozen seed/n -- see DEFAULT_TRAIN_SEED."""
    return train_model()
