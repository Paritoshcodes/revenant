/**
 * THE MARK.
 *
 *      ⊢———————●———————⊣
 *
 * An interval: a span with two endpoints and a centre. This product is
 * about a number that carries its uncertainty, and uncertainty has a
 * shape. Every competitor reports a point and hides the span; making the
 * span the identity is both ownable and literally true of the thing.
 *
 * One primitive, five jobs, so the mark is learned once and then
 * recognised everywhere:
 *   wordmark        spans REVENANT
 *   loader          draws outward from the centre while anything computes
 *   nav indicator   brackets the current screen instead of underlining it
 *   section rule    separates panels instead of a plain hairline
 *   hero            the interval itself, at full width, around the figure
 *
 * Drawn, never typed: an SVG so the endpoints stay crisp hairlines at
 * any width and so the span can draw itself from the centre outward.
 */
import { cn } from '../../lib/cn';

export interface BracketProps {
  /** Where the centre mark sits along the span, 0..1. Defaults to the
   * middle; the hero passes the point estimate's real position, which is
   * usually NOT the middle of its own interval. */
  centre?: number | null;
  /** Fraction of the full width the span occupies, 0..1, anchored by
   * `insetFrom`. The hero uses this to place a real interval on a real
   * scale; every other use spans the whole width. */
  from?: number;
  to?: number;
  tone?: 'accent' | 'chrome' | 'data' | 'refuse';
  /** Height of the end serifs, px. */
  serif?: number;
  /** Draw outward from the centre on mount. */
  animate?: boolean;
  className?: string;
  /** Stroke weight, px. */
  weight?: number;
}

const TONE: Record<NonNullable<BracketProps['tone']>, string> = {
  accent: 'var(--color-accent)',
  chrome: 'var(--color-chrome-hard)',
  data: 'var(--color-fg-data)',
  refuse: 'var(--color-refuse)',
};

export function Bracket({
  centre = 0.5,
  from = 0,
  to = 1,
  tone = 'chrome',
  serif = 7,
  animate = false,
  weight = 1,
  className,
}: BracketProps): JSX.Element {
  const stroke = TONE[tone];
  const h = serif * 2 + 2;
  const mid = h / 2;
  const dot = Math.max(5, serif * 0.72);
  const x1 = from * 100;
  const x2 = to * 100;

  const centreX = centre === null ? null : x1 + (x2 - x1) * centre;

  return (
    <span className={cn('relative block w-full', className)} style={{ height: h }} aria-hidden>
    <svg
      className="block w-full overflow-visible"
      style={{ height: h }}
      viewBox={`0 0 100 ${h}`}
      preserveAspectRatio="none"
    >
      {/* The span. Scales from the centre outward, which is what makes
          this read as an interval being established rather than a line
          being drawn left to right. */}
      <g
        className={animate ? 'bracket-span' : undefined}
        style={{ transformOrigin: `${(x1 + x2) / 2}% ${mid}px` }}
      >
        <line
          x1={x1}
          y1={mid}
          x2={x2}
          y2={mid}
          stroke={stroke}
          strokeWidth={weight}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={x1}
          y1={mid - serif}
          x2={x1}
          y2={mid + serif}
          stroke={stroke}
          strokeWidth={weight}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={x2}
          y1={mid - serif}
          x2={x2}
          y2={mid + serif}
          stroke={stroke}
          strokeWidth={weight}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
      {/* The centre mark is a POINT estimate, so it is rendered outside
          the stretched viewBox: a <circle> in a preserveAspectRatio="none"
          SVG draws as an ellipse, which would make the mark misreport
          the shape of the thing it stands for. */}
      {centreX !== null && (
        <span
          className={cn('absolute rounded-full', animate && 'bracket-centre')}
          style={{
            left: `${centreX}%`,
            top: mid,
            width: dot,
            height: dot,
            marginLeft: -dot / 2,
            marginTop: -dot / 2,
            background: stroke,
          }}
        />
      )}
    </span>
  );
}

/**
 * The section rule. Panels are separated by the mark rather than by a
 * plain hairline, so the identity is present in the page's structure and
 * not only in its headline.
 */
export function BracketRule({ className }: { className?: string }): JSX.Element {
  return (
    <div className={cn('px-4 py-1', className)}>
      <Bracket tone="chrome" serif={4} centre={0.5} />
    </div>
  );
}
