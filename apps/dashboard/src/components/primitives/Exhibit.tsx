/**
 * EXHIBIT EXPANSION — signature moment 5.
 *
 * Any figure opens to the rows behind it, and the figure ITSELF becomes
 * the header of the expanded view rather than the panel cross-fading in.
 * Implemented as a real FLIP: the trigger's rect is measured on click,
 * the overlay header renders at its final position, and the delta is
 * applied as a transform that then animates to identity. Transform and
 * opacity only, so it composites, and the trigger dims rather than
 * disappearing so the origin stays visible.
 *
 * Escape closes and returns focus to the figure that opened it, which is
 * the half of this interaction most implementations skip.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../lib/cn';
import { useReducedMotion } from '../../lib/motion';

export function Exhibit({
  /** The figure. Rendered in place, and again as the overlay header. */
  figure,
  label,
  children,
  className,
}: {
  figure: ReactNode;
  label: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const reduced = useReducedMotion();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const originRect = useRef<DOMRect | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  // FLIP: the header starts at the trigger's rect and moves to its own.
  useLayoutEffect(() => {
    if (!open || reduced) return;
    const el = headerRef.current;
    const from = originRect.current;
    if (!el || !from) return;
    const to = el.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const scale = to.width === 0 ? 1 : from.width / to.width;
    el.style.transformOrigin = 'center';
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`;
    // Force a frame so the browser registers the start state.
    void el.getBoundingClientRect();
    el.style.transition = 'transform 320ms cubic-bezier(0.16, 1, 0.3, 1)';
    el.style.transform = 'translate3d(0, 0, 0) scale(1)';
  }, [open, reduced]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-label={`${label} — open underlying rows`}
        onClick={(e) => {
          originRect.current = (e.currentTarget.firstElementChild ?? e.currentTarget).getBoundingClientRect();
          setOpen(true);
        }}
        className={cn(
          'group block w-full cursor-pointer text-left transition-opacity duration-fast',
          open && 'opacity-25',
          className,
        )}
      >
        {figure}
      </button>

      {open &&
        // PORTALLED to the body on purpose: Panel keeps a clip-path
        // after its reveal wipe, and a clip-path on any ancestor clips
        // fixed-position descendants. Rendered in place, this overlay
        // was being cropped to the panel and looked like a dead click.
        createPortal(
        <div
          className="fixed inset-0 z-[60] flex flex-col bg-ink-000/92"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onClick={close}
        >
          <div
            className="mx-auto flex h-full w-full max-w-5xl flex-col px-6 py-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-6 border-b border-chrome pb-5">
              <div ref={headerRef} className="min-w-0">
                {figure}
              </div>
              <button
                type="button"
                onClick={close}
                className="eyebrow shrink-0 border border-chrome px-2 py-1 text-fg-label transition-colors duration-fast hover:text-fg-data"
              >
                ESC TO CLOSE
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pt-5">{children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
