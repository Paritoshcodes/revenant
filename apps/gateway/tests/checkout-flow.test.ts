import { describe, expect, it } from 'vitest';

import { attempt, openCheckout } from '../src/browser/checkout-flow.js';
import { SELECTORS } from '../src/browser/selectors.js';
import type { LocatorLike, PageLike } from '../src/browser/types.js';

interface FakeOptions {
  /** Whether the conditional save-card prompt (step 8) shows up at all. */
  readonly saveCardPromptAppears?: boolean;
  /** Which DOM marker (if either) appears on the parent page after the bank click. */
  readonly domOutcome?: 'captured' | 'failed' | 'neither';
  /** A call label (see the pushes below) to throw an Error at. */
  readonly throwAt?: string;
}

/** Records every call, in order, so ordering (e.g. popup registered before submit) is assertable. */
const createFakePage = (options: FakeOptions = {}): { page: PageLike; calls: string[] } => {
  const calls: string[] = [];

  const maybeThrow = (label: string): void => {
    calls.push(label);
    if (options.throwAt === label) throw new Error(`boom at ${label}`);
  };

  const popupPage: PageLike = {
    goto: () => {
      throw new Error('popup.goto should not be called');
    },
    fill: () => {
      throw new Error('popup.fill should not be called');
    },
    click: async (selector) => {
      maybeThrow(`popup.click(${selector})`);
    },
    locator: () => {
      throw new Error('popup.locator should not be called');
    },
    waitForEvent: () => {
      throw new Error('popup.waitForEvent should not be called');
    },
    waitForSelector: () => {
      throw new Error('popup.waitForSelector should not be called');
    },
    waitForLoadState: async (state) => {
      maybeThrow(`popup.waitForLoadState(${String(state)})`);
    },
    screenshot: async () => {
      calls.push('popup.screenshot');
    },
  };

  const locator = (selector: string): LocatorLike => ({
    waitFor: async () => {
      calls.push(`locator.waitFor(${selector})`);
      if (selector === SELECTORS.declineSaveCard && !options.saveCardPromptAppears) {
        throw new Error('timeout waiting for save-card prompt');
      }
      if (options.throwAt === `locator.waitFor(${selector})`) {
        throw new Error('boom');
      }
    },
    click: async () => {
      maybeThrow(`locator.click(${selector})`);
    },
  });

  const page: PageLike = {
    goto: async (url) => {
      maybeThrow(`goto(${url})`);
    },
    fill: async (selector) => {
      maybeThrow(`fill(${selector})`);
    },
    click: async (selector) => {
      maybeThrow(`click(${selector})`);
    },
    locator,
    waitForEvent: async (event) => {
      calls.push(`waitForEvent(${event})`);
      if (options.throwAt === `waitForEvent(${event})`) throw new Error('boom');
      return popupPage;
    },
    waitForSelector: async (selector) => {
      calls.push(`waitForSelector(${selector})`);
      if (selector === SELECTORS.completed && options.domOutcome !== 'captured') {
        throw new Error('timeout');
      }
      if (selector === SELECTORS.retrySurface && options.domOutcome !== 'failed') {
        throw new Error('timeout');
      }
    },
    waitForLoadState: async (state) => {
      calls.push(`waitForLoadState(${String(state)})`);
    },
    screenshot: async () => {
      calls.push('screenshot');
    },
  };

  return { page, calls };
};

describe('openCheckout', () => {
  it('navigates to the link and fills the contact field', async () => {
    const { page, calls } = createFakePage();
    const result = await openCheckout(page, 'https://rzp.io/l/abc123', { contact: '9000000000' });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['goto(https://rzp.io/l/abc123)', `fill(${SELECTORS.contact})`]);
  });

  it('returns a typed failure and screenshots when navigation throws', async () => {
    const { page, calls } = createFakePage({ throwAt: 'goto(https://rzp.io/l/bad)' });

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
    const { page, calls } = createFakePage({ throwAt: 'goto(https://rzp.io/l/bad)' });
    await openCheckout(page, 'https://rzp.io/l/bad');
    expect(calls).not.toContain('screenshot');
  });
});

describe('attempt: success path', () => {
  it('drives the card, popup, and bank success button, and reports captured', async () => {
    const { page, calls } = createFakePage({ domOutcome: 'captured' });

    const result = await attempt(page, '4111111111111111', 'success');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ outcome: 'captured' });

    expect(calls).toContain(`click(${SELECTORS.cardMethod})`);
    expect(calls).toContain(`fill(${SELECTORS.cardNumber})`);
    expect(calls).toContain(`fill(${SELECTORS.cardExpiry})`);
    expect(calls).toContain(`fill(${SELECTORS.cardCvv})`);
    expect(calls).toContain(`click(${SELECTORS.submit})`);
    expect(calls).toContain(`popup.click(${SELECTORS.bankSuccess})`);
    expect(calls).not.toContain(`popup.click(${SELECTORS.bankFailure})`);
  });

  it('registers the popup listener before clicking submit, not after', async () => {
    // waitForEvent('popup') must start listening before the action that
    // can trigger it, or the event can be missed.
    const { page, calls } = createFakePage({ domOutcome: 'captured' });
    await attempt(page, '4111111111111111', 'success');

    const popupIndex = calls.indexOf('waitForEvent(popup)');
    const submitIndex = calls.indexOf(`click(${SELECTORS.submit})`);
    expect(popupIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThan(popupIndex);
  });
});

describe('attempt: failure path', () => {
  it('drives the bank failure button and reports failed from the retry surface', async () => {
    const { page, calls } = createFakePage({ domOutcome: 'failed' });

    const result = await attempt(page, '4100280000020007', 'failure');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ outcome: 'failed' });
    expect(calls).toContain(`popup.click(${SELECTORS.bankFailure})`);
    expect(calls).not.toContain(`popup.click(${SELECTORS.bankSuccess})`);
  });

  it('works identically as a retry: the entry point is the same selector', async () => {
    // docs/CHECKOUT-FLOW.md: the retry surface re-exposes [data-testid="card"],
    // so the same function drives a retry with no special-casing.
    const { page } = createFakePage({ domOutcome: 'captured' });
    const result = await attempt(page, '4111111111111111', 'success');
    expect(result.ok).toBe(true);
  });
});

describe('attempt: the save-card prompt is conditional', () => {
  it('declines it when it appears', async () => {
    const { page, calls } = createFakePage({
      saveCardPromptAppears: true,
      domOutcome: 'captured',
    });

    const result = await attempt(page, '4111111111111111', 'success');

    expect(result.ok).toBe(true);
    expect(calls).toContain(`locator.click(${SELECTORS.declineSaveCard})`);
  });

  it('proceeds straight through when it never appears', async () => {
    const { page, calls } = createFakePage({
      saveCardPromptAppears: false,
      domOutcome: 'captured',
    });

    const result = await attempt(page, '4111111111111111', 'success');

    expect(result.ok).toBe(true);
    expect(calls).not.toContain(`locator.click(${SELECTORS.declineSaveCard})`);
    // Still reaches the popup and the outcome marker afterwards.
    expect(calls).toContain(`popup.click(${SELECTORS.bankSuccess})`);
  });
});

describe('attempt: typed failures, never throws', () => {
  it('returns a failure and screenshots when no outcome marker ever appears', async () => {
    const { page, calls } = createFakePage({ domOutcome: 'neither' });

    const result = await attempt(page, '4111111111111111', 'success', {
      screenshotDir: '/tmp/shots',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('upstream');
    expect(result.error.message).toMatch(/Payment-Completed|retry-surface/);
    expect(calls).toContain('screenshot');
  });

  it('wraps a thrown Playwright error as a typed failure, with a screenshot', async () => {
    const { page, calls } = createFakePage({
      domOutcome: 'captured',
      throwAt: `fill(${SELECTORS.cardNumber})`,
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
    const { page } = createFakePage({
      domOutcome: 'captured',
      throwAt: 'waitForEvent(popup)',
    });

    await expect(attempt(page, '4111111111111111', 'success')).resolves.toMatchObject({
      ok: false,
    });
  });
});
