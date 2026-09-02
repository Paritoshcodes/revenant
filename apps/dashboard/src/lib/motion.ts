/**
 * Motion foundation.
 *
 * NO ANIMATION LIBRARY, and the justification is specific rather than
 * reflexive. Everything this brief asks for is one of two things:
 *
 *   (a) a CSS keyframe on transform/opacity — which the platform already
 *       composites on the GPU, interrupts for free, and costs zero bytes;
 *   (b) a numeric tween (figures counting into place, the boot sequence
 *       advancing) — which is a ~30-line requestAnimationFrame loop.
 *
 * Motion/Framer's actual value is layout animation, gesture physics and
 * `layoutId` shared elements. Layout animation is BANNED here outright
 * (transform and opacity only). Gestures are unused. That leaves
 * `layoutId`, which would genuinely help signature moment #5, exhibit
 * expansion — and #5 is not in this session's scope. If #5 lands and a
 * hand-rolled FLIP proves fragile, that is the moment to reconsider, and
 * only then.
 */
import { useEffect, useRef, useState } from 'react';

export const DUR = {
  tick: 90,
  fast: 160,
  base: 260,
  slow: 420,
  piece: 800,
} as const;

/** cubic-bezier(0.16, 1, 0.3, 1) — matches --ease-out-expo in tokens.css.
 * Solved by bisection on x; ample precision at 60fps, no dependency. */
export function easeOutExpo(x: number): number {
  return bezier(0.16, 1, 0.3, 1)(x);
}

/** cubic-bezier(0.25, 1, 0.5, 1) — matches --ease-out-quart. */
export function easeOutQuart(x: number): number {
  return bezier(0.25, 1, 0.5, 1)(x);
}

function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const sx = (t: number): number => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3;
  const sy = (t: number): number => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3;
  return (x) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 18; i += 1) {
      const mid = (lo + hi) / 2;
      if (sx(mid) < x) lo = mid;
      else hi = mid;
    }
    return sy((lo + hi) / 2);
  };
}

/** Live `prefers-reduced-motion`. Every primitive in this app consults
 * it and degrades to an instant state change — never skips the state
 * change itself, so the console stays fully functional. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Counts a figure from where it currently is to `target`. Interruptible
 * by construction: a new target picks up from the on-screen value, never
 * from the original start and never from a queued endpoint, so a viewer
 * moving fast is never watching a stale tween finish.
 *
 * `active: false` holds the figure at its start value — used by the boot
 * sequence so each line counts only when its own turn arrives.
 */
export function useCountUp(
  target: number,
  { active = true, durationMs = DUR.slow, from = 0 }: { active?: boolean; durationMs?: number; from?: number } = {},
): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(active ? target : from);
  const currentRef = useRef(active ? target : from);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      currentRef.current = from;
      setValue(from);
      return undefined;
    }
    if (reduced) {
      currentRef.current = target;
      setValue(target);
      return undefined;
    }
    const start = performance.now();
    const origin = currentRef.current;
    if (origin === target) return undefined;

    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs);
      const next = origin + (target - origin) * easeOutExpo(t);
      currentRef.current = next;
      setValue(next);
      if (t < 1) frameRef.current = requestAnimationFrame(step);
      else {
        currentRef.current = target;
        setValue(target);
      }
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, active, reduced, durationMs, from]);

  return value;
}
