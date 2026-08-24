# Razorpay test-mode checkout flow

Observed manually on 2026-08-24 against test key rzp_test_TTLGluGvmPCtQZ.
Flow is identical for every scenario. Only the card number and the final
Success / Failure click differ. See CAPTURE-CHECKLIST.md for the data table.

## Step sequence

1. Open the payment link short_url.
2. Contact field: `input[name="contact"]` (also `[data-testid="contactNumber"]`).
3. Select card method: `[data-testid="card"]`.
4. Card number: `input[name="card.number"]`.
5. Expiry: `input[name="card.expiry"]`, format `MM/YY`.
6. CVV: `input[name="card.cvv"]`.
7. Submit: `[data-testid="bottom-cta-button"]` (label "Continue").
8. Save-card prompt appears. Decline with
   `button[name="pay_without_saving_card"]` (label "Maybe later").
9. A NEW BROWSER WINDOW opens: the mock bank page at
   `api.razorpay.com/v1/gateway/mocksharp/payment`.
   - Success: `button[data-val="S"]`
   - Failure: `button[data-val="F"]`
10. The popup closes. Back on the original page, completion marker is
    `div.Payment-Completed`.

## Notes that matter for automation

- Step 9 is a POPUP, not a same-tab navigation. Playwright must capture it
  with `page.waitForEvent('popup')` and drive the returned Page object.
- `data-val="S"` / `data-val="F"` are stable attribute selectors. Do not
  match on button text.
- The save-card prompt (step 8) is conditional in principle. Guard it rather
  than assuming it always appears.
- All selectors above are attribute based, so they should survive styling
  changes. The class strings on those elements are Tailwind soup and must
  never be used as selectors.

## Failure branch (observed on gateway_technical_error and card_number_invalid)

No separate branch is needed. Both scenarios follow the identical ten steps
above, including card_number_invalid, which still reaches the mock bank page
rather than rejecting at validation.

After clicking `button[data-val="F"]` the popup closes and the parent page
shows a RETRY SURFACE, not a terminal state:

- Container: `[data-testid="retry-surface"]`
- Heading text: "Payment could not be completed"
- Status line: `[data-testid="retry-description"]` -> "Payment failed"
- Instrument list, each reselectable:
  `[data-testid="card"]`, `[data-testid="paylater"]`, `[data-testid="wallet"]`
- `[data-testid="retry-show-all-options"]`

Success terminal marker: `div.Payment-Completed`
Failure marker:         `[data-testid="retry-surface"]`

## Consequence: one link supports multiple attempts

The retry surface re-exposes `[data-testid="card"]`, so a single payment link
can carry several payment attempts in one browser session. Each attempt
creates a separate payment record on the API side.

Two implications:
1. A 50-attempt batch does not need 50 links.
2. The agent's retry action has a real mechanism. Re-driving the retry
   surface is an actual retry, not a simulated one.

Automation shape: a single `attempt(page, cardNumber, outcome)` function
covers both the first attempt and every retry, since the entry point
(`[data-testid="card"]`) is the same in both states.
