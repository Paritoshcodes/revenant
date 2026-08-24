import { describe, expect, it } from 'vitest';

import {
  CONTROL_ARM_GUARDRAIL_CONFIG,
  DEFAULT_GUARDRAIL_CONFIG,
} from '../src/guardrails/config.js';
import {
  ALL_GUARDRAILS,
  GUARDRAIL_ORDER,
  evaluateGuardrails,
  primaryVetoReason,
} from '../src/guardrails/evaluate.js';
import {
  circuitBreaker,
  isRetryAction,
  maxAttempts,
  minimumBackoff,
  requiredGapMs,
  terminalGridCell,
} from '../src/guardrails/rules.js';
import type {
  GuardrailConfig,
  GuardrailContext,
} from '../src/guardrails/types.js';

const NOW = 1_787_558_000_000;

/** A clean transient failure on the first attempt: everything allows this. */
const baseContext = (over: Partial<GuardrailContext> = {}): GuardrailContext => ({
  transactionId: 'txn_abc',
  errorSource: 'gateway',
  errorStep: 'payment_authorization',
  proposedAction: 'retry_with_backoff',
  attemptNumber: 1,
  nowMs: NOW,
  lastAttemptAtMs: null,
  batch: { settled: 0, failed: 0 },
  ...over,
});

/** The terminal row that is actually observable in test mode. */
const terminalContext = (over: Partial<GuardrailContext> = {}): GuardrailContext =>
  baseContext({
    errorSource: 'business',
    errorStep: 'payment_initiation',
    ...over,
  });

describe('isRetryAction', () => {
  it('counts the three retry actions and nothing else', () => {
    expect(isRetryAction('retry_with_backoff')).toBe(true);
    expect(isRetryAction('retry_prompt_alternate')).toBe(true);
    expect(isRetryAction('retry_on_timing_window')).toBe(true);
    expect(isRetryAction('nudge_no_auto_retry')).toBe(false);
    expect(isRetryAction('never_retry')).toBe(false);
  });
});

describe('terminalGridCell', () => {
  it('vetoes a retry proposed on a terminal cell', () => {
    // The demo case: the policy proposes an action, the guardrail refuses it.
    const decision = terminalGridCell(
      terminalContext({ proposedAction: 'retry_with_backoff' }),
      DEFAULT_GUARDRAIL_CONFIG,
    );

    expect(decision.verdict).toBe('veto');
    expect(decision.guardrail).toBe('terminal_grid_cell');
    expect(decision.reason).toContain('business/payment_initiation');
    expect(decision.reason).toContain('terminal');
  });

  it('vetoes every retry action on a terminal cell, not just the default one', () => {
    for (const action of [
      'retry_with_backoff',
      'retry_prompt_alternate',
      'retry_on_timing_window',
    ] as const) {
      const decision = terminalGridCell(
        terminalContext({ proposedAction: action }),
        DEFAULT_GUARDRAIL_CONFIG,
      );
      expect(decision.verdict).toBe('veto');
    }
  });

  it('allows a non-retry action on a terminal cell', () => {
    // Messaging the customer does not re-present the payment.
    for (const action of ['nudge_no_auto_retry', 'never_retry'] as const) {
      const decision = terminalGridCell(
        terminalContext({ proposedAction: action }),
        DEFAULT_GUARDRAIL_CONFIG,
      );
      expect(decision.verdict).toBe('allow');
    }
  });

  it('allows a retry on every non-terminal cell', () => {
    const nonTerminal = [
      ['gateway', 'payment_authorization'],
      ['gateway', 'authentication'],
      ['bank', 'payment_authorization'],
      ['customer', 'payment_authorization'],
    ] as const;

    for (const [errorSource, errorStep] of nonTerminal) {
      const decision = terminalGridCell(
        baseContext({ errorSource, errorStep }),
        DEFAULT_GUARDRAIL_CONFIG,
      );
      expect(decision.verdict).toBe('allow');
    }
  });

  it('resolves the internal wildcard row rather than treating it as unmapped', () => {
    const decision = terminalGridCell(
      baseContext({ errorSource: 'internal', errorStep: 'authentication' }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('allow');
    expect(decision.reason).toContain('transient');
  });

  it('vetoes an unmapped cell instead of assuming it is safe', () => {
    const decision = terminalGridCell(
      baseContext({
        errorSource: 'bank',
        // bank has no wildcard row and no authentication row.
        errorStep: 'authentication',
      }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('veto');
    expect(decision.reason).toContain('not on the policy grid');
  });
});

describe('maxAttempts', () => {
  it('allows attempts up to the cap', () => {
    for (const attemptNumber of [1, 2, 3]) {
      const decision = maxAttempts(
        baseContext({ attemptNumber }),
        DEFAULT_GUARDRAIL_CONFIG,
      );
      expect(decision.verdict).toBe('allow');
    }
  });

  it('vetoes the fourth attempt', () => {
    const decision = maxAttempts(
      baseContext({ attemptNumber: 4 }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('veto');
    expect(decision.reason).toContain('maximum of 3');
  });

  it('does not apply the cap to a non-retry action', () => {
    const decision = maxAttempts(
      baseContext({ attemptNumber: 9, proposedAction: 'nudge_no_auto_retry' }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('allow');
  });

  it('honours a configured cap other than 3', () => {
    const config: GuardrailConfig = { ...DEFAULT_GUARDRAIL_CONFIG, maxAttempts: 1 };
    expect(maxAttempts(baseContext({ attemptNumber: 1 }), config).verdict).toBe(
      'allow',
    );
    expect(maxAttempts(baseContext({ attemptNumber: 2 }), config).verdict).toBe(
      'veto',
    );
  });
});

describe('requiredGapMs', () => {
  it('requires nothing before the first attempt', () => {
    expect(requiredGapMs(1, DEFAULT_GUARDRAIL_CONFIG.attemptSpacing)).toBe(0);
  });

  it('doubles per attempt from the base', () => {
    const spacing = DEFAULT_GUARDRAIL_CONFIG.attemptSpacing;
    expect(requiredGapMs(2, spacing)).toBe(60_000);
    expect(requiredGapMs(3, spacing)).toBe(120_000);
    expect(requiredGapMs(4, spacing)).toBe(240_000);
  });

  it('caps at maxMs', () => {
    expect(requiredGapMs(50, DEFAULT_GUARDRAIL_CONFIG.attemptSpacing)).toBe(
      DEFAULT_GUARDRAIL_CONFIG.attemptSpacing.maxMs,
    );
  });

  it('is zero throughout when spacing is disabled', () => {
    const spacing = CONTROL_ARM_GUARDRAIL_CONFIG.attemptSpacing;
    expect(requiredGapMs(2, spacing)).toBe(0);
    expect(requiredGapMs(3, spacing)).toBe(0);
  });

  it('is deterministic: no jitter', () => {
    const spacing = DEFAULT_GUARDRAIL_CONFIG.attemptSpacing;
    const runs = Array.from({ length: 20 }, () => requiredGapMs(3, spacing));
    expect(new Set(runs).size).toBe(1);
  });
});

describe('minimumBackoff', () => {
  it('allows the first attempt, which has nothing to space from', () => {
    const decision = minimumBackoff(
      baseContext({ attemptNumber: 1, lastAttemptAtMs: null }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('allow');
  });

  it('vetoes a retry fired too soon after the last attempt', () => {
    const decision = minimumBackoff(
      baseContext({ attemptNumber: 2, lastAttemptAtMs: NOW - 10_000 }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('veto');
    expect(decision.reason).toContain('60000ms required');
  });

  it('allows once the required gap has elapsed', () => {
    const decision = minimumBackoff(
      baseContext({ attemptNumber: 2, lastAttemptAtMs: NOW - 60_000 }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('allow');
  });

  it('demands a longer gap for a later attempt', () => {
    const context = baseContext({
      attemptNumber: 3,
      lastAttemptAtMs: NOW - 60_000,
    });
    // 60s was enough before attempt 2, but attempt 3 needs 120s.
    expect(minimumBackoff(context, DEFAULT_GUARDRAIL_CONFIG).verdict).toBe('veto');
  });

  it('allows an immediate retry for the control arm', () => {
    // EXPERIMENT-PROTOCOL.md freezes the baseline as "retry immediately".
    const decision = minimumBackoff(
      baseContext({ attemptNumber: 2, lastAttemptAtMs: NOW }),
      CONTROL_ARM_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('allow');
    expect(decision.reason).toContain('spacing disabled');
  });

  it('does not apply to a non-retry action', () => {
    const decision = minimumBackoff(
      baseContext({
        attemptNumber: 3,
        lastAttemptAtMs: NOW,
        proposedAction: 'nudge_no_auto_retry',
      }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('allow');
  });
});

describe('circuitBreaker', () => {
  it('stays out of the way below the arming threshold', () => {
    // 4 of 5 failed is a terrible rate, but 5 is not a sample.
    const decision = circuitBreaker(
      baseContext({ batch: { settled: 5, failed: 4 } }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('allow');
    expect(decision.reason).toContain('breaker arms at 10');
  });

  it('trips once the failure rate exceeds the threshold', () => {
    const decision = circuitBreaker(
      baseContext({ batch: { settled: 20, failed: 15 } }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('veto');
    expect(decision.reason).toContain('75.0%');
  });

  it('allows a rate exactly at the threshold', () => {
    const decision = circuitBreaker(
      baseContext({ batch: { settled: 20, failed: 10 } }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(decision.verdict).toBe('allow');
  });

  it('trips regardless of which transaction is being evaluated', () => {
    // It is a property of the batch, not of this transaction.
    const batch = { settled: 40, failed: 39 };
    const first = circuitBreaker(
      baseContext({ transactionId: 'txn_1', batch }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    const second = circuitBreaker(
      baseContext({ transactionId: 'txn_2', batch }),
      DEFAULT_GUARDRAIL_CONFIG,
    );
    expect(first.verdict).toBe('veto');
    expect(second.verdict).toBe('veto');
  });
});

describe('evaluateGuardrails', () => {
  it('allows a clean first attempt on a transient cell', () => {
    const evaluation = evaluateGuardrails(baseContext());

    expect(evaluation.verdict).toBe('allow');
    expect(evaluation.vetoes).toHaveLength(0);
    expect(evaluation.decisions).toHaveLength(ALL_GUARDRAILS.length);
    expect(primaryVetoReason(evaluation)).toBeNull();
  });

  it('vetoes the policy when it proposes a retry on a terminal cell', () => {
    // The demo the architecture doc asks for: a guardrail refusing an action
    // the policy proposed.
    const evaluation = evaluateGuardrails(
      terminalContext({ proposedAction: 'retry_with_backoff' }),
    );

    expect(evaluation.verdict).toBe('veto');
    expect(evaluation.vetoes.map((v) => v.guardrail)).toEqual([
      'terminal_grid_cell',
    ]);
    expect(primaryVetoReason(evaluation)).toContain('terminal_grid_cell');
  });

  it('reports every guardrail, not only the ones that objected', () => {
    const evaluation = evaluateGuardrails(
      terminalContext({ proposedAction: 'retry_with_backoff' }),
    );

    expect(evaluation.decisions.map((d) => d.guardrail)).toEqual(GUARDRAIL_ORDER);
    expect(evaluation.decisions.every((d) => d.reason.length > 0)).toBe(true);
  });

  it('collects several vetoes at once', () => {
    const evaluation = evaluateGuardrails(
      terminalContext({
        attemptNumber: 4,
        lastAttemptAtMs: NOW,
        batch: { settled: 20, failed: 18 },
      }),
    );

    expect(evaluation.verdict).toBe('veto');
    expect(evaluation.vetoes.map((v) => v.guardrail)).toEqual([
      'terminal_grid_cell',
      'max_attempts',
      'minimum_backoff',
      'circuit_breaker',
    ]);
  });

  it('is order-independent in verdict, reason and decision order', () => {
    const context = terminalContext({
      attemptNumber: 4,
      lastAttemptAtMs: NOW,
      batch: { settled: 20, failed: 18 },
    });

    const canonical = evaluateGuardrails(context, DEFAULT_GUARDRAIL_CONFIG, [
      ...ALL_GUARDRAILS,
    ]);
    const reversed = evaluateGuardrails(context, DEFAULT_GUARDRAIL_CONFIG, [
      ...ALL_GUARDRAILS,
    ].reverse());

    expect(reversed.verdict).toBe(canonical.verdict);
    expect(reversed.reason).toBe(canonical.reason);
    expect(reversed.decisions).toEqual(canonical.decisions);
    expect(reversed.vetoes).toEqual(canonical.vetoes);
  });

  it('gives the same result for every permutation of the guardrail list', () => {
    const context = terminalContext({
      attemptNumber: 4,
      lastAttemptAtMs: NOW - 1_000,
      batch: { settled: 30, failed: 29 },
    });
    const expected = evaluateGuardrails(context);

    // Rotations are enough to prove the output does not track input order.
    for (let shift = 1; shift < ALL_GUARDRAILS.length; shift += 1) {
      const rotated = [
        ...ALL_GUARDRAILS.slice(shift),
        ...ALL_GUARDRAILS.slice(0, shift),
      ];
      const evaluation = evaluateGuardrails(
        context,
        DEFAULT_GUARDRAIL_CONFIG,
        rotated,
      );
      expect(evaluation.verdict).toBe(expected.verdict);
      expect(evaluation.reason).toBe(expected.reason);
      expect(evaluation.decisions).toEqual(expected.decisions);
    }
  });

  it('is deterministic: the same context evaluates identically every time', () => {
    const context = baseContext({ attemptNumber: 2, lastAttemptAtMs: NOW - 30_000 });
    const runs = Array.from({ length: 25 }, () =>
      JSON.stringify(evaluateGuardrails(context)),
    );
    expect(new Set(runs).size).toBe(1);
  });

  it('does not mutate the context it was given', () => {
    const context = terminalContext({ attemptNumber: 4 });
    const snapshot = JSON.stringify(context);

    evaluateGuardrails(context);

    expect(JSON.stringify(context)).toBe(snapshot);
  });

  it('a single veto is enough, regardless of how many allowed', () => {
    const evaluation = evaluateGuardrails(
      baseContext({ batch: { settled: 100, failed: 99 } }),
    );

    expect(evaluation.verdict).toBe('veto');
    expect(evaluation.vetoes).toHaveLength(1);
    expect(evaluation.decisions.filter((d) => d.verdict === 'allow')).toHaveLength(
      ALL_GUARDRAILS.length - 1,
    );
  });

  it('joins multiple veto reasons in canonical order', () => {
    const evaluation = evaluateGuardrails(
      terminalContext({ attemptNumber: 4 }),
    );

    const positions = ['terminal_grid_cell', 'max_attempts'].map((id) =>
      evaluation.reason.indexOf(id),
    );
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions[1]).toBeGreaterThan(positions[0]!);
  });

  it('lets the control arm retry immediately while still capping attempts', () => {
    const immediate = baseContext({ attemptNumber: 2, lastAttemptAtMs: NOW });

    expect(evaluateGuardrails(immediate, CONTROL_ARM_GUARDRAIL_CONFIG).verdict).toBe(
      'allow',
    );
    expect(evaluateGuardrails(immediate, DEFAULT_GUARDRAIL_CONFIG).verdict).toBe(
      'veto',
    );

    const overCap = baseContext({
      attemptNumber: 4,
      lastAttemptAtMs: NOW - 3_600_000,
    });
    expect(evaluateGuardrails(overCap, CONTROL_ARM_GUARDRAIL_CONFIG).verdict).toBe(
      'veto',
    );
  });
});

describe('guardrail purity', () => {
  it('never reads the clock: a frozen context is unaffected by real time', async () => {
    const context = baseContext({ attemptNumber: 2, lastAttemptAtMs: NOW - 59_999 });
    const before = evaluateGuardrails(context);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(evaluateGuardrails(context)).toEqual(before);
  });

  it('every guardrail returns a non-empty reason on both verdicts', () => {
    const allowed = evaluateGuardrails(baseContext());
    const vetoed = evaluateGuardrails(
      terminalContext({
        attemptNumber: 9,
        lastAttemptAtMs: NOW,
        batch: { settled: 50, failed: 50 },
      }),
    );

    for (const evaluation of [allowed, vetoed]) {
      for (const decision of evaluation.decisions) {
        expect(decision.reason.trim()).not.toBe('');
      }
    }
    // The all-bad context must trip every guardrail.
    expect(vetoed.vetoes).toHaveLength(ALL_GUARDRAILS.length);
  });
});
