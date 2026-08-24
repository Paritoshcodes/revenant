"""Shared vocabulary, mirroring packages/contracts/src/types.ts.

Only the unions and row shapes live here. The grid data itself is in
../../data/*.json and is read by grid.py, so it is never duplicated.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ErrorSource = Literal["gateway", "bank", "customer", "business", "internal"]
ErrorStep = Literal["payment_initiation", "payment_authorization", "authentication", "*"]
FailureClass = Literal["transient", "soft", "customer", "terminal"]
RecoveryAction = Literal[
    "retry_with_backoff",
    "retry_prompt_alternate",
    "retry_on_timing_window",
    "nudge_no_auto_retry",
    "never_retry",
]
Arm = Literal["control", "treatment"]
TransactionStatus = Literal["open", "recovered", "abandoned", "terminal"]
AttemptOutcome = Literal["captured", "failed", "blocked"]
GuardrailVerdict = Literal["allow", "veto"]

EvidenceLayer = Literal["layer1_observed", "layer2_estimated", "layer3_ope"]
EvidenceLabel = Literal["OBSERVED", "ESTIMATED"]


@dataclass(frozen=True, slots=True)
class PolicyGridRow:
    """One row of the policy grid."""

    grid_cell: str
    error_source: ErrorSource
    error_step: ErrorStep
    failure_class: FailureClass
    action: RecoveryAction
    action_label: str
    observable_in_test_mode: bool


@dataclass(frozen=True, slots=True)
class DeclineReason:
    """One documented decline reason.

    ``observed_in_test_mode`` false means the reason exists only in the
    synthetic population, so any figure derived from it is ESTIMATED and can
    never be reported as OBSERVED.
    """

    error_reason: str
    error_source: ErrorSource
    error_step: ErrorStep
    grid_cell: str
    observed_in_test_mode: bool
    test_cards: tuple[str, ...]
    note: str | None = None
