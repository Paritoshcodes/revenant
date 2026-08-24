/**
 * Shared vocabulary for gateway, engine and dashboard.
 *
 * Row types mirror the Postgres schema in
 * apps/gateway/migrations/0001_init.sql one field for one column. If a
 * column changes, change it here in the same commit.
 */

/** Razorpay `error_source`. `internal` is ours, for failures we caused. */
export type ErrorSource =
  | 'gateway'
  | 'bank'
  | 'customer'
  | 'business'
  | 'internal';

/** Razorpay `error_step`. `*` is the wildcard used by the internal grid row. */
export type ErrorStep =
  | 'payment_initiation'
  | 'payment_authorization'
  | 'authentication'
  | '*';

/** `${ErrorSource}/${ErrorStep}`, the key written to `decisions.grid_cell`. */
export type GridCell = `${ErrorSource}/${ErrorStep}`;

export type FailureClass = 'transient' | 'soft' | 'customer' | 'terminal';

/** What the policy may propose. The LLM never produces these. */
export type RecoveryAction =
  | 'retry_with_backoff'
  | 'retry_prompt_alternate'
  | 'retry_on_timing_window'
  | 'nudge_no_auto_retry'
  | 'never_retry';

export type Arm = 'control' | 'treatment';

export type TransactionStatus = 'open' | 'recovered' | 'abandoned' | 'terminal';

/**
 * `pending` is a reserved attempt: the idempotency row exists but the
 * outbound Razorpay write has not settled yet. See migration 0002.
 */
export type AttemptOutcome = 'pending' | 'captured' | 'failed' | 'blocked';

/** The outcomes an attempt can settle into. `pending` is not one of them. */
export type SettledOutcome = Exclude<AttemptOutcome, 'pending'>;

export type GuardrailVerdict = 'allow' | 'veto';

/** One row of the policy grid, as stored in data/policy-grid.json. */
export interface PolicyGridRow {
  readonly grid_cell: GridCell;
  readonly error_source: ErrorSource;
  readonly error_step: ErrorStep;
  readonly failure_class: FailureClass;
  readonly action: RecoveryAction;
  readonly action_label: string;
  readonly observable_in_test_mode: boolean;
}

/**
 * One documented decline reason, as stored in data/decline-taxonomy.json.
 *
 * `observed_in_test_mode` is the guard against mislabelling: false means the
 * reason exists only in the synthetic population, so any figure derived from
 * it is ESTIMATED and can never be reported as OBSERVED.
 */
export interface DeclineReason {
  readonly error_reason: string;
  readonly error_source: ErrorSource;
  readonly error_step: ErrorStep;
  readonly grid_cell: GridCell;
  readonly observed_in_test_mode: boolean;
  readonly test_cards: readonly string[];
  readonly note?: string;
}

/** Evidence layer a reported figure came from. Never merge these. */
export type EvidenceLayer = 'layer1_observed' | 'layer2_estimated' | 'layer3_ope';

/** Mandatory label on every recovery figure. See CLAUDE.md hard rule 6. */
export type EvidenceLabel = 'OBSERVED' | 'ESTIMATED';

// -- row types -------------------------------------------------------------

export interface Transaction {
  readonly id: string;
  readonly rzp_order_id: string | null;
  readonly rzp_payment_link_id: string | null;
  readonly amount_paise: number;
  readonly arm: Arm;
  readonly status: TransactionStatus;
  readonly created_at: string;
}

export interface Attempt {
  readonly id: number;
  readonly transaction_id: string;
  readonly attempt_number: number;
  readonly idempotency_key: string;
  readonly rzp_payment_id: string | null;
  readonly error_code: string | null;
  readonly error_source: ErrorSource | null;
  readonly error_step: ErrorStep | null;
  readonly error_reason: string | null;
  /** acquirer_data.auth_code. Populated means it reached the bank. */
  readonly auth_code: string | null;
  readonly outcome: AttemptOutcome;
  readonly created_at: string;
}

export interface Decision {
  readonly id: number;
  readonly transaction_id: string;
  readonly attempt_number: number;
  readonly grid_cell: GridCell;
  readonly recovery_probability: number;
  readonly proposed_action: RecoveryAction;
  /** Logged at decision time for off-policy estimation. See EXPERIMENT-PROTOCOL.md. */
  readonly propensity: number;
  readonly guardrail_verdict: GuardrailVerdict;
  readonly guardrail_reason: string | null;
  /** LLM output. Never authoritative, never an input to the policy. */
  readonly diagnosis: string | null;
  readonly created_at: string;
}

export interface AuditRow {
  readonly seq: number;
  readonly prev_hash: string;
  readonly hash: string;
  readonly payload: unknown;
  readonly created_at: string;
}

export interface ExperimentRun {
  readonly id: string;
  readonly seed: number;
  readonly params_hash: string;
  readonly results: unknown;
  readonly created_at: string;
}

// -- typed failures --------------------------------------------------------

/**
 * External calls return these. Nothing throws across a service boundary.
 * See CLAUDE.md, Conventions.
 */
export type FailureKind =
  | 'network'
  | 'rate_limited'
  | 'auth'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'upstream'
  | 'internal';

export interface Failure {
  readonly kind: FailureKind;
  readonly message: string;
  /** Present on rate_limited responses, seconds to wait before retrying. */
  readonly retry_after_seconds?: number;
  readonly cause?: unknown;
}

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = Failure> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });
