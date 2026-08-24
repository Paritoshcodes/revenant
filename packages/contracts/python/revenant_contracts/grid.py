"""Typed access to the canonical policy grid and decline taxonomy.

Reads the same JSON files as the TypeScript package. Data and lookup only:
the policy function decides, this module does not.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from .types import DeclineReason, ErrorSource, ErrorStep, PolicyGridRow

# revenant_contracts/ -> python/ -> contracts/ -> data/
_DATA_DIR = Path(__file__).resolve().parents[2] / "data"

GENESIS_PREV_HASH = "0" * 64


def _load(name: str) -> dict:
    path = _DATA_DIR / name
    if not path.is_file():
        raise FileNotFoundError(
            f"canonical contract data missing at {path}. "
            "revenant-contracts must be installed editable from "
            "packages/contracts/python so it can see ../../data."
        )
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def policy_grid() -> tuple[PolicyGridRow, ...]:
    return tuple(PolicyGridRow(**row) for row in _load("policy-grid.json")["rows"])


@lru_cache(maxsize=1)
def decline_taxonomy() -> tuple[DeclineReason, ...]:
    return tuple(
        DeclineReason(
            error_reason=r["error_reason"],
            error_source=r["error_source"],
            error_step=r["error_step"],
            grid_cell=r["grid_cell"],
            observed_in_test_mode=r["observed_in_test_mode"],
            test_cards=tuple(r["test_cards"]),
            note=r.get("note"),
        )
        for r in _load("decline-taxonomy.json")["reasons"]
    )


def grid_cell(source: ErrorSource, step: ErrorStep) -> str:
    return f"{source}/{step}"


def lookup_grid_row(source: ErrorSource, step: ErrorStep) -> PolicyGridRow | None:
    """Exact (source, step) match first, then the source's wildcard row."""
    by_cell = {row.grid_cell: row for row in policy_grid()}
    return by_cell.get(grid_cell(source, step)) or by_cell.get(grid_cell(source, "*"))


def lookup_decline_reason(error_reason: str) -> DeclineReason | None:
    return next(
        (r for r in decline_taxonomy() if r.error_reason == error_reason), None
    )


def is_observed_in_test_mode(error_reason: str) -> bool:
    """True only for the two reasons that reproduce in Razorpay test mode."""
    reason = lookup_decline_reason(error_reason)
    return reason is not None and reason.observed_in_test_mode


def observed_reasons() -> tuple[str, ...]:
    return tuple(r.error_reason for r in decline_taxonomy() if r.observed_in_test_mode)
