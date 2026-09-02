/**
 * A hero figure with the same interaction grammar as THE NUMBER's, so
 * hovering and expanding behave identically on every screen. An
 * interface where one screen responds and the rest are inert reads as
 * unfinished, and a viewer stops trying after the second dead element.
 *
 * Hover reveals provenance inline — which run, which method, when — and
 * click opens the figure to the rows behind it via the shared-element
 * expansion, with the figure itself becoming the header.
 */
import { useState, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Exhibit } from '../primitives/Exhibit';
import { Fig } from '../primitives/Fig';

export interface HeroFigureProps {
  value: string;
  caption: string;
  /** Label / value pairs revealed on hover. All real, all citable. */
  provenance: Array<[string, string]>;
  /** The rows behind the figure, shown when it is expanded. */
  children: ReactNode;
  label: string;
  tone?: 'data' | 'accent';
  below?: ReactNode;
}

export function HeroFigure({
  value,
  caption,
  provenance,
  children,
  label,
  tone = 'data',
  below,
}: HeroFigureProps): JSX.Element {
  const [hover, setHover] = useState(false);

  return (
    <Exhibit
      label={label}
      figure={
        <div
          className="relative flex flex-col items-center"
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
        >
          <Fig
            className={cn(
              'block text-hero font-medium leading-none',
              tone === 'accent' ? 'text-accent' : 'text-fg-data',
            )}
            style={{ letterSpacing: '-0.045em' }}
          >
            {value}
          </Fig>
          <span className="caption mt-1.5">{caption}</span>

          <div
            className={cn(
              'pointer-events-none absolute -bottom-7 z-30 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border border-chrome bg-ink-000 px-3 py-1.5 transition-opacity duration-fast',
              hover ? 'opacity-100' : 'opacity-0',
            )}
          >
            {provenance.map(([k, v]) => (
              <span key={k} className="flex items-baseline gap-1.5">
                <span className="eyebrow">{k}</span>
                <Fig className="text-2xs text-fg-data">{v}</Fig>
              </span>
            ))}
          </div>

          {below}
        </div>
      }
    >
      {children}
    </Exhibit>
  );
}
