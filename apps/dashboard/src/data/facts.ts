/**
 * Real, measured facts about this system. Every value here was produced
 * by this repo and is citable; nothing is invented for the sake of the
 * interface. The instrument-check sequence and the status rail both read
 * from this file, so a figure on screen can always be traced to the run
 * or the committed artefact that produced it.
 *
 * NOT a fetch layer. When the screens are wired to /experiment,
 * /calibration and the gateway (later build-order steps), these become
 * the fallback/boot values only.
 */

export const CONTRACTS = {
  /** packages/contracts/data/policy-grid.json */
  gridCells: 7,
  /** packages/contracts/data/decline-taxonomy.json */
  declineReasons: 10,
  /** ...of which, observed live in Razorpay test mode */
  observedInTestMode: 3,
} as const;

export const REFERENCE = {
  /** true_lift.compute_true_lift().net_true_lift_pp — the known answer
   * this instrument is verified against. Frozen in
   * apps/engine/config/ground-truth.json BEFORE any run existed. */
  trueLiftPp: 5.4673,
  committed: '2026-08-27',
} as const;

export const INSTRUMENT = {
  /** apps/engine/src/revenant_engine/calibration.py, stratified
   * bootstrap, master_seed 20260901_2000. Precomputed; never re-run
   * live (docs/PLAN.md, demo failure modes). */
  coverage: 0.938,
  wilsonLo: 0.9266,
  wilsonHi: 0.9478,
  replications: 2000,
  method: 'stratified',
  /** The honest caveat: this interval excludes 0.95, so the estimator is
   * slightly anti-conservative. Stated, never smoothed. */
  excludesNominal: true,
  computedOn: '2026-09-01',
} as const;

export const CUSTODY = {
  /** SELECT count(*) FROM audit_log — 2026-09-01 */
  links: 629,
  headSeq: 1355,
  verified: true,
} as const;

export const RUN = {
  /** The most recent Layer 1 batch: npm run batch -- --count 30
   * --concurrency 4, 2026-09-01. */
  seed: 1538946708,
  transactions: 30,
  attempts: 46,
  captures: 24,
  failures: 5,
  refusals: 6,
  elapsedS: 1129.3,
  /** OBSERVED recovered value per arm, in paise. Real Razorpay
   * test-mode captures. These carry NO interval: Layer 1 is a census of
   * one real run, not a sample from a population, so there is nothing
   * for a bootstrap to resample. Anything that puts a span around them
   * would be inventing uncertainty that does not exist. */
  recoveredControlPaise: 499000,
  recoveredTreatmentPaise: 698600,
} as const;

/** Verbatim from run-batch.ts. Always visible on Batch, never dismissible. */
export const LAYER1_CAVEAT =
  'Layer 1 proves the mechanism executes correctly against real Razorpay: real attempts, real guardrails, real audit chain. It does not prove the policy works. The mock-bank outcome per retry is drawn from a seeded stand-in model, not organic bank behaviour, so any difference between arms reflects the chosen parameters, not incremental recovery. That claim belongs to Layer 2.';

/** packages/contracts/data/policy-grid.json, verbatim. Real static
 * contract data, so Decisions renders it for real even with no run. */
export const POLICY_GRID = [
  { cell: 'gateway/payment_authorization', cls: 'TRANSIENT', action: 'retry_with_backoff', observed: true },
  { cell: 'gateway/authentication', cls: 'TRANSIENT', action: 'retry_prompt_alternate', observed: false },
  { cell: 'bank/payment_authorization', cls: 'SOFT', action: 'retry_on_timing_window', observed: false },
  { cell: 'customer/payment_authorization', cls: 'CUSTOMER', action: 'nudge_no_auto_retry', observed: false },
  { cell: 'customer/payment_authentication', cls: 'CUSTOMER', action: 'nudge_no_auto_retry', observed: true },
  { cell: 'business/payment_initiation', cls: 'TERMINAL', action: 'never_retry', observed: true },
  { cell: 'internal/*', cls: 'TRANSIENT', action: 'retry_with_backoff', observed: false },
] as const;
