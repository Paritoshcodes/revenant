/**
 * Drives the Razorpay test-mode checkout flow documented in
 * docs/CHECKOUT-FLOW.md.
 *
 * Two functions: `openCheckout` covers steps 1-2 (navigate, fill contact),
 * done once per transaction. `attempt` covers steps 3-10 (select card,
 * submit, the mock bank popup, outcome detection) and is reusable for both
 * the first attempt and every retry, since the retry surface re-exposes
 * the same entry point, [data-testid="card"] — `page` must already be
 * positioned there, either just after openCheckout or on the retry
 * surface from a prior failed attempt.
 *
 * Nothing here throws. A Playwright error, an unexpected page state, or a
 * timeout all become a typed Failure, with a screenshot taken alongside
 * for debugging (best-effort: a failed screenshot never masks the real
 * error).
 */
import { err, ok } from '@revenant/contracts';
import type { Failure, Result } from '@revenant/contracts';

import { SELECTORS } from './selectors.js';
import type { AttemptFlowOptions, AttemptFlowResult, PageLike } from './types.js';

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

/** Steps 1-2: open the payment link and fill the contact field. */
export const openCheckout = async (
  page: PageLike,
  shortUrl: string,
  options: AttemptFlowOptions = {},
): Promise<Result<void>> => {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const contact = options.contact ?? DEFAULT_CONTACT;

  try {
    await page.goto(shortUrl, { timeout });
    await page.fill(SELECTORS.contact, contact, { timeout });
    return ok(undefined);
  } catch (cause) {
    await screenshot(page, options.screenshotDir, 'open-checkout-failed');
    return err(toFailure(cause, `openCheckout ${shortUrl}`));
  }
};

/**
 * Waits, in parallel, up to `timeout` for either DOM outcome marker to
 * appear. Two independently-awaited, non-rejecting probes rather than
 * Promise.race on the raw waitForSelector calls: a race settles (and
 * rejects) on whichever marker times out first, even when the other one
 * resolves moments later.
 */
const waitForDomOutcome = async (
  page: PageLike,
  timeout: number,
): Promise<'captured' | 'failed' | null> => {
  const success = page
    .waitForSelector(SELECTORS.completed, { timeout })
    .then(() => 'captured' as const)
    .catch(() => null);
  const failure = page
    .waitForSelector(SELECTORS.retrySurface, { timeout })
    .then(() => 'failed' as const)
    .catch(() => null);
  const [succeeded, failed] = await Promise.all([success, failure]);
  return succeeded ?? failed;
};

/**
 * Steps 3-10: select the card instrument, submit, drive the mock bank
 * popup down the given outcome, and read the result back off the parent
 * page.
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

  try {
    // Steps 3-6: select the card instrument and fill its fields.
    await page.click(SELECTORS.cardMethod, { timeout });
    await page.fill(SELECTORS.cardNumber, cardNumber, { timeout });
    await page.fill(SELECTORS.cardExpiry, expiry, { timeout });
    await page.fill(SELECTORS.cardCvv, cvv, { timeout });

    // Registered before the click that can trigger it: waitForEvent must
    // start listening before the popup opens, or the event can be missed.
    const popupPromise = page.waitForEvent('popup', { timeout });

    // Step 7: submit.
    await page.click(SELECTORS.submit, { timeout });

    // Step 8: the save-card prompt is conditional. Guard it rather than
    // assume it appears.
    const saveCardButton = page.locator(SELECTORS.declineSaveCard);
    const saveCardPromptAppeared = await saveCardButton
      .waitFor({ state: 'visible', timeout: saveCardGuardMs })
      .then(() => true)
      .catch(() => false);
    if (saveCardPromptAppeared) {
      await saveCardButton.click({ timeout });
    }

    // Step 9: a NEW BROWSER WINDOW, not a same-tab navigation.
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded', { timeout });
    await popup.click(
      outcome === 'success' ? SELECTORS.bankSuccess : SELECTORS.bankFailure,
      { timeout },
    );

    // Step 10: the popup closes itself; outcome is read from the parent.
    const domOutcome = await waitForDomOutcome(page, timeout);
    if (domOutcome === null) {
      await screenshot(page, options.screenshotDir, 'attempt-no-outcome-marker');
      return err<Failure>({
        kind: 'upstream',
        message:
          'checkout flow finished without a Payment-Completed or retry-surface marker appearing',
      });
    }

    return ok({ outcome: domOutcome });
  } catch (cause) {
    await screenshot(page, options.screenshotDir, 'attempt-failed');
    return err(toFailure(cause, `attempt (outcome=${outcome})`));
  }
};
