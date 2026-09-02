/**
 * THE HERO. The one composition this project is screenshotted by.
 *
 * The point estimate at display scale, near-white and tabular. The
 * interval bracket around it at full width in the accent, positioned on
 * a real scale so the span is measured, not decorative. The REFERENCE
 * cutting vertically through the whole composition, because the entire
 * argument is that this number can be checked against a known answer.
 * The verdict directly beneath, at display size.
 *
 * Everything else on the screen is smaller by an order of magnitude, and
 * that is enforced by the type scale itself: nothing lives between 15px
 * and 28px, so this cannot be crowded by a mid-sized neighbour.
 *
 * The order the pieces arrive in is the order of the argument: the point
 * estimate lands, then the span that qualifies it opens outward from it,
 * then the verdict resolves. The verdict must never precede the evidence
 * it rests on.
 */
import { Bracket } from '../identity/Bracket';
import { cn } from '../../lib/cn';
import { Fig } from './Fig';

export interface IntervalHeroProps {
  point: number;
  lo: number;
  hi: number;
  reference: number;
  /** Rendered under the figure, e.g. "percentage points, treatment minus control". */
  unit: string;
  format: (v: number) => string;
  suffix?: string;
}

export function IntervalHero({ point, lo, hi, reference, unit, format, suffix }: IntervalHeroProps): JSX.Element {
  // Domain: always contains zero, the whole interval, and the reference,
  // with breathing room. Computed rather than fixed so the composition
  // stays honest if the numbers change.
  const lows = [0, lo, reference, point];
  const highs = [0, hi, reference, point];
  const rawMin = Math.min(...lows);
  const rawMax = Math.max(...highs);
  const pad = (rawMax - rawMin) * 0.08 || 1;
  const min = rawMin - pad;
  const max = rawMax + pad;
  const at = (v: number): number => (v - min) / (max - min);

  const refPct = at(reference) * 100;
  const zeroPct = at(0) * 100;

  return (
    <div className="relative">
      {/* REFERENCE, cutting through everything. Drawn behind the figure
          so the number stays legible where they cross. */}
      <div
        className="pointer-events-none absolute inset-y-0 z-0 w-px bg-accent/45"
        style={{ left: `${refPct}%` }}
        aria-hidden
      />
      {/* NULL. A boundary, not a value, so it is dashed and quiet — but
          present, because whether the span crosses it is the finding. */}
      <div
        className="pointer-events-none absolute inset-y-0 z-0 w-px"
        style={{
          left: `${zeroPct}%`,
          backgroundImage:
            'repeating-linear-gradient(to bottom, var(--color-chrome-hard) 0 3px, transparent 3px 7px)',
        }}
        aria-hidden
      />

      <div className="relative z-10 flex flex-col items-center pt-2">
        <Fig className="block text-hero font-medium text-fg-data" style={{ letterSpacing: '-0.045em' }}>
          {format(point)}
          {suffix ? <span className="text-fig-lg text-fg-prose">{suffix}</span> : null}
        </Fig>
        <span className="caption mt-1">{unit}</span>
      </div>

      {/* The mark, carrying the real interval on the real scale. */}
      <div className="relative z-10 mt-6">
        <Bracket
          tone="accent"
          serif={18}
          weight={2}
          from={at(lo)}
          to={at(hi)}
          centre={(point - lo) / (hi - lo)}
          animate
        />
        <div className="relative mt-2.5 h-4">
          <Fig
            className="absolute -translate-x-1/2 text-2xs text-accent"
            style={{ left: `${at(lo) * 100}%` }}
          >
            {format(lo)}
          </Fig>
          <Fig
            className="absolute -translate-x-1/2 text-2xs text-accent"
            style={{ left: `${at(hi) * 100}%` }}
          >
            {format(hi)}
          </Fig>
          <span
            className="eyebrow absolute -translate-x-1/2 whitespace-nowrap text-fg-ghost"
            style={{ left: `${zeroPct}%` }}
          >
            NULL
          </span>
        </div>
      </div>

      {/* The reference, labelled at its own position on the same scale. */}
      <div className="relative z-10 mt-1 h-8">
        <div
          className="absolute flex -translate-x-1/2 flex-col items-center gap-1"
          style={{ left: `${refPct}%` }}
        >
          <span className="eyebrow whitespace-nowrap text-accent">REFERENCE</span>
          <Fig className="whitespace-nowrap text-2xs text-accent">{reference.toFixed(4)}</Fig>
        </div>
      </div>
    </div>
  );
}

/**
 * The verdict, at display size, directly beneath the hero. A null result
 * gets the same size, weight and position as a positive one — the system
 * being able to report that it found nothing is the product, so shrinking
 * or greying it would undo the argument.
 */
export function VerdictLine({
  text,
  basis,
  className,
}: {
  text: string;
  basis: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center gap-2 text-center', className)}>
      <span className="eyebrow">VERDICT</span>
      <span className="text-verdict font-semibold tracking-[-0.02em] text-fg-data">{text}</span>
      <span className="caption max-w-md">Because {basis}.</span>
    </div>
  );
}
