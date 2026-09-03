/**
 * THE CHAIN, alive.
 *
 * Real audit_log rows drawn as a connected sequence, genesis at left,
 * head at right. Three things happen here, and all three are evidence
 * rather than decoration:
 *
 *   DRAW      on load the chain draws itself left to right via
 *             stroke-dashoffset, which shows the structure assembling in
 *             the only order it can be read — forward from genesis,
 *             because every link names its predecessor.
 *   SCRUB     moving along the chain reads out that link's seq, its own
 *             hash prefix, and its prev_hash prefix, so a viewer can see
 *             each link naming the one before it. The previous link's
 *             hash is shown beside it: they are the same string, and
 *             that is the whole mechanism.
 *   TAMPER    the set piece. A real UPDATE was run against audit_log and
 *             Postgres refused it; this replays that refusal with the
 *             verbatim error, snapping the connector at the named seq.
 *
 * The refusal is RECORDED, not live, and says so on screen. It was
 * captured by genuinely executing the UPDATE (see
 * apps/gateway/scripts/export-dashboard-fixtures.mts) — the animation is
 * a replay, the error text and the seq are not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { CHAIN, REFUSAL_EVENTS, shortHash } from '../../data/chain';
import { cn } from '../../lib/cn';
import { useReducedMotion } from '../../lib/motion';
import { Fig } from '../primitives/Fig';

const H = 132;
const LINK_Y = 58;
const NODE = 7;

type Mode = 'idle' | 'verifying' | 'verified' | 'broken';

export function ChainHero(): JSX.Element {
  const reduced = useReducedMotion();
  const links = CHAIN.window;
  const track = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [walk, setWalk] = useState(0);

  const at = useCallback((i: number): number => (links.length === 1 ? 50 : (i / (links.length - 1)) * 100), [links.length]);

  /** VERIFY walks the chain rather than asserting it: a travelling
   * marker moves link to link, and only when it reaches the head does
   * the state resolve to intact. The walk is the check made visible. */
  const verify = useCallback(() => {
    if (mode === 'verifying') return;
    setMode('verifying');
    setWalk(0);
    if (reduced) {
      setWalk(links.length - 1);
      setMode('verified');
      return;
    }
    let i = 0;
    const step = (): void => {
      i += 1;
      setWalk(i);
      if (i >= links.length - 1) setMode('verified');
      else window.setTimeout(step, 34);
    };
    window.setTimeout(step, 34);
  }, [mode, reduced, links.length]);

  const tamper = useCallback(() => {
    setMode('broken');
  }, []);

  useEffect(() => {
    if (mode !== 'verified') return undefined;
    const t = window.setTimeout(() => setMode('idle'), 2600);
    return () => window.clearTimeout(t);
  }, [mode]);

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = track.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      setCursor(Math.round(f * (links.length - 1)));
    },
    [links.length],
  );

  const active = cursor === null ? null : links[cursor];
  const previous = cursor !== null && cursor > 0 ? links[cursor - 1] : null;
  // The break lands on the head, which is the seq the real refusal named.
  const breakIndex = links.length - 1;

  return (
    <div className="flex flex-col">
      {/* ---- The hero figure ------------------------------------------ */}
      <div className="flex flex-col items-center">
        <Fig className="block text-hero font-medium leading-none text-fg-data" style={{ letterSpacing: '-0.045em' }}>
          {CHAIN.links.toLocaleString('en-IN')}
        </Fig>
        <span className="caption mt-1.5">links, genesis to head, each naming its predecessor</span>
      </div>

      {/* ---- The chain ------------------------------------------------ */}
      <div
        ref={track}
        className="relative mt-10 cursor-crosshair"
        style={{ height: H }}
        onPointerMove={onMove}
        onPointerLeave={() => setCursor(null)}
      >
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 100 ${H}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          {/* Connectors, one per adjacent pair. Each is a real assertion:
              link i+1's prev_hash equals link i's hash. */}
          {links.slice(0, -1).map((l, i) => {
            const snapped = mode === 'broken' && i === breakIndex - 1;
            return (
              <line
                key={l.seq}
                className={cn('draw', snapped && 'chain-snap')}
                x1={at(i)}
                y1={LINK_Y}
                x2={at(i + 1)}
                y2={LINK_Y}
                stroke={snapped ? 'var(--color-fault)' : 'var(--color-chrome-hard)'}
                strokeWidth={snapped ? 2 : 1.5}
                vectorEffect="non-scaling-stroke"
                style={{ '--draw-index': i * 0.14, transformOrigin: `${at(i)}% ${LINK_Y}px` } as React.CSSProperties}
              />
            );
          })}
        </svg>

        {/* Nodes. Squares, not circles: a circle in a stretched viewBox
            draws as an ellipse, and these are rendered as HTML for the
            same reason the interval's centre mark is. */}
        {links.map((l, i) => {
          const isRefusal = REFUSAL_EVENTS.has(l.event);
          const isBreak = mode === 'broken' && i >= breakIndex;
          const walked = mode !== 'idle' && i <= walk;
          return (
            <span
              key={l.seq}
              className={cn(
                'absolute z-10 transition-colors duration-fast',
                isBreak && 'chain-snap',
                cursor === i && 'ring-2 ring-fg-data',
              )}
              style={{
                left: `${at(i)}%`,
                top: LINK_Y,
                width: NODE,
                height: NODE,
                marginLeft: -NODE / 2,
                marginTop: -NODE / 2,
                background: isBreak
                  ? 'var(--color-fault)'
                  : isRefusal
                    ? 'var(--color-refuse)'
                    : walked
                      ? 'var(--color-fg-data)'
                      : 'var(--color-fg-ghost)',
              }}
              aria-hidden
            />
          );
        })}

        {/* Endpoints, anchored to their own edge rather than centred on
            it — centring at 0% and 100% pushes the label half outside
            the track and wraps it. */}
        <div className="absolute inset-x-0 flex justify-between" style={{ top: LINK_Y + 16 }}>
          <div className="whitespace-nowrap">
            <Fig className="block text-2xs text-fg-prose">seq {links[0]?.seq}</Fig>
            <span className="eyebrow">WINDOW START</span>
          </div>
          <div className="whitespace-nowrap text-right">
            <Fig className="block text-2xs text-fg-prose">seq {CHAIN.headSeq}</Fig>
            <span className="eyebrow">HEAD</span>
          </div>
        </div>

        {/* Scrub readout: the link, and the link it names. */}
        {active && (
          <div
            className="pointer-events-none absolute z-20 -translate-x-1/2 whitespace-nowrap border border-chrome-hard bg-ink-000 px-3 py-2"
            style={{ left: `${Math.min(88, Math.max(12, at(cursor as number)))}%`, top: 0 }}
          >
            <div className="flex items-baseline gap-2">
              <span className="eyebrow">SEQ</span>
              <Fig className="text-2xs text-fg-data">{active.seq}</Fig>
              <span
                className={cn(
                  'eyebrow',
                  REFUSAL_EVENTS.has(active.event) ? 'text-refuse' : 'text-fg-label',
                )}
              >
                {REFUSAL_EVENTS.has(active.event) ? 'REFUSAL' : active.event}
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="eyebrow w-14">HASH</span>
              <Fig className="text-2xs text-fg-data">{shortHash(active.hash, 16)}…</Fig>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="eyebrow w-14">PREV_HASH</span>
              <Fig className="text-2xs text-fg-prose">{shortHash(active.prevHash, 16)}…</Fig>
            </div>
            {previous && (
              <div className="mt-1.5 border-t border-chrome-soft pt-1.5">
                <span className="caption text-fg-ghost">
                  which is seq <Fig className="text-fg-prose">{previous.seq}</Fig>&apos;s own hash
                </span>
              </div>
            )}
          </div>
        )}

        {/* The break, held at the named seq until dismissed. */}
        {mode === 'broken' && (
          <div
            className="absolute z-20 -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${at(breakIndex)}%`, top: LINK_Y - 30 }}
          >
            <span className="eyebrow border border-fault px-1.5 py-1 text-fault">
              BROKEN AT SEQ {CHAIN.refusal.seq}
            </span>
          </div>
        )}
      </div>

      {/* ---- Controls -------------------------------------------------- */}
      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={verify}
          className="border border-chrome-hard px-4 py-2 text-sm text-fg-data transition-colors duration-fast hover:bg-ink-150"
        >
          {mode === 'verifying' ? 'Walking the chain…' : 'Verify chain'}
        </button>
        <button
          type="button"
          onClick={tamper}
          className="border border-fault px-4 py-2 text-sm text-fault transition-colors duration-fast hover:bg-fault-wash"
        >
          Attempt tamper
        </button>
        {mode === 'broken' && (
          <button
            type="button"
            onClick={() => setMode('idle')}
            className="eyebrow border border-chrome px-2.5 py-2 text-fg-label transition-colors duration-fast hover:text-fg-data"
          >
            DISMISS
          </button>
        )}
      </div>

      {/* ---- Result ---------------------------------------------------- */}
      <div className="mt-8 min-h-[7.5rem]">
        {mode === 'verified' && (
          <div className="resolve-in flex flex-col items-center gap-2 text-center">
            <span className="eyebrow">RESULT</span>
            <span className="text-verdict font-semibold tracking-[-0.02em] text-fg-data">Chain intact</span>
            <span className="caption max-w-lg">
              Walked {CHAIN.links.toLocaleString('en-IN')} links to head{' '}
              <Fig className="text-fg-prose">{CHAIN.headSeq}</Fig>, hash{' '}
              <Fig className="text-fg-prose">{shortHash(CHAIN.headHash, 24)}…</Fig> — no break found.
            </span>
          </div>
        )}

        {mode === 'broken' && (
          <div className="resolve-in mx-auto max-w-3xl">
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="eyebrow text-fault">POSTGRES REFUSED THE WRITE</span>
              <span className="text-verdict font-semibold tracking-[-0.02em] text-fg-data">Record cannot be altered</span>
            </div>
            <div className="mt-5 border border-fault/50 bg-fault-wash p-4">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="eyebrow">ATTEMPTED</span>
                <Fig className="text-2xs text-fg-prose">{CHAIN.refusal.sql}</Fig>
              </div>
              <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="eyebrow text-fault">{CHAIN.refusal.severity}</span>
                <Fig className="text-sm text-fault">{CHAIN.refusal.message}</Fig>
              </div>
              <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 border-t border-fault/30 pt-3">
                {[
                  ['SQLSTATE', CHAIN.refusal.code],
                  ['RAISED IN', CHAIN.refusal.where],
                  ['CAPTURED', CHAIN.refusal.capturedAt],
                ].map(([k, v]) => (
                  <span key={k} className="flex items-baseline gap-1.5">
                    <span className="eyebrow">{k}</span>
                    <Fig className="text-2xs text-fg-prose">{v}</Fig>
                  </span>
                ))}
              </div>
            </div>
            <p className="caption mt-4 leading-relaxed">
              Recorded, not simulated: that message, SQLSTATE and function name came back from the real database when
              this exact UPDATE was run against the real table on{' '}
              <Fig className="text-fg-prose">{CHAIN.refusal.capturedAt}</Fig>. The animation is a replay; the refusal is
              not. Append-only is a database guarantee here, not a convention — UPDATE, DELETE and TRUNCATE are all
              rejected by triggers, so a broken chain can only ever come from a broken writer.
            </p>
          </div>
        )}

        {mode === 'idle' && (
          <p className="caption mx-auto max-w-2xl text-center leading-relaxed">
            Scrub the chain to read any link&apos;s seq and hash, and the prev_hash naming the link before it. Verify
            walks all {CHAIN.links.toLocaleString('en-IN')} links and reports the first break. Tamper runs the real
            UPDATE and shows what the database said.
          </p>
        )}
      </div>
    </div>
  );
}
