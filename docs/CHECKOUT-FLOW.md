# Razorpay test-mode checkout flow

DEFINITIVE. Every claim below was observed live on 2026-08-24 against test
key rzp_test_TTLGluGvmPCtQZ, driving both the success and failure paths and
a full fail-then-retry sequence, with each outcome confirmed against the
Razorpay payments API. Nothing here is inferred.

Supersedes all earlier versions of this file. Five driver bugs came from
assumptions recorded before this run. See the build log in DECISIONS.md.

## 1. Everything lives in a cross-origin iframe

    iframe.razorpay-checkout-frame
    src = https://api.razorpay.com/v1/checkout/public?...

The parent page (razorpay.com/payment-link/plink_.../test) has ZERO
data-testid elements and no form inputs.

The frame is CROSS-ORIGIN. `iframe.contentDocument` from the parent returns
null. It is reachable only through Playwright's frame API
(`page.frameLocator(...)` / `.contentFrame()`), never by JS from the parent.

Two unrelated third-party frames are present and must be ignored:
api.sardine.ai (fraud collection) and js.stripe.com.

## 2. Elements appear in stages

    on load            input[name="contact"]  ([data-testid="contactNumber"])
    after contact      [data-testid="card"], netbanking, wallet, paylater,
                       [data-testid="bottom-cta-button"]
    after card click   input[name="card.number"] (type tel)
                       input[name="card.expiry"] (type tel, format MM/YY)
                       input[name="card.cvv"]    (type tel)
                       input[name="save"]        (checkbox, UNCHECKED default)
                       [data-testid="save-card-checkbox"], nav-back

Never assume an element exists before the stage that creates it. Wait for
[data-testid="card"] after filling contact, and for card.number after
clicking the card method.

## 3. The tokenisation (save card) dialog is CONDITIONAL

After clicking Continue on the FIRST attempt of a session:

    [data-testid="overlay-TokenisationBenefits"]
    [data-testid="dialog-TokenisationBenefits"]
    button[name="pay_without_saving_card"]   "Maybe later"    <- dismiss with this
    button[name="pay_and_save_card"]         "Yes, secure my card"

It appeared on attempt 1 and did NOT appear on the retry in the same
session. It is NOT tied to the `save` checkbox: the checkbox is unchecked
by default and the dialog still appeared. Unchecking it does not suppress
the dialog.

Therefore: guard this step. Poll briefly for the button and click it only
if present. Never block on it.

## 4. The popup: two URLs, and it carries the payment ID

`waitForEvent('popup')` resolves on a window whose INITIAL url is:

    https://api.razorpay.com/v1/payments/<PAYMENT_ID>/authenticate

It then navigates to the mock bank page:

    https://api.razorpay.com/v1/gateway/mocksharp/payment?key_id=rzp_test_...

Two consequences.

**Wait for the right URL.** `waitForLoadState('domcontentloaded')` fires on
the intermediate authenticate page, which has no buttons. Use:

    await popup.waitForURL('**/gateway/mocksharp/**')

**Capture the payment ID from the initial URL.** The `<PAYMENT_ID>` segment
is the Razorpay payment id without the `pay_` prefix. Verified twice:
popup `.../payments/TTeXtRlUAZDA0r/authenticate` produced
`pay_TTeXtRlUAZDA0r`, and the retry's `.../payments/TTeZ2u1jK7dWCu/...`
produced `pay_TTeZ2u1jK7dWCu`. This is how the driver correlates a browser
attempt with its API record. There is no other reliable way.

## 5. The mock bank page

    url      api.razorpay.com/v1/gateway/mocksharp/payment?key_id=...
    success  button[data-val="S"]   class "success"   text "Success"
    failure  button[data-val="F"]   class "danger"    text "Failure"
    form     posts to /v1/gateway/mocksharp/payment/submit
             hidden inputs: callback_url, language_code, success

No data-testid attributes on this page. `data-val` is the stable hook.

## 6. Outcome detection (this is where bugs 3 and 5 came from)

### The trap

`[data-testid="payment-status-heading"]` is a PROGRESS INDICATOR, not an
outcome. Observed timeline on the FAILURE path after clicking data-val="F":

    t+400ms    heading "Processing your payment"    retry-surface false
    t+800ms    heading "Confirming Payment"         retry-surface false
    t+1500ms   heading "Confirming Payment"         retry-surface false
    t+3000ms   heading "Confirming Payment"         retry-surface false
    t+6000ms   heading null                         retry-surface TRUE
    t+10000ms  heading null                         retry-surface TRUE

Waiting on the heading's EXISTENCE resolves at ~400ms and reports success on
a payment that failed. This shipped and was caught only by a live run.

`[data-testid="payment-status-modal"]` wraps BOTH outcomes. Useless as a
discriminator. Never key on it.

### On SUCCESS the checkout frame DETACHES

Sequence: heading passes through "Processing your payment" and "Confirming
Payment", reaches "Payment Successful" with
`[data-testid="payment-status-timer-message"]` reading "You will be
redirected in 5 seconds", then the frame is torn down and the PARENT page
renders the result.

A driver polling the frame across this transition throws
"Frame was detached". That error means success is in progress; it must not
be treated as a failure.

Terminal success state, on the PARENT page:

    div.Payment-Completed   text "Payment Completed"

Parent body also contains "Payment ID: <PAYMENT_ID>" in plain text, a second
way to correlate the attempt.

### Correct algorithm

Poll until one of these holds, timeout >= 30s:

    PARENT  document.querySelector('.Payment-Completed')   -> captured
    FRAME   [data-testid="retry-surface"] present          -> failed
    FRAME   heading text === "Payment Successful"          -> captured (early)

Rules:
  - Never resolve on heading existence. Only on its exact text.
  - Treat "Frame was detached" as keep-polling, then check the parent.
    It is a success signal, not an error.
  - The failure path takes about 6 seconds to settle. Budget for it.

## 7. The retry loop, executed end to end

Verified: one payment link, two attempts, fail then capture.

    attempt 1  bank Failure  -> pay_TTeXtRlUAZDA0r  failed
                                 payment_failed / gateway / payment_authorization
    attempt 2  bank Success  -> pay_TTeZ2u1jK7dWCu  captured  auth_code 616381

Both ids matched the popup URL captured at click time. Each attempt creates
a SEPARATE payment record.

After a failure, the retry surface re-exposes the entry point:

    [data-testid="retry-surface"]
    [data-testid="retry-description"]  text "Payment failed"
    [data-testid="card"]        exactly 1 match, no strict-mode ambiguity
    [data-testid="paylater"], [data-testid="wallet"]
    [data-testid="retry-show-all-options"]
    [data-testid="bottom-cta-button"]  exactly 1 match

Clicking [data-testid="card"] dismisses the retry surface and returns to the
card form.

**The card fields RETAIN their previous values.** After the retry click,
card.number still held "4100 2800 0000 1007", expiry "12 / 30", cvv "123".
A recovery action that switches to a different instrument MUST clear the
fields first. Playwright's `fill()` clears; a native value setter or `type()`
appends. This has not bitten us yet only because the retry reused the same
card.

Note the tokenisation dialog did NOT reappear on the retry (see section 3).

## 8. Values that work

    contact   9000090000
    card      4100 2800 0000 1007   (domestic Visa debit, per Razorpay docs)
    expiry    12/30                 (any future date)
    cvv       123                   (any 3 digits)

The bank page button, not the card number, determines the outcome. The
documented error-simulation cards do NOT reproduce their specific
error_reason values on this account; every bank-page failure returns
`payment_failed / gateway / payment_authorization`. See DECISIONS.md.

## 9. Field entry note

Card inputs are React-controlled. Setting `.value` directly does not
register. Use Playwright's `fill()`, or the native prototype setter followed
by dispatched `input` and `change` events (both bubbling). The fields
reformat on entry: "4100280000001007" renders as "4100 2800 0000 1007" and
"12/30" as "12 / 30", so never assert on raw equality of the field value.

## 10. Open questions, resolved 2026-08-24 (scripts/probe-open-questions.mts)

Raw output in tmp/open-questions.json. NOTE: two of the script's own
auto-generated `conclusion` strings were wrong. The conclusions below are
read from the raw fields, not from those strings.

### Abandonment creates NO payment record

Filled contact and card details, closed the context without submitting.
Evidence scoped to that link:

    payment_link.status        "created"
    payment_link.amount_paid   0
    orders/<id>/payments       0 items

(The script's `newPaymentRecords` list was polluted by payments from an
earlier session because its baseline filter only held one prior id. Ignore
it; `orderPaymentCount: 0` is decisive.)

Consequence: abandonment is INVISIBLE at GET /payments. Detect it from
`payment_link.status` still being "created", or from an order with zero
payments. An agent that only polls /payments will never see an abandoned
checkout.

### There is NO OTP page on this account

The popup is always the mock bank page with Success/Failure buttons. Its
only inputs are three hidden fields (callback_url, language_code, success).
Body text: "This is just a demo bank page."

Consequence: the documented "OTP under 4 digits fails the payment" flow does
not exist here. Drop any OTP-based recovery action from the action menu.

### A single link supports at least 3 attempts

    attempt 1  Failure -> failed
    attempt 2  Failure -> failed
    attempt 3  Success -> captured

All on one payment link, in one browser session. The retry surface reappears
after each failure. Batch sizing can assume >= 3 attempts per link.

### A PAID link does not offer a payable checkout

After capture, reopening the link shows:

    .Payment-Completed  present (1)
    body text           "Payment Completed ... You have successfully paid"
    payment_link.status "paid", amount_paid 49900

(`hasCheckoutFrame: true` is a leftover element and is NOT evidence the
checkout is payable. The script's conclusion string got this wrong.)

Consequence: one capture ends the link. Before any attempt, the driver must
check for `.Payment-Completed` on load and check `payment_link.status`
server-side. Re-driving a paid link would otherwise risk phantom attempts.

## 11. Payment ID capture is TIMING-SENSITIVE

The popup's URL sequence is:

    1. https://api.razorpay.com/v1/payments/<PAYMENT_ID>/authenticate
    2. https://api.razorpay.com/v1/gateway/mocksharp/payment?key_id=...

The payment id exists ONLY in step 1. Reading `popup.url()` after the popup
has settled returns the mocksharp URL, which contains no payment id. In the
probe run this produced `payIdFromUrl: null` on all three attempts even
though the mechanism works.

Correct capture, at popup creation:

    const popup = await popupPromise;
    const payId = popup.url().match(/\/payments\/([A-Za-z0-9]+)\//)?.[1] ?? null;
    // read it HERE, before waitForURL('**/gateway/mocksharp/**')

If the popup has already navigated by the time the handler runs, fall back
to `popup.on('framenavigated')` and capture the first URL seen, or read the
id from the parent page's "Payment ID: <ID>" text after a capture.

Belt and braces: on success the PARENT page body contains
"Payment ID: <PAYMENT_ID>" in plain text. That is a reliable second source
for captured payments, but it does not exist for failures, so the popup URL
remains the only universal path.

A test must assert that the id is captured BEFORE the mocksharp navigation,
or this silently regresses to null and the contract test loses its ability
to correlate.

## 12. Final gap closure, driven manually 2026-08-24

Four remaining uncertainties resolved by hand in a real browser, not by a
script. Each finding below was observed directly.

### THIRD real taxonomy class: cancellation

A payment abandoned AFTER submit (popup opened, neither bank button clicked)
resolves to:

    payment_cancelled | customer | payment_authentication

Full sequence, verified on pay_TTf77VQJupE6KI:

    at submit, popup open      status "created", all error fields null
    after popup closed (<60s)  status "failed", payment_cancelled,
                               customer, payment_authentication
    stable thereafter

This means the real observed taxonomy is THREE classes, not two:

    payment_failed                        gateway   payment_authorization
    payment_cancelled                     customer  payment_authentication
    international_transaction_not_allowed business  payment_initiation

The `customer` row of the policy grid is REAL, not synthetic. It maps to
"nudge, do not auto-retry".

### `status: "created"` is the real `pending` state

While the bank page is open and unanswered, the payment sits at
`status: "created"` with no error fields. This is exactly the schema's
`pending` attempt state, and it validates the reconcile-stale-pending design:
fetch the payment from Razorpay rather than assuming failure.

Distinguish carefully:
  - abandoned BEFORE submit  -> no payment record at all; the payment link
    stays "created" with amount_paid 0 and its order has zero payments
  - abandoned AFTER submit   -> a payment record exists, "created" then
    "failed"/payment_cancelled

### Cancellation is distinguishable in-browser

Closing only the popup leaves the parent alive and shows the retry surface
with a DIFFERENT description:

    bank failure   [data-testid="retry-description"] "Payment failed"
    cancellation   [data-testid="retry-description"]
                   "Your payment has been cancelled. Try again or comp..."

So the driver can tell a decline from a cancellation without calling the API.

### "Payment Successful" IS observable, but the window is ~5s and tight

Discrete probes after clicking Success on the bank page:

    probe 1   heading "Confirming Payment"    timer ""
    probe 2   heading "Payment Successful"    timer "You will be redirected in 1 seconds"
    probe 3   heading null                    (frame torn down)
    parent    .Payment-Completed present, "Payment ID: TTf9TKtdKTngA6"

The heading reaches "Payment Successful" alongside a 5 second countdown,
then the frame detaches. Probe 2 caught it with ONE second left, so the
margin is real but thin.

Design consequence. The PARENT marker `.Payment-Completed` is permanent and
raceless and must be the PRIMARY success signal. The frame heading is an
optional early exit only. A driver that depends on the heading can miss the
window entirely and then hit a detached frame.

Earlier confusion resolved: a long polling loop running INSIDE a single
`evaluate` spans the teardown and throws "Frame was detached", losing
everything collected. Poll with short discrete round trips, not one long
in-page loop.

### A paid link is not interactive

Reloading a captured link:

    .Payment-Completed         present on load
    iframe element             exists, but 0x0 and offsetParent null
    body                       "Payment Completed ... You have successfully paid"

The iframe element being present is NOT evidence the checkout is usable.
Check `.Payment-Completed` on load, and check payment_link.status
server-side, before attempting.

### The tokenisation dialog does not depend on the card

    attempt 1, card 4100 2800 0000 1007   dialog PRESENT
    attempt 2, card 5555 5100 0008 1006   dialog ABSENT

Confirmed once per session, not per card. Guard it either way.

### Popup intermediate states, all three observed

    https://api.razorpay.com/v1/payments/<ID>/authenticate   (carries the id)
    about:blank  title "Processing, Please Wait..."
    https://api.razorpay.com/v1/gateway/mocksharp/payment?key_id=...

Never assume the popup's first URL is the bank page. Always
`waitForURL('**/gateway/mocksharp/**')`, and read the payment id before that.

### Clearing a retained field

Setting the native value to '' with an `input` event, then setting the new
value, works: "4100 2800 0000 1007" became "5555 5100 0008 1006" cleanly.
Playwright's `fill()` does the same. A bare setter without the clear step
would corrupt the field.
