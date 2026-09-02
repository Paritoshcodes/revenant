/**
 * The foot rule. Key hints and the current visibility state, at the
 * lowest possible visual weight — present for a viewer who needs it,
 * invisible to one who does not.
 */
import { useConsole, VISIBILITY_LABEL } from '../../lib/console-state';
import { Fig } from '../primitives/Fig';

const HINTS: Array<[string, string]> = [
  ['1-5', 'SCREEN'],
  ['j/k', 'ROW'],
  ['enter', 'OPEN'],
  ['v', 'VISIBILITY'],
  ['?', 'LEGEND'],
];

export function Footer(): JSX.Element {
  const { visibility, cursor, rowCount } = useConsole();

  return (
    <footer className="flex h-(--h-footer) shrink-0 items-center justify-between border-t border-chrome bg-ink-000 px-4">
      <div className="flex items-center gap-4 overflow-hidden">
        {HINTS.map(([k, v]) => (
          <span key={k} className="flex shrink-0 items-center gap-1.5">
            <Fig className="text-micro text-fg-prose">{k}</Fig>
            <span className="eyebrow text-fg-ghost">{v}</span>
          </span>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {rowCount > 0 && (
          <span className="eyebrow text-fg-ghost">
            ROW <Fig className="text-fg-label">{cursor < 0 ? '--' : String(cursor + 1).padStart(2, '0')}</Fig> /{' '}
            <Fig className="text-fg-label">{String(rowCount).padStart(2, '0')}</Fig>
          </span>
        )}
        <span className="eyebrow text-fg-ghost">{VISIBILITY_LABEL[visibility]}</span>
      </div>
    </footer>
  );
}
