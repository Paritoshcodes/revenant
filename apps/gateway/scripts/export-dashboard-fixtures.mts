/**
 * Exports real gateway data for the dashboard to render, and captures a
 * REAL Postgres refusal for the tamper set-piece.
 *
 * Nothing here is synthesised. The chain links are actual audit_log
 * rows, the batch is the actual --count 30 --concurrency 4 run, and the
 * refusal is produced by genuinely attempting an UPDATE against
 * audit_log and recording verbatim what the database said back.
 *
 * Precomputed on purpose, matching docs/PLAN.md's demo decisions: the
 * console has to render real evidence on a laptop with no gateway
 * process and no database reachable.
 *
 *   npx tsx scripts/export-dashboard-fixtures.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import pg from 'pg';
import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '.env') });

const OUT = join(here, '..', '..', 'dashboard', 'src', 'data');
const BATCH_PREFIX = 'txn_batch_mtibdbso_';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function write(name: string, payload: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), JSON.stringify(payload, null, 2), 'utf8');
  console.log(`wrote ${name}`);
}

/**
 * The tamper proof. Attempts a genuine UPDATE against audit_log and
 * records exactly what Postgres says. The append-only trigger raises
 * before any row changes, so this is safe to run against the real table
 * — but it is wrapped in a transaction and rolled back regardless,
 * because "safe because a trigger stops it" is precisely the claim under
 * test and must not be assumed while testing it.
 */
async function captureRefusal(seq: number): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  const sql = `UPDATE audit_log SET payload = '{"tampered":true}'::jsonb WHERE seq = ${seq}`;
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('ROLLBACK');
    return { refused: false, sql, note: 'NO REFUSAL — the append-only guarantee is not holding.' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const e = err as { message?: string; code?: string; severity?: string; routine?: string; where?: string };
    return {
      refused: true,
      sql,
      seq,
      message: e.message ?? '',
      code: e.code ?? '',
      severity: e.severity ?? '',
      where: e.where ?? '',
      capturedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  // ---- CUSTODY ---------------------------------------------------------
  const head = await pool.query<{ seq: string; hash: string; prev_hash: string }>(
    'select seq, hash, prev_hash from audit_log order by seq desc limit 1',
  );
  const total = await pool.query<{ n: number }>('select count(*)::int n from audit_log');
  const genesis = await pool.query<{ seq: string; hash: string; prev_hash: string }>(
    'select seq, hash, prev_hash from audit_log order by seq asc limit 1',
  );
  // A window the chain can actually be drawn from: real consecutive
  // links, so each one's prev_hash really is its predecessor's hash.
  const window = await pool.query<{ seq: string; hash: string; prev_hash: string; event: string; txn: string | null }>(
    `select seq, hash, prev_hash, coalesce(payload->>'kind', 'event') as event,
            payload->>'transaction_id' as txn
       from audit_log order by seq desc limit 24`,
  );
  const refusal = await captureRefusal(Number(head.rows[0]!.seq));

  write('chain.json', {
    generated: new Date().toISOString().slice(0, 10),
    source: 'apps/gateway/scripts/export-dashboard-fixtures.mts',
    links: total.rows[0]!.n,
    headSeq: Number(head.rows[0]!.seq),
    headHash: head.rows[0]!.hash,
    genesisSeq: Number(genesis.rows[0]!.seq),
    genesisPrevHash: genesis.rows[0]!.prev_hash,
    // Oldest-first so the chain reads left to right the way it is built.
    window: window.rows.reverse().map((r) => ({
      seq: Number(r.seq),
      hash: r.hash,
      prevHash: r.prev_hash,
      event: r.event,
      txn: r.txn,
    })),
    refusal,
  });

  // ---- BATCH -----------------------------------------------------------
  const txns = await pool.query(
    `select t.id, t.amount_paise, t.arm, t.status,
            (select count(*)::int from attempts a where a.transaction_id = t.id) as attempts,
            (select count(*)::int from attempts a where a.transaction_id = t.id and a.outcome = 'captured') as captures,
            (select count(*)::int from decisions d where d.transaction_id = t.id and d.guardrail_verdict = 'veto') as vetoes
       from transactions t
      where t.id like $1
      order by (regexp_replace(t.id, '^.*_', ''))::int`,
    [`${BATCH_PREFIX}%`],
  );

  const decisions = await pool.query(
    `select transaction_id, attempt_number, grid_cell, proposed_action, recovery_probability,
            guardrail_verdict, guardrail_reason, diagnosis
       from decisions where transaction_id like $1 order by transaction_id, attempt_number`,
    [`${BATCH_PREFIX}%`],
  );

  const attempts = await pool.query(
    `select transaction_id, attempt_number, rzp_payment_id, outcome,
            error_reason, error_source, error_step, auth_code
       from attempts where transaction_id like $1 order by transaction_id, attempt_number`,
    [`${BATCH_PREFIX}%`],
  );

  write('batch.json', {
    generated: new Date().toISOString().slice(0, 10),
    source: 'apps/gateway/scripts/export-dashboard-fixtures.mts',
    transactions: txns.rows,
    decisions: decisions.rows,
    attempts: attempts.rows,
  });

  console.log(`  chain: ${total.rows[0]!.n} links, head ${head.rows[0]!.seq}, refusal=${refusal.refused}`);
  console.log(`  batch: ${txns.rowCount} txns, ${attempts.rowCount} attempts, ${decisions.rowCount} decisions`);
  if (refusal.refused) console.log(`  refusal message: ${String(refusal.message)}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
