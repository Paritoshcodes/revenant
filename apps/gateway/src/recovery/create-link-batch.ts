/**
 * Creates a batch of hosted payment links, ready for the browser driver.
 *
 * The batch primitive for Layer 1. On 2026-08-24 this briefly moved to
 * orders plus a locally served checkout page, because payment links were
 * capped at 30 per account for the account's lifetime and that was a hard
 * ceiling on the whole project. Razorpay lifted the cap on this account on
 * 2026-08-26 (docs/API-BEHAVIOUR.md), which removed the only reason for
 * that move, so the order-based files were deleted. Git history has them
 * if the constraint ever returns.
 *
 * Payment links are also the surface that passes `npm run smoke` cleanly
 * and repeatably; the order-based one had an unexplained intermittent
 * stall after submit that was never root-caused.
 *
 * No throttling logic lives here: `client.createPaymentLink` already goes
 * through the per-endpoint write throttle (src/razorpay/http.ts). This
 * function only sequences the calls and gives up immediately if one fails,
 * rather than silently returning a partial batch.
 */
import { err, ok } from '@revenant/contracts';
import type { Failure, Result } from '@revenant/contracts';

import type { RazorpayClient } from '../razorpay/client.js';

export interface LinkBatchItem {
  readonly paymentLinkId: string;
  readonly amountPaise: number;
  /** The hosted rzp.io URL, ready for the driver's openCheckout(). */
  readonly shortUrl: string;
}

export interface CreateLinkBatchOptions {
  readonly amountPaise?: number;
  readonly description?: string;
}

const DEFAULT_AMOUNT_PAISE = 49_900;

export const createLinkBatch = async (
  client: RazorpayClient,
  n: number,
  options: CreateLinkBatchOptions = {},
): Promise<Result<readonly LinkBatchItem[]>> => {
  if (!Number.isInteger(n) || n < 1) {
    return err<Failure>({
      kind: 'validation',
      message: `createLinkBatch: n must be a positive integer, got ${n}`,
    });
  }

  const amountPaise = options.amountPaise ?? DEFAULT_AMOUNT_PAISE;
  const items: LinkBatchItem[] = [];

  for (let i = 0; i < n; i += 1) {
    const created = await client.createPaymentLink({
      amount_paise: amountPaise,
      description: options.description,
    });
    if (!created.ok) return created;

    items.push({
      paymentLinkId: created.value.id,
      amountPaise,
      shortUrl: created.value.short_url,
    });
  }

  return ok(items);
};
