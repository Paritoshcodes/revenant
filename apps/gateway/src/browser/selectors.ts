/**
 * DOM selectors for the Razorpay test-mode checkout flow, corrected
 * 2026-08-24 against a live run (docs/CHECKOUT-FLOW.md, CORRECTION and
 * VERIFIED sections). All attribute based; the class strings on these
 * elements are Tailwind soup and must never be used as selectors.
 */

/**
 * Every checkout element (contact, card method, card fields, save-card
 * prompt, outcome markers) lives inside this frame, not the top-level
 * page. The parent page has zero data-testid elements and zero inputs.
 */
export const FRAME_SELECTOR = 'iframe.razorpay-checkout-frame';

/**
 * The mock bank popup opens on an intermediate
 * api.razorpay.com/v1/checkout/public URL with no buttons, then navigates
 * here. `popup.waitForURL(MOCKSHARP_URL_PATTERN)` must resolve before the
 * bank button is clickable; clicking it beforehand only works by timing
 * luck.
 */
export const MOCKSHARP_URL_PATTERN = '**/gateway/mocksharp/**';

export const SELECTORS = {
  contact: 'input[name="contact"]',
  cardMethod: '[data-testid="card"]',
  cardNumber: 'input[name="card.number"]',
  cardExpiry: 'input[name="card.expiry"]',
  cardCvv: 'input[name="card.cvv"]',
  submit: '[data-testid="bottom-cta-button"]',
  declineSaveCard: 'button[name="pay_without_saving_card"]',
  bankSuccess: 'button[data-val="S"]',
  bankFailure: 'button[data-val="F"]',
  /**
   * Success marker. `div.Payment-Completed` was verified across both a
   * success and a failure run to not exist anywhere on the page or in the
   * frame; do not resurrect it as a selector.
   */
  paymentStatusHeading: '[data-testid="payment-status-heading"]',
  retrySurface: '[data-testid="retry-surface"]',
} as const;
