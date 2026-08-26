/**
 * Layer 1 batch runner CLI. All the orchestration logic lives in
 * src/recovery/run-batch.ts, which stays Playwright- and Postgres-agnostic;
 * this script is the one place that actually launches Chromium and a real
 * connection pool and wires them in.
 *
 *   npm run batch -- --count 5 --concurrency 1
 *
 * count and concurrency both default as shown.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { chromium } from 'playwright';

import { loadConfig } from '../src/config.js';
import { createRazorpayClient } from '../src/razorpay/client.js';
import { runBatch } from '../src/recovery/run-batch.js';
import type {
  BatchProgressEvent,
  BrowserContextFactory,
  BrowserWorkerContext,
  ConnectionPool,
} from '../src/recovery/run-batch.js';

const parseArg = (name: string, fallback: number): number => {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${flag} must be a positive integer, got ${raw}`);
    process.exit(1);
  }
  return value;
};

const parseRateArg = (name: string, fallback: number): number => {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  const value = Number(raw);
  if (Number.isNaN(value) || value < 0 || value > 1) {
    console.error(`${flag} must be a number in [0, 1], got ${raw}`);
    process.exit(1);
  }
  return value;
};

const parseSeedArg = (): number | undefined => {
  const index = process.argv.indexOf('--seed');
  if (index === -1) return undefined;
  const raw = process.argv[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`--seed must be a non-negative integer, got ${raw}`);
    process.exit(1);
  }
  return value;
};

const count = parseArg('count', 5);
const concurrency = parseArg('concurrency', 1);
const seedArg = parseSeedArg();
const controlRate = parseRateArg('control-rate', 0.4);
const treatmentRate = parseRateArg('treatment-rate', 0.9);

const config = loadConfig();
const razorpay = createRazorpayClient(config.razorpay);

const pool = new pg.Pool({ connectionString: config.databaseUrl });
// pg.Pool and pg.PoolClient already satisfy ConnectionPool/PooledConnection
// structurally: .connect() returns something with .query() and .release().
const db: ConnectionPool = pool as unknown as ConnectionPool;

const browser = await chromium.launch({ headless: true });

const browsers: BrowserContextFactory = {
  create: async (): Promise<BrowserWorkerContext> => {
    const context = await browser.newContext();
    const page = await context.newPage();
    return {
      page: page as never,
      context: context as never,
      close: async () => {
        await context.close();
      },
    };
  },
};

console.log(`Layer 1 batch: count=${count} concurrency=${concurrency}\n`);

const onProgress = (event: BatchProgressEvent): void => {
  switch (event.kind) {
    case 'links_created':
      console.log(`[links]  ${event.count} payment links created (${(event.elapsedMs / 1000).toFixed(1)}s)\n`);
      break;
    case 'transaction_started':
      console.log(`[${event.transactionId}] started, arm=${event.arm}, ${event.shortUrl}`);
      break;
    case 'seed_failed':
      console.log(`[${event.transactionId}] seed failed for real: ${event.paymentId}`);
      break;
    case 'attempt_settled':
      console.log(
        `[${event.transactionId}] attempt ${event.attemptNumber} settled: ${event.outcome}`,
      );
      break;
    case 'transaction_vetoed':
      console.log(`[${event.transactionId}] guardrail veto: ${event.reason}`);
      break;
    case 'transaction_done':
      console.log(`[${event.transactionId}] done, final status=${event.finalStatus}`);
      break;
    case 'transaction_error':
      console.error(`[${event.transactionId}] ERROR: ${event.message}`);
      break;
    case 'diagnosis_overridden':
      console.log(`[${event.transactionId}] DIAGNOSTIC OVERRIDE: ${event.reason}`);
      break;
  }
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const result = await runBatch(
  {
    db,
    razorpay,
    browsers,
    onProgress,
    checkoutOptions: { screenshotDir: join(repoRoot, 'tmp') },
    seed: seedArg,
    recoveryRateByArm: { control: controlRate, treatment: treatmentRate },
  },
  { count, concurrency },
);

if (!result.ok) {
  console.error('\nbatch run failed:', result.error);
  await browser.close();
  await pool.end();
  process.exit(1);
}

const report = result.value;

console.log(`\n--- summary (label: ${report.label}) ---\n`);
console.log(`CAVEAT: ${report.caveat}\n`);
console.log(`seed:              ${report.seed}  (rerun with --seed ${report.seed} to reproduce)`);
console.log(
  `recovery rate:     control=${report.recoveryRateByArm.control} treatment=${report.recoveryRateByArm.treatment}  (stand-in parameters, not observed bank behaviour)`,
);
console.log(`links created:     ${report.linksCreated}`);
console.log(`attempts made:     ${report.attemptsMade}`);
console.log(`captures:          ${report.captures}`);
console.log(`failures:          ${report.failures}`);
console.log(`guardrail vetoes:  ${report.guardrailVetoes}`);
console.log(
  `recovered (paise): control=${report.recoveredPaiseByArm.control} treatment=${report.recoveredPaiseByArm.treatment}`,
);
console.log(`elapsed:           ${(report.elapsedMs / 1000).toFixed(1)}s`);

console.log('\nper-transaction detail:');
for (const txn of report.transactions) {
  const status = txn.error !== null ? `ERROR: ${txn.error}` : txn.finalStatus;
  const override = txn.diagnosisOverridden ? '  [diagnosis overridden for guardrail veto test]' : '';
  console.log(
    `  ${txn.transactionId}  arm=${txn.arm}  attempts=${txn.attemptsMade}  executorCalls=${txn.executorCalls}  outcome=${txn.finalOutcome ?? 'none'}  vetoes=${txn.guardrailVetoes}  status=${status}${override}`,
  );
}

console.log('\nguardrail veto verification:');
const vetoedTxns = report.transactions.filter((t) => t.guardrailVetoes > 0);
if (vetoedTxns.length === 0) {
  console.log('  NONE VETOED this run — the veto path was not exercised.');
} else {
  for (const txn of vetoedTxns) {
    const clean = txn.diagnosisOverridden && txn.executorCalls === 0;
    console.log(
      `  ${txn.transactionId}: ${txn.guardrailVetoes} veto(s), executorCalls=${txn.executorCalls} — ${
        clean ? 'CONFIRMED no outbound Razorpay call was made for the vetoed decision' : 'see detail above'
      }`,
    );
  }
}

await browser.close();
await pool.end();

// A completed run is a success even if individual transactions were
// vetoed, failed, or hit a processing error — those are all things this
// script's job is to observe and report, not reasons the SCRIPT failed.
// Exit non-zero only via the !result.ok branch above, when the run itself
// could not complete (e.g. link creation failed outright).
const errorCount = report.transactions.filter((t) => t.error !== null).length;
if (errorCount > 0) {
  console.log(`\n${errorCount} transaction(s) hit a processing error — see detail above.`);
}
