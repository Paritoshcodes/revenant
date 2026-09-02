/**
 * The wordmark: REVENANT inside a bracket that spans it. The mark is
 * drawn, never typed, so the endpoints are true hairlines and the span
 * measures the word rather than approximating it with characters.
 */
import { cn } from '../../lib/cn';
import { Bracket } from './Bracket';

export function Wordmark({
  size = 'sm',
  animate = false,
  className,
}: {
  size?: 'sm' | 'lg';
  animate?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <span className={cn('inline-flex flex-col justify-center', className)}>
      <Bracket tone="chrome" serif={size === 'lg' ? 5 : 3.5} centre={null} animate={animate} />
      <span
        className={cn(
          'fig text-center font-bold leading-none text-fg-data',
          size === 'lg' ? 'my-1.5 text-lg tracking-[0.34em]' : 'my-1 text-xs tracking-[0.24em]',
        )}
      >
        REVENANT
      </span>
      <Bracket tone="chrome" serif={size === 'lg' ? 5 : 3.5} centre={null} animate={animate} />
    </span>
  );
}

/**
 * The loading state, everywhere. No spinners in this app: a spinner says
 * "time is passing", the mark says "an interval is being established",
 * which is what is actually happening whenever this console computes.
 */
export function BracketLoader({ label, className }: { label?: string; className?: string }): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center gap-2', className)} role="status" aria-live="polite">
      <div className="w-full max-w-xs">
        <Bracket tone="data" serif={6} animate />
      </div>
      {label ? <span className="eyebrow">{label}</span> : <span className="sr-only">Computing…</span>}
    </div>
  );
}
