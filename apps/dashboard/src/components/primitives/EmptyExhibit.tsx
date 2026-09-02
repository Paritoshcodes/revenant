/**
 * The console's empty state. Not "nothing here yet" — this is a forensic
 * instrument, so an empty state shows THE APPARATUS WITH NO SAMPLE
 * LOADED: what the exhibit will contain, and the exact command that
 * acquires it. A viewer learns the shape of the evidence before any
 * evidence exists.
 */
import { cn } from '../../lib/cn';

export function EmptyExhibit({
  headline = 'No exhibit loaded',
  contains,
  acquire,
  className,
}: {
  headline?: string;
  /** What this exhibit will hold, in the system's own terms. */
  contains: string;
  /** The literal command or endpoint that produces it. */
  acquire: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-3 py-5', className)}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-[7px] w-[7px] border border-fg-ghost" />
        <span className="text-sm text-fg-prose">{headline}</span>
      </div>
      <p className="caption max-w-2xl leading-relaxed">{contains}</p>
      <div className="flex w-fit items-center gap-2 border border-chrome bg-ink-000 px-2.5 py-1.5">
        <span className="fig text-2xs text-fg-ghost">$</span>
        <span className="fig text-2xs text-fg-prose">{acquire}</span>
      </div>
    </div>
  );
}
