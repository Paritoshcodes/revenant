/**
 * BATCH — the field record. OBSERVED class.
 *
 * The real `--count 30 --concurrency 4` run of 2026-09-01, seed
 * 1538946708, read straight out of transactions / attempts / decisions.
 * Every row is a real payment link, every attempt a real browser-driven
 * payment, every outcome verified against Razorpay's own record.
 *
 * REFUSALS ARE NOT HIDDEN. Six guardrail vetoes fired in this run and
 * each one appears as a first-class REFUSED row in the steel treatment,
 * because declining to retry is correct behaviour and a real cost
 * avoided — not an absence, and never an error.
 *
 * THE MARK MEANS SOMETHING DIFFERENT HERE than on THE NUMBER. A Layer 1
 * figure is a census of one run, not a sample, so it has no sampling
 * interval; a bracket around a single total would invent uncertainty
 * that does not exist. What genuinely is a span is the distance between
 * the two arms' observed totals, so that is what the mark carries.
 */
import { useMemo, useState } from 'react';

import { Bracket } from '../components/identity/Bracket';
import { ClassChip } from '../components/primitives/ClassChip';
import { Exhibit } from '../components/primitives/Exhibit';
import { Fig } from '../components/primitives/Fig';
import { HeroFigure } from '../components/hero/HeroFigure';
import { MaskRise } from '../components/primitives/MaskRise';
import { Panel } from '../components/primitives/Panel';
import { ProximityRows } from '../components/primitives/ProximityRows';
import { ScreenHead } from '../components/primitives/ScreenHead';
import { Tiered } from '../components/primitives/Tier';
import { BATCH, VETOES, shortTxn, vetoRule, type BatchTxn } from '../data/batch';
import { LAYER1_CAVEAT, RUN } from '../data/facts';
import { cn } from '../lib/cn';

const rupees = (paise: number): string => (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

/**
 * The table's column template, as an inline style rather than a Tailwind
 * arbitrary value. `grid-cols-[5.5rem_15rem_...]` never generated here —
 * verified in the browser twice, via a const and inlined as a literal:
 * display:grid applied but grid-template-columns resolved to a single
 * 1391px track, collapsing every row into one column. A seven-column
 * data table is load-bearing enough that it should not depend on the
 * class extractor recognising a long arbitrary track list.
 */
const COLS: React.CSSProperties = {
  gridTemplateColumns: '5.5rem 15rem 5.5rem 6.5rem 13rem 3rem 1fr',
};

const SUMMARY: Array<{ label: string; value: number; refusal?: boolean }> = [
  { label: 'LINKS', value: RUN.transactions },
  { label: 'ATTEMPTS', value: RUN.attempts },
  { label: 'CAPTURES', value: RUN.captures },
  { label: 'DECLINES', value: RUN.failures },
  { label: 'REFUSALS', value: VETOES.length, refusal: true },
];

const STATUS_LABEL: Record<BatchTxn['status'], string> = {
  recovered: 'RECOVERED',
  abandoned: 'ABANDONED',
  terminal: 'TERMINAL',
  open: 'OPEN',
};

export function BatchScreen(): JSX.Element {
  const [refusalsOnly, setRefusalsOnly] = useState(false);
  const diff = RUN.recoveredTreatmentPaise - RUN.recoveredControlPaise;

  const rows = useMemo(
    () => (refusalsOnly ? BATCH.transactions.filter((t) => t.vetoes > 0) : BATCH.transactions),
    [refusalsOnly],
  );

  const byTxn = useMemo(() => {
    const m = new Map<string, { decisions: typeof BATCH.decisions; attempts: typeof BATCH.attempts }>();
    for (const t of BATCH.transactions) m.set(t.id, { decisions: [], attempts: [] });
    for (const d of BATCH.decisions) m.get(d.transaction_id)?.decisions.push(d);
    for (const a of BATCH.attempts) m.get(a.transaction_id)?.attempts.push(a);
    return m;
  }, []);

  return (
    <div className="flex flex-col">
      <ScreenHead
        title="BATCH"
        standing={
          <>
            Real payment links, real browser-driven attempts, real guardrail evaluations, every outcome verified against
            Razorpay&apos;s own record. The only screen whose figures are OBSERVED, and they are never added to the
            ESTIMATED figures on THE NUMBER.
          </>
        }
        right={<ClassChip cls="OBSERVED" />}
      />

      {/* Always visible, outside every tier, no dismiss. */}
      <div className="flex gap-3 border-b border-refuse-dim bg-refuse-wash px-4 py-3">
        <span className="eyebrow mt-px shrink-0 text-refuse">STANDING</span>
        <p className="caption max-w-4xl leading-relaxed text-refuse">{LAYER1_CAVEAT}</p>
      </div>

      <div className="grid gap-px bg-chrome p-px xl:grid-cols-[minmax(0,8fr)_minmax(0,4fr)]">
        <Panel
          label="EXHIBIT / OBSERVED RECOVERED VALUE"
          meta={
            <span className="eyebrow text-fg-ghost">
              SEED {RUN.seed} · {RUN.transactions} LINKS · {Math.round(RUN.elapsedS)}s
            </span>
          }
          className="border-0"
          bodyClassName="px-6 pb-8 pt-9 sm:px-12"
          index={0}
        >
          <MaskRise index={0}>
            <HeroFigure
              label="Observed recovered value"
              value={`₹${rupees(diff)}`}
              caption="treatment minus control, observed, this run only"
              provenance={[
                ['SEED', String(RUN.seed)],
                ['LINKS', String(RUN.transactions)],
                ['ATTEMPTS', String(RUN.attempts)],
                ['SOURCE', 'RAZORPAY TEST'],
                ['ELAPSED', `${Math.round(RUN.elapsedS)}s`],
              ]}
            >
              <p className="caption max-w-2xl leading-relaxed">
                Control recovered <Fig className="text-fg-data">₹{rupees(RUN.recoveredControlPaise)}</Fig>, treatment{' '}
                <Fig className="text-fg-data">₹{rupees(RUN.recoveredTreatmentPaise)}</Fig>, across{' '}
                <Fig className="text-fg-data">{RUN.transactions}</Fig> real payment links and{' '}
                <Fig className="text-fg-data">{RUN.attempts}</Fig> real attempts. The difference is a census of this one
                run: there is no population to resample, so there is no interval, and the mock-bank outcome model behind
                each retry means the gap between arms reflects the configured parameters rather than incremental
                recovery.
              </p>
            </HeroFigure>

            <div className="mt-9">
              <Bracket tone="data" serif={18} weight={2} from={0.06} to={0.94} centre={null} animate />
              <div className="relative mt-2.5 flex justify-between">
                <div className="whitespace-nowrap">
                  <Fig className="block text-2xs text-fg-prose">₹{rupees(RUN.recoveredControlPaise)}</Fig>
                  <span className="eyebrow">CONTROL</span>
                </div>
                <div className="whitespace-nowrap text-right">
                  <Fig className="block text-2xs text-fg-prose">₹{rupees(RUN.recoveredTreatmentPaise)}</Fig>
                  <span className="eyebrow">TREATMENT</span>
                </div>
              </div>
            </div>
          </MaskRise>

          <MaskRise index={1} className="mx-auto mt-10 max-w-2xl border-t border-chrome-soft pt-6 text-center">
            <span className="eyebrow">NO INTERVAL, AND THAT IS CORRECT</span>
            <p className="caption mt-2 leading-relaxed">
              A census of one run has nothing for a bootstrap to resample, so a span around this figure would be
              invented uncertainty. The mark above is the distance between two observed totals, not a range the truth
              might lie in.
            </p>
          </MaskRise>
        </Panel>

        <div className="grid content-start gap-px bg-chrome">
          <Panel label="RUN SUMMARY" className="border-0" bodyClassName="p-0" index={1}>
            <div className="divide-y divide-chrome-soft">
              {SUMMARY.map((s) => (
                <div key={s.label} className="flex items-center justify-between px-4 py-2.5">
                  <span className={cn('eyebrow', s.refusal && 'text-refuse')}>{s.label}</span>
                  <Fig className={cn('text-fig-sm leading-none', s.refusal ? 'text-refuse' : 'text-fg-data')}>
                    {s.value}
                  </Fig>
                </div>
              ))}
            </div>
          </Panel>

          <Tiered tier="secondary">
            <Panel
              label="REFUSALS"
              meta={<span className="eyebrow text-fg-ghost">GUARDRAIL VETOES</span>}
              className="border-0"
              bodyClassName="p-0"
              index={2}
            >
              <div className="divide-y divide-chrome-soft">
                {VETOES.map((v) => (
                  <div key={`${v.transaction_id}-${v.attempt_number}`} className="px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <Fig className="text-2xs text-fg-prose">{shortTxn(v.transaction_id)}</Fig>
                      <span className="eyebrow text-refuse">{vetoRule(v.guardrail_reason)}</span>
                    </div>
                    <p className="caption mt-1 leading-snug text-fg-ghost">{v.guardrail_reason}</p>
                  </div>
                ))}
              </div>
              <p className="caption border-t border-chrome-soft px-4 py-3 leading-relaxed">
                Six actions the system declined to take. Each was written to the audit chain as its own event, and no
                outbound Razorpay call was made for any of them.
              </p>
            </Panel>
          </Tiered>
        </div>
      </div>

      {/* ---- The record --------------------------------------------- */}
      <div className="grid gap-px bg-chrome px-px pb-px">
        <Panel
          label="TRANSACTION RECORD"
          meta={
            <button
              type="button"
              onClick={() => setRefusalsOnly((v) => !v)}
              className={cn(
                'eyebrow border px-2 py-1 transition-colors duration-fast',
                refusalsOnly
                  ? 'border-refuse bg-refuse-wash text-refuse'
                  : 'border-chrome text-fg-label hover:text-fg-data',
              )}
            >
              {refusalsOnly ? `REFUSALS ONLY · ${rows.length}` : 'FILTER TO REFUSALS'}
            </button>
          }
          className="border-0"
          bodyClassName="p-0"
          index={3}
        >
          <ProximityRows className="overflow-x-auto">
            <div className="min-w-[860px]">
              <div className="grid items-center gap-x-3 border-b border-chrome bg-ink-000 px-4 py-2" style={COLS}>
                {['TXN', 'GRID CELL', 'AMOUNT', 'ARM', 'ACTION', 'ATT', 'OUTCOME'].map((k) => (
                  <span key={k} className="eyebrow">
                    {k}
                  </span>
                ))}
              </div>

              {rows.map((t, i) => {
                const detail = byTxn.get(t.id);
                const first = detail?.decisions[0];
                const refused = t.vetoes > 0;
                const recovered = t.status === 'recovered';
                return (
                  <Exhibit
                    key={t.id}
                    label={shortTxn(t.id)}
                    className="row-in border-b border-chrome-soft hover:bg-ink-100"
                    figure={
                      <div
                        className="grid items-center gap-x-3 px-4 py-2.5"
                        style={{ ...COLS, '--row-index': i } as React.CSSProperties}
                      >
                        <Fig className="text-2xs text-fg-data">{shortTxn(t.id)}</Fig>
                        <Fig className="truncate text-2xs text-fg-prose">{first?.grid_cell ?? '—'}</Fig>
                        <Fig className="text-2xs text-fg-data">₹{rupees(Number(t.amount_paise))}</Fig>
                        <span className="eyebrow">{t.arm.toUpperCase()}</span>
                        <Fig className={cn('truncate text-2xs', refused ? 'text-refuse' : 'text-fg-prose')}>
                          {first?.proposed_action ?? '—'}
                        </Fig>
                        <Fig className="text-2xs text-fg-data">{t.attempts}</Fig>
                        <span>
                          {refused ? (
                            <span className="eyebrow border border-refuse-dim bg-refuse-wash px-1.5 py-px text-refuse">
                              REFUSED
                            </span>
                          ) : (
                            <span className={cn('eyebrow', recovered ? 'text-fg-data' : 'text-fg-label')}>
                              {STATUS_LABEL[t.status]}
                            </span>
                          )}
                        </span>
                      </div>
                    }
                  >
                    <div className="flex flex-col gap-6">
                      <div>
                        <span className="eyebrow">ATTEMPTS</span>
                        <div className="mt-2 divide-y divide-chrome-soft border-y border-chrome-soft">
                          {(detail?.attempts ?? []).map((a) => (
                            <div key={a.attempt_number} className="flex flex-wrap items-baseline gap-x-5 gap-y-1 py-2">
                              <Fig className="w-16 text-2xs text-fg-ghost">#{a.attempt_number}</Fig>
                              <Fig className="text-2xs text-fg-data">{a.rzp_payment_id ?? 'no payment id'}</Fig>
                              <span className="eyebrow">{a.outcome}</span>
                              {a.error_reason && (
                                <Fig className="text-2xs text-fg-prose">
                                  {a.error_reason} · {a.error_source}/{a.error_step}
                                </Fig>
                              )}
                              {a.auth_code && <Fig className="text-2xs text-fg-prose">auth {a.auth_code}</Fig>}
                            </div>
                          ))}
                          {(detail?.attempts ?? []).length === 0 && (
                            <p className="caption py-2">
                              No attempts. The guardrail refused before any outbound call was made.
                            </p>
                          )}
                        </div>
                      </div>

                      <div>
                        <span className="eyebrow">DECISIONS</span>
                        <div className="mt-2 divide-y divide-chrome-soft border-y border-chrome-soft">
                          {(detail?.decisions ?? []).map((d) => (
                            <div key={d.attempt_number} className="py-2">
                              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                                <Fig className="w-16 text-2xs text-fg-ghost">#{d.attempt_number}</Fig>
                                <Fig className="text-2xs text-fg-prose">{d.grid_cell}</Fig>
                                <Fig
                                  className={cn(
                                    'text-2xs',
                                    d.guardrail_verdict === 'veto' ? 'text-refuse' : 'text-fg-data',
                                  )}
                                >
                                  {d.proposed_action}
                                </Fig>
                                <span
                                  className={cn(
                                    'eyebrow',
                                    d.guardrail_verdict === 'veto' ? 'text-refuse' : 'text-fg-label',
                                  )}
                                >
                                  {d.guardrail_verdict === 'veto' ? 'REFUSED' : 'ALLOWED'}
                                </span>
                              </div>
                              {d.guardrail_reason && (
                                <p className="caption mt-1 leading-snug text-refuse">{d.guardrail_reason}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </Exhibit>
                );
              })}
            </div>
          </ProximityRows>

          <p className="caption border-t border-chrome-soft px-4 py-3 leading-relaxed">
            {RUN.transactions} transactions, {RUN.attempts} attempts, {VETOES.length} refusals. Click any row for its
            full attempt and decision history, including the Razorpay payment id for every attempt.
          </p>
        </Panel>
      </div>
    </div>
  );
}
