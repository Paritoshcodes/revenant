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
 *
 * Every click in this file goes through `LocatorLike.click()`, never a
 * JS-dispatched click (`evaluate(() => el.click())` or similar). A real
 * Playwright `.click()` performs its own actionability check — non-zero
 * bounding box, a hit test that resolves to the element itself, not
 * something covering it — before the click happens; a JS-dispatched click
 * bypasses all of that and fires regardless. `data-test-id="add-card-cta"`
 * is a live example of why this matters: a collapsed (0x0), unhittable
 * decoy element that coexists with the real submit button on every surface
 * (docs/DECISIONS.md, Build log entry 8). Targeting it through `.click()`
 * fails loudly; targeting it through a JS-dispatched click would have
 * "succeeded" while doing nothing, which is the harder bug to catch.
 */
import { err, ok } from '@revenant/contracts';
import type { Failure, Result } from '@revenant/contracts';

import { FRAME_SELECTOR, MOCKSHARP_URL_PATTERN, PAYMENT_SUCCESSFUL_TEXT, SELECTORS } from './selectors.js';
import type {
  AttemptFlowOptions,
  AttemptFlowResult,
  FrameLocatorLike,
  LocatorLike,
  PageLike,
  PaymentIdCapture,
} from './types.js';

/** A ceiling every individual action waits up to, per docs/CHECKOUT-FLOW.md's "timeout >= 30s". Never the mechanism deciding between two real conditions — see the save-card/popup race below. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_EXPIRY = '12/30';
const DEFAULT_CVV = '123';
/** Values that work (docs/CHECKOUT-FLOW.md section 8): verified test-mode contact, not invented. */
const DEFAULT_CONTACT = '9000090000';
/** Failures settle in ~6s, captures in ~15s (docs/CHECKOUT-FLOW.md section 6). */
const POLL_INTERVAL_MS = 500;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounds a probe against an element that might vanish underneath it.
 * Playwright's `inputValue()`/`textContent()`/etc. auto-wait for the
 * element to be attached, using their own default timeout (30s) when none
 * is given — on an element that is gone and never coming back, that blocks
 * for the full timeout instead of failing this one check (docs/DECISIONS.md,
 * Build log entry 6, repeated in entry 7 for `inputValue`).
 */
const PROBE_TIMEOUT_MS = 250;

/** Interval between value-stability polls. Not a guess at total wait time — only how finely to sample it. */
const VALUE_STABLE_POLL_MS = 40;

/**
 * count() first, always: an element that has been removed from the DOM
 * (docs/DECISIONS.md, Build log entry 7 — `input[name="contact"]` is
 * destroyed the instant its value registers and checkout advances) must
 * never reach an auto-waiting call. `count()` itself never waits, so it is
 * safe to call on anything; a short `timeout` on the read after it is a
 * second line of defence against the gap between the two calls.
 */
const readValueIfPresent = async (locator: LocatorLike): Promise<string | null> => {
  if ((await locator.count()) === 0) return null;
  try {
    return await locator.inputValue({ timeout: PROBE_TIMEOUT_MS });
  } catch {
    return null;
  }
};

/**
 * fill() resolving proves Playwright dispatched the input event; it says
 * nothing about whether the checkout app's own React state — including any
 * reformat, or the element being replaced entirely once the app reacts to
 * it — has caught up before the next action fires. Acting on stale internal
 * state is exactly what left Continue clicking into a no-op when every
 * field was filled and Continue clicked within the same tick. Poll the
 * field's own displayed value until two consecutive reads agree, or until
 * the field itself disappears — the field vanishing IS the app having
 * caught up and moved on, not a failure to wait for.
 */
const waitForValueStable = async (locator: LocatorLike, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let previous = await readValueIfPresent(locator);
  if (previous === null) return;
  while (Date.now() < deadline) {
    await realSleep(VALUE_STABLE_POLL_MS);
    const current = await readValueIfPresent(locator);
    if (current === null) return;
    if (current === previous && current.length > 0) return;
    previous = current;
  }
};

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
    await waitForValueStable(frame.locator(SELECTORS.contact), timeout);

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
    // across a retry). Each fill is followed by a real wait for the
    // field's own displayed value to settle before the next one starts:
    // filling three fields and clicking Continue inside the same tick was
    // exactly what left Continue acting on state the app had not caught
    // up to yet.
    await frame.locator(SELECTORS.cardNumber).fill(cardNumber, { timeout });
    await waitForValueStable(frame.locator(SELECTORS.cardNumber), timeout);
    await frame.locator(SELECTORS.cardExpiry).fill(expiry, { timeout });
    await waitForValueStable(frame.locator(SELECTORS.cardExpiry), timeout);
    await frame.locator(SELECTORS.cardCvv).fill(cvv, { timeout });
    await waitForValueStable(frame.locator(SELECTORS.cardCvv), timeout);

    // Registered before the click that can trigger it: waitForEvent must
    // start listening before the popup opens, or the event can be missed.
    const popupPromise = page.waitForEvent('popup', { timeout });
    // A no-op handler attached immediately, separate from the real one
    // attached later in the race below: if the submit click (or anything
    // else between here and the race) throws first, this function returns
    // via the catch block below without ever reaching that race, leaving
    // popupPromise's own 30s timer to fire later with no handler at all —
    // a genuinely unhandled rejection that crashes the process, not one
    // this function's try/catch can see. Node only needs one handler
    // attached to consider a promise handled; this one exists purely to
    // guarantee that, regardless of which code path runs.
    popupPromise.catch(() => undefined);

    // Recorded before submitting, per docs/CHECKOUT-FLOW.md section 11:
    // reading the captured list's last element immediately after can
    // still miss the newest id by a few milliseconds. Wait for growth
    // past this baseline instead.
    const idsBefore = capture.list().length;
    await frame.locator(SELECTORS.submit).click({ timeout });

    // The tokenisation (save-card) prompt is conditional: present on the
    // first attempt of a session, absent on a retry, independent of which
    // card is used (docs/CHECKOUT-FLOW.md section 3). Rather than
    // guessing how long it takes to render if it is going to, race it
    // directly against the popup opening: whichever genuinely happens
    // first tells us what is actually going on, so there is no duration
    // to get wrong. The dialog probe never rejects the race by itself
    // (matching how the outcome poll avoids a raw Promise.race,
    // docs/DECISIONS.md Build log entry 3): if it never appears, this
    // side simply loses to the popup, which is the fast path on a retry.
    const saveCardButton = frame.locator(SELECTORS.declineSaveCard);
    const dialogAppeared = saveCardButton
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);

    // Neither side may reject the race itself (a raw Promise.race settles
    // on the FIRST settlement, including a rejection — the same failure
    // mode this project already fixed once for the outcome probes,
    // docs/DECISIONS.md Build log entry 3): if popupPromise's own timeout
    // fires before the dialog probe resolves, that rejection must not be
    // allowed to win the race and blow past the decision below.
    const raceWinner = await Promise.race([
      dialogAppeared.then((appeared) => (appeared ? ('dialog' as const) : ('neither' as const))),
      popupPromise.then(
        () => 'popup' as const,
        () => 'neither' as const,
      ),
    ]);

    if (raceWinner === 'dialog') {
      await saveCardButton.click({ timeout });
    }

    // A NEW BROWSER WINDOW, not a same-tab navigation. Already resolved
    // if the race settled on it above; if the dialog needed dismissing
    // first, this is what actually waits for the popup to open now.
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
