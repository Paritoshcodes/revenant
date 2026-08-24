/**
 * Recovery state machine vocabulary.
 */
import type {
  Arm,
  ErrorSource,
  ErrorStep,
  GridCell,
  RecoveryAction,
  Result,
  SettledOutcome,
  TransactionStatus,
} from '@revenant/contracts';

import type { BatchStats, GuardrailConfig } from '../guardrails/types.js';
import type { ReservedAttempt } from './idempotency-store.js';

/** What the previous attempt (or the originating failure, for attempt 1) diagnosed. */
export interface FailureDiagnosis {
  readonly errorSource: ErrorSource;
  readonly errorStep: ErrorStep;
}

/** What driving one real attempt produced. */
export interface AttemptExecutionResult {
  readonly outcome: SettledOutcome;
  readonly rzpPaymentId: string | null;
  readonly rzpRequestId: string | null;
  readonly rzpResponseId: string | null;
  readonly errorCode: string | null;
  readonly errorSource: ErrorSource | null;
  readonly errorStep: ErrorStep | null;
  readonly errorReason: string | null;
  readonly authCode: string | null;
}

/**
 * Drives one real attempt and reports how it settled. Deliberately not the
 * RazorpayClient in src/razorpay/client.ts: a retry is driven through the
 * checkout retry surface in a browser (docs/CHECKOUT-FLOW.md), not a
 * server-to-server write, so the state machine depends on this narrower
 * port instead. Production wiring backs it with Playwright; this module
 * does not know Playwright exists.
 */
export interface AttemptExecutor {
  execute(input: {
    readonly transactionId: string;
    readonly attemptNumber: number;
    readonly idempotencyKey: string;
    readonly action: RecoveryAction;
  }): Promise<Result<AttemptExecutionResult>>;
}

export interface RecoveryStepDeps {
  readonly executor: AttemptExecutor;
  readonly guardrailConfig: GuardrailConfig;
  /** Epoch milliseconds. Injected so a step is reproducible in tests. */
  readonly now: () => number;
}

export interface RecoveryStepInput {
  readonly transactionId: string;
  readonly arm: Arm;
  /** 1-based. Attempt 1 is the first try. */
  readonly attemptNumber: number;
  readonly diagnosis: FailureDiagnosis;
  readonly lastAttemptAtMs: number | null;
  readonly batch: BatchStats;
}

export type RecoveryStepResult =
  | {
      readonly status: 'vetoed';
      readonly gridCell: GridCell;
      readonly proposedAction: RecoveryAction;
      readonly guardrailReason: string;
      readonly transactionStatus: TransactionStatus;
    }
  | {
      /**
       * Allowed, but the action does not move money (nudge_no_auto_retry
       * or never_retry), so no idempotency key was ever reserved and no
       * outbound call was made.
       */
      readonly status: 'no_attempt';
      readonly gridCell: GridCell;
      readonly proposedAction: RecoveryAction;
      readonly transactionStatus: TransactionStatus;
    }
  | {
      /** Someone already holds this attempt's idempotency key; no call was made. */
      readonly status: 'duplicate';
      readonly idempotencyKey: string;
      readonly existing: ReservedAttempt | null;
    }
  | {
      readonly status: 'settled';
      readonly gridCell: GridCell;
      readonly proposedAction: RecoveryAction;
      readonly outcome: SettledOutcome;
      readonly decision: 'stop' | 'continue';
      readonly transactionStatus: TransactionStatus;
    };
