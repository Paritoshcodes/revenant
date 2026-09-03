/**
 * DECISIONS — the decision record, refusals included.
 *
 * The screen no comparable product has. Every dashboard records what was
 * done; this one gives equal weight to what was deliberately NOT done,
 * because declining to retry a terminal decline is correct behaviour and
 * a real cost avoided.
 *
 * The policy grid renders as an actual grid of its seven cells rather
 * than a table of rows, because it IS a grid: the policy switches on
 * (error_source, error_step), and laying it out as a matrix shows that
 * an unseen decline still lands somewhere. Hovering a cell highlights
 * the transactions that landed in it, in the record below.
 *
 * The classifier figures are real and unflattering: 0.667 achievable
 * accuracy on six observations, an interval spanning 0.30 to 0.90, and
 * a confidence gate that caught none of the wrong answers.
 */
import { useMemo, useState } from 'react';

import { ClassChip } from '../components/primitives/ClassChip';
import { Exhibit } from '../components/primitives/Exhibit';
import { Fig } from '../components/primitives/Fig';
import { HeroFigure } from '../components/hero/HeroFigure';
import { MaskRise } from '../components/primitives/MaskRise';
import { Panel } from '../components/primitives/Panel';
import { ProximityRows } from '../components/primitives/ProximityRows';
import { ScreenHead } from '../components/primitives/ScreenHead';
import { Tiered } from '../components/primitives/Tier';
import { BATCH, VETOES, shortTxn, vetoRule } from '../data/batch';
import { CLASSIFICATIONS, CLASSIFIER, POLICY_GRID } from '../data/facts';
import { cn } from '../lib/cn';

const CLASS_NOTE: Record<string, string> = {
  TRANSIENT: 'expected to clear on its own, so a retry is worth spending',
  SOFT: 'may clear on a different timing window',
  CUSTOMER: 'needs the customer, so no automated retry can help',
  TERMINAL: 'will never succeed; retrying spends money for nothing',
};

const DECISION_COLS: React.CSSProperties = {
  gridTemplateColumns: '5.5rem 3rem 15rem 13rem 6rem 1fr',
};

export function DecisionsScreen(): JSX.Element {
  const [cell, setCell] = useState<string | null>(null);
  const [refusalsOnly, setRefusalsOnly] = useState(false);

  const rows = useMemo(() => {
    let out = BATCH.decisions;
    if (refusalsOnly) out = out.filter((d) => d.guardrail_verdict === 'veto');
    if (cell) out = out.filter((d) => d.grid_cell === cell);
    return out;
  }, [refusalsOnly, cell]);

  /** How many real decisions landed in each cell — the grid is not a
   * static contract diagram here, it is a histogram of where this run's
   * traffic actually went. */
  const perCell = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of BATCH.decisions) m.set(d.grid_cell, (m.get(d.grid_cell) ?? 0) + 1);
    return m;
  }, []);

  return (
    <div className="flex flex-col">
      <ScreenHead
        title="DECISIONS"
        standing={
          <>
            Every transaction&apos;s diagnosis, the cell it landed in, the action proposed, the guardrail verdict and the
            outcome. A REFUSAL is entered here as evidence in its own right, never as an error, because the system
            declining to act is the system working.
          </>
        }
        right={<ClassChip cls="RECORD" />}
      />

      <div className="grid gap-px bg-chrome p-px xl:grid-cols-[minmax(0,8fr)_minmax(0,4fr)]">
        <Panel
          label="EXHIBIT / DECISIONS ON THE RECORD"
          meta={
            <span className="eyebrow text-fg-ghost">
              {BATCH.decisions.length} DECISIONS · {VETOES.length} REFUSED
            </span>
          }
          className="border-0"
          bodyClassName="px-6 pb-8 pt-9 sm:px-12"
          index={0}
        >
          <MaskRise index={0}>
            <HeroFigure
              label="Refusals"
              value={String(VETOES.length)}
              caption={`actions declined, of ${BATCH.decisions.length} decisions taken`}
              tone="refuse"
              provenance={[
                ['DECISIONS', String(BATCH.decisions.length)],
                ['REFUSED', String(VETOES.length)],
                ['RULES FIRED', String(new Set(VETOES.map((v) => vetoRule(v.guardrail_reason))).size)],
                ['SOURCE', 'DB decisions'],
              ]}
            >
              <div className="divide-y divide-chrome-soft border-y border-chrome-soft">
                {VETOES.map((v) => (
                  <div key={`${v.transaction_id}-${v.attempt_number}`} className="py-2.5">
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <Fig className="text-2xs text-fg-data">{shortTxn(v.transaction_id)}</Fig>
                      <Fig className="text-2xs text-fg-prose">{v.grid_cell}</Fig>
                      <span className="eyebrow text-refuse">{vetoRule(v.guardrail_reason)}</span>
                    </div>
                    <p className="caption mt-1 leading-snug">{v.guardrail_reason}</p>
                  </div>
                ))}
              </div>
              <p className="caption mt-4 leading-relaxed">
                Each of these was written to the audit chain as its own event, and no outbound Razorpay call was made
                for any of them — verifiable on CUSTODY, where they appear as REFUSAL links.
              </p>
            </HeroFigure>
          </MaskRise>

          {/* ---- The policy grid, as a grid ------------------------- */}
          <MaskRise index={1} className="mt-11 border-t border-chrome-soft pt-7">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
              <span className="eyebrow">POLICY GRID · 7 CELLS · COMMITTED CONTRACT</span>
              <span className="caption text-fg-ghost">
                {cell ? `filtering the record to ${cell}` : 'hover a cell to filter the record below'}
              </span>
            </div>

            <div className="grid gap-px bg-chrome sm:grid-cols-2 lg:grid-cols-3">
              {POLICY_GRID.map((g) => {
                const refuses = g.cls === 'TERMINAL' || g.cls === 'CUSTOMER';
                const count = perCell.get(g.cell) ?? 0;
                const on = cell === g.cell;
                return (
                  <button
                    key={g.cell}
                    type="button"
                    onPointerEnter={() => setCell(g.cell)}
                    onPointerLeave={() => setCell(null)}
                    onClick={() => setCell((c) => (c === g.cell ? null : g.cell))}
                    className={cn(
                      'flex flex-col gap-2 bg-ink-050 p-3 text-left transition-colors duration-fast',
                      on ? 'bg-ink-150' : 'hover:bg-ink-100',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={cn('eyebrow', refuses ? 'text-refuse' : 'text-fg-label')}>{g.cls}</span>
                      <span className="eyebrow text-fg-ghost">{g.observed ? 'OBSERVABLE' : 'SYNTHETIC'}</span>
                    </div>
                    <Fig className="truncate text-2xs text-fg-data">{g.cell}</Fig>
                    <div className="flex items-baseline justify-between gap-2">
                      <Fig className={cn('text-2xs', refuses ? 'text-refuse' : 'text-fg-prose')}>{g.action}</Fig>
                      <Fig className={cn('text-2xs', count > 0 ? 'text-fg-data' : 'text-fg-ghost')}>{count}</Fig>
                    </div>
                  </button>
                );
              })}
            </div>

            <p className="caption mt-4 leading-relaxed">
              {cell ? (
                <>
                  <span className="eyebrow text-fg-prose">
                    {POLICY_GRID.find((g) => g.cell === cell)?.cls}
                  </span>{' '}
                  {CLASS_NOTE[POLICY_GRID.find((g) => g.cell === cell)?.cls ?? ''] ?? ''}.{' '}
                  <Fig className="text-fg-data">{perCell.get(cell) ?? 0}</Fig> of this run&apos;s decisions landed here.
                </>
              ) : (
                <>
                  The policy switches on <Fig className="text-fg-prose">(error_source, error_step)</Fig>, never on the
                  reason string, so an unseen decline still lands somewhere on this grid. The trailing figure is how many
                  of this run&apos;s decisions each cell actually took. Only three cells are reachable in Razorpay test
                  mode; the rest are exercised in the synthetic layer, and that limit is stated rather than papered over.
                </>
              )}
            </p>
          </MaskRise>
        </Panel>

        <div className="grid content-start gap-px bg-chrome">
          <Panel
            label="CLASSIFIER"
            meta={<span className="eyebrow text-fg-ghost">{CLASSIFIER.model}</span>}
            className="border-0"
            bodyClassName="p-4"
            index={1}
          >
            <div className="flex items-baseline gap-3">
              <Fig className="text-fig text-fg-data">{CLASSIFIER.accuracy.toFixed(3)}</Fig>
              <Fig className="text-2xs text-fg-prose">
                95% WILSON [{CLASSIFIER.wilsonLo.toFixed(2)}, {CLASSIFIER.wilsonHi.toFixed(2)}]
              </Fig>
            </div>
            <span className="caption mt-1 block">
              leave-one-cell-out, achievable cases only, N={CLASSIFIER.n}
            </span>
            <p className="caption mt-3 leading-relaxed">
              Six observations cannot distinguish this from chance in either direction, so the interval is never
              dropped. {CLASSIFIER.nonAchievable} further cases are excluded because their class is a singleton — with
              the true cell hidden there is no same-class alternative to land on, so they are unanswerable by
              construction rather than wrong.
            </p>
          </Panel>

          <Tiered tier="secondary">
            <Panel label="PER HELD-OUT CELL" className="border-0" bodyClassName="p-0" index={2}>
              <div className="divide-y divide-chrome-soft">
                {CLASSIFIER.cells.map((c) => (
                  <div key={c.cell} className="flex items-center justify-between gap-3 px-4 py-2">
                    <Fig className="truncate text-2xs text-fg-prose">{c.cell}</Fig>
                    {c.accuracy === null ? (
                      <span className="eyebrow shrink-0 text-fg-ghost">{c.n === 0 ? 'NO CASES' : 'NOT ACHIEVABLE'}</span>
                    ) : (
                      <Fig
                        className={cn('shrink-0 text-2xs', c.accuracy > 0 ? 'text-fg-data' : 'text-refuse')}
                      >
                        {c.accuracy.toFixed(3)}
                      </Fig>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          </Tiered>

          <Tiered tier="secondary">
            <Panel
              label="CANDIDATES AND THE GATE"
              meta={<span className="eyebrow text-fg-ghost">MARGIN ≥ {CLASSIFIER.marginThreshold}</span>}
              className="border-0"
              bodyClassName="p-0"
              index={3}
            >
              <div className="divide-y divide-chrome-soft">
                {CLASSIFICATIONS.map((c) => (
                  <div key={c.resolved + String(c.margin)} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <Fig className="truncate text-2xs text-fg-data">{c.resolved}</Fig>
                      <span className={cn('eyebrow shrink-0', c.gated ? 'text-refuse' : 'text-fg-label')}>
                        {c.gated ? 'GATE REFUSED' : 'ACCEPTED'}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-col gap-1">
                      {c.candidates.map((k) => (
                        <div key={k.cls} className="flex items-center gap-2">
                          <Fig className="w-10 shrink-0 text-2xs text-fg-prose">{k.score.toFixed(2)}</Fig>
                          {/* The score as a bar: the margin between the
                              top two is what the gate reads, so it has
                              to be visible, not just stated. */}
                          <span className="h-1 flex-1 bg-ink-150">
                            <span
                              className="block h-1 bg-fg-ghost"
                              style={{ width: `${k.score * 100}%` }}
                              aria-hidden
                            />
                          </span>
                          <Fig className="w-40 shrink-0 truncate text-2xs text-fg-ghost">{k.cls}</Fig>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="eyebrow">MARGIN</span>
                      <Fig className={cn('text-2xs', c.gated ? 'text-refuse' : 'text-fg-data')}>
                        {c.margin.toFixed(2)}
                      </Fig>
                    </div>
                    <p className="caption mt-1.5 leading-snug">{c.note}</p>
                  </div>
                ))}
              </div>
              <p className="caption border-t border-chrome-soft px-4 py-3 leading-relaxed">
                Across two live runs the margin gate produced {CLASSIFIER.falseRefusals} false refusals and{' '}
                {CLASSIFIER.trueRefusals} true ones — it has caught no wrong answers yet. Separation is not above chance
                on this sample (AUC {CLASSIFIER.separationAuc}, p={CLASSIFIER.separationP}), so no data-driven cut was
                fitted; the threshold comes from the asymmetric cost alone.
              </p>
            </Panel>
          </Tiered>
        </div>
      </div>

      {/* ---- The record --------------------------------------------- */}
      <div className="grid gap-px bg-chrome px-px pb-px">
        <Panel
          label="DECISION RECORD"
          meta={
            <div className="flex items-center gap-2">
              {cell && (
                <button
                  type="button"
                  onClick={() => setCell(null)}
                  className="eyebrow border border-chrome px-2 py-1 text-fg-label transition-colors duration-fast hover:text-fg-data"
                >
                  CLEAR CELL
                </button>
              )}
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
            </div>
          }
          className="border-0"
          bodyClassName="p-0"
          index={4}
        >
          <ProximityRows className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div className="grid items-center gap-x-3 border-b border-chrome bg-ink-000 px-4 py-2" style={DECISION_COLS}>
                {['TXN', 'ATT', 'GRID CELL', 'PROPOSED ACTION', 'P(REC)', 'VERDICT'].map((k) => (
                  <span key={k} className="eyebrow">
                    {k}
                  </span>
                ))}
              </div>

              {rows.map((d, i) => {
                const veto = d.guardrail_verdict === 'veto';
                return (
                  <div
                    key={`${d.transaction_id}-${d.attempt_number}`}
                    className="row-in grid items-center gap-x-3 border-b border-chrome-soft px-4 py-2.5 hover:bg-ink-100"
                    style={{ ...DECISION_COLS, '--row-index': Math.min(i, 20) } as React.CSSProperties}
                  >
                    <Fig className="text-2xs text-fg-data">{shortTxn(d.transaction_id)}</Fig>
                    <Fig className="text-2xs text-fg-prose">{d.attempt_number}</Fig>
                    <Fig className="truncate text-2xs text-fg-prose">{d.grid_cell}</Fig>
                    <Fig className={cn('truncate text-2xs', veto ? 'text-refuse' : 'text-fg-data')}>
                      {d.proposed_action}
                    </Fig>
                    <Fig className="text-2xs text-fg-prose">
                      {d.recovery_probability === null ? '—' : Number(d.recovery_probability).toFixed(3)}
                    </Fig>
                    <span className="min-w-0">
                      {veto ? (
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="eyebrow shrink-0 border border-refuse-dim bg-refuse-wash px-1.5 py-px text-refuse">
                            REFUSED
                          </span>
                          <span className="caption truncate text-fg-ghost">{d.guardrail_reason}</span>
                        </span>
                      ) : (
                        <span className="eyebrow text-fg-label">ALLOWED</span>
                      )}
                    </span>
                  </div>
                );
              })}

              {rows.length === 0 && (
                <p className="caption px-4 py-6">No decisions match this filter.</p>
              )}
            </div>
          </ProximityRows>

          <p className="caption border-t border-chrome-soft px-4 py-3 leading-relaxed">
            Showing <Fig className="text-fg-data">{rows.length}</Fig> of{' '}
            <Fig className="text-fg-data">{BATCH.decisions.length}</Fig> decisions from seed 1538946708. Every refusal
            carries the guardrail rule that fired and the reason it gave.
          </p>
        </Panel>
      </div>
    </div>
  );
}
