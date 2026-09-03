/**
 * THE NUMBER — the finding. ESTIMATED class throughout.
 *
 * Real output from apps/engine (data/experiment.ts), and it landed on a
 * genuinely awkward result this screen refuses to smooth over: the
 * recovery-RATE interval excludes zero while the protocol's own PRIMARY
 * estimate, recovered value in paise, does not. The verdict follows the
 * protocol's nomination rather than the flattering number, so the
 * console reports NO EVIDENCE OF VALUE on a run where one of its two
 * figures looks like a win.
 *
 * The hero carries the rate figure because that is the one the frozen
 * REFERENCE and the whole calibration record are expressed in, so it is
 * the only one that can be shown against a known answer — and it sits ON
 * its own resample distribution, which is the evidence the interval was
 * read from.
 *
 * ONE CONVENTION FOR NUMBERS on this screen: Indian digit grouping
 * everywhere, units in column headers, never repeated per row.
 */
import { DistributionHero } from '../components/hero/DistributionHero';
import { DualInterval } from '../components/hero/DualInterval';
import { MiniDisagreement } from '../components/hero/MiniDisagreement';
import { ClassChip } from '../components/primitives/ClassChip';
import { Exhibit } from '../components/primitives/Exhibit';
import { Fig } from '../components/primitives/Fig';
import { MaskRise } from '../components/primitives/MaskRise';
import { Panel } from '../components/primitives/Panel';
import { ScreenHead } from '../components/primitives/ScreenHead';
import { Tiered } from '../components/primitives/Tier';
import { cn } from '../lib/cn';
import { HighlightProvider, highlightProps, useHighlight, type HighlightKey } from '../lib/highlight';
import { EXPERIMENT as X, VERDICT_BASIS, VERDICT_TEXT, formatPp } from '../data/experiment';
import { INSTRUMENT } from '../data/facts';

/** One convention: Indian grouping, no unit suffix. Units live in the
 * column header. */
const inr = (n: number): string => Math.round(n).toLocaleString('en-IN');
const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${inr(Math.abs(n))}`;

interface ReconRow {
  label: string;
  value: string;
  highlights: Exclude<HighlightKey, null>;
  emphasis?: boolean;
}

const RECON: ReconRow[] = [
  { label: 'Treatment total', value: inr(X.arms.treatment.totalValuePaise), highlights: 'treatment' },
  { label: 'Control total', value: inr(X.arms.control.totalValuePaise), highlights: 'control' },
  { label: 'Treatment, per transaction', value: inr(X.arms.treatment.meanValuePaise), highlights: 'treatment' },
  { label: 'Control, per transaction', value: inr(X.arms.control.meanValuePaise), highlights: 'control' },
  // The row the whole table exists to produce.
  { label: 'Difference, per transaction', value: signed(X.value.point), highlights: 'interval', emphasis: true },
  { label: 'Band cut points', value: X.bandCutPointsPaise.map(inr).join(' · '), highlights: 'provenance' },
  { label: 'Seed', value: String(X.seed), highlights: 'provenance' },
  { label: 'N', value: inr(X.n), highlights: 'provenance' },
];

export function NumberScreen(): JSX.Element {
  return (
    <HighlightProvider>
      <NumberScreenInner />
    </HighlightProvider>
  );
}

function NumberScreenInner(): JSX.Element {
  const { active, set } = useHighlight();

  return (
    <div className="flex flex-col">
      <ScreenHead
        title="THE NUMBER"
        standing={
          <>
            Incremental recovered value: what the policy caused, not what would have recovered anyway. ESTIMATED
            evidence from a synthetic population whose true answer is known by construction. Never added to the OBSERVED
            figures on BATCH.
          </>
        }
        right={<ClassChip cls="ESTIMATED" />}
      />

      <div className="grid gap-px bg-chrome p-px xl:grid-cols-[minmax(0,8fr)_minmax(0,4fr)]">
        {/* ---- THE MONEY SHOT ---------------------------------------- */}
        <Panel
          label="EXHIBIT A / RECOVERY-RATE DIFFERENCE"
          meta={
            <span className="eyebrow text-fg-ghost">
              95% BOOTSTRAP · {X.bootstrapMethod.toUpperCase()} · {inr(X.resamples)} RESAMPLES
            </span>
          }
          className="border-0"
          bodyClassName="px-6 pb-7 pt-8 sm:px-12"
          index={0}
        >
          <MaskRise index={0}>
            <DistributionHero
              point={X.rate.point}
              lo={X.rate.lo}
              hi={X.rate.hi}
              reference={X.estimand}
              counts={X.histogram.counts}
              edges={X.histogram.edges}
              format={formatPp}
              suffix="pp"
              unit="percentage points, treatment minus control"
              provenance={{
                seed: X.seed,
                n: X.n,
                method: X.bootstrapMethod,
                resamples: X.resamples,
                computed: X.generated,
              }}
            />
          </MaskRise>

          {/* The verdict, on the same optical axis as the figure above:
              both are centred in this one column, not to different
              containers. */}
          <MaskRise
            index={1}
            className="mt-9 flex flex-col items-center gap-6 border-t border-chrome-soft pt-7 lg:flex-row lg:items-center lg:justify-center lg:gap-10"
          >
            <div className="flex shrink-0 flex-col items-center gap-2 text-center lg:items-start lg:text-left">
              <span className="eyebrow">VERDICT</span>
              <span className="text-verdict font-semibold tracking-[-0.02em] text-fg-data">
                {VERDICT_TEXT[X.verdict]}
              </span>
              <span className="caption max-w-xs">Because {VERDICT_BASIS[X.verdict]}.</span>
            </div>

            {/* The disagreement, beside the verdict rather than below the
                fold. It is the reason the verdict says what it says, so a
                first-viewport viewer has to be able to see it. */}
            <MiniDisagreement
              className="w-full max-w-xl lg:border-l lg:border-chrome-soft lg:pl-10"
              rows={[
                { label: 'RATE, PP', point: X.rate.point, lo: X.rate.lo, hi: X.rate.hi, primary: false },
                { label: 'VALUE, PAISE', point: X.value.point, lo: X.value.lo, hi: X.value.hi, primary: true },
              ]}
            />
          </MaskRise>
        </Panel>

        {/* ---- Supporting column ------------------------------------- */}
        <div className="grid content-start gap-px bg-chrome">
          <Panel label="PER ARM" className="border-0" bodyClassName="p-0" index={1}>
            <div className="grid grid-cols-2 divide-x divide-chrome-soft">
              {(['control', 'treatment'] as const).map((arm) => {
                const a = X.arms[arm];
                const dimmed = active !== null && active !== arm && (active === 'control' || active === 'treatment');
                return (
                  <div
                    key={arm}
                    {...highlightProps(arm, set)}
                    className={cn(
                      'flex flex-col gap-2 p-4 transition-opacity duration-fast',
                      dimmed ? 'opacity-25' : 'opacity-100',
                    )}
                  >
                    <span className="eyebrow">{arm.toUpperCase()}</span>
                    <Fig className="text-fig-sm text-fg-data">{(a.rate * 100).toFixed(2)}%</Fig>
                    <span className="caption">
                      {inr(a.recovered)} of {inr(a.n)} recovered
                    </span>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Tiered tier="secondary">
            <Panel
              label="RECONCILIATION"
              meta={<span className="eyebrow text-fg-ghost">PAISE, INDIAN GROUPING</span>}
              className="border-0"
              bodyClassName="p-0"
              index={2}
            >
              <Exhibit
                label="Reconciliation"
                figure={
                  <div className="divide-y divide-chrome-soft">
                    {RECON.map((r) => (
                      <div
                        key={r.label}
                        {...highlightProps(r.highlights, set)}
                        className={cn(
                          'flex items-center justify-between gap-3 px-4 transition-colors duration-fast',
                          r.emphasis ? 'bg-ink-000 py-3.5' : 'py-2',
                          active === r.highlights && 'bg-ink-150',
                        )}
                      >
                        <span
                          className={cn(
                            r.emphasis ? 'text-sm font-semibold text-fg-data' : 'text-xs text-fg-label',
                          )}
                        >
                          {r.label}
                        </span>
                        <Fig className={cn(r.emphasis ? 'text-fig-sm text-accent' : 'text-xs text-fg-data')}>
                          {r.value}
                        </Fig>
                      </div>
                    ))}
                  </div>
                }
              >
                <p className="caption max-w-2xl leading-relaxed">
                  Check it by hand. Treatment total <Fig className="text-fg-data">{inr(X.arms.treatment.totalValuePaise)}</Fig>{' '}
                  over <Fig className="text-fg-data">{inr(X.arms.treatment.n)}</Fig> transactions is{' '}
                  <Fig className="text-fg-data">{inr(X.arms.treatment.meanValuePaise)}</Fig> each. Control total{' '}
                  <Fig className="text-fg-data">{inr(X.arms.control.totalValuePaise)}</Fig> over{' '}
                  <Fig className="text-fg-data">{inr(X.arms.control.n)}</Fig> is{' '}
                  <Fig className="text-fg-data">{inr(X.arms.control.meanValuePaise)}</Fig>. The difference is{' '}
                  <Fig className="text-accent">{signed(X.value.point)}</Fig> paise per transaction, which is the figure
                  the primary interval is built on. Every number on this screen is in paise with Indian grouping; nothing
                  is converted or rounded on the way to the headline.
                </p>
              </Exhibit>
            </Panel>
          </Tiered>

          <Tiered tier="tertiary">
            <Panel
              label="SECONDARY CHECK"
              meta={<span className="eyebrow text-fg-ghost">NOT THE CLAIM</span>}
              className="border-0"
              bodyClassName="p-0"
              index={3}
            >
              <div className="divide-y divide-chrome-soft">
                {[
                  ['Two-proportion z', X.z.statistic.toFixed(3)],
                  ['p-value', X.z.pValue.toFixed(4)],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between px-4 py-2">
                    <span className="text-xs text-fg-label">{k}</span>
                    <Fig className="text-xs text-fg-data">{v}</Fig>
                  </div>
                ))}
              </div>
              <p className="caption border-t border-chrome-soft px-4 py-3 leading-relaxed">
                Reported beside the bootstrap interval, never in place of it. Its own standard error ignores the
                stratified design, a recorded limitation, so it is the weaker of the two tests.
              </p>
            </Panel>
          </Tiered>

          <Tiered tier="tertiary">
            <Panel label="INSTRUMENT STANDING" className="border-0" bodyClassName="p-4" index={4}>
              <p className="caption leading-relaxed">
                The estimator behind this figure recovered a known reference of{' '}
                <Fig className="text-fg-data">{X.estimand.toFixed(4)}pp</Fig> in{' '}
                <Fig className="text-fg-data">{(INSTRUMENT.coverage * 100).toFixed(1)}%</Fig> of{' '}
                <Fig className="text-fg-data">{inr(INSTRUMENT.replications)}</Fig> replications. That interval excludes
                the nominal 95%, so it is slightly anti-conservative.
              </p>
            </Panel>
          </Tiered>
        </div>
      </div>

      {/* ---- The disagreement, below the fold and full width -------- */}
      <div className="grid gap-px bg-chrome px-px pb-px">
        <Panel
          label="THE TWO ESTIMATES DISAGREE"
          meta={<span className="eyebrow text-fg-ghost">SAME RUN · SAME SEED</span>}
          className="border-0"
          bodyClassName="px-6 py-7 sm:px-12"
          index={5}
        >
          <div className="mx-auto max-w-3xl">
            <DualInterval
              rows={[
                {
                  label: 'RECOVERY-RATE DIFFERENCE, PP',
                  note: 'The figure in the hero above. Its interval lies entirely above zero, so on this estimate alone the policy looks effective.',
                  point: X.rate.point,
                  lo: X.rate.lo,
                  hi: X.rate.hi,
                  format: (v) => formatPp(v),
                  primary: false,
                },
                {
                  label: 'RECOVERED-VALUE DIFFERENCE, PAISE PER TRANSACTION',
                  note: "EXPERIMENT-PROTOCOL.md's stated primary estimate. Its interval crosses zero, so the run does not support a claim of incremental value — and that is the verdict this screen reports.",
                  point: X.value.point,
                  lo: X.value.lo,
                  hi: X.value.hi,
                  format: signed,
                  primary: true,
                },
              ]}
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}
