/**
 * Cross-panel highlight coordination.
 *
 * Hovering a reconciliation row lights the element in the hero that the
 * row actually feeds, so a viewer can see which part of the composition
 * a number is responsible for. This is the zero-abstraction promise
 * working in the other direction: not only "open the figure to its
 * rows", but "show me which figure this row produced".
 *
 * Deliberately a small fixed vocabulary rather than arbitrary ids — a
 * highlight target has to correspond to something really on screen, and
 * a typo that silently highlights nothing is worse than no highlighting.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type HighlightKey = 'point' | 'interval' | 'control' | 'treatment' | 'provenance' | null;

interface HighlightState {
  active: HighlightKey;
  set: (k: HighlightKey) => void;
}

const Ctx = createContext<HighlightState>({ active: null, set: () => {} });

export function HighlightProvider({ children }: { children: ReactNode }): JSX.Element {
  const [active, set] = useState<HighlightKey>(null);
  const value = useMemo(() => ({ active, set }), [active]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHighlight(): HighlightState {
  return useContext(Ctx);
}

/** Props that make any element a highlight source on hover and focus. */
export function highlightProps(key: Exclude<HighlightKey, null>, set: (k: HighlightKey) => void) {
  return {
    onPointerEnter: () => set(key),
    onPointerLeave: () => set(null),
    onFocus: () => set(key),
    onBlur: () => set(null),
  };
}
