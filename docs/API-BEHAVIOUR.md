# Razorpay API behaviour

DEFINITIVE. Observed live on 2026-08-24 against test key
rzp_test_TTLGluGvmPCtQZ. Raw evidence in tmp/api-probe.json,
tmp/webhook-events.jsonl. Nothing here is inferred from documentation alone.

## 1. Rate limits are PER ENDPOINT and carry Retry-After

This corrects the earlier assumption baked into the throttle.

    GET /payments        25 consecutive reads, ZERO 429s
    POST /orders         7 writes ok, 429 on the 8th, Retry-After: 3
    POST /payment_links  ~5 writes ok, then 429 (needed ~40s to clear)

While /orders was rate limited, GET /payments still returned 200. The limit
is therefore PER ENDPOINT, not a global account budget.

429 body shape:

    { "error": { "code": "BAD_REQUEST_ERROR", "description": "Too many requests" } }

Note this error has NO reason / source / step fields, unlike payment errors.

Design consequences:
  - Reads need no throttle. Do not pace them.
  - Throttle writes PER ENDPOINT, not with one shared window.
  - HONOUR THE `Retry-After` HEADER. /orders asked for 3 seconds, not 40.
    A fixed 40s backoff on every 429 is roughly 13x too slow for /orders and
    would make a 50-attempt batch take many minutes for no reason.
  - Keep an exponential fallback only for when Retry-After is absent.

## 2. Orders are created at FIRST ATTEMPT, not at link creation

    payment link just created      order_id: null
    payment link after an attempt  order_id: order_TTf6ZnUNK63FnK

So a link has no order until someone tries to pay it. Any correlation logic
must tolerate `order_id: null` on a fresh link.

## 3. `payment_link.payments` is USELESS. Use the order.

A link with two real payment attempts still returned `payments: []`. The
array appears never to populate.

Correlate through the order instead:

    GET /orders/<order_id>/payments   -> { count, items: [ full payment objects ] }

That returned the captured payment with its full error triple. It is the
only reliable way to enumerate a link's attempts.

## 4. `order.attempts` is a free server-side attempt counter

    GET /orders/<id>  ->  { status: "paid", attempts: 1, amount_paid: 49900, ... }

Full key set: id, entity, amount, amount_paid, amount_due, currency, receipt,
offer_id, status, attempts, notes, created_at, description, checkout.

Use this to cross-check the `max_attempts` guardrail against Razorpay's own
count rather than trusting only our local `attempts` table. A divergence
means we lost an attempt record and should reconcile.

## 5. Idempotency: confirmed ours to own

    POST /orders        duplicate `receipt`  -> TWO distinct orders, both 200
    POST /payment_links duplicate `reference_id` -> 400

The payment-link rejection body:

    {
      "error": {
        "code": "BAD_REQUEST_ERROR",
        "description": "payment link with given reference_id: <ref> already
                        exists. Please create a payment link with a different
                        reference_id",
        "metadata": [],          // NOTE: an ARRAY here, not an object
        "reason": null, "source": null, "step": null
      }
    }

The client must treat this 400 as "already created, fetch it" rather than a
hard failure, and must not assume `metadata` is an object.

## 6. Pagination

    count max          100. `count=101` -> 400
                       "The count may not be greater than 100." field: "count"
    skip               works; skip=2 returned the next two distinct ids

For batches over 100 payments, page with count+skip. There is no cursor.

## 7. Payment link lifecycle

    create                      status "created"
    POST /payment_links/<id>/cancel  -> 200, status becomes "cancelled"
    cancel an already-cancelled link -> 400
        "cannot cancel or expire a cancelled link"
    cancel a PAID link               -> 400
        "cannot cancel or expire an already paid / partially paid link"
    expire_by                   accepted; minimum future window is ~15 minutes

Statuses seen: created, paid, cancelled. `expired` is documented but was not
observable within the run window.

Cancelling is the clean way to retire a link the agent has finished with, and
the two 400s above are the expected terminal-state responses, not errors to
retry.

## 8. Webhooks: verified end to end

Delivered and signature-verified on 2026-08-24. No polling fallback needed.

    #2 payment.failed  sig=true  eventId=TTjb57UzIl7x8t  status=failed

### Transport

    method        POST
    content-type  application/json
    x-razorpay-signature  HMAC-SHA256 hex over the RAW body, key = webhook secret
    x-razorpay-event-id   unique per event, use for deduplication

Verified: `createHmac('sha256', secret).update(rawBody).digest('hex')` matched
the header exactly. Use a timing-safe compare, and never parse or re-serialise
the body before hashing.

### Envelope

    { entity, account_id, event, contains, payload, created_at }

    event     "payment.failed"
    contains  ["payment"]
    payload   { payment: { entity: {...} } }

`contains` lists which entity keys are present in `payload`, so it can drive
dispatch without guessing.

### The payload entity is IDENTICAL to the REST payment object

Same 31 keys: id, entity, amount, currency, status, order_id, invoice_id,
international, method, amount_refunded, refund_status, captured, description,
card_id, card, bank, wallet, vpa, email, contact, notes, fee, tax, error_code,
error_description, error_source, error_step, error_reason, acquirer_data,
created_at, reward.

Consequence: ONE contract type serves both the API client and the webhook
handler. The redacted samples in data/samples are valid webhook fixtures.

### Operational rules (from Razorpay docs, razorpay.com/docs/webhooks)

  - Respond within 5 SECONDS or the event is retried. Acknowledge first,
    process async. The receiver already does this.
  - Duplicate delivery is expected. Deduplicate on x-razorpay-event-id.
  - ORDER IS NOT GUARANTEED. payment.captured may arrive before
    payment.authorized. Never build a state machine that assumes ordering.
  - Events can be replayed on request within 15 days, using the secret that
    was active at the time.
  - Test-mode dashboard OTP for adding/editing/deleting a webhook: 754081

### Blacklisted webhook hosts

Razorpay rejects these outright: burpcollaborator.net, oast.pro, interact.sh,
canarytokens.com, requestbin.com, webhook.site, hookbin.com, beeceptor.com,
mockbin.org, ngrok.io, loca.lt.

Working setup: local receiver + `cloudflared tunnel --url http://localhost:4000`
(trycloudflare.com is accepted). Razorpay's own docs recommend `zrok`.

### Unsigned requests reach the endpoint

A plain curl with no signature was delivered and logged (row #1,
`sig=null`). The endpoint is public, so signature verification is the ONLY
thing standing between an attacker and forged payment events. Reject any
request whose signature is absent or mismatched, before any processing.

## 9. Full attempt sequence, verified (6 attempts, one link)

    attempt 1  F  pay_TTjie2fIMiyJXj  failed    6.3s
    attempt 2  F  pay_TTjirGijyYgQZ4  failed    5.7s
    attempt 3  F  pay_TTjj4mZIYhUL3t  failed    6.3s
    attempt 4  F  pay_TTjjIz6WqWPLRh  failed    5.8s
    attempt 5  F  pay_TTjjWjalprNwht  failed    6.0s
    attempt 6  S  pay_TTjjkXW7tGeNJz  captured 15.3s

Driver outcome agreed with API status on ALL SIX.

  - A link supports AT LEAST 6 attempts. No ceiling was found. Our
    max_attempts = 3 is a POLICY choice, not a platform limit. Say so.
  - Failures settle in ~6s, captures in ~15s. Success is ~2.5x slower.
    Budget batches accordingly.
  - Each attempt creates its own payment record and its own webhook.

## 10. Webhook ORDERING IS NOT GUARANTEED (observed, not just documented)

Delivery order for the successful attempt:

    #8   payment.authorized   eventId TTjjpb1KpJ1vfv
    #9   order.paid           eventId TTjjrTsKCzH5sE
    #10  payment.captured     eventId TTjjr4s10FcIqM
    #11  payment_link.paid    eventId TTjjsB7bRPLADC

`payment.captured` (TTjjr4s1...) sorts BEFORE `order.paid` (TTjjrTsK...), so
it was generated first and delivered second. Direct proof of out-of-order
delivery, not merely the documented warning.

The handler must be order-independent: treat each event as a fact about an
entity and reconcile, never as a step in a sequence.

Failures emit exactly one `payment.failed` each. The success emitted four
events across three entity types.

## 11. Capturing the payment id from the wire

The `/v1/payments/<id>/authenticate` request is the reliable source, captured
from a CONTEXT-level request listener:

    context.on('request', req => {
      const m = req.url().match(/\/v1\/payments\/([A-Za-z0-9]+)\/authenticate/);
      ...
    })

Reading `popup.url()` after the popup resolves LOSES the id: the popup has
already navigated to mocksharp, especially headless. Confirmed twice.

Caveat found in the probe: reading the captured list immediately after submit
can still miss the newest id by a few ms. Record the list length before
submitting and wait for it to grow, rather than reading the last element.

## 12. Webhook endpoint setup (stable, do this once)

Razorpay has NO API for webhook registration. The dashboard step is manual
and unavoidable. Everything else is scripted.

### The tunnel: zrok v2

zrok v1's `zrok reserve` workflow is GONE in v2. v2 uses namespaces + names.
Every v1 tutorial online is wrong for this binary.

    zrok2 create name -n public revenant           # reserve, once ever
    zrok2 share public localhost:4000 -n public:revenant

On `create name`, `-n` is the NAMESPACE. On `share public`, `-n` is a
`namespace:name` pair. `--share-token` is PRIVATE shares only; it errors on
public ones.

The name persists across share sessions, so the URL is stable forever. That
is the whole point: register it in the dashboard once and never again.

Names are globally unique on the shared instance, lowercase alphanumeric,
4 to 32 chars.

Not usable: webhook.site, ngrok.io, loca.lt are on Razorpay's blacklist.
cloudflared quick tunnels work but the hostname is random per run, which
forces a dashboard re-registration (with OTP) every time. Use zrok.

### Dashboard registration (once)

    Settings -> Webhooks -> Add New Webhook
    URL     : the zrok URL, from WEBHOOK_PUBLIC_URL in .env
    Secret  : RZP_WEBHOOK_SECRET
    OTP     : 754081   (fixed test-mode OTP for add/edit/delete)
    Events  : payment.authorized, payment.failed, payment.captured,
              order.paid, payment_link.paid,
              payment.downtime.started, payment.downtime.updated,
              payment.downtime.resolved

`payment.downtime.*` is not decoration. It reports that a bank or method is
currently degraded, which is a first-class input to the retry policy: it is
the strongest available argument for delaying a retry instead of spending an
attempt. No dunning product we surveyed uses this signal.

Ignore the invoice, settlement, fund_account, refund and engage families.

### Verify before trusting

    curl -X POST https://<zrok-url> -H 'content-type: application/json' -d '{"probe":1}'

The receiver must log it as `sig=null`. If nothing appears, the tunnel is not
routing and registering it in Razorpay would silently fail.

## 2026-08-24 Test-account quota: payment links are capped, orders are not

**UPDATE 2026-08-26: Razorpay lifted this cap on this account**, via the
support ticket referenced below. Payment links are no longer capped.
Everything below this line describes the constraint as it stood on
2026-08-24 and is kept for the record, but the "Consequence for the batch
primitive" section is superseded — see docs/DECISIONS.md, "2026-08-26
Payment-link quota lifted; batch primitive moves back to payment links".
The batch primitive now targets the hosted payment-link surface again.

`POST /v1/payment_links` returned, after 30 links had ever been created:

    { "error": { "code": "RATE_LIMIT_EXCEEDED",
                 "description": "test mode limit of 30 reached for payment_link" } }

Note the code is RATE_LIMIT_EXCEEDED, NOT the BAD_REQUEST_ERROR returned by
a per-window 429. These are different failures and the client must treat
them differently: a 429 is retryable after Retry-After, this one is not
retryable at all and must surface as a hard error.

Confirmed by Razorpay's API reference (Create a Standard Payment Link):
"In test mode, you can create up to 30 Payment Links per business. If you
need to create more than 30 Payment Links for testing purposes, contact
Razorpay Support."

Cancelling does NOT free quota. Verified: cancelled a link in `created`
state, immediately retried creation, same error. Account state at the cap
was 22 created, 6 paid, 1 cancelled, 1 expired.

`POST /v1/orders` is NOT subject to this cap. Created successfully while
payment links were fully exhausted.

### Consequence for the batch primitive (superseded 2026-08-26)

This section described the situation as it stood on 2026-08-24 and is kept
for the record; it is no longer the current design. At the time: building
Layer 1 on payment links put a hard ceiling of 30 on the whole project, so
the batch primitive moved to orders + a locally served checkout page
(`src/browser/checkout-page.ts`, `src/recovery/create-batch.ts`), with
payment links kept for one-off manual testing only.

The support ticket mentioned here landed: Razorpay lifted the cap on this
account. With the ceiling gone, the batch primitive moved back to payment
links, which pass `npm run smoke` cleanly and repeatably, unlike the
order-based surface's still-unexplained intermittent stall
(docs/DECISIONS.md, "Payment-link quota lifted"). The order-based files
are parked on disk, unused, not deleted.

Remaining headroom at time of the 2026-08-24 observation: 21 links still in
`created` state, each supporting at least 6 attempts. Not meaningful now
that the cap itself is gone.

### Both rate-limit failures return HTTP 429

Verified with `curl -w "%{http_code}"`. The per-window limit and the
per-account quota are indistinguishable by status code:

    429 + { error.code: "BAD_REQUEST_ERROR",     description "Too many requests" }
          -> transient, retry after Retry-After

    429 + { error.code: "RATE_LIMIT_EXCEEDED",
            description "test mode limit of 30 reached for payment_link" }
          -> permanent, never retry

So the client MUST inspect `error.code` in the body, not just the status.
Keying on 429 alone would retry a permanent failure until maxRetries is
exhausted, wasting minutes per call and never succeeding.
