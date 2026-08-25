/**
 * Razorpay HTTP transport: basic auth, throttled writes, bounded retries,
 * and typed failures.
 *
 * Nothing here throws across the boundary. Every call returns a Result, per
 * the convention in CLAUDE.md.
 */
import { err, ok } from '@revenant/contracts';
import type { Failure, FailureKind, Result } from '@revenant/contracts';

import { delayForFailure, isRetryable, policyFor, retryAfterMs } from './backoff.js';
import { createThrottle } from './throttle.js';
import type { Throttle } from './throttle.js';
import type { RzpErrorBody } from './types.js';

export const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';

export interface RazorpayCredentials {
  readonly key: string;
  readonly secret: string;
}

export interface HttpDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly throttle: Throttle;
  readonly baseUrl: string;
}

export const defaultHttpDeps = (): HttpDeps => ({
  fetch: globalThis.fetch.bind(globalThis),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  throttle: createThrottle(),
  baseUrl: RAZORPAY_API_BASE,
});

const authHeader = (creds: RazorpayCredentials): string =>
  `Basic ${Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')}`;

/**
 * The permanent per-account quota ceiling (e.g. the test-mode 30 payment
 * links cap) arrives on the SAME HTTP 429 as an ordinary per-window
 * throttle response; the only difference is this error code
 * (docs/API-BEHAVIOUR.md). A per-window 429 carries `BAD_REQUEST_ERROR`.
 */
const QUOTA_EXCEEDED_CODE = 'RATE_LIMIT_EXCEEDED';

/**
 * HTTP status (and, for a 429, the error body) to failure kind. The status
 * alone cannot distinguish a retryable per-window throttle from a
 * permanent quota ceiling: both are 429s, so the body's `error.code` is
 * what tells them apart.
 */
const kindForStatus = (status: number, body: unknown): FailureKind => {
  if (status === 429) {
    const code = (body as RzpErrorBody | null)?.error?.code;
    return code === QUOTA_EXCEEDED_CODE ? 'quota_exceeded' : 'rate_limited';
  }
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'validation';
  return 'internal';
};

const describeError = (status: number, body: unknown): string => {
  const envelope = body as RzpErrorBody | null;
  const detail = envelope?.error;
  if (detail?.description !== undefined && detail.description !== '') {
    const code = detail.code ?? 'unknown';
    return `razorpay ${status} ${code}: ${detail.description}`;
  }
  return `razorpay ${status}`;
};

export interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  readonly body?: unknown;
  readonly query?: Record<string, string | number | undefined>;
  /**
   * Writes go through the throttle and are retried only on 429, because
   * Razorpay does not deduplicate and a network failure leaves us unable to
   * tell whether the request took effect. See backoff.isRetryable.
   */
  readonly isWrite: boolean;
}

const buildUrl = (
  baseUrl: string,
  path: string,
  query: RequestOptions['query'],
): string => {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
};

/**
 * One attempt. Returns a Result rather than throwing so the retry loop above
 * can inspect the failure kind.
 */
const attemptOnce = async <T>(
  creds: RazorpayCredentials,
  deps: HttpDeps,
  options: RequestOptions,
): Promise<Result<T>> => {
  const url = buildUrl(deps.baseUrl, options.path, options.query);

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: options.method,
      headers: {
        Authorization: authHeader(creds),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
    return err<Failure>({
      kind: 'network',
      message: `request to ${options.method} ${options.path} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    });
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return err<Failure>({
        kind: 'upstream',
        message: `razorpay ${response.status} returned non-JSON body`,
        cause,
      });
    }
  }

  if (response.ok) return ok(parsed as T);

  const kind = kindForStatus(response.status, parsed);
  const retryAfter = retryAfterMs(response.headers.get('retry-after'));
  return err<Failure>({
    kind,
    message: describeError(response.status, parsed),
    ...(retryAfter === null
      ? {}
      : { retry_after_seconds: Math.ceil(retryAfter / 1_000) }),
    cause: parsed,
  });
};

/**
 * Performs a request, throttling writes and retrying within policy.
 *
 * The throttle wraps each individual attempt, so a retry consumes a slot
 * exactly like a first try does. Reads never touch the throttle at all:
 * 25 consecutive GET /payments returned zero 429s while /orders was being
 * rate limited in parallel (docs/API-BEHAVIOUR.md), so pacing them would
 * only slow the batch for no reason. Writes queue by `options.path`, the
 * throttle's per-endpoint key, since /orders and /payment_links carry
 * independent budgets.
 */
export const request = async <T>(
  creds: RazorpayCredentials,
  deps: HttpDeps,
  options: RequestOptions,
): Promise<Result<T>> => {
  const call = (): Promise<Result<T>> =>
    options.isWrite
      ? deps.throttle.run(options.path, () => attemptOnce<T>(creds, deps, options))
      : attemptOnce<T>(creds, deps, options);

  let attempt = 0;
  for (;;) {
    const result = await call();
    if (result.ok) return result;

    const { kind } = result.error;
    const policy = policyFor(kind);
    attempt += 1;

    if (!isRetryable(kind, options.isWrite) || attempt > policy.maxRetries) {
      return result;
    }

    await deps.sleep(delayForFailure(result.error, attempt, deps.random));
  }
};
