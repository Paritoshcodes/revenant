/**
 * The custody chain, and a real Postgres refusal.
 *
 * Exported by apps/gateway/scripts/export-dashboard-fixtures.mts from
 * the live audit_log. The refusal was produced by genuinely running
 * `UPDATE audit_log SET payload = ... WHERE seq = 1355` against the real
 * table and recording verbatim what came back. Nothing here is written
 * by hand — see `refusal.capturedAt` for when the database said it.
 */
import raw from './chain.json';

export interface ChainLink {
  seq: number;
  hash: string;
  prevHash: string;
  /** audit_log payload `kind`: attempt_started, guardrail_veto, ... */
  event: string;
  txn: string | null;
}

export interface Refusal {
  refused: boolean;
  sql: string;
  seq: number;
  message: string;
  code: string;
  severity: string;
  where: string;
  capturedAt: string;
}

export interface ChainData {
  generated: string;
  source: string;
  links: number;
  headSeq: number;
  headHash: string;
  genesisSeq: number;
  genesisPrevHash: string;
  window: ChainLink[];
  refusal: Refusal;
}

export const CHAIN = raw as ChainData;

/** Guardrail vetoes are first-class events in the chain, not flags on
 * some other row — so the chain view can mark them as REFUSALS. */
export const REFUSAL_EVENTS = new Set(['guardrail_veto']);

export function shortHash(h: string, n = 10): string {
  return h.slice(0, n);
}
