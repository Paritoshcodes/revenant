/**
 * Deterministic JSON serialization.
 *
 * Object keys are sorted recursively, so the same logical payload produces
 * the same string regardless of construction order. This is what lets a
 * hash be recomputed later and still match: Postgres's `jsonb` type does
 * not preserve object key order on storage, so a row read back from the
 * database can have keys in a different order than when it was written.
 * Sorting on every serialization defeats that, on write and on read alike.
 */

const serialize = (value: unknown): string => {
  if (value === null) return 'null';

  if (value === undefined) {
    throw new TypeError('canonicalJson: undefined is not representable in JSON');
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `canonicalJson: ${String(value)} is not representable in JSON`,
      );
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (value instanceof Date) {
    // Ambiguous on its own: ISO string, epoch millis, and epoch seconds are
    // all plausible. Every event payload in the audit schema already carries
    // timestamps as strings, so a Date here is a caller mistake, not data.
    throw new TypeError(
      'canonicalJson: pass an ISO string instead of a Date, serialization would otherwise be ambiguous',
    );
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // JSON.stringify silently drops undefined-valued keys. Matching that
      // keeps canonicalJson(JSON.parse(JSON.stringify(x))) stable.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries
      .map(([key, v]) => `${JSON.stringify(key)}:${serialize(v)}`)
      .join(',');
    return `{${body}}`;
  }

  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
};

/**
 * Serializes `value` to JSON with object keys sorted at every level.
 * Throws on values JSON cannot represent (undefined, NaN, Infinity,
 * functions, symbols) rather than silently dropping or coercing them.
 */
export const canonicalJson = (value: unknown): string => serialize(value);
