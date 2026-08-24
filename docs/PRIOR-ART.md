# Prior art

Read before writing the README or the pitch. Not needed for coding sessions.

We did not invent controlled measurement of payment recovery. Say so first,
unprompted. Getting caught hiding it would be fatal; naming it is a maturity
signal.

## Closest competitor: Slicker (slickerhq.com)

Splits failed payments 50/50 between control and treatment, stratified by
decline code, region, billing cadence and card type, and reports recovered
value with p-values and confidence intervals. Explicitly argues for
incremental lift over gross recovery. This is our statistical thesis,
already commercialised.

What we do that they do not: Indian rails framing, an inspectable bounded
agent with published guardrails and a tamper-evident audit chain, and a
calibration check that is only possible because we authored the world.

## Gross-recovery incumbents (act, but do not measure incrementally)

- Butter Payments: ML retry, claims 70%+ recovery, no holdout
- GoCardless Success+: NSF-only retries, max 3, timed launch experiment
- Churnkey: ML dunning, claims up to 89%
- FlexPay / Revaly: false-decline reversal
- Vindicia Retain: up to 50% of "terminally failed", a filtered subset
- Churn Buster: attribution framework, not randomisation
- Stripe Billing Smart Retries, Recurly, Chargebee, Paddle Retain

All report gross or attributed recovery. None publish a randomised holdout
with confidence intervals as the default output.

## Razorpay's own overlapping products

- Optimizer: AI/ML routing, fallbacks, retries across many integrations
- Failed Payment Recovery: multi-channel retry links after abandonment

Do not pitch "AI that improves payment success". That is Optimizer's
territory. Pitch the layer above it: did the intervention cause the
recovery, or would it have happened anyway?

## The one-line hook

Most recovery systems tell you how much they recovered. This one tells you
how much it recovered that would not have recovered anyway.

## Honesty commitments for the README

- State plainly that Layer 2 is synthetic and why
- State that test mode collapses all bank failures to one reason, with the
  evidence in DECISIONS.md
- Report a null result as a null result
