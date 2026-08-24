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

## CORRECTION 2026-08-24: the checkout is inside an iframe

The ten step flow above is accurate about the sequence and the selectors,
but wrong about where they live. Everything from the contact field onward is
inside an iframe, not the top-level page:

    iframe.razorpay-checkout-frame
    src = https://api.razorpay.com/v1/checkout/public?...

Frame dump of a payment link page (scripts/frames.mts):

    razorpay.com/payment-link/plink_.../test      contact=0  card=0
    api.razorpay.com/v1/checkout/public           contact=1  card=0
    api.sardine.ai/... (fraud collector)          contact=0  card=0
    js.stripe.com/v3/controller-...               contact=0  card=0

Implications for the driver:

- All element interaction goes through the checkout frame, e.g.
  `page.frameLocator('iframe.razorpay-checkout-frame').locator(sel)`.
- `waitForEvent('popup')` and `screenshot()` stay at PAGE level. The mock
  bank page is a real popup window, not a frame.
- `card=0` in the checkout frame on load: the payment method list does not
  exist until the contact number has been entered. Fill contact, then wait
  for `[data-testid="card"]` to appear. Do not assume both are present.
- `[data-testid="retry-surface"]` is in the checkout frame. Whether
  `div.Payment-Completed` is in the frame or the parent is UNVERIFIED;
  check both before trusting either.
- Do NOT use `waitUntil: 'networkidle'` on these pages. Razorpay checkout
  polls continuously, so the network never goes idle and goto times out
  after 30s. Use `domcontentloaded`.

Two unrelated third-party frames (Sardine fraud collection, Stripe) are
present on the page and should be ignored.

## VERIFIED 2026-08-24 via scripts/recon.mts (payment_timed_out, live run)

Everything below is observed, not inferred. Raw dump in tmp/recon.json.

### Frame boundary
The parent page (`razorpay.com/payment-link/plink_.../test`) has ZERO
data-testid elements, zero inputs, and never carries the outcome markers.
Every interactive element is in `iframe.razorpay-checkout-frame`.

### Element availability by stage (checkout frame)

    on load            input[name=contact], contactNumber
    after contact      card, netbanking, wallet, paylater, bottom-cta-button
    after card click   card.number, card.expiry, card.cvv, save,
                       save-card-checkbox, nav-back, bottom-cta-button
    after continue     overlay-TokenisationBenefits, dialog-TokenisationBenefits
                       (the save-card prompt)
    after failure      payment-status-modal, retry-surface, retry-description,
                       card, paylater, wallet, retry-show-all-options

The method list does not exist until contact is filled. The card fields do
not exist until the card method is selected.

### The save-card prompt
Rendered as `dialog-TokenisationBenefits` inside an
`overlay-TokenisationBenefits`. Dismiss with
`button[name="pay_without_saving_card"]` ("Maybe later").
It WAS present on this run. There is also a `save-card-checkbox` /
`input[name="save"]` on the card form; unchecking it before Continue may
suppress the dialog entirely. UNTESTED.

### The popup is not the bank page when it opens
`waitForEvent('popup')` resolves on a window whose initial URL is
`api.razorpay.com/v1/checkout/public` (same session token as the frame),
with no buttons. It navigates to the mocksharp bank page afterwards.

`waitForLoadState('domcontentloaded')` therefore fires on the WRONG page.
The driver must wait for the mocksharp URL explicitly:

    await popup.waitForURL('**/gateway/mocksharp/**')

Clicking `button[data-val="F"]` without that wait only works by timing luck.

### Retry loop is safe
After failure the frame contains exactly ONE `[data-testid="card"]`, so no
strict-mode violation when re-entering the flow. `bottom-cta-button` is
still present. Note `card.number` remains visible in the DOM after failure,
so do not assume the Cards option must be clicked again before filling.

### Still unverified
Where `div.Payment-Completed` lives. This run took the Failure path, so the
success marker never rendered. Needs one success run before the driver can
trust it.

### Outcome detection: `div.Payment-Completed` DOES NOT EXIST in the checkout

Verified across a success run and a failure run. `.Payment-Completed` is
absent from both the parent page and the checkout frame at every stage. The
earlier note claiming it was the success marker was mistaken; it appears (if
at all) on the parent only AFTER the checkout's own 5 second redirect.

Real markers, both inside `iframe.razorpay-checkout-frame`:

    success   [data-testid="payment-status-heading"]  text "Payment Successful"
              [data-testid="payment-status-timer-message"]
                                        "You will be redirected in 5 seconds"
    failure   [data-testid="retry-surface"]
              [data-testid="retry-description"]  text "Payment failed"

`[data-testid="payment-status-modal"]` wraps BOTH outcomes and is useless as
a discriminator. Do not key on it.

Do not wait for the parent redirect. `payment-status-heading` resolves
immediately, so waiting costs 5 seconds per successful attempt across the
whole batch for no information gain.

### Mock bank page, confirmed

    url      api.razorpay.com/v1/gateway/mocksharp/payment?key_id=...
    success  button[data-val="S"]  class "success"  text "Success"
    failure  button[data-val="F"]  class "danger"   text "Failure"

No data-testid attributes on that page; `data-val` is the stable hook.
Reached only after `popup.waitForURL('**/gateway/mocksharp/**')`.
