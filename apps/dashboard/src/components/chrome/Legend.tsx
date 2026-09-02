/**
 * The `?` legend. Two halves, because a viewer arriving cold needs both:
 * the keyboard map, and the vocabulary. The vocabulary half is not a
 * nicety — this console deliberately refuses generic dashboard words, so
 * it owes the reader a definition of the ones it uses instead.
 */
import { useConsole } from '../../lib/console-state';
import { Fig } from '../primitives/Fig';

const KEYS: Array<[string, string]> = [
  ['1 – 5', 'jump to screen'],
  ['j / k', 'move between rows'],
  ['enter', 'open the focused exhibit'],
  ['esc', 'close, return focus to origin'],
  ['v', 'cycle visibility'],
  ['?', 'this legend'],
];

const VOCAB: Array<[string, string]> = [
  ['EXHIBIT', 'a figure you can open to the rows it came from'],
  ['CUSTODY', 'the hash chain: unbroken, or broken at a named seq'],
  ['CLASS', 'OBSERVED (Layer 1, real) or ESTIMATED (Layer 2, synthetic). Never summed'],
  ['REFUSAL', 'a guardrail veto, recorded as evidence, never as an error'],
  ['INSTRUMENT', 'the estimator, with its own calibration record'],
  ['REFERENCE', 'the frozen true lift, fixed before any run existed'],
];

export function Legend(): JSX.Element | null {
  const { legendOpen, setLegendOpen } = useConsole();
  if (!legendOpen) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-000/80 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Legend"
      onClick={() => setLegendOpen(false)}
    >
      <div
        className="console-arrive w-full max-w-2xl border border-chrome-hard bg-ink-050"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-8 items-center justify-between border-b border-chrome bg-ink-100 px-3">
          <span className="eyebrow text-fg-prose">LEGEND</span>
          <button
            type="button"
            onClick={() => setLegendOpen(false)}
            className="eyebrow text-fg-label transition-colors duration-fast hover:text-fg-data"
          >
            ESC TO CLOSE
          </button>
        </header>

        <div className="grid gap-px bg-chrome sm:grid-cols-2">
          <div className="bg-ink-050 p-4">
            <span className="eyebrow text-fg-ghost">KEYS</span>
            <dl className="mt-3 flex flex-col gap-2">
              {KEYS.map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-3">
                  <dt className="w-14 shrink-0">
                    <Fig className="text-xs text-fg-data">{k}</Fig>
                  </dt>
                  <dd className="text-xs text-fg-label">{v}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="bg-ink-050 p-4">
            <span className="eyebrow text-fg-ghost">VOCABULARY</span>
            <dl className="mt-3 flex flex-col gap-2">
              {VOCAB.map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5">
                  <dt className="eyebrow text-fg-prose">{k}</dt>
                  <dd className="text-xs leading-snug text-fg-label">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
