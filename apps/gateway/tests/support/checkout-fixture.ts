/**
 * A fake checkout page for testing src/browser/checkout-flow.ts.
 *
 * The first version of these fakes answered every selector on every
 * document unconditionally, so 16 passing tests missed all four DOM bugs
 * fixed on 2026-08-24 (see docs/DECISIONS.md, Build log entry 4): the
 * driver queried the top-level page instead of the checkout iframe, waited
 * for popup load instead of the mocksharp navigation, keyed success on a
 * selector that does not exist, and assumed elements existed before the
 * stage that creates them. This fixture models those constraints directly,
 * so a regression to any of them makes the corresponding test fail rather
 * than pass for the wrong reason:
 *
 *   - `page.frameLocator(selector)` for anything other than
 *     FRAME_SELECTOR returns a locator that rejects every call: querying
 *     the wrong document fails instead of silently finding nothing.
 *   - `page.click(...)` on the top-level page always throws: nothing in
 *     the corrected driver should ever call it (checkout elements are in
 *     the frame, the bank buttons are on the popup).
 *   - The frame's elements only resolve once the stage that creates them
 *     has been reached: the method list after contact is filled, the card
 *     fields after the card method is clicked, the outcome markers only
 *     after the popup's bank button was actually clicked.
 *   - The popup starts on an "intermediate" URL where its `click` always
 *     rejects; only after `waitForURL(MOCKSHARP_URL_PATTERN)` resolves
 *     does it accept a bank-button click.
 */
import {
  FRAME_SELECTOR,
  MOCKSHARP_URL_PATTERN,
  SELECTORS,
} from '../../src/browser/selectors.js';
import type { FrameLocatorLike, LocatorLike, PageLike } from '../../src/browser/types.js';

type Stage = 'loaded' | 'contactFilled' | 'cardSelected' | 'submitted';
const STAGE_ORDER: readonly Stage[] = ['loaded', 'contactFilled', 'cardSelected', 'submitted'];

interface World {
  stage: Stage;
  saveCardPromptVisible: boolean;
  popupStage: 'unopened' | 'intermediate' | 'mocksharp';
  bankClicked: 'success' | 'failure' | null;
}

export interface CheckoutFixtureConfig {
  /** Whether the conditional save-card prompt (step 8) shows up at all. */
  readonly saveCardPromptAppears?: boolean;
  /** The bank click registers but neither outcome marker ever appears (a hung/broken page). */
  readonly suppressOutcome?: boolean;
  /** A call label (see below) to throw an Error at. */
  readonly throwAt?: string;
}

export interface CheckoutFixture {
  readonly page: PageLike;
  readonly calls: string[];
  readonly world: World;
  /** Options `page.goto` was last called with, for asserting waitUntil. */
  gotoOptions(): { readonly timeout?: number; readonly waitUntil?: string } | undefined;
}

export const createCheckoutFixture = (config: CheckoutFixtureConfig = {}): CheckoutFixture => {
  const calls: string[] = [];
  const world: World = {
    stage: 'loaded',
    saveCardPromptVisible: false,
    popupStage: 'unopened',
    bankClicked: null,
  };
  let lastGotoOptions: { timeout?: number; waitUntil?: string } | undefined;

  const record = (label: string): void => {
    calls.push(label);
    if (config.throwAt === label) throw new Error(`boom at ${label}`);
  };

  const stageAtLeast = (required: Stage): boolean =>
    STAGE_ORDER.indexOf(world.stage) >= STAGE_ORDER.indexOf(required);

  const frameLocator = (selector: string): LocatorLike => ({
    fill: async (value) => {
      record(`frame.fill(${selector}, ${value})`);
      if (selector === SELECTORS.contact) {
        if (world.stage === 'loaded') world.stage = 'contactFilled';
        return;
      }
      if (
        selector === SELECTORS.cardNumber ||
        selector === SELECTORS.cardExpiry ||
        selector === SELECTORS.cardCvv
      ) {
        if (!stageAtLeast('cardSelected')) {
          throw new Error(`${selector} does not exist yet: the card method was not selected`);
        }
        return;
      }
      throw new Error(`unexpected fill on ${selector}`);
    },
    click: async () => {
      record(`frame.click(${selector})`);
      if (selector === SELECTORS.cardMethod) {
        if (!stageAtLeast('contactFilled')) {
          throw new Error('[data-testid="card"] not visible: contact has not been filled yet');
        }
        world.stage = 'cardSelected';
        return;
      }
      if (selector === SELECTORS.submit) {
        if (!stageAtLeast('cardSelected')) {
          throw new Error('bottom-cta-button not reachable: card fields were never filled');
        }
        world.stage = 'submitted';
        if (config.saveCardPromptAppears) world.saveCardPromptVisible = true;
        return;
      }
      if (selector === SELECTORS.declineSaveCard) {
        if (!world.saveCardPromptVisible) {
          throw new Error('pay_without_saving_card not visible: no save-card prompt is showing');
        }
        world.saveCardPromptVisible = false;
        return;
      }
      throw new Error(`unexpected click on ${selector}`);
    },
    waitFor: async () => {
      record(`frame.waitFor(${selector})`);
      if (selector === SELECTORS.cardMethod) {
        if (!stageAtLeast('contactFilled')) {
          throw new Error('timeout: [data-testid="card"] not visible yet');
        }
        return;
      }
      if (selector === SELECTORS.cardNumber) {
        if (!stageAtLeast('cardSelected')) {
          throw new Error('timeout: card.number not visible yet');
        }
        return;
      }
      if (selector === SELECTORS.declineSaveCard) {
        if (!world.saveCardPromptVisible) {
          throw new Error('timeout: save-card prompt not visible');
        }
        return;
      }
      if (selector === SELECTORS.paymentStatusHeading) {
        if (world.bankClicked !== 'success') {
          throw new Error('timeout: payment-status-heading not visible');
        }
        return;
      }
      if (selector === SELECTORS.retrySurface) {
        if (world.bankClicked !== 'failure') {
          throw new Error('timeout: retry-surface not visible');
        }
        return;
      }
      throw new Error(`unexpected waitFor on ${selector}`);
    },
  });

  const deadLocator = (frameSelector: string, elementSelector: string): LocatorLike => ({
    fill: async () => {
      throw new Error(`no frame matching ${frameSelector}: cannot locate ${elementSelector}`);
    },
    click: async () => {
      throw new Error(`no frame matching ${frameSelector}: cannot locate ${elementSelector}`);
    },
    waitFor: async () => {
      throw new Error(`no frame matching ${frameSelector}: cannot locate ${elementSelector}`);
    },
  });

  const popupPage: PageLike = {
    goto: () => {
      throw new Error('popup.goto should not be called');
    },
    frameLocator: () => {
      throw new Error('popup.frameLocator should not be called: the mock bank page has no frame');
    },
    click: async (selector) => {
      record(`popup.click(${selector})`);
      if (world.popupStage !== 'mocksharp') {
        throw new Error(
          `${selector} not clickable yet: the popup is still on the intermediate checkout URL, waitForURL was not awaited`,
        );
      }
      if (selector === SELECTORS.bankSuccess || selector === SELECTORS.bankFailure) {
        if (!config.suppressOutcome) {
          world.bankClicked = selector === SELECTORS.bankSuccess ? 'success' : 'failure';
        }
        return;
      }
      throw new Error(`unexpected click on ${selector}`);
    },
    waitForEvent: () => {
      throw new Error('popup.waitForEvent should not be called');
    },
    waitForURL: async (pattern) => {
      record(`popup.waitForURL(${pattern})`);
      if (pattern !== MOCKSHARP_URL_PATTERN) {
        throw new Error(`unexpected waitForURL pattern ${pattern}`);
      }
      world.popupStage = 'mocksharp';
    },
    screenshot: async () => {
      calls.push('popup.screenshot');
    },
  };

  const page: PageLike = {
    goto: async (url, options) => {
      record(`goto(${url})`);
      lastGotoOptions = options;
    },
    frameLocator: (selector): FrameLocatorLike => {
      calls.push(`frameLocator(${selector})`);
      if (selector !== FRAME_SELECTOR) {
        return { locator: (elementSelector) => deadLocator(selector, elementSelector) };
      }
      return { locator: frameLocator };
    },
    click: async (selector) => {
      // Nothing in the corrected driver clicks the top-level page: every
      // checkout element is in the frame, and the bank buttons are on the
      // popup. A call here means the driver queried the wrong document.
      throw new Error(
        `page.click(${selector}) should never be called: use the frame or the popup`,
      );
    },
    waitForEvent: async (event) => {
      record(`waitForEvent(${event})`);
      world.popupStage = 'intermediate';
      return popupPage;
    },
    waitForURL: () => {
      throw new Error('page.waitForURL should not be called: only the popup navigates');
    },
    screenshot: async () => {
      calls.push('screenshot');
    },
  };

  return { page, calls, world, gotoOptions: () => lastGotoOptions };
};
