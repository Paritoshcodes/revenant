/**
 * INSTRUMENT — the verification certificate.
 *
 * The screen no vendor can build, and the reason is structural rather
 * than technical: on real merchant data nobody knows the true lift, so
 * nobody can check whether their interval covers it. Here the world was
 * authored, the reference was frozen before any run, and the estimator
 * can therefore be graded against a known answer.
 *
 * These figures are precomputed and constant by definition, so this
 * screen carries real values with no run loaded. It also states the
 * result that is NOT flattering: the coverage interval excludes nominal.
 */
import { INSTRUMENT, REFERENCE } from '../data/facts';
import { cn } from '../lib/cn';
import { ClassChip } from '../components/primitives/ClassChip';
import { EmptyExhibit } from '../components/primitives/EmptyExhibit';
import { Fig } from '../components/primitives/Fig';
import { Bracket, BracketRule } from '../components/identity/Bracket';
import { HeroFigure } from '../components/hero/HeroFigure';
import { Panel } from '../components/primitives/Panel';
import { ScreenHead } from '../components/primitives/ScreenHead';
import { Tiered } from '../components/primitives/Tier';

const LO = 0.9;
const HI = 1.0;
const NOMINAL = 0.95;
const pct = (v: number): number => ((v - LO) / (HI - LO)) * 100;

export function InstrumentScreen(): JSX.Element {
  return (
    <div className="flex flex-col">
      <ScreenHead
        title="INSTRUMENT"
        standing={
          <>
            Before the estimator was used on anything, it was run{' '}
            <Fig className="text-fg-prose">{INSTRUMENT.replications}</Fig> times against a world whose true answer was
            fixed in advance, to measure how often its 95% interval actually contained that answer. This is the
            certificate for the instrument that produces THE NUMBER.
          </>
        }
        right={<ClassChip cls="ESTIMATED" />}
      />

      <div className="grid gap-px bg-chrome p-px xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Panel
          label="COVERAGE / CERTIFICATE"
          meta={
            <span className="eyebrow text-fg-ghost">
              {INSTRUMENT.method.toUpperCase()} BOOTSTRAP · {INSTRUMENT.computedOn}
            </span>
          }
          className="border-0"
          bodyClassName="p-4"
        >
          <div className="relative pt-4">
            {/* NOMINAL cuts through the composition the way REFERENCE
                does on THE NUMBER: the thing being measured against. */}
            <div
              className="pointer-events-none absolute inset-y-0 z-0 w-px"
              style={{
                left: `${pct(NOMINAL)}%`,
                backgroundImage:
                  'repeating-linear-gradient(to bottom, var(--color-chrome-hard) 0 3px, transparent 3px 7px)',
              }}
              aria-hidden
            />

            <div className="relative z-10">
              <HeroFigure
                label="Coverage"
                value={INSTRUMENT.coverage.toFixed(3)}
                caption={`of ${INSTRUMENT.replications.toLocaleString('en-IN')} intervals contained the reference`}
                provenance={[
                  ['REPLICATIONS', INSTRUMENT.replications.toLocaleString('en-IN')],
                  ['METHOD', INSTRUMENT.method.toUpperCase()],
                  ['MASTER SEED', '202609012000'],
                  ['COMPUTED', INSTRUMENT.computedOn],
                ]}
              >
                <p className="caption max-w-2xl leading-relaxed">
                  The estimator was run <Fig className="text-fg-data">{INSTRUMENT.replications.toLocaleString('en-IN')}</Fig>{' '}
                  times against a world whose true lift was fixed at{' '}
                  <Fig className="text-accent">{REFERENCE.trueLiftPp.toFixed(4)}pp</Fig> before any experiment existed,
                  and its 95% interval contained that answer{' '}
                  <Fig className="text-fg-data">{(INSTRUMENT.coverage * 100).toFixed(1)}%</Fig> of the time. At 500
                  replications the Wilson interval still contained the nominal 0.95 and the estimator looked exact; at{' '}
                  <Fig className="text-fg-data">{INSTRUMENT.replications.toLocaleString('en-IN')}</Fig> it does not. More
                  replications did not move the point estimate, they resolved a small real departure. The bootstrap&apos;s
                  implied standard error runs about 6.5% under the true sampling spread, which predicts coverage near
                  0.933 against the {INSTRUMENT.coverage.toFixed(3)} observed. No third variant was attempted.
                </p>
              </HeroFigure>
            </div>

            <div className="relative z-10 mt-6">
              <Bracket
                tone="data"
                serif={18}
                weight={2}
                from={pct(INSTRUMENT.wilsonLo) / 100}
                to={pct(INSTRUMENT.wilsonHi) / 100}
                centre={
                  (INSTRUMENT.coverage - INSTRUMENT.wilsonLo) / (INSTRUMENT.wilsonHi - INSTRUMENT.wilsonLo)
                }
                animate
              />
              <div className="relative mt-2.5 h-4">
                <Fig
                  className="absolute -translate-x-1/2 text-2xs text-fg-prose"
                  style={{ left: `${pct(INSTRUMENT.wilsonLo)}%` }}
                >
                  {INSTRUMENT.wilsonLo.toFixed(4)}
                </Fig>
                <Fig
                  className="absolute -translate-x-1/2 text-2xs text-fg-prose"
                  style={{ left: `${pct(INSTRUMENT.wilsonHi)}%` }}
                >
                  {INSTRUMENT.wilsonHi.toFixed(4)}
                </Fig>
              </div>
            </div>

            <div className="relative z-10 mt-1 h-9">
              <div
                className="absolute flex -translate-x-1/2 flex-col items-center gap-1"
                style={{ left: `${pct(NOMINAL)}%` }}
              >
                <span className="eyebrow whitespace-nowrap">NOMINAL</span>
                <Fig className="text-2xs text-fg-prose">0.950</Fig>
              </div>
            </div>

            <div className="relative z-10 mt-2">
              {[0.9, 0.925, 0.95, 0.975, 1.0].map((tk) => (
                <Fig
                  key={tk}
                  className="absolute -translate-x-1/2 text-micro text-fg-ghost"
                  style={{ left: `${pct(tk)}%` }}
                >
                  {tk.toFixed(3)}
                </Fig>
              ))}
            </div>
          </div>

          <BracketRule className="my-9" />

          <div className="flex flex-col items-center gap-2 text-center">
            <span className="eyebrow">FINDING</span>
            <span className="text-verdict font-semibold tracking-[-0.02em] text-refuse">
              Interval excludes nominal
            </span>
            <span className="caption max-w-md">
              The instrument is slightly anti-conservative. Reported at the same weight a passing result would get.
            </span>
          </div>

        </Panel>

        <div className="grid gap-px bg-chrome">
          <Panel label="REFERENCE" className="border-0" bodyClassName="p-4">
            {/* The accent's one permitted use on this screen: this IS the
                reference, the anchor the certificate above grades against. */}
            <div className="flex items-baseline justify-between gap-3">
              <Fig className="text-2xl text-accent">{REFERENCE.trueLiftPp.toFixed(4)}pp</Fig>
              <span className="eyebrow">FROZEN {REFERENCE.committed}</span>
            </div>
            <p className="caption mt-3 leading-relaxed">
              Computed in code by <Fig className="text-fg-prose">compute_true_lift()</Fig> and committed before any
              experiment had run, so it cannot have been fitted to a result. A hand-computed first draft of this figure
              was wrong in two independent ways and was corrected on the record rather than quietly replaced.
            </p>
          </Panel>

          <Tiered tier="secondary">
            <Panel label="NULL CONDITION" className="border-0" bodyClassName="p-0">
              <div className="divide-y divide-chrome-soft">
                {[
                  ['Treatment', 'Forced equal to control'],
                  ['True lift', 'Exactly 0, by construction'],
                  ['Contains zero', '0.9520'],
                  ['z-test rejects', '0.0110'],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="eyebrow text-fg-label">{k}</span>
                    <Fig className="text-xs text-fg-prose">{v}</Fig>
                  </div>
                ))}
              </div>
              <p className="border-t border-chrome-soft px-4 py-3 text-2xs leading-relaxed text-fg-label">
                With no real effect to find, the interval still contains zero 95.2% of the time. A system that can report
                its own null is the point; one that cannot is not measuring anything.
              </p>
            </Panel>
          </Tiered>

          <Tiered tier="tertiary">
            <Panel label="METHOD ON RECORD" className="border-0" bodyClassName="p-0">
              <div className="divide-y divide-chrome-soft">
                {[
                  ['Pooled', '38% too wide', 'text-fg-label'],
                  ['Stratified', '6.5% too narrow', 'text-fg-data'],
                ].map(([k, v, tone]) => (
                  <div key={k} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className={cn('text-xs', k === 'Stratified' ? 'text-fg-prose' : 'text-fg-label')}>{k}</span>
                    <Fig className={cn('text-xs', tone)}>{v}</Fig>
                  </div>
                ))}
              </div>
              <p className="border-t border-chrome-soft px-4 py-3 text-2xs leading-relaxed text-fg-label">
                Both remain selectable and both stay on the record. Pooled ignored the stratified design and ran wide;
                the correction was made because the cause was diagnosed and confirmed two independent ways, not because
                the number was unwelcome.
              </p>
            </Panel>
          </Tiered>

          <Tiered tier="tertiary">
            <Panel label="REPLICATION RECORD" className="border-0" bodyClassName="px-4">
              <EmptyExhibit
                headline="DISTRIBUTION NOT LOADED"
                contains="The individual point estimates across every replication, their mean and spread, and which replications missed. Precomputed and never re-run live: a full pass takes over half an hour."
                acquire="POST /calibration  { replications: 2000, master_seed }"
              />
            </Panel>
          </Tiered>
        </div>
      </div>
    </div>
  );
}
