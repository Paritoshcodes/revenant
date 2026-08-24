import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/audit/canonical-json.js';

describe('canonicalJson', () => {
  it('is unaffected by top-level key order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('is unaffected by key order at every nesting level', () => {
    const a = canonicalJson({ outer: { z: 1, y: { n: 2, m: 3 } } });
    const b = canonicalJson({ outer: { y: { m: 3, n: 2 }, z: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array element order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('canonicalizes objects nested inside arrays', () => {
    const a = canonicalJson([{ b: 1, a: 2 }]);
    const b = canonicalJson([{ a: 2, b: 1 }]);
    expect(a).toBe(b);
  });

  it('matches JSON.stringify for primitives', () => {
    expect(canonicalJson('hello')).toBe(JSON.stringify('hello'));
    expect(canonicalJson(42)).toBe(JSON.stringify(42));
    expect(canonicalJson(true)).toBe(JSON.stringify(true));
    expect(canonicalJson(false)).toBe(JSON.stringify(false));
    expect(canonicalJson(null)).toBe('null');
  });

  it('escapes strings the same way JSON.stringify does', () => {
    expect(canonicalJson('quote " backslash \\ newline \n')).toBe(
      JSON.stringify('quote " backslash \\ newline \n'),
    );
  });

  it('drops undefined-valued object keys, matching JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(
      JSON.stringify({ a: 1, b: undefined }),
    );
  });

  it('serializes an empty object and an empty array', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('rejects a bare top-level undefined', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
  });

  it('rejects a Date rather than silently serializing it as {}', () => {
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
  });

  it('rejects a function value nested in an object', () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });

  it('produces the same string for a value built two structurally different ways', () => {
    const built: Record<string, unknown> = {};
    built['zebra'] = 1;
    built['apple'] = { nested: true, alpha: 1 };

    const literal = {
      apple: { alpha: 1, nested: true },
      zebra: 1,
    };

    expect(canonicalJson(built)).toBe(canonicalJson(literal));
  });

  it('is stable across repeated calls on the same value', () => {
    const value = { z: [1, { b: 2, a: 1 }], a: 'x' };
    const runs = Array.from({ length: 10 }, () => canonicalJson(value));
    expect(new Set(runs).size).toBe(1);
  });
});
