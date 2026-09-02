/**
 * CUSTODY — the hash chain, which is literally a chain of custody.
 *
 * Every audit row stores prev_hash and hash = sha256(prev_hash +
 * canonical_json(payload)), and Postgres refuses UPDATE, DELETE and
 * TRUNCATE on the table outright. So the claim this screen makes is not
 * "we log things"; it is "the record cannot have been altered, and here
 * is the arithmetic that proves it".
 *
 * The link structure renders with no rows loaded because the STRUCTURE
 * is the point: genesis is 64 zeros, every link names its predecessor,
 * and a break is locatable to an exact seq.
 */
import { CUSTODY } from '../data/facts';
import { ClassChip } from '../components/primitives/ClassChip';
import { EmptyExhibit } from '../components/primitives/EmptyExhibit';
import { Fig } from '../components/primitives/Fig';
import { Bracket } from '../components/identity/Bracket';
import { HeroFigure } from '../components/hero/HeroFigure';
import { Panel } from '../components/primitives/Panel';
import { ScreenHead } from '../components/primitives/ScreenHead';
import { Tiered } from '../components/primitives/Tier';

const GENESIS = '0'.repeat(64);

export function CustodyScreen(): JSX.Element {
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
        <div className="flex flex-col gap-1.5 border-r border-chrome px-4 py-3">
          <span className="eyebrow">LINKS</span>
          <Fig className="text-xl text-fg-data">{CUSTODY.links}</Fig>
        </div>
        <div className="flex flex-col gap-1.5 border-r border-chrome px-4 py-3">
          <span className="eyebrow">HEAD SEQ</span>
          <Fig className="text-xl text-fg-data">{CUSTODY.headSeq}</Fig>
        </div>
        <div className="flex flex-col gap-1.5 border-r border-chrome px-4 py-3">
          <span className="eyebrow">STATE</span>
          <span className="flex items-center gap-2">
            <span aria-hidden className="h-[9px] w-[9px] bg-fg-data" />
            <Fig className="text-xl text-fg-data">UNBROKEN</Fig>
          </span>
        </div>
        <div className="flex flex-col gap-1.5 px-4 py-3">
          <span className="eyebrow">ENFORCED BY</span>
          <Fig className="text-xl text-fg-prose">POSTGRES</Fig>
        </div>
      </div>

      <div className="grid gap-px bg-chrome p-px">
        <Panel
          label="LINK STRUCTURE"
          meta={<span className="eyebrow text-fg-ghost">sha256(prev_hash + canonical_json(payload))</span>}
          className="border-0"
          bodyClassName="px-6 py-7 sm:px-10"
          index={0}
        >
          {/* A chain is already a span between two endpoints, so the mark
              is its native grammar here, not an applied decoration:
              genesis and head ARE the serifs. */}
          <HeroFigure
            label="Custody chain"
            value={String(CUSTODY.links)}
            caption="links, genesis to head, unbroken"
            provenance={[
              ['SOURCE', 'audit_log'],
              ['HEAD SEQ', String(CUSTODY.headSeq)],
              ['ENFORCED BY', 'POSTGRES'],
              ['STATE', CUSTODY.verified ? 'UNBROKEN' : 'BROKEN'],
            ]}
          >
            <p className="caption max-w-2xl leading-relaxed">
              Every row stores <Fig className="text-fg-data">prev_hash</Fig> and{' '}
              <Fig className="text-fg-data">hash = sha256(prev_hash + canonical_json(payload))</Fig>. Reading the chain
              forward from genesis and recomputing each hash is the whole verification: any altered payload changes its
              own hash, which breaks the link the next row names, and the verifier reports the first seq where that
              happens. Append-only is enforced by the database — UPDATE, DELETE and TRUNCATE are all refused outright —
              so a break can only come from a broken writer, never from a quiet edit.
            </p>
          </HeroFigure>

          <div className="mt-8">
            <Bracket tone="data" serif={18} weight={2} from={0.05} to={0.95} centre={null} animate />
            <div className="relative mt-2.5 h-10">
              <div className="absolute -translate-x-1/2 text-center" style={{ left: '5%' }}>
                <Fig className="block text-2xs text-fg-prose">SEQ 1</Fig>
                <span className="eyebrow">GENESIS · 64 ZEROS</span>
              </div>
              <div className="absolute -translate-x-1/2 text-center" style={{ left: '95%' }}>
                <Fig className="block text-2xs text-fg-prose">SEQ {CUSTODY.headSeq}</Fig>
                <span className="eyebrow">HEAD</span>
              </div>
            </div>
          </div>

          <div className="mx-auto mt-8 max-w-2xl border-t border-chrome-soft pt-6">
            <Fig className="block break-all text-2xs leading-relaxed text-fg-ghost">{GENESIS}</Fig>
            <p className="caption mt-3 leading-relaxed">
              Genesis prev_hash, verbatim. Every link after it names its predecessor, so the chain can only be read
              forward from here and any alteration breaks it at a seq the verifier can name. Append-only is enforced by
              the database, not by convention: UPDATE, DELETE and TRUNCATE are all refused outright.
            </p>
          </div>
        </Panel>

        <Panel label="CHAIN RECORD" className="border-0" bodyClassName="px-4">
          <EmptyExhibit
            headline="Chain not loaded"
            contains="Every event in order: timestamp, transaction, attempt, grid cell, proposed action, guardrail verdict, idempotency key, and both hashes. Guardrail REFUSALS appear here as first-class events, not as flags on some other row."
            acquire="SELECT seq, prev_hash, hash, payload FROM audit_log ORDER BY seq"
          />
        </Panel>

        <Tiered tier="secondary">
          <Panel label="INSTRUMENTS" className="border-0" bodyClassName="p-px">
            <div className="grid gap-px bg-chrome sm:grid-cols-2">
              <div className="flex flex-col gap-2 bg-ink-050 p-4">
                <span className="text-sm text-fg-prose">Verify</span>
                <p className="text-2xs leading-relaxed text-fg-label">
                  Walks the chain from genesis, recomputing every hash, and reports the first break by seq. A travelling
                  marker follows the walk so the check is visible rather than asserted.
                </p>
                <button
                  type="button"
                  disabled
                  className="mt-1 w-fit cursor-not-allowed border border-chrome px-3 py-1.5 text-xs text-fg-ghost"
                >
                  <span className="fig">Verify chain</span>
                </button>
              </div>
              <div className="flex flex-col gap-2 bg-ink-050 p-4">
                <span className="text-sm text-refuse">Tamper</span>
                <p className="text-2xs leading-relaxed text-fg-label">
                  Attempts a real UPDATE against audit_log and shows Postgres refuse it, verbatim. The targeted link
                  flashes, the connector snaps, and the break holds with the failing seq named. Roughly 800ms, once.
                </p>
                <button
                  type="button"
                  disabled
                  className="mt-1 w-fit cursor-not-allowed border border-refuse-dim/50 px-3 py-1.5 text-xs text-refuse/50"
                >
                  <span className="fig">Attempt tamper</span>
                </button>
              </div>
            </div>
          </Panel>
        </Tiered>
      </div>
    </div>
  );
}
