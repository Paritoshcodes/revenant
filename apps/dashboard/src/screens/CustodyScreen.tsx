/**
 * CUSTODY — the hash chain, which is literally a chain of custody.
 *
 * The shortest and most visceral proof in the project: a real UPDATE
 * against audit_log, refused by the database, with the verbatim error.
 * So the chain is the centrepiece and it is interactive — drawn,
 * scrubbable, verifiable, and breakable — rather than an illustration
 * with prose underneath.
 *
 * Guardrail vetoes appear in the chain as first-class events (the
 * audit payload's own `kind`), marked in the refusal treatment, because
 * a refusal to act is evidence in its own right.
 */
import { ChainHero } from '../components/hero/ChainHero';
import { ClassChip } from '../components/primitives/ClassChip';
import { Exhibit } from '../components/primitives/Exhibit';
import { Fig } from '../components/primitives/Fig';
import { MaskRise } from '../components/primitives/MaskRise';
import { Panel } from '../components/primitives/Panel';
import { ProximityRows } from '../components/primitives/ProximityRows';
import { ScreenHead } from '../components/primitives/ScreenHead';
import { Tiered } from '../components/primitives/Tier';
import { CHAIN, REFUSAL_EVENTS, shortHash } from '../data/chain';
import { cn } from '../lib/cn';

export function CustodyScreen(): JSX.Element {
  const recent = [...CHAIN.window].reverse();

  return (
    <div className="flex flex-col">
      <ScreenHead
        title="CUSTODY"
        standing={
          <>
            The audit log as a hash chain. Append-only, enforced by the database rather than by convention: a row cannot
            be edited or deleted, and any alteration breaks the chain at a seq the verifier can name.
          </>
        }
        right={<ClassChip cls="RECORD" />}
      />

      <div className="grid grid-cols-2 border-b border-chrome lg:grid-cols-4">
        {[
          ['LINKS', CHAIN.links.toLocaleString('en-IN')],
          ['HEAD SEQ', String(CHAIN.headSeq)],
          ['STATE', 'UNBROKEN'],
          ['ENFORCED BY', 'POSTGRES'],
        ].map(([k, v], i) => (
          <div key={k} className={cn('flex flex-col gap-1.5 px-4 py-3', i < 3 && 'border-r border-chrome')}>
            <span className="eyebrow">{k}</span>
            <Fig className="text-fig-sm leading-none text-fg-data">{v}</Fig>
          </div>
        ))}
      </div>

      <div className="grid gap-px bg-chrome p-px xl:grid-cols-[minmax(0,8fr)_minmax(0,4fr)]">
        <Panel
          label="EXHIBIT / CHAIN OF CUSTODY"
          meta={
            <span className="eyebrow text-fg-ghost">
              sha256(prev_hash + canonical_json(payload)) · WINDOW {CHAIN.window[0]?.seq}–{CHAIN.headSeq}
            </span>
          }
          className="border-0"
          bodyClassName="px-6 pb-8 pt-9 sm:px-12"
          index={0}
        >
          <MaskRise index={0}>
            <ChainHero />
          </MaskRise>
        </Panel>

        <div className="grid content-start gap-px bg-chrome">
          <Panel label="GENESIS" className="border-0" bodyClassName="p-4" index={1}>
            <Fig className="block break-all text-2xs leading-relaxed text-fg-prose">{CHAIN.genesisPrevHash}</Fig>
            <p className="caption mt-3 leading-relaxed">
              The genesis row&apos;s prev_hash: 64 zeros, the one link in the chain that names nothing before it. Every
              row after it is anchored here, so the chain can only be read forward.
            </p>
          </Panel>

          <Tiered tier="secondary">
            <Panel
              label="RECENT EVENTS"
              meta={<span className="eyebrow text-fg-ghost">{CHAIN.window.length} OF {CHAIN.links.toLocaleString('en-IN')}</span>}
              className="border-0"
              bodyClassName="p-0"
              index={2}
            >
              <Exhibit
                label="Chain events"
                figure={
                  <ProximityRows>
                    <div className="divide-y divide-chrome-soft">
                      {recent.slice(0, 8).map((l) => {
                        const refusal = REFUSAL_EVENTS.has(l.event);
                        return (
                          <div key={l.seq} className="flex items-center justify-between gap-3 px-4 py-2">
                            <span className="flex items-baseline gap-2.5">
                              <Fig className="text-2xs text-fg-ghost">{l.seq}</Fig>
                              <span className={cn('eyebrow', refusal ? 'text-refuse' : 'text-fg-label')}>
                                {refusal ? 'REFUSAL' : l.event}
                              </span>
                            </span>
                            <Fig className="text-2xs text-fg-prose">{shortHash(l.hash, 8)}…</Fig>
                          </div>
                        );
                      })}
                    </div>
                  </ProximityRows>
                }
              >
                <div className="divide-y divide-chrome-soft">
                  {recent.map((l) => {
                    const refusal = REFUSAL_EVENTS.has(l.event);
                    return (
                      <div key={l.seq} className="grid grid-cols-[4rem_9rem_1fr] items-baseline gap-3 py-2.5">
                        <Fig className="text-2xs text-fg-ghost">seq {l.seq}</Fig>
                        <span className={cn('eyebrow', refusal ? 'text-refuse' : 'text-fg-label')}>
                          {refusal ? 'REFUSAL' : l.event}
                        </span>
                        <span className="min-w-0">
                          <Fig className="block truncate text-2xs text-fg-data">{l.hash}</Fig>
                          <Fig className="block truncate text-2xs text-fg-ghost">prev {l.prevHash}</Fig>
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="caption mt-4 leading-relaxed">
                  Every row&apos;s prev_hash is the previous row&apos;s hash, which is what makes the sequence a chain
                  rather than a list. Guardrail vetoes are stored here as their own events, so a refusal to act is part
                  of the record on the same footing as an action taken.
                </p>
              </Exhibit>
            </Panel>
          </Tiered>

          <Tiered tier="tertiary">
            <Panel label="ENFORCEMENT" className="border-0" bodyClassName="p-4" index={3}>
              <p className="caption leading-relaxed">
                A <Fig className="text-fg-prose">BEFORE UPDATE OR DELETE</Fig> row trigger and a{' '}
                <Fig className="text-fg-prose">BEFORE TRUNCATE</Fig> statement trigger both raise{' '}
                <Fig className="text-fg-prose">restrict_violation</Fig>. Row-level triggers do not see TRUNCATE, hence
                the second one. Append-only is therefore a guarantee of the database, not a property of the code that
                writes to it.
              </p>
            </Panel>
          </Tiered>
        </div>
      </div>
    </div>
  );
}
