/**
 * DOM selectors for the Razorpay test-mode checkout flow, pinned exactly
 * as observed in docs/CHECKOUT-FLOW.md. All attribute based; the class
 * strings on these elements are Tailwind soup and must never be used as
 * selectors.
 */
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
  completed: 'div.Payment-Completed',
  retrySurface: '[data-testid="retry-surface"]',
} as const;
