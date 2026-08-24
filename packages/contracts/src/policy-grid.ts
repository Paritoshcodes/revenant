/**
 * Typed access to the canonical policy grid and decline taxonomy.
 *
 * This module carries data and lookup only. It does not decide anything:
 * the policy function lives in the engine, and the guardrails in the
 * gateway. Both read their grid from here so there is one grid, not three.
 */
import gridData from '../data/policy-grid.json' with { type: 'json' };
import taxonomyData from '../data/decline-taxonomy.json' with { type: 'json' };

import type {
  DeclineReason,
  ErrorSource,
  ErrorStep,
  GridCell,
  PolicyGridRow,
} from './types.js';

export const POLICY_GRID: readonly PolicyGridRow[] =
  gridData.rows as readonly PolicyGridRow[];

export const DECLINE_TAXONOMY: readonly DeclineReason[] =
  taxonomyData.reasons as readonly DeclineReason[];

/** Provenance strings, so a report can cite where the grid came from. */
export const POLICY_GRID_SOURCE = gridData.source;
export const DECLINE_TAXONOMY_SOURCE = taxonomyData.source;

const BY_CELL = new Map<GridCell, PolicyGridRow>(
  POLICY_GRID.map((row) => [row.grid_cell, row]),
);

const BY_REASON = new Map<string, DeclineReason>(
  DECLINE_TAXONOMY.map((reason) => [reason.error_reason, reason]),
);

export const gridCell = (source: ErrorSource, step: ErrorStep): GridCell =>
  `${source}/${step}`;

/**
 * Exact `(source, step)` match first, then the source's wildcard row.
 * Returns undefined only when the source itself is unknown, which means
 * the taxonomy needs a new row rather than the caller needing a fallback.
 */
export const lookupGridRow = (
  source: ErrorSource,
  step: ErrorStep,
): PolicyGridRow | undefined =>
  BY_CELL.get(gridCell(source, step)) ?? BY_CELL.get(gridCell(source, '*'));

export const lookupDeclineReason = (
  errorReason: string,
): DeclineReason | undefined => BY_REASON.get(errorReason);

/**
 * True only for the two reasons that actually reproduce in Razorpay test
 * mode. Anything else is synthetic and must be labelled ESTIMATED.
 * See docs/DECISIONS.md and CLAUDE.md hard rule 6.
 */
export const isObservedInTestMode = (errorReason: string): boolean =>
  BY_REASON.get(errorReason)?.observed_in_test_mode ?? false;

export const OBSERVED_REASONS: readonly string[] = DECLINE_TAXONOMY.filter(
  (reason) => reason.observed_in_test_mode,
).map((reason) => reason.error_reason);
