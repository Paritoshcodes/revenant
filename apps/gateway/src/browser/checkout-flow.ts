/**
 * Drives the Razorpay test-mode checkout flow documented in
 * docs/CHECKOUT-FLOW.md, corrected 2026-08-24 against live runs
 * (CORRECTION and VERIFIED sections):
 *
 *   - Every element from the contact field onward lives inside
 *     iframe.razorpay-checkout-frame, not the top-level page. The parent
 *     page has zero data-testid elements and zero inputs.
 *   - The mock bank popup opens on an intermediate
 *     api.razorpay.com/v1/checkout/public URL with no buttons, and only
 *     later navigates to the mocksharp bank page. The driver must
 *     `waitForURL` that navigation before the bank button is clickable.
 *   - `div.Payment-Completed` does not exist anywhere. The real markers,
 *     both inside the frame, are [data-testid="payment-status-heading"]
 *     (success) and [data-testid="retry-surface"] (failure).
 *   - The payment method list does not exist until contact is filled, and
 *     the card fields do not exist until the card method is selected.
 *
 * Two functions: `openCheckout` covers steps 1-2 (navigate, fill contact,
 * wait for the method list to unlock), done once per transaction.
 * `attempt` covers steps 3-10 (select card, submit, the mock bank popup,
 * outcome detection) and is reusable for both the first attempt and every
 * retry, since the retry surface re-exposes the same entry point,
 * [data-testid="card"] — `page` must already be positioned there, either
 * just after openCheckout or on the retry surface from a prior failed
 * attempt.
 *
 * Nothing here throws. A Playwright error, an unexpected page state, or a
 * timeout all become a typed Failure, with a screenshot taken alongside
 * for debugging (best-effort: a failed screenshot never masks the real
 * error).
 */
import { err, ok } from '@revenant/contracts';
import type { Failure, Result } from '@revenant/contracts';

import { FRAME_SELECTOR, MOCKSHARP_URL_PATTERN, SELECTORS } from './selectors.js';
import type {
  AttemptFlowOptions,
  AttemptFlowResult,
  FrameLocatorLike,
  PageLike,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SAVE_CARD_GUARD_MS = 5_000;
const DEFAULT_EXPIRY = '12/30';
const DEFAULT_CVV = '123';
/** Generic Razorpay test-mode contact number; not a real subscriber. */
const DEFAULT_CONTACT = '9999999999';

const toFailure = (cause: unknown, context: string): Failure => ({
  kind: 'upstream',
  message: `${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
  cause,
});

/** Best-effort: a screenshot failure must never hide the real error. */
const screenshot = async (
  page: PageLike,
  dir: string | undefined,
  label: string,
): Promise<void> => {
  if (dir === undefined) return;
  try {
    await page.screenshot({ path: `${dir}/${label}-${Date.now()}.png` });
  } catch {
    // Debugging aid only; the caller already has the real error.
  }
};

const checkoutFrame = (page: PageLike): FrameLocatorLike => page.frameLocator(FRAME_SELECTOR);

/** Steps 1-2: open the payment link, fill contact, and wait for the method list to unlock. */
export const openCheckout = async (
  page: PageLike,
  shortUrl: string,
  options: AttemptFlowOptions = {},
): Promise<Result<void>> => {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const contact = options.contact ?? DEFAULT_CONTACT;

  try {
    // Razorpay checkout polls continuously, so the network never goes
    // idle: 'networkidle' would time out after 30s. domcontentloaded is
    // what actually resolves.
    await page.goto(shortUrl, { timeout, waitUntil: 'domcontentloaded' });

    const frame = checkoutFrame(page);
    await frame.locator(SELECTORS.contact).fill(contact, { timeout });

    // The payment method list, including [data-testid="card"], does not
    // exist until contact is filled. Wait for it rather than assuming it.
    await frame.locator(SELECTORS.cardMethod).waitFor({ state: 'visible', timeout });

    return ok(undefined);
  } catch (cause) {
    await screenshot(page, options.screenshotDir, 'open-checkout-failed');
    return err(toFailure(cause, `openCheckout ${shortUrl}`));
  }
};

/**
 * Waits, in parallel, up to `timeout` for either DOM outcome marker to
 * appear in the checkout frame. Two independently-awaited, non-rejecting
 * probes rather than Promise.race on the raw waitFor calls: a race
 * settles (and rejects) on whichever marker times out first, even when
 * the other one resolves moments later.
 */
const waitForDomOutcome = async (
  frame: FrameLocatorLike,
  timeout: number,
): Promise<'captured' | 'failed' | null> => {
  const success = frame
    .locator(SELECTORS.paymentStatusHeading)
    .waitFor({ state: 'visible', timeout })
    .then(() => 'captured' as const)
    .catch(() => null);
  const failure = frame
    .locator(SELECTORS.retrySurface)
    .waitFor({ state: 'visible', timeout })
    .then(() => 'failed' as const)
    .catch(() => null);
  const [succeeded, failed] = await Promise.all([success, failure]);
  return succeeded ?? failed;
};

/**
 * Steps 3-10: select the card instrument, submit, drive the mock bank
 * popup down the given outcome, and read the result back off the checkout
 * frame.
 */
export const attempt = async (
  page: PageLike,
  cardNumber: string,
  outcome: 'success' | 'failure',
  options: AttemptFlowOptions = {},
): Promise<Result<AttemptFlowResult>> => {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const saveCardGuardMs = options.saveCardGuardMs ?? DEFAULT_SAVE_CARD_GUARD_MS;
  const expiry = options.expiry ?? DEFAULT_EXPIRY;
  const cvv = options.cvv ?? DEFAULT_CVV;
  const frame = checkoutFrame(page);

  try {
    // Step 3: select the card instrument.
    await frame.locator(SELECTORS.cardMethod).click({ timeout });

    // The card fields do not exist until the card method is selected.
    await frame.locator(SELECTORS.cardNumber).waitFor({ state: 'visible', timeout });

    // Steps 4-6.
    await frame.locator(SELECTORS.cardNumber).fill(cardNumber, { timeout });
    await frame.locator(SELECTORS.cardExpiry).fill(expiry, { timeout });
    await frame.locator(SELECTORS.cardCvv).fill(cvv, { timeout });

    // Registered before the click that can trigger it: waitForEvent must
    // start listening before the popup opens, or the event can be missed.
    const popupPromise = page.waitForEvent('popup', { timeout });

    // Step 7: submit.
    await frame.locator(SELECTORS.submit).click({ timeout });

    // Step 8: the save-card prompt is conditional. Guard it rather than
    // assume it appears.
    const saveCardButton = frame.locator(SELECTORS.declineSaveCard);
    const saveCardPromptAppeared = await saveCardButton
      .waitFor({ state: 'visible', timeout: saveCardGuardMs })
      .then(() => true)
      .catch(() => false);
    if (saveCardPromptAppeared) {
      await saveCardButton.click({ timeout });
    }

    // Step 9: a NEW BROWSER WINDOW, not a same-tab navigation. It opens on
    // an intermediate checkout URL with no buttons and navigates to the
    // mocksharp bank page afterwards — clicking the bank button before
    // that navigation only works by timing luck.
    const popup = await popupPromise;
    await popup.waitForURL(MOCKSHARP_URL_PATTERN, { timeout });
    await popup.click(
      outcome === 'success' ? SELECTORS.bankSuccess : SELECTORS.bankFailure,
      { timeout },
    );

    // Step 10: the popup closes itself; outcome is read from the checkout
    // frame, not the parent page. div.Payment-Completed does not exist.
    const domOutcome = await waitForDomOutcome(frame, timeout);
    if (domOutcome === null) {
      await screenshot(page, options.screenshotDir, 'attempt-no-outcome-marker');
      return err<Failure>({
        kind: 'upstream',
        message:
          'checkout flow finished without a payment-status-heading or retry-surface marker appearing',
      });
    }

    return ok({ outcome: domOutcome });
  } catch (cause) {
    await screenshot(page, options.screenshotDir, 'attempt-failed');
    return err(toFailure(cause, `attempt (outcome=${outcome})`));
  }
};
