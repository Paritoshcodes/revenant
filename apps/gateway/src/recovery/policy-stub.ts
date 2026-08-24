/**
 * Proposes an action by reading the policy grid directly.
 *
 * A stand-in for the engine's logistic-regression policy (ARCHITECTURE.md,
 * "Where the AI sits"). `recoveryProbability` and `propensity` are
 * therefore placeholders, not a model: 0 wherever the grid already tells us
 * the answer (terminal cells have true probability 0 for every action, per
 * EXPERIMENT-PROTOCOL.md; an unmapped cell is unknown, not guessed at), a
 * flat 0.5 for every other mapped cell pending the real estimate, and
 * propensity 1 because this stub always proposes the same action for a
 * given cell.
 */
import { gridCell, lookupGridRow } from '@revenant/contracts';
import type { GridCell, RecoveryAction } from '@revenant/contracts';

import type { FailureDiagnosis } from './types.js';

/** Deterministic stub: always proposes this action, hence propensity 1. */
export const STUB_PROPENSITY = 1;

/** Placeholder recovery probability for any non-terminal, mapped cell. */
export const STUB_RECOVERY_PROBABILITY = 0.5;

/**
 * Safe fallback when the cell has no grid row. The terminal_grid_cell
 * guardrail vetoes an unmapped cell unconditionally (fails closed), so
 * whatever is proposed here never actually executes.
 */
const UNMAPPED_ACTION: RecoveryAction = 'retry_with_backoff';

export interface ProposedAction {
  readonly gridCell: GridCell;
  readonly action: RecoveryAction;
  readonly recoveryProbability: number;
  readonly propensity: number;
}

export const proposeAction = (diagnosis: FailureDiagnosis): ProposedAction => {
  const cell = gridCell(diagnosis.errorSource, diagnosis.errorStep);
  const row = lookupGridRow(diagnosis.errorSource, diagnosis.errorStep);

  if (row === undefined) {
    return {
      gridCell: cell,
      action: UNMAPPED_ACTION,
      recoveryProbability: 0,
      propensity: STUB_PROPENSITY,
    };
  }

  return {
    gridCell: cell,
    action: row.action,
    recoveryProbability:
      row.failure_class === 'terminal' ? 0 : STUB_RECOVERY_PROBABILITY,
    propensity: STUB_PROPENSITY,
  };
};
