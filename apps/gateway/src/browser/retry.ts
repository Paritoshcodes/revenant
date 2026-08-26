/**
 * Retry for genuinely transient network failures during browser-driven
 * checkout, distinct from the outbound Razorpay client's own retry
 * (src/razorpay/backoff.ts). A dropped connection mid page-load or a
 * failed checkout.js chunk fetch is a fact about the local network, not
 * about the checkout page's state, and is safe to retry from a fresh
 * page: unlike a write to Razorpay, nothing has been submitted yet at
 * this point, so there is no double-attempt risk (docs/DECISIONS.md,
 * "Writes are never retried on a network error" — that constraint exists
 * because Razorpay does not deduplicate for us; it does not apply here
 * because a network failure during navigation never reaches Razorpay's
 * write path at all).
 */
import type { Failure, Result } from '@revenant/contracts';

/**
 * Chromium's own network-layer error codes for a transient condition (a
 * dropped connection, a DNS hiccup, a network interface change mid
 * request) — never a signal about anything the checkout page itself did.
 * Observed live: `net::ERR_NAME_NOT_RESOLVED` on `page.goto`, and
 * `net::ERR_QUIC_PROTOCOL_ERROR` / `net::ERR_NETWORK_CHANGED` on
 * checkout.js's own chunk fetches mid-flow. Deliberately narrow: an
 * application-level failure (a selector timing out because the DOM never
 * reached the expected state) must never match this and get blindly
 * retried, since that would waste time and can mask a real regression.
 */
const TRANSIENT_NETWORK_PATTERN =
  /net::ERR_(NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_(RESET|REFUSED|CLOSED|ABORTED)|QUIC_PROTOCOL_ERROR|INTERNET_DISCONNECTED|TIMED_OUT|ADDRESS_UNREACHABLE)|getaddrinfo ENOTFOUND|ConnectTimeoutError/;

const matches = (value: unknown): boolean =>
  value instanceof Error
    ? TRANSIENT_NETWORK_PATTERN.test(value.message)
    : typeof value === 'string' && TRANSIENT_NETWORK_PATTERN.test(value);

export const isTransientNetworkFailure = (failure: Failure): boolean =>
  matches(failure.message) || matches(failure.cause);

export interface RetryOptions {
  /** Total tries, including the first. Default 3. */
  readonly attempts?: number;
  /** Base backoff between retries; attempt N waits backoffMs * N. Default 2000. */
  readonly backoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries `operation` only on a transient network failure, up to
 * `attempts` total tries, with linear backoff. Any other outcome —
 * success, or a failure that is not transient-network — returns
 * immediately on the first try.
 */
export const withNetworkRetry = async <T>(
  operation: () => Promise<Result<T>>,
  options: RetryOptions = {},
): Promise<Result<T>> => {
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 2_000;
  const sleep = options.sleep ?? realSleep;

  let last: Result<T> = await operation();
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (last.ok || !isTransientNetworkFailure(last.error)) return last;
    await sleep(backoffMs * attempt);
    last = await operation();
  }
  return last;
};
