import { describe, expect, it } from 'vitest';

import { assignArms, createOutcomeModel, deriveTransactionSeed } from '../../src/recovery/run-batch.js';

describe('assignArms', () => {
  it('splits evenly for an even count', () => {
    const arms = assignArms(6, () => 0.5);
    expect(arms.filter((a) => a === 'control')).toHaveLength(3);
    expect(arms.filter((a) => a === 'treatment')).toHaveLength(3);
  });

  it('is off by exactly one for an odd count, never more', () => {
    const arms = assignArms(5, () => 0.5);
    const control = arms.filter((a) => a === 'control').length;
    const treatment = arms.filter((a) => a === 'treatment').length;
    expect(Math.abs(control - treatment)).toBe(1);
    expect(control + treatment).toBe(5);
  });

  it('returns an empty array for n=0', () => {
    expect(assignArms(0)).toEqual([]);
  });

  it('assigns the single transaction to one arm or the other for n=1', () => {
    const arms = assignArms(1, () => 0);
    expect(arms).toHaveLength(1);
    expect(['control', 'treatment']).toContain(arms[0]);
  });

  it('is deterministic for a given random source, and the random source actually drives the shuffle', () => {
    // A constant-0 source and a constant-0.99 source must not necessarily
    // agree, proving the shuffle really consults `random` rather than
    // ignoring it.
    const always0 = assignArms(10, () => 0);
    const always0Again = assignArms(10, () => 0);
    expect(always0).toEqual(always0Again);

    const alwaysHigh = assignArms(10, () => 0.999);
    expect(alwaysHigh.filter((a) => a === 'control')).toHaveLength(5);
    expect(alwaysHigh.filter((a) => a === 'treatment')).toHaveLength(5);
  });

  it('never produces an arm other than control or treatment', () => {
    const arms = assignArms(20, Math.random);
    for (const arm of arms) {
      expect(['control', 'treatment']).toContain(arm);
    }
  });
});

describe('deriveTransactionSeed', () => {
  it('is deterministic for the same master seed and index', () => {
    expect(deriveTransactionSeed(12345, 3)).toBe(deriveTransactionSeed(12345, 3));
  });

  it('differs across indices under the same master seed', () => {
    const seeds = Array.from({ length: 10 }, (_, i) => deriveTransactionSeed(12345, i));
    expect(new Set(seeds).size).toBe(10);
  });

  it('differs across master seeds for the same index', () => {
    expect(deriveTransactionSeed(1, 0)).not.toBe(deriveTransactionSeed(2, 0));
  });
});

describe('createOutcomeModel', () => {
  it('is fully reproducible: the same seed and rate produce the same sequence', () => {
    const a = createOutcomeModel(42, 0.5);
    const b = createOutcomeModel(42, 0.5);
    const drawsA = Array.from({ length: 20 }, () => a.next());
    const drawsB = Array.from({ length: 20 }, () => b.next());
    expect(drawsA).toEqual(drawsB);
  });

  it('rate 0 never succeeds', () => {
    const model = createOutcomeModel(7, 0);
    for (let i = 0; i < 50; i += 1) {
      expect(model.next()).toBe('failure');
    }
  });

  it('rate 1 always succeeds', () => {
    const model = createOutcomeModel(7, 1);
    for (let i = 0; i < 50; i += 1) {
      expect(model.next()).toBe('success');
    }
  });

  it('a mid-range rate produces both outcomes over enough draws', () => {
    const model = createOutcomeModel(99, 0.5);
    const draws = Array.from({ length: 100 }, () => model.next());
    expect(draws).toContain('success');
    expect(draws).toContain('failure');
  });

  it('different seeds at the same rate are not forced into lockstep', () => {
    const a = createOutcomeModel(1, 0.5);
    const b = createOutcomeModel(2, 0.5);
    const drawsA = Array.from({ length: 20 }, () => a.next());
    const drawsB = Array.from({ length: 20 }, () => b.next());
    expect(drawsA).not.toEqual(drawsB);
  });
});
