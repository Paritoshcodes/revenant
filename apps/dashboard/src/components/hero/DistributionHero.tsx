/**
 * THE MONEY SHOT.
 *
 * A giant number sitting on its own sampling distribution, with the
 * interval bracketing it. One composition, and it carries the entire
 * argument: here is the estimate, here is every resample that produced
 * it, here is exactly which 95% of them the interval spans, and here is
 * the reference it can be checked against — all in one glance, above the
 * fold, with nothing else competing.
 *
 * The bars are the REAL bins from the same `_bootstrap_stratified` call
 * at the same seed that produced the interval (data/experiment.json).
 * The bracket endpoints land on the 2.5 and 97.5 percentile positions
 * because they ARE those percentiles, not because they were placed to
 * look right.
 *
 * SCRUBBING is the zero-abstraction promise made tangible: drag across
 * the distribution and read off the value and the proportion of
 * resamples below it. Land on either endpoint and it reads exactly 2.5%
 * or 97.5%, because that is what those endpoints mean. A viewer can
 * verify the interval by hand without leaving the page.
 */
import { useCallback, useMemo, useRef, useState } from 'react';

import { cn } from '../../lib/cn';
import { useHighlight } from '../../lib/highlight';
import { Fig } from '../primitives/Fig';

const H = 186;
const PLOT_TOP = 34;
const AXIS_Y = 156;
const BRACKET_Y = 20;

export interface DistributionHeroProps {
  point: number;
  lo: number;
  hi: number;
  reference: number;
  counts: number[];
  edges: number[];
  format: (v: number) => string;
  suffix?: string;
  unit: string;
  /** Provenance, revealed on hovering the figure. */
  provenance: { seed: number; n: number; method: string; resamples: number; computed: string };
}

export function DistributionHero({
  point,
  lo,
  hi,
  reference,
  counts,
  edges,
  format,
  suffix,
  unit,
  provenance,
}: DistributionHeroProps): JSX.Element {
  const { active } = useHighlight();
  const plot = useRef<HTMLDivElement | null>(null);
  const [scrub, setScrub] = useState<{ x: number; value: number; below: number; snapped: boolean } | null>(null);
  const [showProv, setShowProv] = useState(false);

  const min = edges[0] as number;
  const max = edges[edges.length - 1] as number;
  const peak = Math.max(...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  const at = useCallback((v: number): number => ((v - min) / (max - min)) * 100, [min, max]);

  /** Cumulative resample count up to each bin edge, so the scrub can
   * report a real proportion rather than an assumed distribution. */
  const cumulative = useMemo(() => {
    const out: number[] = [0];
    let run = 0;
    for (const c of counts) {
      run += c;
      out.push(run);
    }
    return out;
  }, [counts]);

  const proportionBelow = useCallback(
    (v: number): number => {
      if (v <= min) return 0;
      if (v >= max) return 1;
      const binW = (max - min) / counts.length;
      const idx = Math.min(counts.length - 1, Math.floor((v - min) / binW));
      const within = (v - (min + idx * binW)) / binW;
      const below = (cumulative[idx] as number) + (counts[idx] as number) * within;
      return below / total;
    },
    [cumulative, counts, min, max, total],
  );

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = plot.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      let value = min + f * (max - min);
      let below = proportionBelow(value);
      let snapped = false;
      // Within ~1% of an endpoint, snap: those two positions are the
      // percentile cuts by definition, so reporting 2.51% there would be
      // a rounding artefact reading as an inconsistency.
      for (const [endpoint, exact] of [
        [lo, 0.025],
        [hi, 0.975],
      ] as const) {
        if (Math.abs(f - at(endpoint) / 100) < 0.012) {
          value = endpoint;
          below = exact;
          snapped = true;
        }
      }
      setScrub({ x: f * 100, value, below, snapped });
    },
    [min, max, lo, hi, at, proportionBelow],
  );

  return (
    <div className="relative">
      {/* ---- The figure ------------------------------------------- */}
      <div
        className="relative z-20 flex flex-col items-center"
        onPointerEnter={() => setShowProv(true)}
        onPointerLeave={() => setShowProv(false)}
      >
        <Fig
          // Never recoloured by a highlight: the reconciliation's
          // "Difference, per transaction" is the recovered-VALUE
          // difference while this is the RATE difference, and lighting
          // this figure from that row would imply they are one number.
          className="block cursor-default text-hero font-medium leading-none text-fg-data"
          style={{ letterSpacing: '-0.045em' }}
          tabIndex={0}
        >
          {format(point)}
          {suffix ? (
            // A third of the figure, at label weight: the unit names the
            // number, it does not compete with it.
            <span className="align-baseline text-[0.32em] font-normal tracking-normal text-fg-label">{suffix}</span>
          ) : null}
        </Fig>
        <span className="caption mt-1.5">{unit}</span>

        {/* Provenance, inline on hover. Which run, which method, when. */}
        <div
          className={cn(
            'pointer-events-none absolute -bottom-7 z-30 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border border-chrome bg-ink-000 px-3 py-1.5 transition-opacity duration-fast',
            showProv || active === 'provenance' ? 'opacity-100' : 'opacity-0',
          )}
        >
          {[
            ['SEED', String(provenance.seed)],
            ['N', String(provenance.n)],
            ['METHOD', provenance.method],
            ['RESAMPLES', provenance.resamples.toLocaleString('en-IN')],
            ['COMPUTED', provenance.computed],
          ].map(([k, v]) => (
            <span key={k} className="flex items-baseline gap-1.5">
              <span className="eyebrow">{k}</span>
              <Fig className="text-2xs text-fg-data">{v}</Fig>
            </span>
          ))}
        </div>
      </div>

      {/* ---- The distribution the interval was read from ----------- */}
      <div
        ref={plot}
        className="relative mt-7 cursor-crosshair"
        style={{ height: H }}
        onPointerMove={onMove}
        onPointerLeave={() => setScrub(null)}
      >
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 100 ${H}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          {counts.map((c, i) => {
            const barH = (c / peak) * (AXIS_Y - PLOT_TOP);
            const left = edges[i] as number;
            const right = edges[i + 1] as number;
            const inside = left >= lo && right <= hi;
            const w = 100 / counts.length;
            return (
              <rect
                key={i}
                className="hist-bar"
                x={i * w + w * 0.1}
                y={AXIS_Y - barH}
                width={w * 0.8}
                height={Math.max(barH, 0.5)}
                fill={inside ? 'var(--color-accent)' : 'var(--color-chrome-hard)'}
                opacity={inside ? 0.42 : 1}
                style={{ transformBox: 'fill-box', transformOrigin: 'bottom', animationDelay: `${240 + i * 7}ms` }}
              />
            );
          })}

          <line
            x1="0"
            y1={AXIS_Y}
            x2="100"
            y2={AXIS_Y}
            className="draw"
            stroke="var(--color-chrome-hard)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />

          {/* NULL, on the distribution's own scale rather than pinned to
              an edge. Whether the span crosses it is the finding. */}
          {0 >= min && 0 <= max && (
            <line
              x1={at(0)}
              y1={PLOT_TOP - 10}
              x2={at(0)}
              y2={AXIS_Y}
              className="resolve-in"
              stroke="var(--color-chrome-hard)"
              strokeWidth="1"
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
              style={{ animationDelay: '520ms' }}
            />
          )}

          {/* REFERENCE, continuing down through the distribution. */}
          <line
            x1={at(reference)}
            y1={BRACKET_Y - 8}
            x2={at(reference)}
            y2={AXIS_Y}
            className="resolve-in"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            style={{ animationDelay: '660ms' }}
          />

          {/* THE MARK, overlaid across the distribution. Its serifs run
              the full plot height because they are cuts through the
              resamples, not decoration sitting above them. */}
          <g className="bracket-span" style={{ transformOrigin: `${at(point)}% ${BRACKET_Y}px` }}>
            <line
              x1={at(lo)}
              y1={BRACKET_Y}
              x2={at(hi)}
              y2={BRACKET_Y}
              stroke="var(--color-accent)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
            {[lo, hi].map((v) => (
              <line
                key={v}
                x1={at(v)}
                y1={BRACKET_Y}
                x2={at(v)}
                y2={AXIS_Y}
                stroke="var(--color-accent)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        </svg>

        {/* Centre mark: a point estimate, so it is rendered outside the
            stretched viewBox where a circle would draw as an ellipse. */}
        <span
          className="bracket-centre pointer-events-none absolute z-10 rounded-full"
          style={{
            left: `${at(point)}%`,
            top: BRACKET_Y,
            width: 11,
            height: 11,
            marginLeft: -5.5,
            marginTop: -5.5,
            background: 'var(--color-accent)',
          }}
          aria-hidden
        />

        {/* Endpoint readings. */}
        <Fig
          className="pointer-events-none absolute -translate-x-1/2 text-2xs text-accent"
          style={{ left: `${at(lo)}%`, top: BRACKET_Y - 20 }}
        >
          {format(lo)}
        </Fig>
        <Fig
          className="pointer-events-none absolute -translate-x-1/2 text-2xs text-accent"
          style={{ left: `${at(hi)}%`, top: BRACKET_Y - 20 }}
        >
          {format(hi)}
        </Fig>
        {0 >= min && 0 <= max && (
          <span
            className="eyebrow pointer-events-none absolute -translate-x-1/2 whitespace-nowrap text-fg-ghost"
            style={{ left: `${at(0)}%`, top: PLOT_TOP - 26 }}
          >
            NULL
          </span>
        )}
        <span
          className="eyebrow pointer-events-none absolute -translate-x-1/2 whitespace-nowrap text-accent"
          style={{ left: `${at(reference)}%`, top: AXIS_Y + 6 }}
        >
          REFERENCE {reference.toFixed(4)}
        </span>

        {/* ---- Scrub readout -------------------------------------- */}
        {scrub && (
          <>
            <div
              className="pointer-events-none absolute z-20 w-px bg-fg-data/70"
              style={{ left: `${scrub.x}%`, top: PLOT_TOP - 14, height: AXIS_Y - PLOT_TOP + 14 }}
              aria-hidden
            />
            <div
              className={cn(
                'pointer-events-none absolute z-30 -translate-x-1/2 whitespace-nowrap border bg-ink-000 px-2 py-1.5 text-center',
                scrub.snapped ? 'border-accent' : 'border-chrome-hard',
              )}
              style={{ left: `${Math.min(92, Math.max(8, scrub.x))}%`, top: AXIS_Y + 22 }}
            >
              <Fig className={cn('block text-2xs', scrub.snapped ? 'text-accent' : 'text-fg-data')}>
                {format(scrub.value)}
                {suffix}
              </Fig>
              <span className="eyebrow mt-0.5 block">
                {(scrub.below * 100).toFixed(1)}% OF RESAMPLES BELOW
              </span>
            </div>
          </>
        )}
      </div>

    </div>
  );
}
