/**
 * The real Layer 1 batch: `npm run batch -w apps/gateway -- --count 30
 * --concurrency 4`, seed 1538946708, 2026-09-01. Exported straight out
 * of transactions / attempts / decisions.
 */
import raw from './batch.json';

export interface BatchTxn {
  id: string;
  amount_paise: string;
  arm: 'control' | 'treatment';
  status: 'recovered' | 'abandoned' | 'terminal' | 'open';
  attempts: number;
  captures: number;
  vetoes: number;
}

export interface BatchDecision {
  transaction_id: string;
  attempt_number: number;
  grid_cell: string;
  proposed_action: string;
  recovery_probability: string | null;
  guardrail_verdict: 'allow' | 'veto';
  guardrail_reason: string | null;
  diagnosis: string | null;
}

export interface BatchAttempt {
  transaction_id: string;
  attempt_number: number;
  rzp_payment_id: string | null;
  outcome: string;
  error_reason: string | null;
  error_source: string | null;
  error_step: string | null;
  auth_code: string | null;
}

export interface BatchData {
  generated: string;
  source: string;
  transactions: BatchTxn[];
  decisions: BatchDecision[];
  attempts: BatchAttempt[];
}

export const BATCH = raw as BatchData;

/** Short label for a transaction id: the batch prefix is identical on
 * every row and carries no information in a dense table. */
export function shortTxn(id: string): string {
  const m = /_(\d+)$/.exec(id);
  return m ? `txn ${m[1]!.padStart(2, '0')}` : id;
}

export const VETOES = BATCH.decisions.filter((d) => d.guardrail_verdict === 'veto');

/** The guardrail rule that fired, split off its explanation. */
export function vetoRule(reason: string | null): string {
  if (!reason) return 'refused';
  const i = reason.indexOf(':');
  return i === -1 ? reason : reason.slice(0, i);
}
