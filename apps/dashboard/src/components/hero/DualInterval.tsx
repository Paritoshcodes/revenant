/**
 * THE DISAGREEMENT, rendered so it is seen before it is read.
 *
 * Two estimates from the same run, on one shared axis, normalised to
 * each one's own scale so their spans are comparable: the rate
 * difference clearing zero, and the protocol's stated PRIMARY estimate
 * straddling it. The zero line runs through both.
 *
 * This is the most persuasive thing in the submission, and the reason is
 * not statistical: nobody fabricates a result that undercuts their own
 * headline. So it is given a real composition rather than a paragraph,
 * and the verdict on this screen follows the one that does NOT flatter.
 */
import { cn } from '../../lib/cn';
import { Fig } from '../primitives/Fig';

export interface IntervalRow {
  label: string;
  note: string;
  point: number;
  lo: number;
  hi: number;
  format: (v: number) => string;
  /** True when this is the estimate the protocol nominates as primary. */
  primary: boolean;
}

/** Each row is normalised to its OWN symmetric domain around zero, so
 * two quantities in different units (percentage points and paise) can be
 * compared by shape without ever implying they share a scale. Stated
 * explicitly under the figure, because a shared axis that is not really
 * shared would be exactly the sort of quiet dishonesty this console is
 * arguing against. */
function domainFor(r: IntervalRow): [number, number] {
  const reach = Math.max(Math.abs(r.lo), Math.abs(r.hi), Math.abs(r.point)) * 1.15;
  return [-reach, reach];
}

export function DualInterval({ rows, className }: { rows: IntervalRow[]; className?: string }): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-7', className)}>
      {rows.map((r) => {
        const [min, max] = domainFor(r);
        const at = (v: number): number => ((v - min) / (max - min)) * 100;
        const clearsZero = r.lo > 0 || r.hi < 0;
        const tone = clearsZero ? 'var(--color-accent)' : 'var(--color-refuse)';

        return (
          <div key={r.label} className="relative">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="flex items-baseline gap-2.5">
                <span className="eyebrow">{r.label}</span>
                {r.primary && (
                  <span className="eyebrow border border-chrome-hard px-1.5 py-px text-fg-data">PRIMARY</span>
                )}
              </div>
              <span className={cn('caption', clearsZero ? 'text-accent' : 'text-refuse')}>
                {clearsZero ? 'clears zero' : 'straddles zero'}
              </span>
            </div>

            <div className="relative h-11">
              <svg
                className="absolute inset-0 h-full w-full overflow-visible"
                viewBox="0 0 100 44"
                preserveAspectRatio="none"
                aria-hidden
              >
                <line
                  x1="0"
                  y1="30"
                  x2="100"
                  y2="30"
                  stroke="var(--color-chrome)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
                {/* Zero, through both rows. */}
                <line
                  x1={at(0)}
                  y1="0"
                  x2={at(0)}
                  y2="44"
                  stroke="var(--color-fg-label)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
                <g className="bracket-span" style={{ transformOrigin: `${at(r.point)}% 16px` }}>
                  <line
                    x1={at(r.lo)}
                    y1="16"
                    x2={at(r.hi)}
                    y2="16"
                    stroke={tone}
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                  {[r.lo, r.hi].map((v) => (
                    <line
                      key={v}
                      x1={at(v)}
                      y1="6"
                      x2={at(v)}
                      y2="26"
                      stroke={tone}
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </g>
              </svg>

              <span
                className="absolute rounded-full"
                style={{
                  left: `${at(r.point)}%`,
                  top: 16,
                  width: 9,
                  height: 9,
                  marginLeft: -4.5,
                  marginTop: -4.5,
                  background: tone,
                }}
                aria-hidden
              />

              <Fig className="absolute -translate-x-1/2 text-2xs" style={{ left: `${at(r.lo)}%`, top: 30, color: tone }}>
                {r.format(r.lo)}
              </Fig>
              <Fig className="absolute -translate-x-1/2 text-2xs" style={{ left: `${at(r.hi)}%`, top: 30, color: tone }}>
                {r.format(r.hi)}
              </Fig>
              <span
                className="eyebrow absolute -translate-x-1/2 text-fg-label"
                style={{ left: `${at(0)}%`, top: 30 }}
              >
                0
              </span>
            </div>

            <p className="caption mt-5 leading-relaxed">{r.note}</p>
          </div>
        );
      })}

      <p className="caption border-t border-chrome-soft pt-4 leading-relaxed">
        Each row is drawn on its own symmetric scale around zero, because the two estimates are in different units and a
        genuinely shared axis would be meaningless. What is comparable is the shape: whether the span crosses the line.
        The verdict follows the row marked PRIMARY, which is the one the frozen protocol nominates — not the one that
        happens to look better.
      </p>
    </div>
  );
}
