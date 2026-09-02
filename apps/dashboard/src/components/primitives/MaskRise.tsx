/**
 * Prose and list rows rise into place behind a mask, 40ms apart.
 *
 * What it reveals: reading order. A block that rises in sequence tells
 * the eye where to start, which in a dense console is worth more than
 * it costs. First paint only — a CSS animation restarts on remount and
 * never on re-render, so this is once per screen visit by construction
 * rather than by a guard someone has to remember.
 */
import type { ElementType, ReactNode } from 'react';

import { cn } from '../../lib/cn';

export function MaskRise({
  index = 0,
  as,
  className,
  children,
}: {
  index?: number;
  as?: ElementType;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag className={cn('mask-rise', className)} style={{ '--rise-index': index } as React.CSSProperties}>
      {children}
    </Tag>
  );
}
