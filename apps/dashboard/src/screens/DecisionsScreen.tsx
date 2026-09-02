/**
 * DECISIONS — the decision record, refusals included.
 *
 * The screen no comparable product has. Every dashboard records what was
 * done; this one gives equal weight to what was deliberately NOT done,
 * because declining to retry a terminal decline is correct behaviour and
 * a real cost avoided, not an absence.
 *
 * The policy grid is committed contract data, so it renders for real
 * with no run loaded, and it is where the j/k cursor is live today.
 */
import { useEffect } from 'react';

import { POLICY_GRID } from '../data/facts';
import { cn } from '../lib/cn';
import { useConsole, useRows } from '../lib/console-state';
import { ClassChip } from '../components/primitives/ClassChip';
import { EmptyExhibit } from '../components/primitives/EmptyExhibit';
import { Fig } from '../components/primitives/Fig';
import { Panel } from '../components/primitives/Panel';
import { ProximityRows } from '../components/primitives/ProximityRows';
import { ScreenHead } from '../components/primitives/ScreenHead';
import { Tiered } from '../components/primitives/Tier';

const CLASS_NOTE: Record<string, string> = {
  TRANSIENT: 'the failure is expected to clear on its own',
  SOFT: 'may clear on a different timing window',
  CUSTOMER: 'requires the customer, so no automated retry',
  TERMINAL: 'will never succeed; retrying spends money for nothing',
};

export function DecisionsScreen(): JSX.Element {
  const cursor = useRows(POLICY_GRID.length);
  const { setOnEnter, setOnEscape } = useConsole();

  useEffect(() => {
    setOnEnter(() => () => {
      /* Exhibit expansion is signature moment 5, a later build step.
         Registering nothing here rather than a stub keeps `enter` honest:
         it does nothing visible because there is nothing yet to open. */
    });
    return () => {
      setOnEnter(null);
      setOnEscape(null);
    };
  }, [setOnEnter, setOnEscape]);

  return (
    <div className="flex flex-col">
      <ScreenHead
        title="DECISIONS"
        standing={
          <>
            Every transaction&apos;s diagnosis, the cell it landed in, the action proposed, the guardrail verdict and the
            outcome. A REFUSAL is entered here as evidence in its own right, never as an error, because the system
            declining to act is the system working.
          </>
        }
        right={<ClassChip cls="RECORD" />}
      />

      <div className="grid gap-px bg-chrome p-px">
        <Panel
          label="POLICY GRID"
          meta={
            <span className="eyebrow text-fg-ghost">
              <Fig className="text-fg-prose">{POLICY_GRID.length}</Fig> CELLS / COMMITTED CONTRACT
            </span>
          }
          className="border-0"
          bodyClassName="p-0"
        >
          <ProximityRows className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="border-b border-chrome bg-ink-000">
                  <th className="eyebrow w-8 px-3 py-2 font-normal" />
                  <th className="eyebrow px-3 py-2 font-normal">GRID CELL</th>
                  <th className="eyebrow px-3 py-2 font-normal">CLASS</th>
                  <th className="eyebrow px-3 py-2 font-normal">DESIGNATED ACTION</th>
                  <th className="eyebrow px-3 py-2 font-normal">TEST MODE</th>
                </tr>
              </thead>
              <tbody>
                {POLICY_GRID.map((row, i) => {
                  const isCursor = i === cursor;
                  const isTerminal = row.cls === 'TERMINAL';
                  const isCustomer = row.cls === 'CUSTOMER';
                  const refuses = isTerminal || isCustomer;
                  return (
                    <tr
                      key={row.cell}
                      className={cn(
                        'row-in border-b border-chrome-soft transition-colors duration-fast',
                        isCursor ? 'row-cursor' : 'hover:bg-ink-100',
                      )}
                      style={{ '--row-index': i } as React.CSSProperties}
                    >
                      <td className="px-3 py-2.5">
                        <Fig className="text-micro text-fg-ghost">{String(i + 1).padStart(2, '0')}</Fig>
                      </td>
                      <td className="px-3 py-2.5">
                        <Fig className="text-xs text-fg-data">{row.cell}</Fig>
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={cn(
                            'eyebrow',
                            refuses ? 'text-refuse' : 'text-fg-prose',
                          )}
                        >
                          {row.cls}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <Fig className={cn('text-xs', refuses ? 'text-refuse' : 'text-fg-prose')}>{row.action}</Fig>
                          {refuses && (
                            <span className="eyebrow border border-refuse-dim/50 bg-refuse-wash px-1 py-px text-refuse">
                              NO RETRY
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="caption text-fg-ghost">{row.observed ? 'Observable' : 'Synthetic only'}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ProximityRows>
          <p className="border-t border-chrome-soft px-4 py-3 text-2xs leading-relaxed text-fg-label">
            {cursor >= 0 ? (
              <>
                <span className="eyebrow text-fg-prose">{POLICY_GRID[cursor]?.cls}</span>{' '}
                {CLASS_NOTE[POLICY_GRID[cursor]?.cls ?? ''] ?? ''}. Only three of these seven cells are reachable in
                Razorpay test mode; the rest are exercised in the synthetic layer, and that limit is stated rather than
                papered over.
              </>
            ) : (
              <>
                Three of these seven cells are reachable in Razorpay test mode. The rest are exercised in the synthetic
                layer, and that limit is stated rather than papered over. Press <Fig className="text-fg-prose">j</Fig> to
                move down the grid.
              </>
            )}
          </p>
        </Panel>

        <Panel label="DECISION RECORD" className="border-0" bodyClassName="px-4">
          <EmptyExhibit
            headline="No decisions on the record"
            contains="One row per attempt: the diagnosis the classifier produced, the cell it resolved to, the action the policy proposed, the recovery probability behind it, the guardrail verdict, and the outcome. Filterable to REFUSALS alone."
            acquire="SELECT * FROM decisions ORDER BY id DESC"
          />
        </Panel>

        <Tiered tier="tertiary">
          <Panel
            label="CLASSIFIER"
            meta={<span className="eyebrow text-fg-ghost">OPEN-WORLD, GATED</span>}
            className="border-0"
            bodyClassName="px-4"
          >
            <EmptyExhibit
              headline="No classifications on the record"
              contains="Where the deterministic grid lookup missed, the classifier names a failure class only. It is never permitted to name a cell: our own code resolves the class against Razorpay's trusted error_source and error_step, and fails closed when the two contradict. Ranked candidates, the margin between the top two, and whether the gate refused."
              acquire="POST /classify  { error_code, error_description, error_source, error_step }"
            />
          </Panel>
        </Tiered>
      </div>
    </div>
  );
}
