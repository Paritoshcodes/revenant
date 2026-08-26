/**
 * The Layer 1 batch runner.
 *
 * Creates n real payment links, then drives each one through the real
 * browser driver and the real recovery state machine: every decision,
 * attempt, and audit event goes through the existing modules
 * (state-machine.ts, idempotency-store.ts, audit/writer.ts) exactly as a
 * live production call would. Nothing here bypasses a guardrail or
 * fabricates an outcome.
 *
 * The seed. `runRecoveryStep`'s diagnosis for attempt 1 describes "the
 * previous attempt, OR THE ORIGINATING FAILURE" (types.ts) — in a real
 * merchant integration that originating failure is the customer's own
 * failed checkout, learned about from a webhook, entirely outside the
 * agent's own attempts table. There is no real customer here, so this
 * module manufactures that starting condition itself: one real browser
 * attempt per transaction, driven to the bank page's Failure button, done
 * BEFORE the idempotency store or the state machine are ever invoked for
 * that transaction. Its real Razorpay error taxonomy (fetched from the
 * payment record, never guessed) becomes attempt 1's diagnosis. This seed
 * attempt is intentionally NOT one of the agent's own `attempts` rows — it
 * is the thing the agent is reacting to, not one of its actions — which
 * means Razorpay's own `order.attempts` counter will run one ahead of the
 * local count for every batch transaction; a known, documented offset, not
 * a lost record (contrast with reconcile.ts's divergence check, which is
 * about genuinely lost rows).
 *
 * The retry outcome, and the honest limit of what this proves. Nothing on
 * Razorpay's side determines whether a real test-mode retry recovers — we
 * choose which mock-bank button gets clicked. `OutcomeModel` below is a
 * labelled STAND-IN for real bank behaviour: a seeded, deterministic
 * Bernoulli draw per agent-driven attempt, parameterised per arm so the
 * two arms CAN differ. The seed is logged with every run so a result is
 * reproducible. This buys back the ability to demonstrate that control and
 * treatment can diverge — impossible when both arms always captured by
 * construction — but it must never be read as more than that: a
 * difference between arms here is a property of the recoveryRateByArm
 * PARAMETERS this run was given, not evidence that the policy causes real
 * incremental recovery. That claim belongs to Layer 2, on synthetic data
 * where the true lift is known by construction and the calibration check
 * proves the estimator sound (docs/PLAN.md, docs/EXPERIMENT-PROTOCOL.md).
 * Layer 1's real job is unchanged: proving the pipeline — guardrails,
 * idempotency, the hash-chained audit log — moves real money correctly
 * end to end against real Razorpay. Every figure this module reports is
 * OBSERVED (real Razorpay execution); none of it is evidence the policy
 * works, and the CLI prints that caveat every run, not just here.
 *
 * The guardrail veto path. No batch run had ever produced a veto before
 * this, because every real test-mode diagnosis in this account maps to a
 * transient, retryable grid cell — there is no organic way to reach an
 * unsafe cell through real Razorpay data alone. `forceGuardrailVetoOn`
 * deliberately overrides one transaction's diagnosis, AFTER its real seed
 * failure, to an unmapped grid cell (bank/authentication — the same one
 * recovery-integration.test.ts already uses for exactly this reason): the
 * policy stub proposes a retry regardless, and terminal_grid_cell vetoes
 * an unmapped cell unconditionally, per its own "absence of a terminal
 * marking is not evidence of safety" rule. The override is logged plainly
 * as a deliberate diagnostic override, not a real observed diagnosis.
 *
 * Concurrency. Link creation is always sequential: the write throttle on
 * /payment_links is a remote rate limit, and parallelising it only
 * produces 429s (docs/API-BEHAVIOUR.md). Processing (seed + recovery loop)
 * runs with a worker pool of the requested size; each worker gets its own
 * browser context and its own payment-id capture listener
 * (docs/CHECKOUT-FLOW.md section 11 — the capture listener is
 * context-scoped), never shared with another worker.
 */
import { err, ok } from '@revenant/contracts';
import { BASELINE_SUCCESS_CARD_DIGITS } from '@revenant/contracts';
import type { Arm, Failure, Result, SettledOutcome, TransactionStatus } from '@revenant/contracts';

import { appendAuditEvent } from '../audit/writer.js';
import type { TransactionClient } from '../audit/types.js';
import { attempt, openCheckout } from '../browser/index.js';
import type { AttemptFlowOptions, ContextLike, PageLike } from '../browser/types.js';
import { capturePaymentIds } from '../browser/payment-id-capture.js';
import { CONTROL_ARM_GUARDRAIL_CONFIG, DEFAULT_GUARDRAIL_CONFIG } from '../guardrails/config.js';
import type { GuardrailConfig } from '../guardrails/types.js';
import type { RazorpayClient } from '../razorpay/client.js';

import { createLinkBatch } from './create-link-batch.js';
import type { LinkBatchItem } from './create-link-batch.js';
import { insertTransaction } from './db.js';
import { runRecoveryStep } from './state-machine.js';
import type { AttemptExecutionResult, AttemptExecutor, FailureDiagnosis } from './types.js';

// -- ports: everything Playwright- and Postgres-shaped is injected --------

/**
 * A dedicated connection, checked out until released. Structurally what
 * `pg.PoolClient` already is: a real `pg.Pool` satisfies `ConnectionPool`
 * with no adapter. Every worker needs its own so concurrent BEGIN/COMMIT
 * blocks (and the advisory lock inside appendAuditEvent) never interleave
 * across transactions.
 */
export interface PooledConnection extends TransactionClient {
  release(): void;
}

export interface ConnectionPool {
  connect(): Promise<PooledConnection>;
}

/**
 * One worker's isolated browser context. Recovery logic never imports
 * `playwright` (matching AttemptExecutor's own port in types.ts); the CLI
 * wiring (scripts/run-batch.mts) is what actually launches Chromium and
 * hands back real `browser.newContext()` + `newPage()` results here.
 */
export interface BrowserWorkerContext {
  readonly page: PageLike;
  readonly context: ContextLike;
  close(): Promise<void>;
}

export interface BrowserContextFactory {
  create(): Promise<BrowserWorkerContext>;
}

export type BatchProgressEvent =
  | { readonly kind: 'links_created'; readonly count: number; readonly elapsedMs: number }
  | { readonly kind: 'transaction_started'; readonly transactionId: string; readonly arm: Arm; readonly shortUrl: string }
  | { readonly kind: 'seed_failed'; readonly transactionId: string; readonly paymentId: string }
  | {
      readonly kind: 'attempt_settled';
      readonly transactionId: string;
      readonly attemptNumber: number;
      readonly outcome: SettledOutcome;
    }
  | { readonly kind: 'transaction_vetoed'; readonly transactionId: string; readonly reason: string }
  | { readonly kind: 'transaction_done'; readonly transactionId: string; readonly finalStatus: TransactionStatus }
  | { readonly kind: 'transaction_error'; readonly transactionId: string; readonly message: string }
  | {
      readonly kind: 'diagnosis_overridden';
      readonly transactionId: string;
      readonly reason: string;
    };

export interface RunBatchDeps {
  readonly db: ConnectionPool;
  readonly razorpay: RazorpayClient;
  readonly browsers: BrowserContextFactory;
  /** Epoch milliseconds. Injected so a run is reproducible in tests. */
  readonly now?: () => number;
  /** [0, 1). Injected so arm assignment is reproducible in tests. Independent of `seed`, which drives only the per-attempt outcome model. */
  readonly random?: () => number;
  readonly checkoutOptions?: AttemptFlowOptions;
  readonly onProgress?: (event: BatchProgressEvent) => void;
  /**
   * Drives the per-attempt outcome model (see the module doc). Logged with
   * the run either way, so every run is reproducible from its own report.
   * Defaults to a value derived from the current time, not a fixed
   * constant, so repeated runs are not accidentally identical.
   */
  readonly seed?: number;
  readonly recoveryRateByArm?: RecoveryRateByArm;
}

export interface RunBatchOptions {
  readonly count: number;
  /** Worker-pool size for processing. Default 1. Link creation is always sequential regardless. */
  readonly concurrency?: number;
  readonly amountPaise?: number;
}

export interface TransactionResult {
  readonly transactionId: string;
  readonly paymentLinkId: string;
  readonly arm: Arm;
  readonly amountPaise: number;
  readonly finalStatus: TransactionStatus;
  readonly attemptsMade: number;
  readonly finalOutcome: SettledOutcome | null;
  readonly guardrailVetoes: number;
  /** How many times the executor actually drove a real browser attempt. A vetoed decision must show 0 here — no outbound Razorpay call. */
  readonly executorCalls: number;
  /** True when this transaction's diagnosis was deliberately overridden to exercise the guardrail veto path, rather than being the real seed diagnosis. */
  readonly diagnosisOverridden: boolean;
  readonly error: string | null;
}

export interface RunBatchReport {
  /**
   * Always OBSERVED: every figure here is a real Razorpay test-mode
   * outcome — a real attempt genuinely happened and genuinely settled.
   * Never combine this with an ESTIMATED (Layer 2/3) figure — CLAUDE.md
   * hard rule 6. Separately: which button got clicked on each retry was
   * decided by a labelled stand-in model (below), not organic bank
   * behaviour, so a difference between arms is not evidence the policy
   * causes real incremental recovery. See `caveat`.
   */
  readonly label: 'OBSERVED';
  readonly caveat: string;
  readonly seed: number;
  readonly recoveryRateByArm: RecoveryRateByArm;
  readonly transactions: readonly TransactionResult[];
  readonly linksCreated: number;
  readonly attemptsMade: number;
  readonly captures: number;
  readonly failures: number;
  readonly guardrailVetoes: number;
  readonly recoveredPaiseByArm: { readonly control: number; readonly treatment: number };
  readonly elapsedMs: number;
}

export const LAYER1_CAVEAT =
  'Layer 1 proves the mechanism executes correctly against real Razorpay (real attempts, real guardrails, real audit chain). It does not prove the policy works: the mock-bank outcome per retry is drawn from a seeded stand-in model, not organic bank behaviour, so any difference between arms reflects the chosen recoveryRateByArm parameters, not incremental recovery. That claim belongs to Layer 2.';

const DEFAULT_CHECKOUT_OPTIONS: AttemptFlowOptions = {
  contact: '9000090000',
  expiry: '12/30',
  cvv: '123',
  timeoutMs: 30_000,
};

/**
 * EXPERIMENT-PROTOCOL.md's stratification is a Layer 2 construct (grid
 * cell crossed with amount band, over N=2000). It is degenerate here:
 * every seed attempt in this account's test mode produces the SAME real
 * diagnosis (gateway/payment_authorization, docs/DECISIONS.md), so there
 * is only one stratum to begin with. What "stratified" reduces to at this
 * scale is a guaranteed-balanced split — block randomisation — rather
 * than letting a coin flip per transaction risk a lopsided small sample.
 */
export const assignArms = (n: number, random: () => number = Math.random): Arm[] => {
  const half = Math.floor(n / 2);
  const arms: Arm[] = [...Array<Arm>(half).fill('control'), ...Array<Arm>(n - half).fill('treatment')];
  for (let i = arms.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = arms[i]!;
    arms[i] = arms[j]!;
    arms[j] = tmp;
  }
  return arms;
};

const guardrailConfigFor = (arm: Arm): GuardrailConfig =>
  arm === 'control' ? CONTROL_ARM_GUARDRAIL_CONFIG : DEFAULT_GUARDRAIL_CONFIG;

/**
 * Fed into the circuit breaker's `batch: BatchStats` context instead of a
 * literal payment-outcome count. `BatchStats.failed` was originally "how
 * many settled attempts came back failed", which is exactly what a
 * deliberately low `recoveryRateByArm` produces on purpose — a real batch
 * run at control-rate 0.2 tripped the breaker at a 53% "failure" rate and
 * halted 8 of 20 transactions before they ever got an attempt, which is
 * the experiment working, not a fault (docs/DECISIONS.md). `attempted`
 * counts every real browser/API operation this runner makes, regardless
 * of outcome; `errored` counts only the ones that came back as a genuine
 * `Result` failure — a Playwright error, an API error, a DB error. A
 * payment settling as `failed` is neither: the attempt itself worked
 * exactly as intended, the mock bank just declined it. This keeps the
 * breaker's own threshold and arming point in guardrails/config.ts
 * untouched — only what this caller feeds it changes, so the guardrail
 * module's meaning for any other caller (a real production run with no
 * outcome model at all) is unaffected.
 */
interface ExecutionHealth {
  attempted: number;
  errored: number;
}

const recordExecution = (health: ExecutionHealth, succeeded: boolean): void => {
  health.attempted += 1;
  if (!succeeded) health.errored += 1;
};

/**
 * mulberry32: small, fast, seedable PRNG. Not cryptographic — irrelevant
 * here, since its only job is a reproducible stand-in Bernoulli draw, not
 * anything security-relevant.
 */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface RecoveryRateByArm {
  readonly control: number;
  readonly treatment: number;
}

/**
 * Illustrative stand-in values, not derived from anything: chosen only to
 * make control and treatment CAPABLE of diverging. See the module doc for
 * why a difference produced with these is not evidence of policy value.
 */
export const DEFAULT_RECOVERY_RATE_BY_ARM: RecoveryRateByArm = {
  control: 0.4,
  treatment: 0.9,
};

/**
 * One transaction's own deterministic outcome sequence. Seeded
 * independently per transaction (mixed from the run's master seed and the
 * transaction's index) rather than sharing one RNG across the worker pool:
 * a shared RNG's draws would still be reproducible in the abstract, but
 * WHICH transaction consumes which draw would depend on real async
 * interleaving, which is not reproducible across runs at concurrency > 1.
 * Per-transaction seeding makes every transaction's own sequence
 * reproducible regardless of concurrency, since only that transaction's
 * own worker ever calls it.
 */
export const createOutcomeModel = (
  seed: number,
  rate: number,
): { next: () => 'success' | 'failure' } => {
  const rng = mulberry32(seed);
  return { next: () => (rng() < rate ? 'success' : 'failure') };
};

export const deriveTransactionSeed = (masterSeed: number, index: number): number =>
  (masterSeed + (index + 1) * 0x9e3779b1) >>> 0;

/** bank/authentication has no grid row (docs/ARCHITECTURE.md's grid), so terminal_grid_cell vetoes it unconditionally regardless of what the policy proposes. */
const FORCED_VETO_DIAGNOSIS: FailureDiagnosis = { errorSource: 'bank', errorStep: 'authentication' };

/** Isolated in its own function so narrowing a value read out of a closure-mutated variable stays reliable. */
const diagnosisFrom = (result: AttemptExecutionResult | null): FailureDiagnosis | null => {
  if (result === null) return null;
  if (result.errorSource === null || result.errorStep === null) return null;
  return { errorSource: result.errorSource, errorStep: result.errorStep };
};

interface ProcessDeps {
  readonly db: ConnectionPool;
  readonly razorpay: RazorpayClient;
  readonly browsers: BrowserContextFactory;
  readonly checkoutOptions: AttemptFlowOptions;
  readonly now: () => number;
  readonly onProgress: (event: BatchProgressEvent) => void;
}

const emptyResult = (
  transactionId: string,
  item: LinkBatchItem,
  arm: Arm,
): TransactionResult => ({
  transactionId,
  paymentLinkId: item.paymentLinkId,
  arm,
  amountPaise: item.amountPaise,
  finalStatus: 'open',
  attemptsMade: 0,
  finalOutcome: null,
  guardrailVetoes: 0,
  executorCalls: 0,
  diagnosisOverridden: false,
  error: null,
});

/** One transaction's full lifecycle: open, seed failure, recovery loop, close. */
const processTransaction = async (
  deps: ProcessDeps,
  item: LinkBatchItem,
  arm: Arm,
  transactionId: string,
  errorStats: ExecutionHealth,
  outcomeModel: { next: () => 'success' | 'failure' },
  forceGuardrailVeto: boolean,
): Promise<TransactionResult> => {
  const base = emptyResult(transactionId, item, arm);
  const fail = (message: string, partial: Partial<TransactionResult> = {}): TransactionResult => {
    deps.onProgress({ kind: 'transaction_error', transactionId, message });
    return { ...base, ...partial, error: message };
  };

  deps.onProgress({ kind: 'transaction_started', transactionId, arm, shortUrl: item.shortUrl });

  // -- open the transaction, in its own committed step ------------------

  const openConn = await deps.db.connect();
  try {
    await openConn.query('BEGIN');
    const inserted = await insertTransaction(openConn, {
      id: transactionId,
      rzpPaymentLinkId: item.paymentLinkId,
      amountPaise: item.amountPaise,
      arm,
    });
    if (!inserted.ok) {
      await openConn.query('ROLLBACK');
      return fail(`insertTransaction: ${inserted.error.message}`);
    }
    const opened = await appendAuditEvent(openConn, {
      kind: 'transaction_opened',
      timestamp: new Date(deps.now()).toISOString(),
      transaction_id: transactionId,
      arm,
      amount_paise: item.amountPaise,
      rzp_order_id: null,
      rzp_payment_link_id: item.paymentLinkId,
    });
    if (!opened.ok) {
      await openConn.query('ROLLBACK');
      return fail(`appendAuditEvent transaction_opened: ${opened.error.message}`);
    }
    await openConn.query('COMMIT');
  } finally {
    openConn.release();
  }

  // -- browser work: seed, then the agent's own recovery loop ------------

  const browserCtx = await deps.browsers.create();
  try {
    const capture = capturePaymentIds(browserCtx.context);

    const openedCheckout = await openCheckout(browserCtx.page, item.shortUrl, deps.checkoutOptions);
    recordExecution(errorStats, openedCheckout.ok);
    if (!openedCheckout.ok) return fail(`openCheckout: ${openedCheckout.error.message}`);

    const seed = await attempt(
      browserCtx.page,
      BASELINE_SUCCESS_CARD_DIGITS,
      'failure',
      capture,
      deps.checkoutOptions,
    );
    recordExecution(errorStats, seed.ok);
    if (!seed.ok) return fail(`seed attempt: ${seed.error.message}`);
    if (seed.value.paymentId === null) return fail('seed attempt: no payment id captured');

    const seedPayment = await deps.razorpay.fetchPayment(seed.value.paymentId);
    recordExecution(errorStats, seedPayment.ok);
    if (!seedPayment.ok) return fail(`fetch seed payment: ${seedPayment.error.message}`);
    if (seedPayment.value.error_source === null || seedPayment.value.error_step === null) {
      return fail(`seed payment ${seed.value.paymentId} settled with no error taxonomy to diagnose`);
    }
    deps.onProgress({ kind: 'seed_failed', transactionId, paymentId: seed.value.paymentId });

    let diagnosis: FailureDiagnosis = {
      errorSource: seedPayment.value.error_source,
      errorStep: seedPayment.value.error_step,
    };
    let diagnosisOverridden = false;
    if (forceGuardrailVeto) {
      diagnosis = FORCED_VETO_DIAGNOSIS;
      diagnosisOverridden = true;
      deps.onProgress({
        kind: 'diagnosis_overridden',
        transactionId,
        reason: `forced to ${diagnosis.errorSource}/${diagnosis.errorStep} (unmapped) to exercise the guardrail veto path — not the real seed diagnosis`,
      });
    }

    let lastAttemptAtMs: number | null = null;
    let attemptNumber = 1;
    let attemptsMade = 0;
    let guardrailVetoes = 0;
    let executorCalls = 0;
    let finalStatus: TransactionStatus = 'open';
    let finalOutcome: SettledOutcome | null = null;
    let lastExecution: AttemptExecutionResult | null = null;

    const executor: AttemptExecutor = {
      execute: async () => {
        executorCalls += 1;
        // The one place this batch runner decides which mock-bank button
        // gets clicked: a seeded stand-in, not organic behaviour. See the
        // module doc and LAYER1_CAVEAT.
        const targetOutcome = outcomeModel.next();
        const driven = await attempt(
          browserCtx.page,
          BASELINE_SUCCESS_CARD_DIGITS,
          targetOutcome,
          capture,
          deps.checkoutOptions,
        );
        recordExecution(errorStats, driven.ok);
        if (!driven.ok) return driven;
        if (driven.value.paymentId === null) {
          recordExecution(errorStats, false);
          return err<Failure>({
            kind: 'upstream',
            message: 'agent attempt settled with no payment id captured',
          });
        }
        const fetched = await deps.razorpay.fetchPayment(driven.value.paymentId);
        recordExecution(errorStats, fetched.ok);
        const result: AttemptExecutionResult = {
          outcome: driven.value.outcome,
          rzpPaymentId: driven.value.paymentId,
          rzpRequestId: null,
          rzpResponseId: null,
          errorCode: fetched.ok ? fetched.value.error_code : null,
          errorSource: fetched.ok ? fetched.value.error_source : null,
          errorStep: fetched.ok ? fetched.value.error_step : null,
          errorReason: fetched.ok ? fetched.value.error_reason : null,
          authCode: fetched.ok ? (fetched.value.acquirer_data?.auth_code ?? null) : null,
        };
        lastExecution = result;
        return ok(result);
      },
    };

    for (;;) {
      const stepConn = await deps.db.connect();
      let stepResult;
      try {
        await stepConn.query('BEGIN');
        stepResult = await runRecoveryStep(
          stepConn,
          { executor, guardrailConfig: guardrailConfigFor(arm), now: deps.now },
          {
            transactionId,
            arm,
            attemptNumber,
            diagnosis,
            lastAttemptAtMs,
            batch: { settled: errorStats.attempted, failed: errorStats.errored },
          },
        );
        if (!stepResult.ok) {
          await stepConn.query('ROLLBACK');
          recordExecution(errorStats, false);
          return fail(`runRecoveryStep: ${stepResult.error.message}`, {
            attemptsMade,
            guardrailVetoes,
            executorCalls,
            diagnosisOverridden,
          });
        }
        await stepConn.query('COMMIT');
      } finally {
        stepConn.release();
      }

      const value = stepResult.value;

      if (value.status === 'vetoed') {
        guardrailVetoes += 1;
        finalStatus = value.transactionStatus;
        deps.onProgress({ kind: 'transaction_vetoed', transactionId, reason: value.guardrailReason });
        break;
      }
      if (value.status === 'no_attempt') {
        finalStatus = value.transactionStatus;
        break;
      }
      if (value.status === 'duplicate') {
        // A fresh batch run never reuses an idempotency key; stop rather
        // than loop on a state this run did not expect.
        break;
      }

      attemptsMade += 1;
      finalStatus = value.transactionStatus;
      finalOutcome = value.outcome;
      // Deliberately NOT recorded in errorStats: a payment settling as
      // 'failed' here is the outcome model doing its job, not a fault.
      deps.onProgress({ kind: 'attempt_settled', transactionId, attemptNumber, outcome: value.outcome });

      if (value.outcome === 'captured') break;

      // Failed again, per the outcome model: needs a real diagnosis for
      // the next decision, from what this attempt itself actually
      // produced, not a reused one.
      const nextDiagnosis = diagnosisFrom(lastExecution);
      if (nextDiagnosis !== null) diagnosis = nextDiagnosis;
      lastAttemptAtMs = deps.now();
      attemptNumber += 1;
    }

    deps.onProgress({ kind: 'transaction_done', transactionId, finalStatus });
    return {
      ...base,
      finalStatus,
      attemptsMade,
      finalOutcome,
      guardrailVetoes,
      executorCalls,
      diagnosisOverridden,
    };
  } finally {
    await browserCtx.close();
  }
};

/**
 * Runs one Layer 1 batch: n real payment links, each driven through a real
 * seed failure and the real recovery loop, with a worker pool of the
 * requested concurrency. See the module doc for the seed and retry-outcome
 * design, and CLAUDE.md hard rule 1: the policy function decides whether
 * money moves, never the LLM, and nothing here is an LLM either — this
 * orchestrates the same deterministic pipeline a live call would use.
 */
export const runBatch = async (
  deps: RunBatchDeps,
  options: RunBatchOptions,
): Promise<Result<RunBatchReport>> => {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const onProgress = deps.onProgress ?? ((): void => undefined);
  const checkoutOptions = { ...DEFAULT_CHECKOUT_OPTIONS, ...(deps.checkoutOptions ?? {}) };
  // >>> 0 keeps it a positive 32-bit int regardless of Date.now()'s size or
  // sign quirks from a custom `now`, so it is always a clean number to log
  // and to re-derive per-transaction seeds from.
  const seed = (deps.seed ?? Date.now()) >>> 0;
  const recoveryRateByArm = deps.recoveryRateByArm ?? DEFAULT_RECOVERY_RATE_BY_ARM;

  const startMs = now();

  const created = await createLinkBatch(deps.razorpay, options.count, {
    amountPaise: options.amountPaise,
    description: 'revenant layer1 batch',
  });
  if (!created.ok) return created;
  onProgress({ kind: 'links_created', count: created.value.length, elapsedMs: now() - startMs });

  const arms = assignArms(created.value.length, random);
  const runId = now().toString(36);
  // Shared across every worker: genuine execution faults, never payment
  // outcomes. See ExecutionHealth's own doc.
  const errorStats: ExecutionHealth = { attempted: 0, errored: 0 };
  const results: TransactionResult[] = new Array(created.value.length);

  const processDeps: ProcessDeps = {
    db: deps.db,
    razorpay: deps.razorpay,
    browsers: deps.browsers,
    checkoutOptions,
    now,
    onProgress,
  };

  // Exactly one transaction per run is deliberately steered into the
  // guardrail veto path (see the module doc): the first one processed,
  // by index, regardless of concurrency or arm.
  const vetoIndex = 0;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= created.value.length) return;
      const item = created.value[i]!;
      const arm = arms[i]!;
      const transactionId = `txn_batch_${runId}_${i}`;
      const outcomeModel = createOutcomeModel(deriveTransactionSeed(seed, i), recoveryRateByArm[arm]);
      results[i] = await processTransaction(
        processDeps,
        item,
        arm,
        transactionId,
        errorStats,
        outcomeModel,
        i === vetoIndex,
      );
    }
  };

  const workerCount = Math.min(concurrency, created.value.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const elapsedMs = now() - startMs;

  const recoveredPaiseByArm = { control: 0, treatment: 0 };
  let attemptsMade = 0;
  let captures = 0;
  let failures = 0;
  let guardrailVetoes = 0;
  for (const r of results) {
    attemptsMade += r.attemptsMade;
    guardrailVetoes += r.guardrailVetoes;
    if (r.finalOutcome === 'captured') {
      captures += 1;
      recoveredPaiseByArm[r.arm] += r.amountPaise;
    } else if (r.finalOutcome === 'failed') {
      failures += 1;
    }
  }

  return ok({
    label: 'OBSERVED',
    caveat: LAYER1_CAVEAT,
    seed,
    recoveryRateByArm,
    transactions: results,
    linksCreated: created.value.length,
    attemptsMade,
    captures,
    failures,
    guardrailVetoes,
    recoveredPaiseByArm,
    elapsedMs,
  });
};
