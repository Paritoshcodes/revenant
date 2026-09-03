/**
 * The disagreement, compressed to sit beside the verdict.
 *
 * The full panel below carries the detail; this exists because the
 * contradiction is the strongest fact in the submission and it cannot be
 * below the fold. A first-viewport viewer must see that one interval
 * clears zero and the other straddles it BEFORE reading a word about it.
 *
 * Deliberately small: two 10px-tall tracks, sized to explain the verdict
 * rather than to compete with the hero figure. Each row is normalised to
 * its own symmetric domain around zero — the two estimates are in
 * different units, so a genuinely shared axis would be meaningless, and
 * only the SHAPE is comparable. The zero line is the one thing that is
 * literally shared, and it runs through both.
 */
import { Fig } from '../primitives/Fig';
import { cn } from '../../lib/cn';

export interface MiniRow {
  label: string;
  point: number;
  lo: number;
  hi: number;
  primary: boolean;
}

export function MiniDisagreement({ rows, className }: { rows: MiniRow[]; className?: string }): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {rows.map((r) => {
        const reach = Math.max(Math.abs(r.lo), Math.abs(r.hi), Math.abs(r.point)) * 1.12;
        const at = (v: number): number => ((v + reach) / (2 * reach)) * 100;
        const clears = r.lo > 0 || r.hi < 0;
        const tone = clears ? 'var(--color-accent)' : 'var(--color-refuse)';

        return (
          <div key={r.label} className="flex items-center gap-3">
            <span className="w-[5.5rem] shrink-0 text-right">
              <span className="eyebrow">{r.label}</span>
            </span>

            <span className="relative h-[18px] flex-1">
              <svg
                className="absolute inset-0 h-full w-full overflow-visible"
                viewBox="0 0 100 18"
                preserveAspectRatio="none"
                aria-hidden
              >
                <line
                  x1={at(0)}
                  y1="0"
                  x2={at(0)}
                  y2="18"
                  stroke="var(--color-fg-label)"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                  vectorEffect="non-scaling-stroke"
                />
                <g className="bracket-span" style={{ transformOrigin: `${at(r.point)}% 9px` }}>
                  <line
                    x1={at(r.lo)}
                    y1="9"
                    x2={at(r.hi)}
                    y2="9"
                    stroke={tone}
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                  {[r.lo, r.hi].map((v) => (
                    <line
                      key={v}
                      x1={at(v)}
                      y1="3"
                      x2={at(v)}
                      y2="15"
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
                  top: 9,
                  width: 6,
                  height: 6,
                  marginLeft: -3,
                  marginTop: -3,
                  background: tone,
                }}
                aria-hidden
              />
            </span>

            <span className="flex w-[9.5rem] shrink-0 items-baseline gap-1.5">
              <span className={cn('eyebrow', clears ? 'text-accent' : 'text-refuse')}>
                {clears ? 'CLEARS 0' : 'STRADDLES 0'}
              </span>
              {r.primary && (
                <span className="eyebrow border border-chrome-hard px-1 py-px text-fg-data">PRIMARY</span>
              )}
            </span>
          </div>
        );
      })}
      <p className="caption mt-0.5 leading-snug">
        Two estimates from the same run. The verdict follows the one the frozen protocol nominates as{' '}
        <Fig className="text-fg-data">PRIMARY</Fig>, not the one that looks better.
      </p>
    </div>
  );
}
