import { describe, expect, it } from 'vitest';

import { attempt, openCheckout } from '../src/browser/checkout-flow.js';
import { FRAME_SELECTOR, MOCKSHARP_URL_PATTERN, SELECTORS } from '../src/browser/selectors.js';
import { createCheckoutFixture } from './support/checkout-fixture.js';

describe('openCheckout', () => {
  it('navigates with domcontentloaded, fills contact in the frame, and unlocks the method list', async () => {
    const { page, calls, world, gotoOptions } = createCheckoutFixture();

    const result = await openCheckout(page, 'https://rzp.io/l/abc123', { contact: '9000000000' });

    expect(result.ok).toBe(true);
    expect(world.stage).toBe('contactFilled');
    // Razorpay checkout polls continuously; 'networkidle' would time out.
    expect(gotoOptions()?.waitUntil).toBe('domcontentloaded');
    expect(calls).toEqual([
      'goto(https://rzp.io/l/abc123)',
      `frameLocator(${FRAME_SELECTOR})`,
      `frame.fill(${SELECTORS.contact}, 9000000000)`,
      `frame.waitFor(${SELECTORS.cardMethod})`,
    ]);
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

const openedFixture = (config: Parameters<typeof createCheckoutFixture>[0] = {}) => {
  const fixture = createCheckoutFixture(config);
  fixture.world.stage = 'contactFilled';
  return fixture;
};

describe('attempt: success path', () => {
  it('drives the frame, the popup through its intermediate URL, and reports captured', async () => {
    const { page, calls } = openedFixture();

    const result = await attempt(page, '4111111111111111', 'success');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ outcome: 'captured' });

    expect(calls).toContain(`frame.click(${SELECTORS.cardMethod})`);
    expect(calls).toContain(`frame.fill(${SELECTORS.cardNumber}, 4111111111111111)`);
    expect(calls).toContain(`frame.click(${SELECTORS.submit})`);
    expect(calls).toContain(`popup.waitForURL(${MOCKSHARP_URL_PATTERN})`);
    expect(calls).toContain(`popup.click(${SELECTORS.bankSuccess})`);
    expect(calls).not.toContain(`popup.click(${SELECTORS.bankFailure})`);
    expect(calls).toContain(`frame.waitFor(${SELECTORS.paymentStatusHeading})`);
  });

  it('registers the popup listener before clicking submit, not after', async () => {
    const { page, calls } = openedFixture();
    await attempt(page, '4111111111111111', 'success');

    const popupIndex = calls.indexOf('waitForEvent(popup)');
    const submitIndex = calls.indexOf(`frame.click(${SELECTORS.submit})`);
    expect(popupIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThan(popupIndex);
  });

  it('waits for the mocksharp navigation before clicking the bank button, not popup load', async () => {
    const { page, calls } = openedFixture();
    await attempt(page, '4111111111111111', 'success');

    const waitForUrlIndex = calls.indexOf(`popup.waitForURL(${MOCKSHARP_URL_PATTERN})`);
    const bankClickIndex = calls.indexOf(`popup.click(${SELECTORS.bankSuccess})`);
    expect(waitForUrlIndex).toBeGreaterThanOrEqual(0);
    expect(bankClickIndex).toBeGreaterThan(waitForUrlIndex);
  });

  it('waits for the card fields to unlock before filling them', async () => {
    const { page, calls } = openedFixture();
    await attempt(page, '4111111111111111', 'success');

    const cardClickIndex = calls.indexOf(`frame.click(${SELECTORS.cardMethod})`);
    const waitForCardNumberIndex = calls.indexOf(`frame.waitFor(${SELECTORS.cardNumber})`);
    const fillCardNumberIndex = calls.indexOf(
      `frame.fill(${SELECTORS.cardNumber}, 4111111111111111)`,
    );
    expect(cardClickIndex).toBeGreaterThanOrEqual(0);
    expect(waitForCardNumberIndex).toBeGreaterThan(cardClickIndex);
    expect(fillCardNumberIndex).toBeGreaterThan(waitForCardNumberIndex);
  });
});

describe('attempt: failure path', () => {
  it('drives the bank failure button and reports failed from the retry surface', async () => {
    const { page, calls } = openedFixture();

    const result = await attempt(page, '4100280000020007', 'failure');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ outcome: 'failed' });
    expect(calls).toContain(`popup.click(${SELECTORS.bankFailure})`);
    expect(calls).not.toContain(`popup.click(${SELECTORS.bankSuccess})`);
    expect(calls).toContain(`frame.waitFor(${SELECTORS.retrySurface})`);
  });

  it('drives a retry on the same page and session, since the entry point is unchanged', async () => {
    // docs/CHECKOUT-FLOW.md: the retry surface re-exposes [data-testid="card"],
    // so the same function, on the same page, drives attempt after attempt.
    const { page } = openedFixture();

    const first = await attempt(page, '4100280000020007', 'failure');
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.outcome).toBe('failed');

    const second = await attempt(page, '4111111111111111', 'success');
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.outcome).toBe('captured');
  });
});

describe('attempt: the save-card prompt is conditional', () => {
  it('declines it when it appears', async () => {
    const { page, calls } = openedFixture({ saveCardPromptAppears: true });

    const result = await attempt(page, '4111111111111111', 'success');

    expect(result.ok).toBe(true);
    expect(calls).toContain(`frame.click(${SELECTORS.declineSaveCard})`);
  });

  it('proceeds straight through when it never appears', async () => {
    const { page, calls } = openedFixture({ saveCardPromptAppears: false });

    const result = await attempt(page, '4111111111111111', 'success');

    expect(result.ok).toBe(true);
    expect(calls).not.toContain(`frame.click(${SELECTORS.declineSaveCard})`);
    expect(calls).toContain(`popup.click(${SELECTORS.bankSuccess})`);
  });
});

describe('attempt: typed failures, never throws', () => {
  it('returns a failure and screenshots when neither outcome marker ever appears', async () => {
    const { page, calls } = openedFixture({ suppressOutcome: true });

    const result = await attempt(page, '4111111111111111', 'success', {
      screenshotDir: '/tmp/shots',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('upstream');
    expect(result.error.message).toMatch(/payment-status-heading|retry-surface/);
    expect(calls).toContain('screenshot');
  });

  it('wraps a thrown Playwright error as a typed failure, with a screenshot', async () => {
    const { page, calls } = openedFixture({
      throwAt: `frame.fill(${SELECTORS.cardNumber}, 4111111111111111)`,
    });

    const result = await attempt(page, '4111111111111111', 'success', {
      screenshotDir: '/tmp/shots',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('upstream');
    expect(result.error.message).toContain('boom');
    expect(calls).toContain('screenshot');
  });

  it('never throws out of the function, even on a mid-flow exception', async () => {
    const { page } = openedFixture({ throwAt: 'waitForEvent(popup)' });

    await expect(attempt(page, '4111111111111111', 'success')).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('fixture fidelity: the four bugs are structurally caught, not just avoided', () => {
  it('page.click always rejects: the corrected driver never queries the top-level page', async () => {
    const { page } = createCheckoutFixture();
    await expect(page.click(SELECTORS.cardMethod)).rejects.toThrow(/should never be called/);
  });

  it('frameLocator on any selector but the real frame returns a dead locator', async () => {
    const { page } = createCheckoutFixture();
    const wrongFrame = page.frameLocator('iframe.some-other-frame');
    await expect(wrongFrame.locator(SELECTORS.contact).fill('9000000000')).rejects.toThrow(
      /no frame matching/,
    );
  });

  it("the popup's bank button rejects until waitForURL resolves the mocksharp navigation", async () => {
    const { page } = openedFixture();
    // Drive far enough to open the popup without going through attempt(),
    // so we can try to click before waitForURL.
    await page.frameLocator(FRAME_SELECTOR).locator(SELECTORS.cardMethod).click();
    await page.frameLocator(FRAME_SELECTOR).locator(SELECTORS.cardNumber).waitFor();
    const popup = await page.waitForEvent('popup');

    await expect(popup.click(SELECTORS.bankSuccess)).rejects.toThrow(/waitForURL was not awaited/);
  });

  it('card fields reject before the card method has been clicked', async () => {
    const { page } = openedFixture();
    const frame = page.frameLocator(FRAME_SELECTOR);
    await expect(frame.locator(SELECTORS.cardNumber).fill('4111111111111111')).rejects.toThrow(
      /card method was not selected/,
    );
  });

  it('the card method rejects before contact has been filled', async () => {
    const { page } = createCheckoutFixture(); // stage still 'loaded'
    const frame = page.frameLocator(FRAME_SELECTOR);
    await expect(frame.locator(SELECTORS.cardMethod).click()).rejects.toThrow(
      /contact has not been filled/,
    );
  });
});
