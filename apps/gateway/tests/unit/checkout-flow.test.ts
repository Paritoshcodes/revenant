import { describe, expect, it } from 'vitest';

import { attempt, openCheckout } from '../../src/browser/checkout-flow.js';
import { FRAME_SELECTOR, MOCKSHARP_URL_PATTERN, SELECTORS } from '../../src/browser/selectors.js';
import { createCheckoutFixture } from '../support/checkout-fixture.js';
import type { CheckoutFixture, CheckoutFixtureConfig } from '../support/checkout-fixture.js';

/** A fixture already past openCheckout: contact filled, card method visible. */
const openedFixture = (config: CheckoutFixtureConfig = {}): CheckoutFixture => {
  const fixture = createCheckoutFixture(config);
  fixture.world.stage = 'contactFilled';
  return fixture;
};

/** Drives one attempt() call, wiring the fixture's capture and sleep automatically. */
const driveAttempt = (
  fixture: CheckoutFixture,
  cardNumber: string,
  outcome: 'success' | 'failure',
  options: Parameters<typeof attempt>[4] = {},
) =>
  attempt(fixture.page, cardNumber, outcome, fixture.capture, {
    sleep: fixture.sleep,
    ...options,
  });

describe('openCheckout', () => {
  it('navigates with domcontentloaded, checks pre-flight, fills contact, and unlocks the method list', async () => {
    const { page, calls, world, gotoOptions } = createCheckoutFixture();

    const result = await openCheckout(page, 'https://rzp.io/l/abc123', { contact: '9000000000' });

    expect(result.ok).toBe(true);
    expect(world.stage).toBe('contactFilled');
    // Razorpay checkout polls continuously; 'networkidle' would time out.
    expect(gotoOptions()?.waitUntil).toBe('domcontentloaded');
    expect(calls).toEqual([
      'goto(https://rzp.io/l/abc123)',
      `locator(${SELECTORS.paymentCompleted})`,
      `page.count(${SELECTORS.paymentCompleted})`,
      `frameLocator(${FRAME_SELECTOR})`,
      `frame.fill(${SELECTORS.contact}, 9000000000)`,
      // The field is destroyed the instant fill() resolves (Build log
      // entry 7): waitForValueStable's count()-first guard sees it already
      // gone and returns immediately, never reaching inputValue().
      `frame.count(${SELECTORS.contact})`,
      `frame.waitFor(${SELECTORS.cardMethod})`,
    ]);
  });

  it('refuses to drive an already-paid link, and never touches the frame', async () => {
    const { page, calls, world } = createCheckoutFixture({ alreadyPaidOnLoad: true });

    const result = await openCheckout(page, 'https://rzp.io/l/paid');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('conflict');
    expect(result.error.message).toContain('already paid');
    expect(world.stage).toBe('loaded'); // contact was never touched
    expect(calls.some((call) => call.startsWith('frameLocator'))).toBe(false);
  });

  it('returns a typed failure and screenshots when navigation throws', async () => {
    const { page, calls } = createCheckoutFixture({
      throwAt: 'goto(https://rzp.io/l/bad)',
    });

    const result = await openCheckout(page, 'https://rzp.io/l/bad', {
      screenshotDir: '/tmp/shots',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('upstream');
    expect(result.error.message).toContain('openCheckout');
    expect(calls).toContain('screenshot');
  });

  it('does not screenshot when no screenshotDir is configured', async () => {
    const { page, calls } = createCheckoutFixture({
      throwAt: 'goto(https://rzp.io/l/bad)',
    });
    await openCheckout(page, 'https://rzp.io/l/bad');
    expect(calls).not.toContain('screenshot');
  });
});

describe('attempt: success, heading resolves within its window', () => {
  it('drives the frame, the popup through its two-URL sequence, captures the payment id, and reports captured', async () => {
    const fixture = openedFixture();

    const result = await driveAttempt(fixture, '4100280000001007', 'success');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ outcome: 'captured', paymentId: 'pay_Ttest1' });

    expect(fixture.calls).toContain(`frame.click(${SELECTORS.cardMethod})`);
    expect(fixture.calls).toContain(`frame.fill(${SELECTORS.cardNumber}, 4100280000001007)`);
    expect(fixture.calls).toContain(`frame.click(${SELECTORS.submit})`);
    expect(fixture.calls).toContain(`popup.waitForURL(${MOCKSHARP_URL_PATTERN})`);
    expect(fixture.calls).toContain(`popup.click(${SELECTORS.bankSuccess})`);
    expect(fixture.calls).not.toContain(`popup.click(${SELECTORS.bankFailure})`);
  });

  it('registers the popup listener before clicking submit, not after', async () => {
    const fixture = openedFixture();
    await driveAttempt(fixture, '4111111111111111', 'success');

    const popupIndex = fixture.calls.indexOf('waitForEvent(popup)');
    const submitIndex = fixture.calls.indexOf(`frame.click(${SELECTORS.submit})`);
    expect(popupIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThan(popupIndex);
  });

  it('waits for the mocksharp navigation before clicking the bank button, not popup load', async () => {
    const fixture = openedFixture();
    await driveAttempt(fixture, '4111111111111111', 'success');

    const waitForUrlIndex = fixture.calls.indexOf(`popup.waitForURL(${MOCKSHARP_URL_PATTERN})`);
    const bankClickIndex = fixture.calls.indexOf(`popup.click(${SELECTORS.bankSuccess})`);
    expect(waitForUrlIndex).toBeGreaterThanOrEqual(0);
    expect(bankClickIndex).toBeGreaterThan(waitForUrlIndex);
  });

  it('waits for the card fields to unlock before filling them', async () => {
    const fixture = openedFixture();
    await driveAttempt(fixture, '4111111111111111', 'success');

    const cardClickIndex = fixture.calls.indexOf(`frame.click(${SELECTORS.cardMethod})`);
    const waitForCardNumberIndex = fixture.calls.indexOf(`frame.waitFor(${SELECTORS.cardNumber})`);
    const fillCardNumberIndex = fixture.calls.indexOf(
      `frame.fill(${SELECTORS.cardNumber}, 4111111111111111)`,
    );
    expect(cardClickIndex).toBeGreaterThanOrEqual(0);
    expect(waitForCardNumberIndex).toBeGreaterThan(cardClickIndex);
    expect(fillCardNumberIndex).toBeGreaterThan(waitForCardNumberIndex);
  });

  it('resolves via the early-exit exact heading match before the frame ever detaches', async () => {
    const fixture = openedFixture();
    const result = await driveAttempt(fixture, '4111111111111111', 'success');

    expect(result.ok).toBe(true);
    // tick0 misses ("Confirming Payment"), tick1 hits the exact
    // "Payment Successful" text: exactly one outcome-poll sleep (500ms)
    // between them. Filtered to that duration specifically so it stays
    // unaffected by the separate, differently-timed pre-submit settle
    // wait (1500ms) that now also goes through this same fixture hook.
    expect(fixture.calls.filter((call) => call === 'sleep(500)').length).toBe(1);
    expect(fixture.calls).toContain(`frame.textContent(${SELECTORS.paymentStatusHeading})`);
  });
});

describe('attempt: success, the heading window is missed and the frame detaches', () => {
  it('tolerates "Frame was detached" and resolves via the parent marker instead', async () => {
    // docs/CHECKOUT-FLOW.md section 12: "the margin is real but thin" —
    // this models missing the ~1-tick "Payment Successful" window
    // entirely, forcing the parent .Payment-Completed check to do the work.
    const fixture = openedFixture({
      successHeadingTick: null,
      successDetachTick: 1,
      successParentTick: 2,
    });

    const result = await driveAttempt(fixture, '4111111111111111', 'success');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('captured');

    // Proves the detached-frame branch actually ran: the heading's count()
    // was checked once before detachment (element present, no match via
    // textContent) and once after (throws, caught) before the parent
    // finally resolved it. Only one textContent() call happens at all —
    // the tick-1 count() already reports the heading gone, so
    // textContent() is correctly never attempted on it.
    const headingCountChecks = fixture.calls.filter(
      (call) => call === `frame.count(${SELECTORS.paymentStatusHeading})`,
    );
    expect(headingCountChecks.length).toBeGreaterThanOrEqual(2);
    expect(
      fixture.calls.filter((call) => call === `frame.textContent(${SELECTORS.paymentStatusHeading})`)
        .length,
    ).toBe(1);
  });
});

describe('attempt: failure', () => {
  it('drives the bank failure button and reports failed once the retry surface appears', async () => {
    const fixture = openedFixture();

    const result = await driveAttempt(fixture, '4100280000020007', 'failure');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('failed');
    expect(fixture.calls).toContain(`popup.click(${SELECTORS.bankFailure})`);
    expect(fixture.calls).not.toContain(`popup.click(${SELECTORS.bankSuccess})`);
  });

  it('does not resolve on the heading merely existing: "Confirming Payment" must not read as captured', async () => {
    // docs/CHECKOUT-FLOW.md section 6: the trap. The heading is present
    // with non-empty text for several ticks on the failure path; only its
    // EXACT text may resolve success.
    const fixture = openedFixture({ failureSettleTick: 3 });

    const result = await driveAttempt(fixture, '4100280000020007', 'failure');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('failed');
    expect(
      fixture.calls.filter((call) => call === `frame.textContent(${SELECTORS.paymentStatusHeading})`)
        .length,
    ).toBeGreaterThan(0);
  });

  it('completes a poll tick, rather than blocking, once the heading has disappeared but before the retry surface renders', async () => {
    // docs/DECISIONS.md, Build log entry 6: the heading disappears at
    // ~6s but the retry surface does not render until later still. A
    // driver that called textContent() unconditionally would block for
    // Playwright's full default timeout on every tick in that gap and
    // the attempt would fail with a TimeoutError instead of resolving
    // failed. Modelled here as an explicit gap between the two ticks.
    const fixture = openedFixture({ failureHeadingGoneTick: 1, failureSettleTick: 3 });

    const result = await driveAttempt(fixture, '4100280000020007', 'failure');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('failed');

    // The heading's count() was checked in the gap (reporting it gone),
    // and textContent() was correctly never attempted on it there.
    expect(fixture.calls).toContain(`frame.count(${SELECTORS.paymentStatusHeading})`);
    const textContentAfterGoneTick = fixture.calls.filter(
      (call) => call === `frame.textContent(${SELECTORS.paymentStatusHeading})`,
    );
    // Only the one tick before the heading disappeared ever reached
    // textContent(); none of the gap ticks did.
    expect(textContentAfterGoneTick.length).toBe(1);
  });

  it('drives a retry on the same page and session: each attempt gets its own captured id', async () => {
    // docs/CHECKOUT-FLOW.md: the retry surface re-exposes [data-testid="card"],
    // so the same function, on the same page, drives attempt after
    // attempt, and each attempt's popup carries its own payment id.
    const fixture = openedFixture();

    const first = await driveAttempt(fixture, '4100280000001007', 'failure');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.outcome).toBe('failed');

    const second = await driveAttempt(fixture, '5555510000081006', 'success');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.outcome).toBe('captured');

    expect(first.value.paymentId).not.toBeNull();
    expect(second.value.paymentId).not.toBeNull();
    expect(second.value.paymentId).not.toBe(first.value.paymentId);
  });

  it('overwrites the retained card value on retry rather than appending to it', async () => {
    // docs/CHECKOUT-FLOW.md section 7: card fields retain their previous
    // values across a retry; fill() must clear, not append.
    const fixture = openedFixture();

    await driveAttempt(fixture, '4100280000001007', 'failure');
    await driveAttempt(fixture, '5555510000081006', 'success');

    expect(fixture.world.fieldValues[SELECTORS.cardNumber]).toBe('5555510000081006');
  });
});

describe('attempt: the tokenisation (save-card) prompt is conditional', () => {
  it('declines it when it appears — present on attempt one', async () => {
    const fixture = openedFixture({ saveCardPromptAppears: true });

    const result = await driveAttempt(fixture, '4100280000001007', 'success');

    expect(result.ok).toBe(true);
    expect(fixture.calls).toContain(`frame.click(${SELECTORS.declineSaveCard})`);
  });

  it('proceeds straight through when it never appears — absent on a retry', async () => {
    const fixture = openedFixture({ saveCardPromptAppears: false });

    const result = await driveAttempt(fixture, '4100280000001007', 'success');

    expect(result.ok).toBe(true);
    expect(fixture.calls).not.toContain(`frame.click(${SELECTORS.declineSaveCard})`);
    expect(fixture.calls).toContain(`popup.click(${SELECTORS.bankSuccess})`);
  });
});

describe('attempt: typed failures, never throws', () => {
  it('returns a failure and screenshots when no outcome ever resolves', async () => {
    const fixture = openedFixture({ suppressOutcome: true });

    const result = await attempt(fixture.page, '4111111111111111', 'success', fixture.capture, {
      sleep: fixture.sleep,
      timeoutMs: 2_000,
      screenshotDir: '/tmp/shots',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('upstream');
    expect(result.error.message).toMatch(/Payment-Completed|Payment Successful|retry surface/);
    expect(fixture.calls).toContain('screenshot');
  });

  it('wraps a thrown Playwright error as a typed failure, with a screenshot', async () => {
    const fixture = openedFixture({
      throwAt: `frame.fill(${SELECTORS.cardNumber}, 4111111111111111)`,
    });

    const result = await driveAttempt(fixture, '4111111111111111', 'success', {
      screenshotDir: '/tmp/shots',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('upstream');
    expect(result.error.message).toContain('boom');
    expect(fixture.calls).toContain('screenshot');
  });

  it('never throws out of the function, even on a mid-flow exception', async () => {
    const fixture = openedFixture({ throwAt: 'waitForEvent(popup)' });

    await expect(driveAttempt(fixture, '4111111111111111', 'success')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('propagates a genuine payment-id capture failure rather than silently returning null', async () => {
    const fixture = openedFixture({ suppressPaymentIdCapture: true });

    const result = await attempt(fixture.page, '4111111111111111', 'success', fixture.capture, {
      sleep: fixture.sleep,
      timeoutMs: 50,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/timed out|payment id/);
  });
});

describe('fixture fidelity: the five build-log bugs are structurally catchable', () => {
  it('1. frame boundary: the wrong frame, and any page-level selector but .Payment-Completed, reject', async () => {
    const { page } = createCheckoutFixture();

    const wrongFrame = page.frameLocator('iframe.some-other-frame');
    await expect(wrongFrame.locator(SELECTORS.contact).fill('9000000000')).rejects.toThrow(
      /no frame matching/,
    );

    await expect(page.locator(SELECTORS.cardMethod).count()).rejects.toThrow(
      /should never be called/,
    );
    await expect(page.click(SELECTORS.cardMethod)).rejects.toThrow(/should never be called/);
  });

  it('2. payment id capture: the id is only available after waiting for growth, never synchronously', async () => {
    const fixture = openedFixture();
    const frame = fixture.page.frameLocator(FRAME_SELECTOR);
    // Drive far enough for the popup to actually become available (real
    // Checkout does not open it until submit; the fixture's own popup
    // only exists once submit has run), so this is a genuine timing
    // check, not one that only holds because nothing triggered it yet.
    await frame.locator(SELECTORS.cardMethod).click();
    await frame.locator(SELECTORS.cardNumber).fill('4111111111111111');
    await frame.locator(SELECTORS.submit).click();

    const before = fixture.capture.list().length;
    const popup = await fixture.page.waitForEvent('popup');
    // The instant the popup resolves, nothing has been captured yet: the
    // fixture fires the authenticate request on a later macrotask, just
    // like a real one arrives after a real network round trip.
    expect(fixture.capture.list().length).toBe(before);

    await fixture.capture.waitForGrowth(before, 1_000);
    expect(fixture.capture.list().length).toBeGreaterThan(before);
    void popup;
  });

  it('3. outcome detection: heading existence is not enough, and a detached frame is tolerated, not fatal', async () => {
    // Failure path: heading exists with real text long before the retry
    // surface appears. Covered end to end above; asserted again here
    // directly against the fixture as a structural proof.
    const failing = openedFixture({ failureSettleTick: 3 });
    const failed = await driveAttempt(failing, '4100280000020007', 'failure');
    expect(failed.ok && failed.value.outcome).toBe('failed');

    // Success path: the frame detaches mid-poll; a naive driver treating
    // that as a fatal error would never reach the parent check.
    const detaching = openedFixture({
      successHeadingTick: null,
      successDetachTick: 1,
      successParentTick: 2,
    });
    const captured = await driveAttempt(detaching, '4111111111111111', 'success');
    expect(captured.ok && captured.value.outcome).toBe('captured');
  });

  it('4. staged availability: card fields and the card method reject before their stage', async () => {
    const readyForCard = openedFixture();
    const frame = readyForCard.page.frameLocator(FRAME_SELECTOR);
    await expect(frame.locator(SELECTORS.cardNumber).fill('4111111111111111')).rejects.toThrow(
      /card method was not selected/,
    );

    const freshlyLoaded = createCheckoutFixture(); // stage still 'loaded'
    const freshFrame = freshlyLoaded.page.frameLocator(FRAME_SELECTOR);
    await expect(freshFrame.locator(SELECTORS.cardMethod).click()).rejects.toThrow(
      /contact has not been filled/,
    );
  });

  it('5. pre-flight and retry: an already-paid link refuses to drive, and fill() overwrites, not appends', async () => {
    const paid = createCheckoutFixture({ alreadyPaidOnLoad: true });
    const preflight = await openCheckout(paid.page, 'https://rzp.io/l/paid');
    expect(preflight.ok).toBe(false);
    if (!preflight.ok) expect(preflight.error.kind).toBe('conflict');

    const fixture = openedFixture();
    await driveAttempt(fixture, '4100280000001007', 'failure');
    await driveAttempt(fixture, '5555510000081006', 'success');
    expect(fixture.world.fieldValues[SELECTORS.cardNumber]).toBe('5555510000081006');
  });
});

describe('fixture fidelity: a sixth bug (Build log entry 6), the fixture mismodelling Playwright itself', () => {
  it('textContent() on a missing element blocks/rejects, exactly like the real Playwright API, rather than resolving with null', async () => {
    // The bug this fixture change catches: the first version of this fake
    // resolved textContent() with null the instant an element was
    // missing. Playwright's real textContent() auto-waits and then
    // rejects instead, which is what let the driver's original,
    // unguarded call hang for 30s on the failure path once the heading
    // disappeared. A driver that regresses to calling textContent()
    // without checking count() first must see a rejection here, not a
    // quiet null.
    const fixture = openedFixture({ failureSettleTick: 1 });
    await driveAttempt(fixture, '4100280000020007', 'failure');
    // The attempt above has already settled with the heading long gone
    // (outcomeTick sits at failureSettleTick or beyond). Reading it
    // directly must reject, not resolve.
    const frame = fixture.page.frameLocator(FRAME_SELECTOR);

    await expect(frame.locator(SELECTORS.paymentStatusHeading).textContent()).rejects.toThrow(
      /Timeout.*payment-status-heading/,
    );
  });

  it('a poll tick completes (returns null, does not throw) when the heading is absent, because count() is checked first', async () => {
    // The corrected pollOutcomeOnce never lets that rejection happen: it
    // only calls textContent() once count() has confirmed the element
    // exists. Exercised end to end via the gap test above; asserted
    // directly here against the fixture's two calls in sequence.
    const fixture = openedFixture({ failureHeadingGoneTick: 0 });
    fixture.world.bankClicked = 'failure';
    const frame = fixture.page.frameLocator(FRAME_SELECTOR);
    const heading = frame.locator(SELECTORS.paymentStatusHeading);

    await expect(heading.count()).resolves.toBe(0);
    // A correct driver stops here for this tick; it never calls
    // textContent() on an element count() just reported as absent.
  });
});

describe('fixture fidelity: an eighth bug (Build log entry 8), a collapsed decoy click target', () => {
  it('surfaces a clean failure rather than hanging or silently succeeding when the submit target is not actionable', async () => {
    // [data-test-id="add-card-cta"] coexists with the real submit button
    // on every surface, 0x0 and unhittable. A real Playwright .click()
    // fails on an element like this rather than clicking through to
    // whatever sits underneath. attempt() must convert that into a typed
    // Failure like any other Playwright error, not hang or report success.
    const fixture = openedFixture({ submitTargetCollapsed: true });

    const result = await driveAttempt(fixture, '4100280000001007', 'success');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not visible|0x0/);
  });
});

describe('fixture fidelity: a tenth bug (Build log entry 10), a non-authoritative probe killing the whole attempt', () => {
  it('does not fail the attempt when the heading exists at count() but its own textContent() times out', async () => {
    // A real batch run hit exactly this: count() reported the heading
    // present, but textContent() a moment later timed out (the element
    // had moved on) with a plain "Timeout ... exceeded" message, not
    // "Frame was detached" — so the old catch, which only swallowed
    // detachment, re-threw it and killed the transaction. The heading is
    // a non-authoritative early-exit probe; the retry surface below is
    // what this attempt must actually resolve on.
    const fixture = openedFixture({
      headingTextContentAlwaysTimesOut: true,
      failureSettleTick: 2,
    });

    const result = await driveAttempt(fixture, '4100280000020007', 'failure');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('failed');
  });
});
