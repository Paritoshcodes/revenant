/**
 * The masthead. Wordmark, the five screens in argument order with their
 * number keys shown, and the visibility state. Showing the keys is not
 * decoration: this console is keyboard-first and the affordance has to
 * be visible or the interaction model is invisible.
 */
import { cn } from '../../lib/cn';
import { useConsole, VISIBILITY_LABEL } from '../../lib/console-state';
import { SCREENS, SCREEN_META, type ScreenId } from '../../lib/route';
import { Bracket } from '../identity/Bracket';
import { Wordmark } from '../identity/Wordmark';

export function Masthead({
  active,
  onNavigate,
}: {
  active: ScreenId;
  onNavigate: (id: ScreenId) => void;
}): JSX.Element {
  const { visibility, cycleVisibility, setLegendOpen } = useConsole();

  return (
    <header className="flex h-(--h-masthead) shrink-0 items-stretch border-b border-chrome bg-ink-000">
      <div className="flex items-center gap-3 border-r border-chrome px-4">
        <Wordmark />
        <span className="eyebrow hidden text-fg-ghost sm:inline">EVIDENCE CONSOLE</span>
      </div>

      <nav aria-label="Screens" className="flex min-w-0 flex-1 items-stretch">
        {SCREENS.map((id) => {
          const meta = SCREEN_META[id];
          const isActive = id === active;
          return (
            <a
              key={id}
              href={`#/${id}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(id);
              }}
              className={cn(
                'group relative flex shrink-0 items-center gap-2 border-r border-chrome px-2.5 transition-colors duration-fast lg:px-3.5',
                isActive ? 'bg-ink-100 text-fg-data' : 'text-fg-label hover:bg-ink-050 hover:text-fg-prose',
              )}
            >
              <span
                className={cn(
                  'fig w-3 text-center text-micro leading-none transition-colors duration-fast',
                  isActive ? 'text-fg-prose' : 'text-fg-ghost',
                )}
              >
                {meta.key}
              </span>
              <span className="eyebrow whitespace-nowrap text-current">
                <span className="hidden lg:inline">{meta.label}</span>
                <span className="lg:hidden">{meta.short}</span>
              </span>
              {/* The current screen is BRACKETED, not underlined — the
                  mark is the selection indicator, so the identity lives
                  in the navigation and not only in the headline. */}
              {isActive && (
                <span aria-hidden className="pointer-events-none absolute inset-x-1 bottom-[3px]">
                  <Bracket tone="data" serif={3} centre={null} animate />
                </span>
              )}
            </a>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-stretch">
        <button
          type="button"
          onClick={cycleVisibility}
          title="Cycle visibility (v)"
          className="flex items-center gap-2 border-l border-chrome px-3 text-fg-label transition-colors duration-fast hover:bg-ink-050 hover:text-fg-prose"
        >
          <span className="fig text-micro text-fg-ghost">v</span>
          <span className="eyebrow hidden text-current lg:inline">{VISIBILITY_LABEL[visibility]}</span>
        </button>
        <button
          type="button"
          onClick={() => setLegendOpen(true)}
          title="Legend (?)"
          className="flex w-10 items-center justify-center border-l border-chrome text-fg-label transition-colors duration-fast hover:bg-ink-050 hover:text-fg-prose"
        >
          <span className="fig text-xs">?</span>
        </button>
      </div>
    </header>
  );
}
