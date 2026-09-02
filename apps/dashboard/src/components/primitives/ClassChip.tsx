/**
 * Evidence class, per CLAUDE.md hard rule 6: no recovery figure is ever
 * reported without it, and the two classes are never summed.
 *
 * Separated by SURFACE, not hue — see tokens.css rule 2. OBSERVED is a
 * solid fill: it happened, there is a Razorpay payment id for it.
 * ESTIMATED is hatched: it is derived from a model, and a hatch cannot
 * be mistaken for a fill at any size or by a viewer who sees no colour.
 * Neither uses the accent, which belongs to recovered value alone.
 */
import { cn } from '../../lib/cn';

export type EvidenceClass = 'OBSERVED' | 'ESTIMATED' | 'RECORD';

export function ClassChip({ cls, className }: { cls: EvidenceClass; className?: string }): JSX.Element {
  const base =
    'inline-flex items-center gap-1.5 border px-1.5 py-[3px] text-micro uppercase tracking-[0.14em] font-mono leading-none';

  if (cls === 'OBSERVED') {
    return (
      <span className={cn(base, 'solidfill border-chrome-hard text-fg-data', className)} title="Layer 1: real Razorpay outcomes">
        <span aria-hidden className="h-[6px] w-[6px] bg-fg-data" />
        OBSERVED
      </span>
    );
  }
  if (cls === 'ESTIMATED') {
    return (
      <span className={cn(base, 'hatch border-chrome-hard text-fg-prose', className)} title="Layer 2: synthetic, modelled">
        <span aria-hidden className="h-[6px] w-[6px] border border-fg-label" />
        ESTIMATED
      </span>
    );
  }
  return (
    <span className={cn(base, 'border-chrome text-fg-label', className)} title="The record itself, not a recovery figure">
      <span aria-hidden className="h-[6px] w-[6px] border border-fg-ghost" />
      RECORD
    </span>
  );
}
