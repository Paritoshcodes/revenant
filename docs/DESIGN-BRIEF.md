# Dashboard design brief

Written 2026-08-27, before any UI work. Build this on 1 September per
docs/PLAN.md, after the engine produces real numbers. Designing against
invented data means building it twice.

## The thesis

Not a prettier dashboard. An instrument panel that reports on itself.

Every comparable product is a record of things done, aggregated, with the
uncertainty stripped out. This one shows what it did, what it deliberately
did not do, how confident it is, and lets you take the headline number
apart down to the rows that produced it.

## What competitors show (researched 2026-08-27)

Slicker is the closest product and the most instructive. Their own
marketing says most recovery tools lack A/B testing to verify incremental
lift, and that Slicker splits traffic 50/50, measures dollars recovered
against a control group, and reports the p-value. But that lives in the
EVALUATION period, as proof shown before purchase. The production
dashboard they describe is a "recoverable-revenue dashboard ... a single
view of exactly how much revenue has been saved". Gross recovery, once you
are a customer.

One thing of theirs worth taking: a "Transparent AI Engine" with
click-through logs so finance teams can inspect and audit every action.

Best statistical UI pattern found: Spotify's Confidence. It shows a point
estimate and CI on a relative scale, then converts it into a
RECOMMENDATION (Ship / Continue / End). "End" fires when all success
metrics are powered but none is significant. The honest-null is a
first-class product state, not an error.

## What NOBODY shows (this is the differentiation)

1. The control group in production. Shown during evaluation, then dropped.
2. The counterfactual explicitly: "of the X recovered, Y would have
   recovered anyway."
3. Deliberate inaction. Every dashboard records things done. None shows
   "we declined to retry these N payments and here is why", even though
   that is correct behaviour on a terminal decline and a real cost avoided.
4. Cost of action. Recovery is always gross, never net of retries
   attempted, API calls burned, customer contacts spent.
5. Their own uncertainty. No error bars on the headline number.
6. A null result. Only 14-20% of experiments reach significance, so
   inconclusive is the NORMAL case, and almost nobody designs a screen for
   it.
7. Reconciliation to raw rows. A real Eppo review complains that the
   calculated lift differs from hand-calculating control vs variation and
   that it is hard to explain to stakeholders why. That is exactly the
   failure zero-abstraction answers.

## The five screens

**1. Batch, live.** A run in progress. Transactions as rows, arm visible,
attempts accumulating, money counting up. Guardrail vetoes arrive as
interruptions, not log lines. This is the screen that proves the system is
real and touching Razorpay.

**2. The number.** The headline: incremental recovered value with its
confidence interval, OBSERVED and ESTIMATED strictly separated and never
summed. Below it, the reconciliation: treatment total, control total,
difference, and the arithmetic laid out so a viewer can check it by hand.
Steal Confidence's recommendation pattern: the screen states a verdict
(deploy / keep running / no evidence of value) derived from the interval,
not just the numbers.

**3. Decisions, including refusals.** Every transaction: the diagnosis, the
grid cell, the proposed action, the guardrail verdict, the outcome. Filter
to refusals alone. This is the screen no competitor has.

**4. The chain.** The audit log as a chain, verifiable in the browser. A
button that attempts to tamper with a row and shows Postgres refusing it.
Ten seconds, no explanation needed.

**5. Calibration.** The coverage result: across N replications against a
world whose true lift is known (5.47pp, frozen in
apps/engine/config/ground-truth.json before any run), how often did the 95%
interval contain the truth. Plus the null case. This is the screen that
proves the instrument, and no vendor can build it because on real merchant
data nobody knows the true answer.

## Motion

Motion serves comprehension, never ambience. A dashboard reporting on
measurement integrity gains credibility from restraint; ambient animation
reads as compensating for something. Every serious financial tool
(Bloomberg, Stripe's own dashboards, Mercury, Ramp) is visually quiet on
purpose.

Animate exactly these:
- money counting up as a batch settles
- a confidence interval drawing itself as bootstrap resamples complete
- a chain link breaking on a tamper attempt
- a guardrail veto arriving, as an interruption
- row state transitions in the live batch

Everything else holds still. 60fps on what moves, nothing moving that
should not.

## Zero abstraction

Every number is clickable down to the rows that produced it. The headline
interval opens the bootstrap distribution. A cell's contribution opens its
transactions. A recovered total opens the payment ids, and those are real
Razorpay ids that can be checked against the API. If a viewer wants to
verify the arithmetic by hand, the interface must let them.

## Naming

Do not use the rupee mark in place of the R. It reads as a naming gimmick
to a payments audience, and it breaks in a terminal, a README, a repo name
and a video title. If wanted at all: favicon only.

## Tooling

Install before the UI sessions begin:

    npx skills add Leonxlnx/taste-skill
    npx skills add https://github.com/vercel-labs/agent-skills --skill web-design-guidelines

Reference: https://github.com/voltagent/awesome-design-md

Iterate with Playwright driving a real browser: screenshot at multiple
viewports, fix spacing, contrast, alignment and motion timing directly.
That is the same loop that found nine driver bugs.

## Design language reference

Restraint, precision, typography and spacing discipline. Look at Linear,
Stripe's dashboard, Mercury, Ramp, Vercel, Resend. Tabular/monospace
numerals for money so figures align in columns. One accent colour, used
sparingly, ideally reserved for recovered value alone.
