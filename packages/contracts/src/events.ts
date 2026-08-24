/**
 * Audit event schema.
 *
 * Every row of audit_log holds one of these as its payload. The chain is
 * append only and hash linked: hash = sha256(prev_hash + canonical_json(payload)).
 * The genesis row's prev_hash is 64 zeros. See docs/ARCHITECTURE.md.
 */
import type {
  Arm,
  AttemptOutcome,
  ErrorSource,
  ErrorStep,
  GridCell,
  GuardrailVerdict,
  RecoveryAction,
} from './types.js';

export const GENESIS_PREV_HASH = '0'.repeat(64);

export type AuditEventKind =
  | 'transaction_opened'
  | 'decision_made'
  | 'guardrail_veto'
  | 'attempt_started'
  | 'attempt_settled'
  | 'transaction_closed';

interface AuditEventBase {
  readonly kind: AuditEventKind;
  /** ISO 8601, UTC. */
  readonly timestamp: string;
  readonly transaction_id: string;
  readonly arm: Arm;
}

export interface TransactionOpened extends AuditEventBase {
  readonly kind: 'transaction_opened';
  readonly amount_paise: number;
  readonly rzp_order_id: string | null;
  readonly rzp_payment_link_id: string | null;
}

export interface DecisionMade extends AuditEventBase {
  readonly kind: 'decision_made';
  readonly attempt_number: number;
  readonly grid_cell: GridCell;
  readonly recovery_probability: number;
  readonly proposed_action: RecoveryAction;
  readonly propensity: number;
  readonly guardrail_verdict: Extract<GuardrailVerdict, 'allow'>;
  /** LLM narrative. Evidence of reasoning, never the reason money moved. */
  readonly diagnosis: string | null;
}

/**
 * A veto is a first-class event, not a flag on a decision. The demo has to
 * be able to show a guardrail refusing an action the policy proposed.
 */
export interface GuardrailVeto extends AuditEventBase {
  readonly kind: 'guardrail_veto';
  readonly attempt_number: number;
  readonly grid_cell: GridCell;
  readonly proposed_action: RecoveryAction;
  readonly guardrail_verdict: Extract<GuardrailVerdict, 'veto'>;
  readonly guardrail_reason: string;
}

export interface AttemptStarted extends AuditEventBase {
  readonly kind: 'attempt_started';
  readonly attempt_number: number;
  readonly idempotency_key: string;
  readonly action: RecoveryAction;
  readonly rzp_request_id: string | null;
}

export interface AttemptSettled extends AuditEventBase {
  readonly kind: 'attempt_settled';
  readonly attempt_number: number;
  readonly idempotency_key: string;
  readonly rzp_payment_id: string | null;
  readonly rzp_response_id: string | null;
  readonly error_code: string | null;
  readonly error_source: ErrorSource | null;
  readonly error_step: ErrorStep | null;
  readonly error_reason: string | null;
  readonly auth_code: string | null;
  readonly outcome: AttemptOutcome;
}

export interface TransactionClosed extends AuditEventBase {
  readonly kind: 'transaction_closed';
  readonly final_status: 'recovered' | 'abandoned' | 'terminal';
  readonly attempts_made: number;
  readonly narrative: string | null;
}

export type AuditEvent =
  | TransactionOpened
  | DecisionMade
  | GuardrailVeto
  | AttemptStarted
  | AttemptSettled
  | TransactionClosed;
