/**
 * Compares the driver's model against reality: drives ONE real payment
 * attempt per outcome through the exported checkout driver, against a
 * fresh real payment link created for that run, and asserts the driver's
 * reported outcome matches Razorpay's own recorded payment status.
 *
 * Double-gated: living under tests/contract/ keeps it out of `npm test`
 * (vitest.config.ts's include glob never matches this directory; this file
 * is only visible to vitest.contract.config.ts), and RUN_CONTRACT_TEST
 * additionally gates it inside the file itself, so pointing vitest at this
 * config alone is still not enough to run it by accident. It creates a
 * real payment link and drives a real (test-mode) payment through
 * Razorpay every time it runs.
 *
 * docs/DECISIONS.md, "The pattern, stated honestly": eight driver bugs so
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

import { attempt, capturePaymentIds, openCheckout } from '../../src/browser/index.js';
import type { AttemptFlowResult } from '../../src/browser/index.js';
import { loadConfig } from '../../src/config.js';
import { createRazorpayClient } from '../../src/razorpay/client.js';

const RUN = process.env.RUN_CONTRACT_TEST === '1';

/** Documented working test-mode card (docs/CHECKOUT-FLOW.md section 8). The bank page's Success/Failure button, not the card, determines the outcome (docs/DECISIONS.md). */
const CARD_NUMBER = '4100280000001007';

describe.skipIf(!RUN)('checkout outcome contract: driver vs Razorpay API', () => {
  const config = loadConfig();
  const client = createRazorpayClient(config.razorpay);
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  const driveOnce = async (outcome: 'success' | 'failure'): Promise<AttemptFlowResult> => {
    const created = await client.createPaymentLink({
      amount_paise: 49_900,
      description: `contract test (${outcome})`,
    });
    if (!created.ok) {
      throw new Error(`payment link creation failed: ${created.error.message}`);
    }

    const context = await browser.newContext();
    const capture = capturePaymentIds(context as never);
    const page = await context.newPage();

    try {
      const opened = await openCheckout(page as never, created.value.short_url, {
        timeoutMs: 30_000,
      });
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
});
