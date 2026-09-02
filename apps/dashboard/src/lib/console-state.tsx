/**
 * Console state: visibility mode, the j/k row cursor, the legend, and
 * the single global keyboard handler that drives all of them.
 *
 * One handler rather than per-component listeners, because the console
 * is keyboard-first: a key must do the same thing regardless of what
 * happens to hold DOM focus, and there must be exactly one place that
 * answers "what does `v` do".
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { SCREENS, SCREEN_META, type ScreenId } from './route';

/** Three states, cycled with `v`. Named for what a viewer is asking to
 * see, not for a widget count. */
export type Visibility = 'everything' | 'essential' | 'figure';

export const VISIBILITY_ORDER: Visibility[] = ['everything', 'essential', 'figure'];

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  everything: 'EVERYTHING',
  essential: 'ESSENTIAL',
  figure: 'FIGURE ONLY',
};

const VIS_KEY = 'revenant.console.visibility';

interface ConsoleState {
  visibility: Visibility;
  cycleVisibility: () => void;
  legendOpen: boolean;
  setLegendOpen: (open: boolean) => void;
  /** Index of the j/k cursor within the current screen's rows, or -1. */
  cursor: number;
  setCursor: (n: number) => void;
  /** Screens declare how many rows they have; the handler clamps to it. */
  registerRows: (n: number) => void;
  rowCount: number;
  /** Set by a screen that has an openable exhibit under the cursor. */
  onEnter: (() => void) | null;
  setOnEnter: (fn: (() => void) | null) => void;
  onEscape: (() => void) | null;
  setOnEscape: (fn: (() => void) | null) => void;
}

const Ctx = createContext<ConsoleState | null>(null);

export function ConsoleProvider({
  children,
  navigate,
}: {
  children: ReactNode;
  navigate: (id: ScreenId) => void;
}): JSX.Element {
  const [visibility, setVisibility] = useState<Visibility>(() => {
    try {
      const raw = localStorage.getItem(VIS_KEY);
      return raw && VISIBILITY_ORDER.includes(raw as Visibility) ? (raw as Visibility) : 'everything';
    } catch {
      return 'everything';
    }
  });
  const [legendOpen, setLegendOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [rowCount, setRowCount] = useState(0);
  const [onEnter, setOnEnter] = useState<(() => void) | null>(null);
  const [onEscape, setOnEscape] = useState<(() => void) | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(VIS_KEY, visibility);
    } catch {
      /* private mode / quota: visibility degrades to session-only */
    }
  }, [visibility]);

  const cycleVisibility = useCallback(() => {
    setVisibility((v) => VISIBILITY_ORDER[(VISIBILITY_ORDER.indexOf(v) + 1) % VISIBILITY_ORDER.length] as Visibility);
  }, []);

  const registerRows = useCallback((n: number) => {
    setRowCount(n);
    setCursor((c) => (c >= n ? n - 1 : c));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      // Never hijack typing.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Screen jump: 1-5, in argument order.
      const screenIndex = SCREENS.findIndex((id) => SCREEN_META[id].key === e.key);
      if (screenIndex !== -1) {
        e.preventDefault();
        navigate(SCREENS[screenIndex] as ScreenId);
        setCursor(-1);
        return;
      }

      switch (e.key) {
        case 'j':
          e.preventDefault();
          setCursor((c) => (rowCount === 0 ? -1 : Math.min(rowCount - 1, c + 1)));
          break;
        case 'k':
          e.preventDefault();
          setCursor((c) => (rowCount === 0 ? -1 : Math.max(0, c - 1)));
          break;
        case 'Enter':
          if (onEnter) {
            e.preventDefault();
            onEnter();
          }
          break;
        case 'Escape':
          e.preventDefault();
          if (legendOpen) setLegendOpen(false);
          else if (onEscape) onEscape();
          else setCursor(-1);
          break;
        case 'v':
          e.preventDefault();
          cycleVisibility();
          break;
        default:
          // `?` reaches us as key '?' on most layouts, but on some it
          // arrives as shift + '/' with key still '/'. Accept both
          // rather than silently doing nothing on a valid press.
          if (e.key === '?' || (e.shiftKey && (e.key === '/' || e.code === 'Slash'))) {
            e.preventDefault();
            setLegendOpen((o) => !o);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, rowCount, onEnter, onEscape, legendOpen, cycleVisibility]);

  const value = useMemo<ConsoleState>(
    () => ({
      visibility,
      cycleVisibility,
      legendOpen,
      setLegendOpen,
      cursor,
      setCursor,
      registerRows,
      rowCount,
      onEnter,
      setOnEnter,
      onEscape,
      setOnEscape,
    }),
    [visibility, cycleVisibility, legendOpen, cursor, registerRows, rowCount, onEnter, onEscape],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConsole(): ConsoleState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useConsole outside ConsoleProvider');
  return ctx;
}

/** A screen declares its navigable row count for the j/k cursor. */
export function useRows(count: number): number {
  const { registerRows, cursor } = useConsole();
  useEffect(() => {
    registerRows(count);
    return () => registerRows(0);
  }, [count, registerRows]);
  return cursor;
}
