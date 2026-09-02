/**
 * Every figure, id, hash and code in the console renders through here.
 * Tabular numerals and slashed zero are structural, not a utility class
 * a callsite can forget, so a digit never changes width while counting
 * and a column of money always aligns.
 */
import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../../lib/cn';

export function Fig({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span className={cn('fig', className)} {...rest}>
      {children}
    </span>
  );
}
