/**
 * Five screens, five number keys, hash-routed. No router dependency for
 * a fixed set this small; the hash keeps navigation real (back button,
 * bookmarkable, shareable to a specific exhibit).
 *
 * Screen order is the order of the ARGUMENT, and the number keys follow
 * it: what was done (BATCH) -> what it was worth (NUMBER) -> what was
 * decided and refused (DECISIONS) -> proof the record is intact
 * (CUSTODY) -> proof the instrument itself is sound (INSTRUMENT).
 */
import { useEffect, useState } from 'react';

export const SCREENS = ['batch', 'number', 'decisions', 'custody', 'instrument'] as const;
export type ScreenId = (typeof SCREENS)[number];

export interface ScreenMeta {
  id: ScreenId;
  key: string;
  label: string;
  /** Which evidence class this screen's figures belong to. Drives the
   * CLASS cell of the status rail. */
  cls: 'OBSERVED' | 'ESTIMATED' | 'RECORD';
  source: string;
  /** Condensed label for narrow viewports, so the nav never wraps or
   * scrolls (web-interface-guidelines: nav renders on one line). */
  short: string;
  /** The rail's second cell, per screen. Label AND value, because not
   * every screen is examining a seeded run — CUSTODY examines an append
   * -only log, which has a head seq and no seed. A fixed "SEED" label
   * reading "NO RUN LOADED" on a screen that is showing real loaded data
   * is the rail stating something untrue, and a console whose rail can
   * lie is worthless. Every screen therefore names its own identifier. */
  railLabel: string;
  railValue: string;
}

/** calibration.py master_seed 20260901_2000 for the shipped 2,000
 * replication run (docs/DECISIONS.md, 2026-09-01 scale pass). */
const CALIBRATION_MASTER_SEED = 202609012000;
/** run-batch, --count 30 --concurrency 4, 2026-09-01. */
const BATCH_SEED = 1538946708;
/** The exported experiment run the dashboard renders (data/experiment.json). */
const EXPERIMENT_SEED = 20260901;

export const SCREEN_META: Record<ScreenId, ScreenMeta> = {
  batch: {
    id: 'batch', key: '1', label: 'BATCH', short: 'BATCH', cls: 'OBSERVED',
    source: 'LIVE / RAZORPAY TEST', railLabel: 'SEED', railValue: String(BATCH_SEED),
  },
  number: {
    id: 'number', key: '2', label: 'THE NUMBER', short: 'NUMBER', cls: 'ESTIMATED',
    source: 'ENGINE /experiment', railLabel: 'SEED', railValue: String(EXPERIMENT_SEED),
  },
  decisions: {
    id: 'decisions', key: '3', label: 'DECISIONS', short: 'DECIDE', cls: 'RECORD',
    source: 'DB decisions', railLabel: 'SEED', railValue: String(BATCH_SEED),
  },
  // An append-only log has no seed. It has a head, and that is what
  // identifies the state being examined.
  custody: {
    id: 'custody', key: '4', label: 'CUSTODY', short: 'CUSTODY', cls: 'RECORD',
    source: 'DB audit_log', railLabel: 'HEAD SEQ', railValue: '1355',
  },
  instrument: {
    id: 'instrument',
    key: '5',
    label: 'INSTRUMENT', short: 'INSTR',
    cls: 'ESTIMATED',
    source: 'PRECOMPUTED 2026-09-01',
    railLabel: 'MASTER SEED',
    railValue: String(CALIBRATION_MASTER_SEED),
  },
};

const DEFAULT: ScreenId = 'number';

function parse(): ScreenId {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (SCREENS as readonly string[]).includes(raw) ? (raw as ScreenId) : DEFAULT;
}

export function useRoute(): [ScreenId, (next: ScreenId) => void] {
  const [screen, setScreen] = useState<ScreenId>(() => (typeof window === 'undefined' ? DEFAULT : parse()));

  useEffect(() => {
    const onHash = (): void => setScreen(parse());
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash) window.location.replace(`#/${DEFAULT}`);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return [screen, (next: ScreenId) => { window.location.hash = `#/${next}`; }];
}
