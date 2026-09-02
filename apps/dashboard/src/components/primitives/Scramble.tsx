/**
 * Text scramble on value arrival.
 *
 * Any figure that changes cycles through random characters of the same
 * width, locking digit by digit left to right, before settling. What it
 * reveals: a value RESOLVING rather than appearing. In a console whose
 * whole job is provenance, "this number just became something else" is
 * information, and a crossfade states it ambiguously — a value caught
 * mid-fade looks like a value being read.
 *
 * Same-width by construction: the type is monospace with tabular
 * numerals, and the scramble pool is drawn per character class, so a
 * digit only ever scrambles through digits. Nothing around it moves.
 */
import { useEffect, useRef, useState } from 'react';

import { cn } from '../../lib/cn';
import { useReducedMotion } from '../../lib/motion';

const DIGITS = '0123456789';
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SYMBOL = '/-.:+#%';
const FRAME_MS = 28;

function poolFor(ch: string): string | null {
  if (ch === ' ') return null;
  if (ch >= '0' && ch <= '9') return DIGITS;
  if (/[a-z]/i.test(ch)) return ALPHA;
  return SYMBOL;
}

function noise(ch: string): string {
  const pool = poolFor(ch);
  if (pool === null) return ch;
  return pool[Math.floor(Math.random() * pool.length)] as string;
}

export function Scramble({
  value,
  className,
  durationMs = 240,
  /** Scramble on first paint too, not only on change. Used by figures
   * that arrive with the screen rather than updating in place. */
  onMount = false,
}: {
  value: string;
  className?: string;
  durationMs?: number;
  onMount?: boolean;
}): JSX.Element {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(() => (onMount ? value.replace(/./g, (c) => noise(c)) : value));
  const previous = useRef(onMount ? null : value);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (previous.current === value) return undefined;
    previous.current = value;

    if (reduced) {
      setShown(value);
      return undefined;
    }

    const start = performance.now();
    const run = (): void => {
      const t = Math.min(1, (performance.now() - start) / durationMs);
      if (t >= 1) {
        setShown(value);
        timer.current = null;
        return;
      }
      // Lock left to right: characters settle in reading order, so the
      // eye follows the value arriving instead of watching noise.
      const locked = Math.floor(value.length * t);
      setShown(
        value
          .split('')
          .map((ch, i) => (i < locked ? ch : noise(ch)))
          .join(''),
      );
      timer.current = window.setTimeout(run, FRAME_MS);
    };
    run();

    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [value, reduced, durationMs]);

  return <span className={cn('fig', className)}>{shown}</span>;
}
