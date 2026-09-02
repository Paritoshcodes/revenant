/**
 * BATCH — the field record. OBSERVED class: real Razorpay test-mode
 * calls, real guardrails, real audit writes, from the --count 30
 * --concurrency 4 run of 2026-09-01.
 *
 * THE MARK MEANS SOMETHING SPECIFIC HERE, and it is not what it means on
 * THE NUMBER. A Layer 1 figure is a CENSUS of one real run, not a sample
 * from a population, so it has no sampling interval, and a bracket around
 * a single total would be inventing uncertainty that does not exist. What
 * genuinely IS a span here is the distance between the two arms' observed
 * totals — so that is what the mark carries: endpoints at control and
 * treatment. Same grammar, honestly applied.
 *
 * The LAYER1_CAVEAT sits outside every visibility tier with no dismiss
 * control, because the one thing this screen must never do is let a
 * viewer read a real recovered figure without the sentence saying what
 * it does and does not prove.
 */
import { Bracket, BracketRule } from '../components/identity/Bracket';
import { HeroFigure } from '../components/hero/HeroFigure';
import { ClassChip } from '../components/primitives/ClassChip';
import { EmptyExhibit } from '../components/primitives/EmptyExhibit';
import { Fig } from '../components/primitives/Fig';
import { MaskRise } from '../components/primitives/MaskRise';
import { Panel } from '../components/primitives/Panel';
import { ProximityRows } from '../components/primitives/ProximityRows';
import { ScreenHead } from '../components/primitives/ScreenHead';
import { Tiered } from '../components/primitives/Tier';
import { LAYER1_CAVEAT, RUN } from '../data/facts';

const COLUMNS = [
  { key: 'TXN', w: 'w-[16%]' },
  { key: 'GRID CELL', w: 'w-[22%]' },
  { key: 'AMOUNT', w: 'w-[11%]' },
  { key: 'ARM', w: 'w-[10%]' },
  { key: 'ACTION', w: 'w-[19%]' },
  { key: 'ATT', w: 'w-[7%]' },
  { key: 'OUTCOME', w: 'w-[15%]' },
] as const;

const rupees = (paise: number): string => (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const SUMMARY = [
  { label: 'LINKS', value: RUN.transactions },
  { label: 'ATTEMPTS', value: RUN.attempts },
  { label: 'CAPTURES', value: RUN.captures },
  { label: 'DECLINES', value: RUN.failures },
  { label: 'REFUSALS', value: RUN.refusals },
] as const;

export function BatchScreen(): JSX.Element {
  const diff = RUN.recoveredTreatmentPaise - RUN.recoveredControlPaise;

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

      <div className="flex gap-3 border-b border-refuse-dim bg-refuse-wash px-4 py-3">
        <span className="eyebrow mt-px shrink-0 text-refuse">STANDING</span>
        <p className="caption max-w-4xl leading-relaxed text-refuse">{LAYER1_CAVEAT}</p>
      </div>

      <div className="grid gap-px bg-chrome p-px xl:grid-cols-[minmax(0,8fr)_minmax(0,4fr)]">
        <Panel
          label="EXHIBIT / OBSERVED RECOVERED VALUE"
          meta={
            <span className="eyebrow text-fg-ghost">
              SEED {RUN.seed} · {RUN.transactions} TRANSACTIONS
            </span>
          }
          className="border-0"
          bodyClassName="px-6 pb-6 pt-8 sm:px-10"
          index={0}
        >
          <MaskRise index={0}>
            <HeroFigure
              label="Observed recovered value"
              value={`₹${rupees(diff)}`}
              caption="treatment minus control, observed, this run only"
              provenance={[
                ['SEED', String(RUN.seed)],
                ['N', String(RUN.transactions)],
                ['ATTEMPTS', String(RUN.attempts)],
                ['SOURCE', 'RAZORPAY TEST'],
                ['ELAPSED', `${Math.round(RUN.elapsedS)}s`],
              ]}
            >
              <p className="caption max-w-2xl leading-relaxed">
                Control recovered <Fig className="text-fg-data">₹{rupees(RUN.recoveredControlPaise)}</Fig> and treatment
                recovered <Fig className="text-fg-data">₹{rupees(RUN.recoveredTreatmentPaise)}</Fig> across{' '}
                <Fig className="text-fg-data">{RUN.transactions}</Fig> real payment links and{' '}
                <Fig className="text-fg-data">{RUN.attempts}</Fig> real attempts, every outcome verified against
                Razorpay&apos;s own payment record. The difference is a census of this one run: there is no population
                to resample, so there is no interval, and the mock-bank outcome model behind each retry means the gap
                between arms reflects the configured parameters rather than incremental recovery.
              </p>
            </HeroFigure>

            <div className="mt-8">
              <Bracket tone="data" serif={18} weight={2} from={0.06} to={0.94} centre={null} animate />
              <div className="relative mt-2.5 h-10">
                <div className="absolute -translate-x-1/2 text-center" style={{ left: '6%' }}>
                  <Fig className="block text-2xs text-fg-prose">₹{rupees(RUN.recoveredControlPaise)}</Fig>
                  <span className="eyebrow">CONTROL</span>
                </div>
                <div className="absolute -translate-x-1/2 text-center" style={{ left: '94%' }}>
                  <Fig className="block text-2xs text-fg-prose">₹{rupees(RUN.recoveredTreatmentPaise)}</Fig>
                  <span className="eyebrow">TREATMENT</span>
                </div>
              </div>
            </div>
          </MaskRise>

          <BracketRule className="my-8" />

          <MaskRise index={1} className="mx-auto max-w-2xl text-center">
            <span className="eyebrow">NO INTERVAL, AND THAT IS CORRECT</span>
            <p className="caption mt-2 leading-relaxed">
              This figure carries no confidence interval because it is a census of one real run, not a sample from a
              population. There is nothing here for a bootstrap to resample, so drawing a span around it would be
              inventing uncertainty that does not exist. The mark above is the distance between two observed totals, not
              a claim about a range the truth might lie in. The interval on THE NUMBER is a different class of claim
              about a different world, and the two are never summed.
            </p>
          </MaskRise>
        </Panel>

        <div className="grid content-start gap-px bg-chrome">
          <Panel label="RUN SUMMARY" className="border-0" bodyClassName="p-0" index={1}>
            <div className="divide-y divide-chrome-soft">
              {SUMMARY.map((s, i) => (
                <MaskRise key={s.label} index={i} className="flex items-center justify-between px-4 py-2.5">
                  <span className="eyebrow">{s.label}</span>
                  <Fig className="text-fig-sm leading-none text-fg-data">{s.value}</Fig>
                </MaskRise>
              ))}
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="eyebrow">ELAPSED</span>
                <Fig className="text-xs text-fg-prose">{Math.round(RUN.elapsedS)} s</Fig>
              </div>
            </div>
          </Panel>

          <Tiered tier="tertiary">
            <Panel label="EXECUTION HEALTH" className="border-0" bodyClassName="p-4" index={2}>
              <p className="caption leading-relaxed">
                The circuit breaker counts genuine execution faults only, never declines. A payment settling as failed is
                the mock bank doing its job, not the system failing, and conflating the two once caused the breaker to
                halt a run because the experiment was working. Fixed, and separated here for the same reason.
              </p>
            </Panel>
          </Tiered>
        </div>
      </div>

      <div className="grid gap-px bg-chrome px-px pb-px">
        <Panel
          label="TRANSACTION RECORD"
          meta={<span className="eyebrow text-fg-ghost">ROWS ENTER AT THE OUTBOUND THROTTLE</span>}
          className="border-0"
          bodyClassName="p-0"
          index={3}
        >
          <ProximityRows className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div className="flex border-b border-chrome bg-ink-000 px-3 py-2">
                {COLUMNS.map((c) => (
                  <span key={c.key} className={`eyebrow ${c.w}`}>
                    {c.key}
                  </span>
                ))}
              </div>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex border-b border-chrome-soft px-3 py-2.5">
                  {COLUMNS.map((c) => (
                    <span key={c.key} className={`fig text-2xs text-fg-ghost ${c.w}`}>
                      ·
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </ProximityRows>

          <div className="px-4">
            <EmptyExhibit
              headline="Per-transaction rows not loaded"
              contains="Each row is one transaction: grid cell, amount, arm, the action the policy proposed, attempts made, and the outcome Razorpay recorded. Rows enter staggered at the real outbound throttle rate, and a guardrail refusal interrupts its row where it stands while the recovered total visibly does not move."
              acquire="npm run batch -w apps/gateway -- --count 30 --concurrency 4"
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}
