/**
 * Cursor-proximity highlight for dense tables.
 *
 * A soft horizontal band follows the pointer down the rows. What it
 * reveals: which row the pointer is addressing, in a table too dense for
 * per-row hover borders to be readable — and it does it without moving
 * anything, which is the point. A Bloomberg-dense screen should feel
 * responsive while staying completely still.
 *
 * Implemented as ONE absolutely-positioned element driven by transform
 * and written straight to the node's style inside a rAF, never through
 * React state: a pointermove that re-renders a 30-row table is how dense
 * data starts dropping frames.
 */
import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '../../lib/cn';

export function ProximityRows({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const band = useRef<HTMLDivElement | null>(null);
  const frame = useRef<number | null>(null);
  const y = useRef(0);

  useEffect(() => {
    const el = host.current;
    const bandEl = band.current;
    if (!el || !bandEl) return undefined;

    const paint = (): void => {
      frame.current = null;
      bandEl.style.transform = `translate3d(0, ${y.current}px, 0)`;
    };

    const onMove = (e: PointerEvent): void => {
      const rect = el.getBoundingClientRect();
      y.current = e.clientY - rect.top;
      if (frame.current === null) frame.current = requestAnimationFrame(paint);
    };
    const onEnter = (): void => {
      bandEl.style.opacity = '1';
    };
    const onLeave = (): void => {
      bandEl.style.opacity = '0';
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return (
    <div ref={host} className={cn('relative', className)}>
      <div
        ref={band}
        aria-hidden
        className="proximity-band pointer-events-none absolute inset-x-0 z-0 h-16 opacity-0 transition-opacity duration-fast"
        style={{
          top: -32,
          background: 'radial-gradient(60% 100% at 50% 50%, rgb(255 255 255 / 0.045), transparent 70%)',
        }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
