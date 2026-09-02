/**
 * REVENANT / EVIDENCE CONSOLE
 *
 * The conceit, and the reason every screen belongs to it: Revenant acts
 * on real money and then proves whether its actions mattered, so
 * everything it emits is EVIDENCE OF A CLASS, and this is where that
 * evidence is examined.
 *
 *   BATCH       the field record. What was actually done, OBSERVED.
 *   THE NUMBER  the finding. What it was worth, ESTIMATED, with its
 *               uncertainty, never summed with the above.
 *   DECISIONS   the decision record, including every REFUSAL.
 *   CUSTODY     proof the record itself was not altered.
 *   INSTRUMENT  proof the estimator that produced the finding is sound,
 *               graded against a REFERENCE frozen before any run.
 *
 * The order is the order of the argument: what happened, what it was
 * worth, what was decided, is the record intact, is the instrument
 * sound. The number keys follow it.
 */
import { useEffect, useRef, useState } from 'react';

import { InstrumentCheck, alreadyBooted } from './components/boot/InstrumentCheck';
import { Footer } from './components/chrome/Footer';
import { Legend } from './components/chrome/Legend';
import { Masthead } from './components/chrome/Masthead';
import { StatusRail } from './components/chrome/StatusRail';
import { ConsoleProvider } from './lib/console-state';
import { useRoute, type ScreenId } from './lib/route';
import { BatchScreen } from './screens/BatchScreen';
import { CustodyScreen } from './screens/CustodyScreen';
import { DecisionsScreen } from './screens/DecisionsScreen';
import { InstrumentScreen } from './screens/InstrumentScreen';
import { NumberScreen } from './screens/NumberScreen';

const SCREEN_VIEW: Record<ScreenId, () => JSX.Element> = {
  batch: BatchScreen,
  number: NumberScreen,
  decisions: DecisionsScreen,
  custody: CustodyScreen,
  instrument: InstrumentScreen,
};

export const App = (): JSX.Element => {
  const [screen, navigate] = useRoute();
  const [booted, setBooted] = useState(() => alreadyBooted());

  if (!booted) {
    return (
      <>
        <InstrumentCheck onComplete={() => setBooted(true)} />
        <div className="grain" aria-hidden />
      </>
    );
  }

  return (
    <ConsoleProvider navigate={navigate}>
      <Console screen={screen} navigate={navigate} />
    </ConsoleProvider>
  );
};

function Console({ screen, navigate }: { screen: ScreenId; navigate: (id: ScreenId) => void }): JSX.Element {
  const View = SCREEN_VIEW[screen];
  const scroller = useRef<HTMLDivElement | null>(null);
  /** Screens hold their own scroll position across a switch away and
   * back, per the brief. Cheaper and more predictable than keeping five
   * screens mounted, which would also make the j/k row registration
   * ambiguous about which screen owns the cursor. */
  const offsets = useRef<Partial<Record<ScreenId, number>>>({});
  const previous = useRef<ScreenId>(screen);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    if (previous.current !== screen) previous.current = screen;
    el.scrollTop = offsets.current[screen] ?? 0;
    return () => {
      offsets.current[screen] = el.scrollTop;
    };
  }, [screen]);

  return (
    <div className="console-arrive flex h-full flex-col">
      <Masthead active={screen} onNavigate={navigate} />
      <StatusRail screen={screen} />
      <main ref={scroller} id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div key={screen} className="screen-in">
          <View />
        </div>
      </main>
      <Footer />
      <Legend />
      <div className="scanline" aria-hidden />
      <div className="grain" aria-hidden />
    </div>
  );
}
