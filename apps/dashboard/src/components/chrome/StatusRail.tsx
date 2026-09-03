/**
 * SIGNATURE MOMENT 2 — the persistent status rail.
 *
 * This is what makes the page read as an instrument rather than a
 * website. Fixed, always visible, and it answers, at a glance and at all
 * times: what am I looking at, and how much should I trust it.
 *
 *   CLASS      which evidence class the current screen's figures belong to
 *   SEED       the seed of the run under examination — reproducibility
 *   REFERENCE  the frozen true lift, and that it predates every run
 *   CUSTODY    chain state: N links, unbroken or broken at a named seq
 *   SOURCE     live or precomputed, and from where
 *
 * Values TICK rather than fade (see Ticker) so a change is legible as a
 * change. Nothing here moves on its own.
 */
import { CUSTODY, REFERENCE } from '../../data/facts';
import { cn } from '../../lib/cn';
import { SCREEN_META, type ScreenId } from '../../lib/route';
import { ClassChip } from '../primitives/ClassChip';
import { Fig } from '../primitives/Fig';
import { Scramble } from '../primitives/Scramble';

function Cell({
  label,
  children,
  note,
  className,
}: {
  label: string;
  children: React.ReactNode;
  note?: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-col justify-center gap-1 border-r border-chrome px-3 py-2', className)}>
      <span className="eyebrow">{label}</span>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <div className="min-w-0 truncate text-sm text-fg-data">{children}</div>
        {note ? <span className="eyebrow shrink-0 text-fg-ghost">{note}</span> : null}
      </div>
    </div>
  );
}

export function StatusRail({ screen }: { screen: ScreenId }): JSX.Element {
  const meta = SCREEN_META[screen];

  return (
    <div className="grid h-(--h-rail) shrink-0 grid-cols-2 border-b border-chrome bg-ink-050 md:grid-cols-4 xl:grid-cols-5">
      <Cell label="CLASS">
        <ClassChip cls={meta.cls} />
      </Cell>

      <Cell label={meta.railLabel} note={meta.railLabel === 'HEAD SEQ' ? 'APPEND ONLY' : 'REPRODUCIBLE'}>
        <Scramble value={meta.railValue} className="text-fg-data" />
      </Cell>

      <Cell label="REFERENCE" note={`FROZEN ${REFERENCE.committed.slice(5)}`} className="hidden md:flex">
        <Fig className="text-accent">{REFERENCE.trueLiftPp.toFixed(4)}pp</Fig>
      </Cell>

      <Cell label="CUSTODY" className="hidden md:flex">
        <span className="inline-flex items-center gap-2">
          <Scramble value={String(CUSTODY.links)} className="text-fg-data" />
          <span className="eyebrow text-fg-label">LINKS</span>
          <span
            aria-hidden
            className={cn('h-[7px] w-[7px]', CUSTODY.verified ? 'bg-fg-data' : 'bg-fault')}
          />
          <span className={cn('eyebrow', CUSTODY.verified ? 'text-fg-label' : 'text-fault')}>
            {CUSTODY.verified ? 'UNBROKEN' : 'BROKEN'}
          </span>
        </span>
      </Cell>

      <Cell label="SOURCE" className="hidden border-r-0 xl:flex">
        <Scramble value={meta.source} className="text-fg-prose" />
      </Cell>
    </div>
  );
}
