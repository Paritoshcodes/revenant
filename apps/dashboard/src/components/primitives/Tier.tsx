/**
 * Visibility tiers. `v` cycles EVERYTHING -> ESSENTIAL -> FIGURE ONLY,
 * which is the brief's "show me everything ... just the number" and
 * back. A tier is a claim about how load-bearing a panel is to the
 * argument, so the cycle strips supporting evidence before it strips the
 * finding, never the reverse.
 */
import type { ReactNode } from 'react';

import { useConsole } from '../../lib/console-state';

export type Tier = 'primary' | 'secondary' | 'tertiary';

export function Tiered({ tier, children }: { tier: Tier; children: ReactNode }): JSX.Element | null {
  const { visibility } = useConsole();
  if (visibility === 'figure' && tier !== 'primary') return null;
  if (visibility === 'essential' && tier === 'tertiary') return null;
  return <>{children}</>;
}
