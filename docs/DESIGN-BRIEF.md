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

---

# PART TWO: the build spec

Written 2026-09-01, after the design direction was settled. Everything
above this line is the research and the thesis. Everything below is what
gets built.

## Direction, decided

Dark, dense instrument panel. Linear and Bloomberg, not a marketing site.

The tension worth naming: an awwwards site is judged on surprise, a
financial instrument is judged on whether you believe the number. This
project's whole argument is honest measurement, so scroll-jacking,
parallax and decorative motion would actively undercut it. The craft goes
into instrument design instead, which is rarer and harder: motion that
reveals system behaviour, executed with real choreography at 60fps.

The wow is a bootstrap distribution forming as 10,000 resamples land, a
hash chain breaking when you try to tamper with it, a guardrail veto
interrupting a running batch. Not ambience.

## Feature inventory: what exists, and where it goes

Everything the system can currently produce, mapped to a screen. Nothing
is invented; if it is listed here, an endpoint or a table already
returns it.

**Screen 1, Batch (Layer 1, OBSERVED).** Source: `run-batch.ts`,
`transactions`/`attempts`/`decisions` tables.
- transactions as rows: id, grid cell, amount, arm, action, attempts,
  outcome
- live progress as a run executes, or replay of a completed run
- captures, failures, guardrail vetoes with their reason strings
- recovered value per arm, in paise, labelled OBSERVED
- elapsed time, links created, executor calls per transaction
- the LAYER1_CAVEAT text, always visible, never dismissible

**Screen 2, The Number (Layer 2, ESTIMATED).** Source: `/experiment`.
- recovery-rate difference in pp with its 95% bootstrap interval
- recovered-value difference in paise with its interval
- per-arm recovery rate and mean recovered value
- the two-proportion z-test, labelled secondary
- the amount-band cut points, the seed, N
- a verdict line derived from the interval: deploy / keep running /
  no evidence of value
- the reconciliation: treatment total, control total, difference, laid
  out so a viewer can check the arithmetic by hand

**Screen 3, Decisions.** Source: `decisions` table, `/propose`,
`/classify`.
- per transaction: diagnosis, grid cell, proposed action, recovery
  probability, guardrail verdict, outcome
- filter to refusals alone. No competitor has this screen
- the policy grid itself: 7 cells, their failure class, designated
  action, and whether observable in test mode
- classifier results where one ran: failure class, candidates with
  scores, the margin, whether the gate refused

**Screen 4, The Chain.** Source: `audit_log`, `verifyChain`.
- the chain as a sequence, each row's prev_hash linking to the last
- a verify action that walks it and reports the first break, if any
- a tamper action that attempts an UPDATE and shows Postgres refusing it
- guardrail vetoes as first-class events in the chain, not flags

**Screen 5, Calibration.** Source: `/calibration`, precomputed.
- coverage: 0.938 over 2000 replications, Wilson [0.9266, 0.9478]
- the estimand, 5.4673pp, from `compute_true_lift()`, frozen before any
  run
- the null condition: containment and rejection rates
- the sample mean and SD of the point estimates
- the pooled-versus-stratified comparison, both on record: pooled 38%
  too wide, stratified 6.5% too narrow, and the diagnosis in between
- stated plainly: the interval excludes nominal, the estimator is
  slightly anti-conservative, no third variant was attempted

## Customisation

Visibility control, not layout building. A viewer can collapse or hide
any section, and go from "show me everything" to "just the number" and
back. Preference persists across reloads. No drag-and-drop, no saved
layouts, no widget grid.

## Motion: what animates, and why

Every entry below earns its place by revealing something about the
system. If a motion could be removed without losing information, it is
removed.

### Batch, live
- Rows enter as transactions are created, staggered ~20ms apart. Not
  decorative: the stagger IS the throttle, made visible.
- Attempt counters tick. Outcome resolves with a colour and weight
  change, not a bounce.
- Recovered value counts up, easing out, with tabular numerals so digits
  do not shift laterally.
- A guardrail veto INTERRUPTS: the row halts mid-flight, the reason
  string arrives, and the running total visibly does not move. The
  absence of movement is the point.
- The circuit breaker, if it fires, stops every in-flight row at once.

### The statistics
- The confidence interval draws itself outward from the point estimate
  as bootstrap resamples land. Duration proportional to real resample
  progress where possible, not a fixed timer.
- The bootstrap distribution forms as a histogram filling in, with the
  2.5 and 97.5 percentile lines settling last.
- The verdict line resolves only after the interval settles. It must
  never appear before the evidence it rests on.
- Null result: when the interval contains zero, it renders in a distinct,
  deliberately unexciting state. "No evidence of value" gets the same
  visual weight as a positive result, never less.

### The chain
- Links form sequentially as the chain loads, each connecting to the
  previous. The visual is the data structure.
- Verify walks the chain: a travelling highlight, resolving to intact.
- Tamper is the set piece. The attempted row flashes, Postgres refuses,
  the link snaps and stays broken until dismissed. Roughly 800ms, once,
  no loop.

### Navigation
- Shared-element transitions between screens: a transaction row in Batch
  expands into its detail in Decisions rather than cross-fading.
- Screens hold their scroll and filter state.

### Hard rules
- 60fps means transform and opacity only. No animating layout
  properties, no width/height/top/left.
- Respect `prefers-reduced-motion`: everything still works, motion
  reduces to instant state change.
- Nothing loops. Nothing moves while idle. A page reporting on
  measurement integrity that fidgets reads as compensating.
- Every animation is interruptible. A viewer who clicks through fast
  must never wait on a transition.

## References worth stealing from, and what specifically

- Linear: transition timing, keyboard-first interaction, the way state
  changes feel instant while still being animated
- Stripe dashboard: dense numeric tables that stay readable
- Vercel deployments and GitHub Actions: live progress that conveys real
  work happening, staged rather than a spinner
- Git commit graphs and blockchain explorers: chain visualisation, for
  Screen 4
- Observable and D3: distribution and interval rendering that is precise
  rather than pretty
- Bloomberg: information density without visual noise

## Typography and colour

- Tabular numerals everywhere a figure appears. Money and percentages
  must align in columns and must not shift width as they animate.
- One accent colour, reserved for recovered value. Nothing else uses it.
- Distinct, non-accent treatment for refusals and vetoes: these are
  correct behaviour, not errors, and must not read as red-alarm.
- OBSERVED and ESTIMATED are visually distinct at a glance and never
  adjacent in a way that implies they can be summed.

## Zero abstraction

Every number opens the rows behind it. The headline interval opens the
bootstrap distribution. A grid cell's contribution opens its
transactions. A recovered total opens real Razorpay payment ids, which
can be checked against the API. If a viewer wants to verify the
arithmetic by hand, the interface must permit it.

## Build order

1. Design system and shell: tokens, typography, spacing, motion
   primitives, navigation, empty and loading states. No data.
2. Screens 2 and 5 (The Number, Calibration) against real engine output.
   These carry the argument.
3. Screen 1 (Batch) against real gateway data.
4. Screens 3 and 4 (Decisions, Chain).
5. Visibility controls and persistence.
6. Polish pass with Playwright: screenshot every screen at three
   viewports, fix spacing, contrast, alignment, motion timing.

---

# PART THREE: the concept

The first build attempt produced a wireframe with dark mode applied. It
failed because Parts One and Two gave a feature inventory and motion
rules but no CONCEPT. Sections with labels, no spine. Nothing to make it
cohere, so no amount of animation could have saved it.

This part supplies the spine. Nothing gets built until it is understood.

## The conceit: an evidence console

Revenant acts on money and then proves whether its actions mattered.
Everything it produces is EVIDENCE of a different class, and the
interface is where that evidence is examined.

This is not a metaphor bolted on. It is literally what the system is:

- the hash-chained audit log IS a chain of custody
- OBSERVED and ESTIMATED ARE evidence classes that must never be conflated
- a guardrail veto IS a recorded refusal to act, entered into the record
- the calibration IS instrument verification, run against a known
  reference before the instrument was ever used on a real sample
- every figure IS reducible to the rows it came from

So the interface is a forensic console. Cold, precise, serious. It does
not sell you the number. It hands you the number, its provenance, its
uncertainty, and the instrument's own calibration certificate, and lets
you decide.

The vocabulary follows from that and must be used consistently:

    EXHIBIT      a figure you can open to its underlying rows
    CUSTODY      the hash chain, unbroken or broken at a named seq
    CLASS        OBSERVED (Layer 1) or ESTIMATED (Layer 2)
    REFUSAL      a guardrail veto, recorded as evidence, never as an error
    INSTRUMENT   the estimator, with its own calibration record
    REFERENCE    the frozen true lift, 5.4673pp, fixed before any run

Never use generic dashboard words where one of these applies. No
"Overview", no "Insights", no "Analytics".

## What this is NOT

Not the portfolio's broadcast conceit reused. No ON AIR, no channels,
no timecode, no REC dot. That belongs to paritoshsingh.me and copying it
here would read as a template.

Not an awwwards site. No scroll-jacking, no parallax, no cursor
followers, no ambient particles. A page arguing that its own numbers are
honest loses that argument the moment it starts performing.

The craft goes into instrument design, which is rarer and harder than
decoration.

## The signature moments

Five, in priority order. Each is a specific, choreographed sequence, not
a transition. If a build has no budget left, the earlier ones survive.

### 1. Instrument check, on load

The console does not appear. It comes up. A cold-start sequence,
1.2 to 1.8 seconds, that reads as an instrument self-testing:

    contracts loaded              7 grid cells, 10 decline reasons
    reference fixed               5.4673pp, committed 2026-08-27
    instrument calibrated         coverage 0.938 [0.9266, 0.9478]
    custody chain                 verified, N links, unbroken
    evidence classes              OBSERVED / ESTIMATED, never summed

Each line resolves in sequence with its real value counting or ticking
into place, then the console reveals. Skippable on click or key, and
skipped entirely on repeat visits within a session.

This is the equivalent of the portfolio's "CALIBRATING INSTRUMENT 00%",
but stating this system's own facts. It establishes the conceit in under
two seconds and every number in it is real.

### 2. The interval draws itself

On The Number. The point estimate lands first. Then the bootstrap
distribution fills in as a histogram, left to right, ~900ms. Then the
2.5 and 97.5 percentile lines slide inward and settle. Only then does
the verdict line resolve.

The order is the argument: evidence, then uncertainty, then conclusion.
The verdict must never appear before the interval it rests on.

If the interval contains zero, the verdict renders "NO EVIDENCE OF
VALUE" in the same weight and the same position as a positive result.
Not smaller, not greyed. The system reporting its own null is the point.

### 3. The refusal interrupt

On Batch. A row is mid-flight. The guardrail vetoes. The row stops where
it is, the reason string types into the row itself, and the running
total does not move. Hold for a beat. Then the row settles into a
distinct REFUSED state, not an error state.

The absence of movement in the total is the whole effect. Everything
else on screen keeps going.

### 4. Custody break

On The Chain. Links render as a connected sequence. A TAMPER control
attempts an UPDATE against audit_log. Postgres refuses. The targeted
link flashes, the connector snaps, the break holds with the failing seq
named, and the Postgres error text appears verbatim.

Roughly 800ms, once, no loop, dismissible. This is the shortest and most
visceral proof in the project.

### 5. Exhibit expansion

Everywhere. Any figure opens to the rows behind it via shared-element
transition: the figure itself moves and becomes the header of the
expanded view. Never a modal fade. Escape closes and the figure returns
to where it was.

This is what makes zero-abstraction feel designed rather than like a
drilldown menu.

## The persistent status rail

Fixed, always visible, top or side. This is what makes it read as an
instrument rather than a webpage. It carries, at all times:

    CLASS       which evidence class the current screen shows
    SEED        the seed of the run being examined
    REFERENCE   5.4673pp, and that it was frozen before any run
    CUSTODY     chain state: N links, verified or broken at seq X
    SOURCE      live or precomputed, and when

Values in it update with a tick, never a fade. A viewer glancing at it
should always know what they are looking at and how much to trust it.

## Interaction

Keyboard-first, like the portfolio.

    1-5         jump to screen
    j / k       move between rows
    enter       open the focused exhibit
    esc         close, return focus to origin
    v           cycle visibility: everything / essential / just the number
    ?           legend

Every hover has a purpose. Hovering a figure reveals its provenance
inline: which endpoint, which seed, when computed. Hovering a grid cell
highlights its transactions elsewhere on screen. Nothing hovers merely
to glow.

Clicks resolve immediately. Any animation is interruptible; a viewer
moving fast never waits.

## Visual language

Dark, near-black, not grey-blue. Type is the interface: a strong
monospace for every figure, id, hash and code, and a tight sans for
prose. Tabular numerals mandatory so digits never shift while counting.

One accent, used only for recovered value. Refusals get a distinct
non-alarm treatment: they are correct behaviour and must never read as
red errors. OBSERVED and ESTIMATED are distinguishable at a glance and
never placed where they could be read as summable.

Density over whitespace. Bloomberg, not a landing page. A screen should
feel like it is showing you everything it has, because it is.

Grain, scanline or texture at very low opacity is acceptable if it
serves the instrument feel. Nothing that moves on its own.

## The rule that decides everything

If a viewer cannot tell what a motion revealed, it is decoration and it
comes out. Every animation in this build must be defensible as: it
showed the order of the argument, it showed something not moving, it
showed a structure forming, or it showed provenance.
