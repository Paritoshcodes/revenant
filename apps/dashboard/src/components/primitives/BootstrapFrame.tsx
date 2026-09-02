/**
 * The resample distribution the interval was actually read off.
 *
 * Not a re-derived bell curve: these are the real counts from the same
 * `_bootstrap_stratified` call, at the same seed, that produced the
 * interval in the hero above. The 2.5 and 97.5 percentile lines are
 * drawn where that interval's own endpoints fall, so a viewer can see
 * that the bracket IS these two cuts.
 *
 * Bars grow via scaleY from the baseline — transform only, never height
 * — and land left to right so the shape assembles the way the resamples
 * did rather than appearing whole.
 */
import { EXPERIMENT } from '../../data/experiment';
import { cn } from '../../lib/cn';
import { Fig } from './Fig';

const H = 132;
const PLOT_TOP = 12;
const AXIS_Y = 106;

export function BootstrapFrame({
  lo,
  hi,
  reference,
  className,
}: {
  lo: number;
  hi: number;
  reference: number;
  className?: string;
}): JSX.Element {
  const { counts, edges } = EXPERIMENT.histogram;
  const min = edges[0] as number;
  const max = edges[edges.length - 1] as number;
  const peak = Math.max(...counts);
  const at = (v: number): number => ((v - min) / (max - min)) * 100;
  const barW = 100 / counts.length;

  const ticks = [0, 3, 6, 9].filter((t) => t >= min && t <= max);

  return (
    <div className={cn('select-none', className)}>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <span className="eyebrow">RESAMPLE DISTRIBUTION</span>
        <span className="eyebrow text-fg-ghost">
          {EXPERIMENT.resamples.toLocaleString('en-US')} RESAMPLES · PERCENTILE METHOD
        </span>
      </div>

      <div className="relative mx-4" style={{ height: H }}>
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 100 ${H}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          {counts.map((c, i) => {
            const barH = (c / peak) * (AXIS_Y - PLOT_TOP);
            const inside = (edges[i] as number) >= lo && (edges[i + 1] as number) <= hi;
            return (
              <rect
                key={i}
                className="hist-bar"
                x={i * barW + barW * 0.14}
                y={AXIS_Y - barH}
                width={barW * 0.72}
                height={Math.max(barH, 0.5)}
                fill={inside ? 'var(--color-accent)' : 'var(--color-chrome-hard)'}
                opacity={inside ? 0.55 : 1}
                style={{
                  transformBox: 'fill-box',
                  transformOrigin: 'bottom',
                  animationDelay: `${260 + i * 7}ms`,
                }}
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

          {/* The percentile cuts. These ARE the hero bracket's endpoints. */}
          {[lo, hi].map((v, i) => (
            <line
              key={v}
              x1={at(v)}
              y1={PLOT_TOP - 6}
              x2={at(v)}
              y2={AXIS_Y}
              className="resolve-in"
              stroke="var(--color-accent)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              style={{ animationDelay: `${700 + i * 90}ms` }}
            />
          ))}

          <line
            x1={at(reference)}
            y1={PLOT_TOP - 6}
            x2={at(reference)}
            y2={AXIS_Y}
            className="resolve-in"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
            style={{ animationDelay: '880ms' }}
          />
        </svg>

        <span
          className="eyebrow absolute -translate-x-1/2 whitespace-nowrap text-accent"
          style={{ left: `${at(lo)}%`, top: -6 }}
        >
          2.5%
        </span>
        <span
          className="eyebrow absolute -translate-x-1/2 whitespace-nowrap text-accent"
          style={{ left: `${at(hi)}%`, top: -6 }}
        >
          97.5%
        </span>

        {ticks.map((t) => (
          <Fig
            key={t}
            className="absolute -translate-x-1/2 text-micro text-fg-ghost"
            style={{ left: `${at(t)}%`, top: AXIS_Y + 6 }}
          >
            {t > 0 ? `+${t}` : String(t)}
          </Fig>
        ))}
      </div>

      <p className="caption mt-7 leading-relaxed">
        Every resample draws within its own <span className="text-fg-prose">(grid cell, amount band)</span> stratum, so
        each of the {EXPERIMENT.resamples.toLocaleString('en-US')} preserves the per-cell balance the real assignment
        guarantees. The lit bars are the 95% of the distribution the interval spans; the two cuts above are its
        endpoints, and they are the same two numbers the bracket carries.
      </p>
    </div>
  );
}
