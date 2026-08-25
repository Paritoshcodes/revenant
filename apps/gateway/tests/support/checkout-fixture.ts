/**
 * A fake checkout page for testing src/browser/checkout-flow.ts.
 *
 * Modelled directly against docs/CHECKOUT-FLOW.md (DEFINITIVE, 2026-08-24)
 * rather than against what the driver assumes: a fake that answers every
 * query unconditionally cannot catch a driver that queries the wrong
 * document, reads a transient state as terminal, or races a background
 * capture. Five driver bugs shipped with 16 passing tests for exactly
 * that reason (docs/DECISIONS.md, Build log entry 4). This fixture
 * enforces, structurally:
 *
 *   - The frame boundary: `page.frameLocator` on anything but
 *     FRAME_SELECTOR, and `page.locator` on anything but
 *     `.Payment-Completed`, both return a locator that rejects every
 *     call.
 *   - Staged availability: the frame's elements only resolve once the
 *     stage that creates them has been reached.
 *   - The popup's two-URL sequence: its bank button rejects until
 *     `waitForURL(MOCKSHARP_URL_PATTERN)` resolves, and its
 *     `/authenticate` request only fires on a later macrotask — never
 *     synchronously available the instant the popup opens.
 *   - The outcome heading's transient text and frame detachment on
 *     success: modelled per POLL TICK, advanced only by this fixture's
 *     own `sleep`, so it moves exactly when (and only when) the driver
 *     actually waits.
 */
import {
  FRAME_SELECTOR,
  MOCKSHARP_URL_PATTERN,
  PAYMENT_SUCCESSFUL_TEXT,
  SELECTORS,
} from '../../src/browser/selectors.js';
import { capturePaymentIds } from '../../src/browser/payment-id-capture.js';
import type {
  ContextLike,
  FrameLocatorLike,
  LocatorLike,
  PageLike,
  PaymentIdCapture,
  RequestLike,
} from '../../src/browser/types.js';

type Stage = 'loaded' | 'contactFilled' | 'cardSelected' | 'submitted';
const STAGE_ORDER: readonly Stage[] = ['loaded', 'contactFilled', 'cardSelected', 'submitted'];

interface World {
  stage: Stage;
  saveCardPromptVisible: boolean;
  popupStage: 'unopened' | 'intermediate' | 'mocksharp';
  bankClicked: 'success' | 'failure' | null;
  /** Poll ticks elapsed since the bank button was clicked; advanced only by this fixture's own sleep(). */
  outcomeTick: number;
  alreadyPaidOnLoad: boolean;
  /** Last value fill() stored per selector: proves fill() overwrites rather than appends. */
  fieldValues: Record<string, string>;
  popupsOpened: number;
}

export interface CheckoutFixtureConfig {
  readonly saveCardPromptAppears?: boolean;
  readonly throwAt?: string;
  readonly alreadyPaidOnLoad?: boolean;
  /**
   * Poll tick at which the frame heading reaches exactly "Payment
   * Successful" (success path only). Null skips the window entirely,
   * modelling docs/CHECKOUT-FLOW.md section 12's "the margin is real but
   * thin": the driver must then rely on the parent marker. Default 1.
   */
  readonly successHeadingTick?: number | null;
  /** Poll tick from which the frame is unqueryable ("detached") on the success path. Default 2. */
  readonly successDetachTick?: number;
  /** Poll tick from which the parent's `.Payment-Completed` appears on the success path. Default equals successDetachTick. */
  readonly successParentTick?: number;
  /** Poll tick from which the retry surface appears on the failure path. Default 3. */
  readonly failureSettleTick?: number;
  /**
   * Poll tick from which the heading stops returning text on the failure
   * path. Default equals failureSettleTick (no gap). Set lower than
   * failureSettleTick to model a window where the heading has already
   * gone but the retry surface has not rendered yet — proves a poll tick
   * completes via count() rather than blocking in textContent() on an
   * element known to be absent (docs/DECISIONS.md, Build log entry 6).
   */
  readonly failureHeadingGoneTick?: number;
  /** The bank click registers but neither outcome ever resolves: a hung page. */
  readonly suppressOutcome?: boolean;
  /** The popup opens, but its /authenticate request never fires: proves a genuine capture timeout surfaces. */
  readonly suppressPaymentIdCapture?: boolean;
}

export interface CheckoutFixture {
  readonly page: PageLike;
  readonly context: ContextLike;
  readonly capture: PaymentIdCapture;
  readonly calls: string[];
  readonly world: World;
  gotoOptions(): { readonly timeout?: number; readonly waitUntil?: string } | undefined;
  /** Advances outcome-phase state; wire into AttemptFlowOptions.sleep so polling costs no real time. */
  sleep(ms: number): Promise<void>;
}

export const createCheckoutFixture = (config: CheckoutFixtureConfig = {}): CheckoutFixture => {
  const successHeadingTick =
    config.successHeadingTick === undefined ? 1 : config.successHeadingTick;
  const successDetachTick = config.successDetachTick ?? 2;
  const successParentTick = config.successParentTick ?? successDetachTick;
  const failureSettleTick = config.failureSettleTick ?? 3;
  const failureHeadingGoneTick = config.failureHeadingGoneTick ?? failureSettleTick;

  const calls: string[] = [];
  const world: World = {
    stage: 'loaded',
    saveCardPromptVisible: false,
    popupStage: 'unopened',
    bankClicked: null,
    outcomeTick: 0,
    alreadyPaidOnLoad: config.alreadyPaidOnLoad ?? false,
    fieldValues: {},
    popupsOpened: 0,
  };
  let lastGotoOptions: { timeout?: number; waitUntil?: string } | undefined;
  const requestHandlers: Array<(request: RequestLike) => void> = [];

  const record = (label: string): void => {
    calls.push(label);
    if (config.throwAt === label) throw new Error(`boom at ${label}`);
  };

  const stageAtLeast = (required: Stage): boolean =>
    STAGE_ORDER.indexOf(world.stage) >= STAGE_ORDER.indexOf(required);

  const detached = (): Error => new Error('Frame was detached');

  // -- outcome-phase state, keyed by world.outcomeTick --------------------

  const frameIsDetached = (): boolean =>
    world.bankClicked === 'success' && world.outcomeTick >= successDetachTick;

  const parentPaymentCompletedCount = (): number => {
    if (world.alreadyPaidOnLoad) return 1;
    if (world.bankClicked === 'success' && world.outcomeTick >= successParentTick) return 1;
    return 0;
  };

  const headingText = (): string | null => {
    if (world.bankClicked === null) return null;
    if (world.bankClicked === 'failure') {
      return world.outcomeTick < failureHeadingGoneTick ? 'Confirming Payment' : null;
    }
    if (successHeadingTick !== null && world.outcomeTick === successHeadingTick) {
      return PAYMENT_SUCCESSFUL_TEXT;
    }
    return 'Confirming Payment';
  };

  const retrySurfaceCount = (): number => {
    if (world.bankClicked !== 'failure') return 0;
    return world.outcomeTick >= failureSettleTick ? 1 : 0;
  };

  // -- frame ----------------------------------------------------------------

  const frameLocator = (selector: string): LocatorLike => ({
    fill: async (value) => {
      record(`frame.fill(${selector}, ${value})`);
      if (selector === SELECTORS.contact) {
        if (world.stage === 'loaded') world.stage = 'contactFilled';
        world.fieldValues[selector] = value;
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
        // fill() clears then types: overwrite, never append, or a retry
        // would corrupt the field with the previous attempt's value
        // (docs/CHECKOUT-FLOW.md section 7).
        world.fieldValues[selector] = value;
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
      throw new Error(`unexpected waitFor on ${selector}`);
    },
    count: async () => {
      record(`frame.count(${selector})`);
      if (selector === SELECTORS.retrySurface) {
        if (frameIsDetached()) throw detached();
        return retrySurfaceCount();
      }
      if (selector === SELECTORS.paymentStatusHeading) {
        if (frameIsDetached()) throw detached();
        return headingText() !== null ? 1 : 0;
      }
      throw new Error(`unexpected count on ${selector}`);
    },
    textContent: async (options) => {
      record(`frame.textContent(${selector})`);
      if (selector === SELECTORS.paymentStatusHeading) {
        if (frameIsDetached()) throw detached();
        const text = headingText();
        if (text === null) {
          // Playwright's real textContent() auto-waits for the element
          // to be attached; on a genuinely absent element it blocks for
          // its timeout (30s default) and then rejects, it does not
          // resolve with null (docs/DECISIONS.md, Build log entry 6).
          // The fixture rejects immediately rather than actually
          // waiting, but the rejection itself is what a driver that
          // skips the count() check first must be made to observe.
          throw new Error(
            `Timeout ${options?.timeout ?? 30_000}ms exceeded waiting for ${selector} to be attached`,
          );
        }
        return text;
      }
      throw new Error(`unexpected textContent on ${selector}`);
    },
  });

  const deadLocator = (documentLabel: string, elementSelector: string): LocatorLike => {
    const fail = async (): Promise<never> => {
      throw new Error(`no frame matching ${documentLabel}: cannot locate ${elementSelector}`);
    };
    return { fill: fail, click: fail, waitFor: fail, count: fail, textContent: fail };
  };

  // -- popup ------------------------------------------------------------------

  const popupPage: PageLike = {
    goto: () => {
      throw new Error('popup.goto should not be called');
    },
    locator: () => {
      throw new Error('popup.locator should not be called');
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
        // Each attempt's outcome timeline starts fresh from its own bank
        // click, not from wherever a previous attempt in this session
        // left off.
        world.outcomeTick = 0;
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

  // -- parent page --------------------------------------------------------------

  const pageLocator = (selector: string): LocatorLike => {
    if (selector !== SELECTORS.paymentCompleted) {
      const fail = async (): Promise<never> => {
        throw new Error(
          `page.locator(${selector}) should never be called: only .Payment-Completed lives on the parent`,
        );
      };
      return { fill: fail, click: fail, waitFor: fail, count: fail, textContent: fail };
    }
    return {
      fill: async () => {
        throw new Error('div.Payment-Completed is not fillable');
      },
      click: async () => {
        throw new Error('div.Payment-Completed is not clickable');
      },
      waitFor: async () => {
        throw new Error('use count(), not waitFor(), for the pre-flight/outcome check');
      },
      count: async () => {
        record(`page.count(${selector})`);
        return parentPaymentCompletedCount();
      },
      textContent: async () => {
        throw new Error('div.Payment-Completed textContent is not modelled');
      },
    };
  };

  const page: PageLike = {
    goto: async (url, options) => {
      record(`goto(${url})`);
      lastGotoOptions = options;
    },
    locator: (selector) => {
      calls.push(`locator(${selector})`);
      return pageLocator(selector);
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
      world.popupsOpened += 1;
      const paymentIdSegment = `Ttest${world.popupsOpened}`;
      if (config.suppressPaymentIdCapture) return popupPage;
      // Fires on a LATER macrotask, never synchronously: proves the
      // driver's wait-for-growth is load-bearing, not incidentally
      // already satisfied by the time it checks
      // (docs/CHECKOUT-FLOW.md section 11).
      setTimeout(() => {
        for (const handler of requestHandlers) {
          handler({
            url: () => `https://api.razorpay.com/v1/payments/${paymentIdSegment}/authenticate`,
          });
        }
      }, 0);
      return popupPage;
    },
    waitForURL: () => {
      throw new Error('page.waitForURL should not be called: only the popup navigates');
    },
    screenshot: async () => {
      calls.push('screenshot');
    },
  };

  const context: ContextLike = {
    on: (event, handler) => {
      if (event === 'request') requestHandlers.push(handler);
    },
  };

  return {
    page,
    context,
    capture: capturePaymentIds(context),
    calls,
    world,
    gotoOptions: () => lastGotoOptions,
    sleep: async (ms) => {
      calls.push(`sleep(${ms})`);
      world.outcomeTick += 1;
    },
  };
};
