/**
 * Compares the driver's model against reality: drives real payment
 * attempts through the exported checkout driver, against fresh real
 * payment links created for each run, and asserts the driver's reported
 * outcome matches Razorpay's own recorded payment status.
 *
 * Live tier: lives under tests/live/, visible only to vitest.live.config.ts
 * (vitest.unit.config.ts and vitest.db.config.ts's include globs never
 * match this directory). Additionally gated on RUN_LIVE_TESTS=1, checked in
 * beforeAll — if it is not set, this FAILS LOUDLY with a clear message
 * rather than silently skipping (see docs/ARCHITECTURE.md, "Regression
 * suite"). It creates real payment links and drives real (test-mode)
 * payments through Razorpay every time it runs.
 *
 * docs/DECISIONS.md, "The pattern, stated honestly": nine driver bugs so
 * far were found by a live run, zero by the unit suite that runs on every
 * commit, because a hand-built fixture can only confirm what its author
 * already believes. This is the one test that compares the driver against
 * Razorpay itself, not against our own fixture.
 *
 * Runs against the hosted payment-link surface, not the order-based one:
 * that is where the batch primitive lives now that Razorpay has lifted
 * the 30-link cap (docs/DECISIONS.md, "Payment-link quota lifted").
 */
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';

import { BASELINE_SUCCESS_CARD_DIGITS } from '@revenant/contracts';

import { attempt, capturePaymentIds, openCheckout } from '../../src/browser/index.js';
import type { AttemptFlowResult } from '../../src/browser/index.js';
import { loadConfig } from '../../src/config.js';
import { createRazorpayClient } from '../../src/razorpay/client.js';
import type { RazorpayClient } from '../../src/razorpay/client.js';

/** The bank page's Success/Failure button, not the card, determines the outcome (docs/DECISIONS.md). */
const CARD_NUMBER = BASELINE_SUCCESS_CARD_DIGITS;

describe('checkout outcome contract: driver vs Razorpay API', () => {
  let client: RazorpayClient;
  let browser: Browser;

  beforeAll(async () => {
    if (process.env.RUN_LIVE_TESTS !== '1') {
      throw new Error(
        'tests/live/checkout-outcome.live.test.ts requires RUN_LIVE_TESTS=1 ' +
          '(it drives real Playwright-controlled Razorpay test-mode payments). ' +
          'Run `RUN_LIVE_TESTS=1 npm run test:live` instead of skipping this file.',
      );
    }
    const config = loadConfig();
    client = createRazorpayClient(config.razorpay);
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  const createLink = async (label: string) => {
    const created = await client.createPaymentLink({
      amount_paise: 49_900,
      description: `live test (${label})`,
    });
    if (!created.ok) {
      throw new Error(`payment link creation failed: ${created.error.message}`);
    }
    return created.value;
  };

  const driveOnce = async (outcome: 'success' | 'failure'): Promise<AttemptFlowResult> => {
    const link = await createLink(outcome);

    const context = await browser.newContext();
    const capture = capturePaymentIds(context as never);
    const page = await context.newPage();

    try {
      const opened = await openCheckout(page as never, link.short_url, { timeoutMs: 30_000 });
      if (!opened.ok) {
        throw new Error(`openCheckout failed: ${opened.error.message}`);
      }

      const driven = await attempt(page as never, CARD_NUMBER, outcome, capture, {
        timeoutMs: 30_000,
      });
      if (!driven.ok) {
        throw new Error(`attempt failed: ${driven.error.message}`);
      }

      return driven.value;
    } finally {
      await context.close();
    }
  };

  it('failure path: driver outcome matches the API status, payment id is non-null', async () => {
    const driven = await driveOnce('failure');

    expect(driven.paymentId).not.toBeNull();
    expect(driven.outcome).toBe('failed');

    const fetched = await client.fetchPayment(driven.paymentId!);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.status).toBe('failed');
  });

  it('success path: driver outcome matches the API status, payment id is non-null', async () => {
    const driven = await driveOnce('success');

    expect(driven.paymentId).not.toBeNull();
    expect(driven.outcome).toBe('captured');

    const fetched = await client.fetchPayment(driven.paymentId!);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.status).toBe('captured');
  });

  /**
   * The retry path specifically: four of the nine driver bugs in
   * docs/DECISIONS.md lived here (retained card field values, the
   * headless-only pre-submit-settle race, the tokenisation dialog's
   * once-per-session behaviour, outcome detection across a second attempt),
   * and none of it was covered by the single-attempt cases above. Drives a
   * real failure, then a real retry to capture, on the SAME page and the
   * SAME PaymentIdCapture — exactly the fail-then-retry sequence
   * docs/CHECKOUT-FLOW.md section 7 documents: the retry surface
   * re-exposes [data-testid="card"], and attempt() is reusable for it
   * without a new context.
   */
  it('retry path: a failure then a same-session retry each match their own API status, with distinct payment ids', async () => {
    const link = await createLink('retry');

    const context = await browser.newContext();
    const capture = capturePaymentIds(context as never);
    const page = await context.newPage();

    try {
      const opened = await openCheckout(page as never, link.short_url, { timeoutMs: 30_000 });
      if (!opened.ok) {
        throw new Error(`openCheckout failed: ${opened.error.message}`);
      }

      const failed = await attempt(page as never, CARD_NUMBER, 'failure', capture, {
        timeoutMs: 30_000,
      });
      if (!failed.ok) {
        throw new Error(`first attempt failed: ${failed.error.message}`);
      }

      const retried = await attempt(page as never, CARD_NUMBER, 'success', capture, {
        timeoutMs: 30_000,
      });
      if (!retried.ok) {
        throw new Error(`retry attempt failed: ${retried.error.message}`);
      }

      expect(failed.value.paymentId).not.toBeNull();
      expect(retried.value.paymentId).not.toBeNull();
      expect(retried.value.paymentId).not.toBe(failed.value.paymentId);
      expect(failed.value.outcome).toBe('failed');
      expect(retried.value.outcome).toBe('captured');

      const fetchedFailed = await client.fetchPayment(failed.value.paymentId!);
      expect(fetchedFailed.ok).toBe(true);
      if (fetchedFailed.ok) expect(fetchedFailed.value.status).toBe('failed');

      const fetchedRetried = await client.fetchPayment(retried.value.paymentId!);
      expect(fetchedRetried.ok).toBe(true);
      if (fetchedRetried.ok) expect(fetchedRetried.value.status).toBe('captured');
    } finally {
      await context.close();
    }
  });
});
