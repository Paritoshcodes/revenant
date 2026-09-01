# Plan: 26 Aug to 5 Sep

Ten days. Two already spent, and they bought the entire gateway plus a fully
characterised Razorpay surface. Nothing below is padding.

## The thesis, one sentence

Most recovery tools tell you how much they recovered. This one tells you how
much it recovered that would not have recovered anyway, and proves its own
measuring instrument is not lying.

## The unlock: orders, not payment links

Payment links are capped at 30 per test account, lifetime. Orders are NOT
(verified 2026-08-25). Checkout.js works against an order served from a
local page (verified during taxonomy testing).

So the batch primitive becomes:

    POST /orders  ->  local checkout page  ->  Playwright  ->  real payment

The 30-link ceiling stops being a project constraint. A 200-payment batch is
achievable, every outcome API-verified. Most submissions will demo five
hand-clicked transactions. Scale is visceral evidence and costs us nothing
but a local HTML page we have already proven works.

## What blows minds, ranked

1. **Calibration.** Run the whole experiment 500 times against a world whose
   true lift we set. Show the 95% CI covers the truth ~95% of the time. On
   real merchant data nobody knows the true lift, so no vendor (Slicker
   included) can run this check. Our synthetic data, the obvious weakness,
   becomes the only place the claim is verifiable at all.

2. **The honest null.** Set the agent policy equal to the baseline so true
   lift is zero, and show the system report "no evidence of incremental
   value, do not deploy". A system willing to declare its own work worthless
   is unforgettable and unfakeable.

3. **The system refusing itself.** Policy proposes a retry, guardrail vetoes
   it, no outbound call, audit event written. On camera.

4. **Tamper-evidence, live.** Run UPDATE against audit_log on screen and
   watch Postgres refuse. Ten seconds, no explanation needed.

5. **Downtime-aware retries.** Razorpay emits payment.downtime.started /
   .updated / .resolved. No third-party dunning tool uses this. "The issuer
   is down right now, hold retries and resume on resolve" is a first-class
   policy input available only because we are on Razorpay's platform.

6. **Open-world taxonomy.** Test mode exposes 3 decline reasons; production
   has far more. A hard-coded grid is closed-world and breaks on the first
   unseen reason. The LLM maps an unseen error_description to a grid cell
   with a confidence, and the guardrail fails closed below threshold. This
   is the answer to "why is this an AI project" and it is testable: hold out
   reasons and measure classification accuracy.

## Where the AI actually earns its place

The current design is `error_code -> grid lookup -> action`, with the LLM
writing an explanation afterwards. That is garnish, and a judge will say so.
AI judgment is one of four scored criteria, so this needs a real answer.

Three jobs the LLM does that a rule cannot:

**Open-world classification.** Map an unseen `error_description` onto the
policy grid with a confidence score. Rules cover what we have observed; the
model covers the tail. Fail closed below a confidence threshold, reusing the
unmapped-cell behaviour already built. Demonstrable: hold out reasons,
measure accuracy, then show it refusing an ambiguous one.

**Context extraction.** Turn the messy payload (error_description prose,
card metadata, timing, attempt history, downtime state) into a structured
diagnosis the policy consumes. The policy stays deterministic and readable;
the LLM does the parsing a regex cannot.

**Narration.** The audit-log explanation and the customer-facing message.
Real work, but never the reason to call this an AI project.

The line that never moves: the LLM never decides whether money moves.

## Day by day

    Aug 26  session 4: contract test, then the orders-based batch primitive
    Aug 27  engine: recovery probability model + deterministic policy
    Aug 28  engine: open-world LLM classifier + confidence gate
    Aug 29  engine: synthetic generator against the frozen protocol
    Aug 30  engine: randomised holdout, bootstrap CI, significance
    Aug 31  engine: calibration harness (coverage + null), the headline proof
    Sep 01  dashboard: batch view, decision trail, audit viewer, two panels
    Sep 02  the full run: 200 payments end to end, API-verified
    Sep 03  README, architecture, prior art, honesty section
    Sep 04  video, buffer
    Sep 05  submit

OPE stays in scope as a stretch on Aug 31 if calibration lands early. It is
secondary evidence and never the headline; the randomised holdout carries
the argument alone.

## Rules for the remaining days

Nothing goes in that does not appear in the five-minute video or answer a
judge's question. Every layer's numbers stay labelled OBSERVED or ESTIMATED
and are never summed. The experiment protocol stays frozen; if a parameter
must change, it is logged with a reason and the run starts over. Run the
smoke script after every browser change, because six bugs so far were found
by browsers and none by tests.

## Demo failure modes, decided in advance (2026-09-01)

The demo depends on three third-party services (Groq, the zrok tunnel,
Razorpay test mode) plus one long-running computation (calibration). Each
gets a decided fallback here, before demo day, not discovered on it.

**Groq unavailable** (rate-limited, key revoked, or the service is down).
`POST /classify` already degrades to `ExactClassifier`-only and returns a
503 with a clear message on a genuine miss (`apps/engine/src/revenant_engine/main.py`).
Decision: demo the exact-match path live, and show the 503/fallback on a
deliberately off-grid example as part of the script -- framed as the
system correctly refusing rather than fabricating a diagnosis. Never rely
on a live Groq call as the centerpiece with no rehearsed fallback if it
fails.

**zrok tunnel down, OR Razorpay's dashboard registration has gone stale.**
Webhook delivery has no polling fallback in this codebase
(docs/API-BEHAVIOUR.md: "No polling fallback needed" was written when the
tunnel was up and stayed up). Confirmed live 2026-09-01
(docs/DECISIONS.md): the zrok tunnel itself came up correctly and routed
a real request to the gateway (an unsigned-probe sub-test passed), and
the driver-vs-API contract held on all 3 cases -- but the real
Razorpay-originated `payment.failed` webhook for that same run never
arrived; the newest row in `webhook_events` is still from 26 August. Since
Razorpay has no webhook-registration API (docs/API-BEHAVIOUR.md section
12: dashboard-only, manual, needs the OTP), the tunnel software working
is not sufficient -- the dashboard's registered URL has to actually match
today's live tunnel, and nothing here confirms it still does. Decision:
the demo does not depend on live webhook delivery at all, regardless of
cause. Show the recorded webhook evidence already in
docs/API-BEHAVIOUR.md and docs/DECISIONS.md instead, and treat
`RUN_LIVE_TESTS=1` webhook coverage as a pre-verified, rehearsed result,
never a live segment. Before the demo, if live webhook delivery is wanted
as a rehearsed (not live) segment, re-register the webhook URL in the
Razorpay dashboard by hand (Settings -> Webhooks, OTP 754081) against the
tunnel that will actually be running that day, and re-verify with
`RUN_LIVE_TESTS=1 npm run test:live` before relying on it.

**Razorpay test mode slow.** The batch runner throttles per
docs/API-BEHAVIOUR.md's measured limits, so a real batch takes real
minutes (a 30-transaction, concurrency-4 run measured 2026-09-01 -- see
docs/DECISIONS.md -- took several minutes end to end). Decision: the live
demo segment uses a small, pre-sized batch (5-10 transactions), chosen
for a bounded, rehearsed run time. The large N=30+ batch and the engine's
100,000-transaction scale figures are pre-recorded, reported results
shown on screen -- never re-run live in front of an audience.

**Calibration runtime.** 2,000 replications (docs/DECISIONS.md,
2026-09-01 scale pass) takes on the order of half an hour; even 500
replications takes several minutes. Decision: calibration is always
precomputed before the demo and shown as a completed dashboard screen. It
is never re-run live under any circumstance -- stated here as a hard
rule the same way docs/EXPERIMENT-PROTOCOL.md states its own frozen
parameters.
