/**
 * Real output from apps/engine, exported by
 * apps/engine/scripts/export_dashboard_fixture.py. Reproducible from the
 * `seed` it carries; regenerate by re-running that script.
 *
 * Precomputed rather than fetched, matching docs/PLAN.md's demo
 * decision: the console has to render a real figure on a laptop with no
 * Python process running.
 */
import raw from './experiment.json';

export interface Interval {
  point: number;
  lo: number;
  hi: number;
}

export interface ArmSummary {
  n: number;
  recovered: number;
  rate: number;
  totalValuePaise: number;
  meanValuePaise: number;
}

export type Verdict = 'deploy' | 'no_evidence' | 'keep_running' | 'do_not_deploy';

export interface ExperimentResult {
  generated: string;
  source: string;
  seed: number;
  n: number;
  bootstrapMethod: string;
  resamples: number;
  estimand: number;
  rate: Interval;
  value: Interval;
  z: { statistic: number; pValue: number };
  arms: { control: ArmSummary; treatment: ArmSummary };
  bandCutPointsPaise: number[];
  histogram: { counts: number[]; edges: number[] };
  verdict: Verdict;
  rateVerdict: Verdict;
}

export const EXPERIMENT = raw as ExperimentResult;

/** The verdict is stated in the console's own vocabulary, and the null
 * gets exactly the same weight as a positive result — that is the whole
 * point of having a verdict at all. */
export const VERDICT_TEXT: Record<Verdict, string> = {
  deploy: 'Deploy',
  no_evidence: 'No evidence of value',
  keep_running: 'Keep running',
  do_not_deploy: 'Do not deploy',
};

export const VERDICT_BASIS: Record<Verdict, string> = {
  deploy: 'the interval on the primary estimate excludes zero',
  no_evidence:
    'the interval on the primary estimate contains zero, at an N the protocol considers powered',
  keep_running: 'the interval contains zero and N is below the powered threshold',
  do_not_deploy: 'the interval on the primary estimate lies entirely below zero',
};

export function formatPp(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(4)}`;
}

export function formatPaise(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}
