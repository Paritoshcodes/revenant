/**
 * DOM selectors and URL patterns for the Razorpay test-mode checkout
 * flow, pinned exactly against docs/CHECKOUT-FLOW.md (DEFINITIVE,
 * observed live 2026-08-24, supersedes every earlier version). All
 * attribute based; the class strings on these elements are Tailwind soup
 * and must never be used as selectors — `div.Payment-Completed` is the
 * one necessary exception, since Razorpay gives it no data-testid.
 */

/**
 * Every checkout element (contact, card method, card fields, save-card
 * prompt, outcome heading, retry surface) lives inside this cross-origin
 * frame, not the top-level page. The parent page has zero data-testid
 * elements and zero inputs.
 */
export const FRAME_SELECTOR = 'iframe.razorpay-checkout-frame';

/**
 * The mock bank popup's SECOND url. It opens first on an intermediate
 * authenticate URL with no buttons (see AUTHENTICATE_URL_PATTERN) and
 * only navigates here afterwards. `popup.waitForURL(MOCKSHARP_URL_PATTERN)`
 * must resolve before the bank button is clickable; clicking it
 * beforehand only works by timing luck.
 */
export const MOCKSHARP_URL_PATTERN = '**/gateway/mocksharp/**';

/**
 * Matches the popup's INITIAL url,
 * `.../v1/payments/<id>/authenticate`. Capturing group 1 is the payment
 * id without its `pay_` prefix (docs/CHECKOUT-FLOW.md sections 4 and 11).
 * Read via a context-level request listener, not `popup.url()`: by the
 * time that can be read the popup may have already navigated on to
 * mocksharp, especially headless.
 */
export const AUTHENTICATE_URL_PATTERN = /\/v1\/payments\/([A-Za-z0-9]+)\/authenticate/;

/**
 * The ONLY heading text that means success.
 * [data-testid="payment-status-heading"] is a progress indicator, not an
 * outcome: on the FAILURE path it reads "Processing your payment" then
 * "Confirming Payment" for several seconds before the retry surface
 * appears. Resolving on the heading's mere EXISTENCE reports success on a
 * payment that failed (docs/CHECKOUT-FLOW.md section 6).
 */
export const PAYMENT_SUCCESSFUL_TEXT = 'Payment Successful';

export const SELECTORS = {
  contact: 'input[name="contact"]',
  cardMethod: '[data-testid="card"]',
  cardNumber: 'input[name="card.number"]',
  cardExpiry: 'input[name="card.expiry"]',
  cardCvv: 'input[name="card.cvv"]',
  /**
   * Two attributes have each been verified live as BOTH "the real,
   * visible submit button" and "a collapsed 0x0 decoy", on different runs
   * against the same order-based surface (docs/DECISIONS.md, Build log
   * entry 8 found `bottom-cta-button` real and `add-card-cta` collapsed;
   * a direct re-query minutes later found the reverse — `bottom-cta-button`
   * absent entirely, `add-card-cta` real and visible, 371x44). Razorpay's
   * checkout.js is fetched live from their CDN and its markup is not
   * stable across sessions.
   *
   * Given that, hardcoding either attribute alone is a coin flip. Playwright's
   * `:visible` pseudo-class computes actual visibility (non-zero bounding
   * box, not display:none/visibility:hidden) at query time, so this
   * selector defers the choice to whichever candidate is really visible
   * in the current DOM, however many candidates exist. This still relies
   * on `.click()`'s native actionability check as the last line of
   * defence, not on `:visible` alone, in case a third variant appears.
   */
  submit: '[data-testid="bottom-cta-button"]:visible, [data-test-id="add-card-cta"]:visible',
  declineSaveCard: 'button[name="pay_without_saving_card"]',
  bankSuccess: 'button[data-val="S"]',
  bankFailure: 'button[data-val="F"]',
  paymentStatusHeading: '[data-testid="payment-status-heading"]',
  retrySurface: '[data-testid="retry-surface"]',
  /**
   * PARENT-page marker only; it does not exist inside the checkout frame.
   * Permanent and raceless once it appears, unlike the frame's transient
   * heading, so it is the PRIMARY signal both for the pre-flight
   * "already paid" check and for outcome detection.
   */
  paymentCompleted: 'div.Payment-Completed',
} as const;
