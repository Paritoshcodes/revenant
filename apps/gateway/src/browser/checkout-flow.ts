/**
 * Drives the Razorpay test-mode checkout flow documented in
 * docs/CHECKOUT-FLOW.md (DEFINITIVE, 2026-08-24, supersedes every earlier
 * version). Five things a driver gets wrong if built from an earlier live
 * run instead of this one — see docs/DECISIONS.md, Build log entry 5:
 *
 *   - Every checkout element lives inside the cross-origin
 *     iframe.razorpay-checkout-frame, not the top-level page.
 *   - The popup's initial URL carries the payment id
 *     (/v1/payments/<id>/authenticate) before it navigates to mocksharp;
 *     reading popup.url() after the fact can lose it, so a context-level
 *     request listener captures it instead (payment-id-capture.ts).
 *   - [data-testid="payment-status-heading"] is a progress indicator, not
 *     an outcome: it reads "Processing"/"Confirming" on the FAILURE path
 *     for several seconds before the retry surface appears. Resolving on
 *     its mere existence reports success on a payment that failed. The
 *     frame also DETACHES on success, so a driver polling it must treat
 *     "Frame was detached" as a signal to check the parent, not an error.
 *   - The method list and card fields do not exist until the stage that
 *     creates them (contact filled, card method clicked).
 *   - A paid link must never be re-driven, and card fields retain stale
 *     values across a retry.
 *
 * Two functions: `openCheckout` covers navigation, the pre-flight
 * already-paid check, and filling contact — done once per transaction.
 * `attempt` covers the rest (select card, submit, the mock bank popup,
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

import { FRAME_SELECTOR, MOCKSHARP_URL_PATTERN, PAYMENT_SUCCESSFUL_TEXT, SELECTORS } from './selectors.js';
import type {
  AttemptFlowOptions,
  AttemptFlowResult,
  FrameLocatorLike,
  PageLike,
  PaymentIdCapture,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SAVE_CARD_GUARD_MS = 5_000;
const DEFAULT_EXPIRY = '12/30';
const DEFAULT_CVV = '123';
/** Generic Razorpay test-mode contact number; not a real subscriber. */
const DEFAULT_CONTACT = '9999999999';
/** Failures settle in ~6s, captures in ~15s (docs/CHECKOUT-FLOW.md section 6). */
const POLL_INTERVAL_MS = 500;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const toFailure = (cause: unknown, context: string): Failure => ({
  kind: 'upstream',
  message: `${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
  cause,
});

/**
 * On success the checkout frame is torn down mid-poll. Playwright's own
 * error for that case names it "detached"; treated as "not yet", not a
 * fatal error, per docs/CHECKOUT-FLOW.md section 6.
 */
const isFrameDetachedError = (cause: unknown): boolean =>
  cause instanceof Error && /detach/i.test(cause.message);

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

/** Navigate, refuse to re-drive an already-paid link, fill contact, and wait for the method list to unlock. */
export const openCheckout = async (
  page: PageLike,
  shortUrl: string,
  options: AttemptFlowOptions = {},
): Promise<Result<void>> => {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const contact = options.contact ?? DEFAULT_CONTACT;

  try {
    // Razorpay checkout polls continuously, so the network never goes
    // idle: 'networkidle' would time out. domcontentloaded is what
    // actually resolves.
    await page.goto(shortUrl, { timeout, waitUntil: 'domcontentloaded' });

    // A paid link must never be re-driven (docs/CHECKOUT-FLOW.md section
    // 10: "A PAID link does not offer a payable checkout"; re-attempting
    // it risks a phantom attempt against a link that can no longer accept
    // one).
    const alreadyPaid = (await page.locator(SELECTORS.paymentCompleted).count()) > 0;
    if (alreadyPaid) {
      return err<Failure>({
        kind: 'conflict',
        message: `openCheckout ${shortUrl}: payment link is already paid, refusing to drive it again`,
      });
    }

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
 * Bounds the heading's textContent() probe to a short budget. Playwright's
 * real textContent() auto-waits for the element to be attached; on the
 * failure path the heading disappears around t+6s, and without this an
 * unguarded call blocks for Playwright's full default timeout (30s)
 * instead of failing this one tick (docs/DECISIONS.md, Build log entry 6).
 */
const PROBE_TIMEOUT_MS = 250;

/**
 * One look at the current state, every probe inside it non-blocking so one
 * tick always completes. `.Payment-Completed` on the PARENT is checked
 * first: permanent and raceless, unlike anything in the frame, so it is
 * the primary signal. The retry surface — the STABLE frame signal — is
 * checked next via `count()` alone, which never waits. The heading is
 * checked last, since it is the transient signal and only useful as an
 * early exit: `count()` gates whether it exists at all, and only then is
 * `textContent()` called, itself still bounded by PROBE_TIMEOUT_MS in
 * case the element vanishes in the gap between the two calls. It counts
 * only on its EXACT text, never its existence. A query against the frame
 * that throws "detached" is swallowed rather than propagated — the driver
 * keeps polling and lets the parent check catch it on a later iteration.
 * Any other error is a genuine failure and propagates immediately.
 */
const pollOutcomeOnce = async (
  page: PageLike,
  frame: FrameLocatorLike,
): Promise<'captured' | 'failed' | null> => {
  if ((await page.locator(SELECTORS.paymentCompleted).count()) > 0) {
    return 'captured';
  }

  try {
    if ((await frame.locator(SELECTORS.retrySurface).count()) > 0) return 'failed';
  } catch (cause) {
    if (!isFrameDetachedError(cause)) throw cause;
  }

  try {
    const heading = frame.locator(SELECTORS.paymentStatusHeading);
    if ((await heading.count()) > 0) {
      const headingText = await heading.textContent({ timeout: PROBE_TIMEOUT_MS });
      if (headingText === PAYMENT_SUCCESSFUL_TEXT) return 'captured';
    }
  } catch (cause) {
    if (!isFrameDetachedError(cause)) throw cause;
  }

  return null;
};

/**
 * Polls in short discrete round trips rather than one long in-page wait:
 * a wait that spans the success-path frame teardown throws "Frame was
 * detached" and loses everything collected (docs/CHECKOUT-FLOW.md section
 * 12). `timeoutMs` should be at least 30s.
 */
const waitForDomOutcome = async (
  page: PageLike,
  frame: FrameLocatorLike,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<'captured' | 'failed' | null> => {
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / POLL_INTERVAL_MS));
  for (let i = 0; i < maxAttempts; i += 1) {
    const outcome = await pollOutcomeOnce(page, frame);
    if (outcome !== null) return outcome;
    if (i < maxAttempts - 1) await sleep(POLL_INTERVAL_MS);
  }
  return null;
};

/**
 * Select the card instrument, submit, drive the mock bank popup down the
 * given outcome, capture the payment id, and read the result back.
 * `capture` must be the SAME PaymentIdCapture across every attempt on this
 * transaction: each attempt's popup fires its own matching request
 * against the shared context.
 */
export const attempt = async (
  page: PageLike,
  cardNumber: string,
  outcome: 'success' | 'failure',
  capture: PaymentIdCapture,
  options: AttemptFlowOptions = {},
): Promise<Result<AttemptFlowResult>> => {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const saveCardGuardMs = options.saveCardGuardMs ?? DEFAULT_SAVE_CARD_GUARD_MS;
  const expiry = options.expiry ?? DEFAULT_EXPIRY;
  const cvv = options.cvv ?? DEFAULT_CVV;
  const sleep = options.sleep ?? realSleep;
  const frame = checkoutFrame(page);

  try {
    // Select the card instrument. The card fields do not exist until it
    // is selected.
    await frame.locator(SELECTORS.cardMethod).click({ timeout });
    await frame.locator(SELECTORS.cardNumber).waitFor({ state: 'visible', timeout });

    // fill() clears before typing; a native setter or type() would append
    // onto whatever a previous attempt in this session left behind
    // (docs/CHECKOUT-FLOW.md section 7: card fields retain their values
    // across a retry).
    await frame.locator(SELECTORS.cardNumber).fill(cardNumber, { timeout });
    await frame.locator(SELECTORS.cardExpiry).fill(expiry, { timeout });
    await frame.locator(SELECTORS.cardCvv).fill(cvv, { timeout });

    // Registered before the click that can trigger it: waitForEvent must
    // start listening before the popup opens, or the event can be missed.
    const popupPromise = page.waitForEvent('popup', { timeout });

    // Recorded before submitting, per docs/CHECKOUT-FLOW.md section 11:
    // reading the captured list's last element immediately after can
    // still miss the newest id by a few milliseconds. Wait for growth
    // past this baseline instead.
    const idsBefore = capture.list().length;
    await frame.locator(SELECTORS.submit).click({ timeout });

    // The tokenisation (save-card) prompt is conditional: present on the
    // first attempt of a session, absent on a retry, independent of which
    // card is used. Guard it rather than assume either way.
    const saveCardButton = frame.locator(SELECTORS.declineSaveCard);
    const saveCardPromptAppeared = await saveCardButton
      .waitFor({ state: 'visible', timeout: saveCardGuardMs })
      .then(() => true)
      .catch(() => false);
    if (saveCardPromptAppeared) {
      await saveCardButton.click({ timeout });
    }

    // A NEW BROWSER WINDOW, not a same-tab navigation.
    const popup = await popupPromise;
    await capture.waitForGrowth(idsBefore, timeout);
    const ids = capture.list();
    const paymentId = ids[ids.length - 1] ?? null;

    // The popup opens on an intermediate URL with no buttons and
    // navigates to the mocksharp bank page afterwards — clicking the bank
    // button before that navigation only works by timing luck.
    await popup.waitForURL(MOCKSHARP_URL_PATTERN, { timeout });
    await popup.click(
      outcome === 'success' ? SELECTORS.bankSuccess : SELECTORS.bankFailure,
      { timeout },
    );

    const domOutcome = await waitForDomOutcome(page, frame, timeout, sleep);
    if (domOutcome === null) {
      await screenshot(page, options.screenshotDir, 'attempt-no-outcome-marker');
      return err<Failure>({
        kind: 'upstream',
        message:
          'checkout flow finished without .Payment-Completed, an exact "Payment Successful" heading, or a retry surface appearing',
      });
    }

    return ok({ outcome: domOutcome, paymentId });
  } catch (cause) {
    await screenshot(page, options.screenshotDir, 'attempt-failed');
    return err(toFailure(cause, `attempt (outcome=${outcome})`));
  }
};
