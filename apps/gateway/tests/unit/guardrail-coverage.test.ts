/**
 * Meta-test: every guardrail in GUARDRAIL_ORDER must have dedicated
 * coverage exercising both its allow and veto paths.
 *
 * A test cannot introspect what assertions live in other test files, so
 * this works by construction instead: COVERAGE below is a table keyed by
 * every GuardrailId, each entry holding a context this guardrail allows and
 * a context it vetoes. The test iterates GUARDRAIL_ORDER (the canonical
 * enumeration, src/guardrails/evaluate.ts) and fails with a named error if
 * any id has no entry — that is what makes this fail when someone adds a
 * sixth guardrail without registering coverage for it, rather than only
 * when an existing one regresses. It then calls the REAL rule function
 * against both contexts and asserts the real verdicts, so this is a live
 * functional check, not just a bookkeeping list.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_GUARDRAIL_CONFIG } from '../../src/guardrails/config.js';
import { GUARDRAIL_ORDER } from '../../src/guardrails/evaluate.js';
import {
  circuitBreaker,
  maxAttempts,
  minimumBackoff,
  terminalGridCell,
} from '../../src/guardrails/rules.js';
import type {
  Guardrail,
  GuardrailContext,
  GuardrailId,
} from '../../src/guardrails/types.js';

const NOW = 1_787_558_000_000;

const baseContext = (over: Partial<GuardrailContext> = {}): GuardrailContext => ({
  transactionId: 'txn_coverage',
  errorSource: 'gateway',
  errorStep: 'payment_authorization',
  proposedAction: 'retry_with_backoff',
  attemptNumber: 1,
  nowMs: NOW,
  lastAttemptAtMs: null,
  batch: { settled: 0, failed: 0 },
  ...over,
});

interface CoverageCase {
  readonly guardrail: Guardrail;
  readonly allowContext: GuardrailContext;
  readonly vetoContext: GuardrailContext;
}

const COVERAGE: Record<GuardrailId, CoverageCase> = {
  terminal_grid_cell: {
    guardrail: terminalGridCell,
    allowContext: baseContext({ errorSource: 'gateway', errorStep: 'payment_authorization' }),
    // business/payment_initiation is the real observed-in-test-mode terminal
    // row (docs/ARCHITECTURE.md's policy grid).
    vetoContext: baseContext({ errorSource: 'business', errorStep: 'payment_initiation' }),
  },
  max_attempts: {
    guardrail: maxAttempts,
    allowContext: baseContext({ attemptNumber: 1 }),
    vetoContext: baseContext({ attemptNumber: DEFAULT_GUARDRAIL_CONFIG.maxAttempts + 1 }),
  },
  minimum_backoff: {
    guardrail: minimumBackoff,
    allowContext: baseContext({ attemptNumber: 1, lastAttemptAtMs: null }),
    vetoContext: baseContext({ attemptNumber: 2, lastAttemptAtMs: NOW }),
  },
  circuit_breaker: {
    guardrail: circuitBreaker,
    allowContext: baseContext({ batch: { settled: 0, failed: 0 } }),
    vetoContext: baseContext({ batch: { settled: 20, failed: 20 } }),
  },
};

describe('guardrail coverage', () => {
  it('every id in GUARDRAIL_ORDER has a registered coverage case', () => {
    for (const id of GUARDRAIL_ORDER) {
      if (!(id in COVERAGE)) {
        throw new Error(
          `guardrail-coverage.test.ts: no coverage case registered for guardrail ` +
            `'${id}'. Add an entry to COVERAGE with a context this guardrail ` +
            `allows and a context it vetoes.`,
        );
      }
    }
  });

  it('GUARDRAIL_ORDER and the coverage table describe exactly the same set', () => {
    // Catches the inverse gap: a stale COVERAGE entry for a guardrail that
    // was removed from GUARDRAIL_ORDER.
    expect(Object.keys(COVERAGE).sort()).toEqual([...GUARDRAIL_ORDER].sort());
  });

  for (const id of GUARDRAIL_ORDER) {
    describe(id, () => {
      const testCase = COVERAGE[id];

      it('allows on its registered allow context', () => {
        const decision = testCase.guardrail(testCase.allowContext, DEFAULT_GUARDRAIL_CONFIG);
        expect(decision.verdict).toBe('allow');
        expect(decision.guardrail).toBe(id);
      });

      it('vetoes on its registered veto context', () => {
        const decision = testCase.guardrail(testCase.vetoContext, DEFAULT_GUARDRAIL_CONFIG);
        expect(decision.verdict).toBe('veto');
        expect(decision.guardrail).toBe(id);
      });
    });
  }
});
