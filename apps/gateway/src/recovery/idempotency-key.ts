/**
 * Idempotency key derivation.
 *
 * `transaction_id + ':' + attempt_number`, matching the unique constraint on
 * attempts.idempotency_key. Pure, so the format is pinned by a unit test.
 */

export const KEY_SEPARATOR = ':';

/**
 * The separator must not appear in the transaction id, or the key stops
 * being a faithful encoding of the pair and two different attempts could
 * collide on one key.
 */
export const idempotencyKey = (
  transactionId: string,
  attemptNumber: number,
): string => {
  if (transactionId === '') {
    throw new RangeError('transactionId must not be empty');
  }
  if (transactionId.includes(KEY_SEPARATOR)) {
    throw new RangeError(
      `transactionId must not contain '${KEY_SEPARATOR}': ${transactionId}`,
    );
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new RangeError(
      `attemptNumber must be an integer >= 1, got ${attemptNumber}`,
    );
  }
  return `${transactionId}${KEY_SEPARATOR}${attemptNumber}`;
};

/** Inverse of idempotencyKey. Returns null when the key is malformed. */
export const parseIdempotencyKey = (
  key: string,
): { transactionId: string; attemptNumber: number } | null => {
  const index = key.indexOf(KEY_SEPARATOR);
  if (index <= 0 || index === key.length - 1) return null;

  const transactionId = key.slice(0, index);
  const rest = key.slice(index + 1);
  if (!/^\d+$/.test(rest)) return null;

  const attemptNumber = Number.parseInt(rest, 10);
  if (attemptNumber < 1) return null;
  return { transactionId, attemptNumber };
};
