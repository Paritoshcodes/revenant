/**
 * The console's only container. A hairline-bordered rack face with an
 * eyebrow strip. Two material details do the work: a one-pixel top
 * highlight at 4% white so it reads as raised rather than drawn, and a
 * clip-path wipe on first paint so it reads as an instrument drawing its
 * own face rather than a webpage fading in.
 */
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export function Panel({
  label,
  meta,
  children,
  className,
  bodyClassName,
  /** Staggers the wipe across a screen's panels, in source order. */
  index = 0,
}: {
  label: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  index?: number;
}): JSX.Element {
  return (
    <section
      className={cn('panel-wipe raised border border-chrome bg-ink-050', className)}
      style={{ '--panel-index': index } as React.CSSProperties}
    >
      <header className="flex h-8 items-center justify-between gap-3 border-b border-chrome-soft bg-ink-100 px-3">
        <h2 className="eyebrow">{label}</h2>
        {meta ? <div className="flex items-center gap-2">{meta}</div> : null}
      </header>
      <div className={cn(bodyClassName ?? 'p-3')}>{children}</div>
    </section>
  );
}
