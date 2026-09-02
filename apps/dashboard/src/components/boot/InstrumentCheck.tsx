/**
 * SIGNATURE MOMENT 1 — the console does not appear, it COMES UP.
 *
 * Five lines, resolving in sequence, each with its real value counting
 * into place. What the motion reveals: THE ORDER OF THE ARGUMENT. The
 * lines are in dependency order and each genuinely rests on the one
 * above it — contracts define the grid, the grid defines the reference,
 * the reference is what the instrument was verified against, the custody
 * chain is what makes any of it admissible, and the classes are the rule
 * that stops the whole thing being added together. Shuffle them and the
 * argument stops making sense, which is the test for whether a sequence
 * is choreography or decoration.
 *
 * Every value on this screen is real and citable (see data/facts.ts).
 * Skippable on any key or click. Skipped entirely on repeat visits
 * within a session. Reduced motion: all five resolve at once, held long
 * enough to read, then the console arrives.
 */
import { useEffect, useRef, useState } from 'react';

import { CONTRACTS, CUSTODY, INSTRUMENT, REFERENCE } from '../../data/facts';
import { cn } from '../../lib/cn';
import { useReducedMotion } from '../../lib/motion';
import { ClassChip } from '../primitives/ClassChip';
import { Counter } from '../primitives/Counter';
import { Fig } from '../primitives/Fig';

const SESSION_KEY = 'revenant.console.booted';
const STEP_MS = 250;
const TAIL_MS = 420;
const STEPS = 5;

export function alreadyBooted(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markBooted(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    /* session storage unavailable: the check simply runs again */
  }
}

export function InstrumentCheck({ onComplete }: { onComplete: () => void }): JSX.Element {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(reduced ? STEPS : 0);
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);

  const finish = useRef(() => {
    if (done.current) return;
    done.current = true;
    markBooted();
    setLeaving(true);
    window.setTimeout(onComplete, reduced ? 0 : 180);
  });
  finish.current = () => {
    if (done.current) return;
    done.current = true;
    markBooted();
    setLeaving(true);
    window.setTimeout(onComplete, reduced ? 0 : 180);
  };

  // Advance the sequence.
  useEffect(() => {
    if (reduced) {
      const t = window.setTimeout(() => finish.current(), 700);
      return () => window.clearTimeout(t);
    }
    if (step >= STEPS) {
      const t = window.setTimeout(() => finish.current(), TAIL_MS);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => window.clearTimeout(t);
  }, [step, reduced]);

  // Skip on any key or click. Interruptible, like everything else here.
  useEffect(() => {
    const skip = (): void => finish.current();
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, []);

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex flex-col justify-between bg-ink-000 px-6 py-6 transition-opacity duration-fast sm:px-10 sm:py-8',
        leaving && 'pointer-events-none opacity-0',
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1.5">
          <span className="fig text-sm font-bold tracking-[0.2em] text-fg-data">REVENANT</span>
          <span className="eyebrow text-fg-ghost">EVIDENCE CONSOLE</span>
        </div>
        <span className="eyebrow text-fg-label">INSTRUMENT CHECK</span>
      </div>

      <div className="mx-auto w-full max-w-3xl">
        <div className="flex flex-col gap-px">
          <CheckLine n={0} step={step} label="CONTRACTS LOADED">
            <Counter value={CONTRACTS.gridCells} format={(v) => String(Math.round(v))} active={step > 0} />
            <span className="text-fg-label"> grid cells, </span>
            <Counter value={CONTRACTS.declineReasons} format={(v) => String(Math.round(v))} active={step > 0} />
            <span className="text-fg-label"> decline reasons</span>
          </CheckLine>

          <CheckLine n={1} step={step} label="REFERENCE FIXED">
            <Counter value={REFERENCE.trueLiftPp} format={(v) => `${v.toFixed(4)}pp`} active={step > 1} />
            <span className="text-fg-label"> committed </span>
            <Fig className="text-fg-prose">{REFERENCE.committed}</Fig>
          </CheckLine>

          <CheckLine n={2} step={step} label="INSTRUMENT CALIBRATED">
            <span className="text-fg-label">coverage </span>
            <Counter value={INSTRUMENT.coverage} format={(v) => v.toFixed(3)} active={step > 2} />
            <span className="text-fg-label">
              {' '}
              [{INSTRUMENT.wilsonLo.toFixed(4)}, {INSTRUMENT.wilsonHi.toFixed(4)}]
            </span>
          </CheckLine>

          <CheckLine n={3} step={step} label="CUSTODY CHAIN">
            <span className="text-fg-label">verified, </span>
            <Counter value={CUSTODY.links} format={(v) => String(Math.round(v))} active={step > 3} />
            <span className="text-fg-label"> links, unbroken</span>
          </CheckLine>

          <CheckLine n={4} step={step} label="EVIDENCE CLASSES">
            <span className="inline-flex items-center gap-2 align-middle">
              <ClassChip cls="OBSERVED" />
              <ClassChip cls="ESTIMATED" />
              <span className="text-fg-label">never summed</span>
            </span>
          </CheckLine>
        </div>

        {/* Progress. scaleX, never width — transform only. */}
        <div className="mt-6 h-px w-full bg-chrome">
          <div
            className="h-px origin-left bg-fg-mute transition-transform duration-base ease-out-quart"
            style={{ transform: `scaleX(${Math.min(step, STEPS) / STEPS})` }}
          />
        </div>
      </div>

      <div className="flex items-end justify-between">
        <span className="eyebrow text-fg-ghost">
          {step >= STEPS ? 'CHECK COMPLETE' : `${Math.min(step, STEPS)} / ${STEPS}`}
        </span>
        <span className="eyebrow text-fg-ghost">PRESS ANY KEY TO SKIP</span>
      </div>
    </div>
  );
}

function CheckLine({
  n,
  step,
  label,
  children,
}: {
  n: number;
  step: number;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  const started = step > n;
  const resolved = step > n + 1 || step >= STEPS;

  return (
    // No animation-delay here: the step machine above already sequences
    // the lines. Adding a delay as well double-counts it and the last
    // line lands a full second after its own turn.
    <div
      className={cn(
        'grid grid-cols-[14px_minmax(0,auto)_1fr_minmax(0,auto)_28px] items-center gap-3 border-b border-chrome-soft py-2.5 transition-opacity duration-base',
        started ? 'resolve-in opacity-100' : 'opacity-0',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-[7px] w-[7px] border transition-colors duration-fast',
          resolved ? 'border-fg bg-fg-data' : 'border-fg-ghost',
        )}
      />
      <span
        className={cn(
          'whitespace-nowrap font-mono text-2xs uppercase tracking-[0.14em] transition-colors duration-base',
          resolved ? 'text-fg-prose' : 'text-fg-data',
        )}
      >
        {label}
      </span>
      {/* Dotted leader: ties label to value across the gap, the way a
          printed instrument report does. */}
      <span
        aria-hidden
        className="h-px w-full"
        style={{
          backgroundImage: 'repeating-linear-gradient(to right, var(--color-rule) 0 1px, transparent 1px 5px)',
        }}
      />
      <span className="fig whitespace-nowrap text-base text-fg-data">{children}</span>
      <span className={cn('eyebrow text-right transition-opacity duration-fast', resolved ? 'text-fg-label opacity-100' : 'opacity-0')}>
        OK
      </span>
    </div>
  );
}
