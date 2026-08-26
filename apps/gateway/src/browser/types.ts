/**
 * Browser driver vocabulary.
 */
import type { RecoveryAction, Result } from '@revenant/contracts';

/** The slice of Playwright's Locator this module depends on. */
export interface LocatorLike {
  click(options?: { readonly timeout?: number }): Promise<void>;
  fill(value: string, options?: { readonly timeout?: number }): Promise<void>;
  waitFor(options?: {
    readonly state?: 'visible' | 'attached';
    readonly timeout?: number;
  }): Promise<void>;
  /** Immediate, non-waiting count of currently-matching elements. */
  count(): Promise<number>;
  /**
   * Immediate, non-waiting read of the field's current value. Used to poll
   * for the value settling after fill() resolves: fill() dispatching the
   * input event and the checkout app's own React state (and any reformat,
   * docs/CHECKOUT-FLOW.md section 9) catching up to it are two different
   * moments, and clicking on before the second one lands risks the
   * checkout acting on stale internal state (docs/DECISIONS.md, Build log
   * entry 7).
   */
  inputValue(options?: { readonly timeout?: number }): Promise<string>;
  /**
   * Playwright's real `textContent()` AUTO-WAITS for the element to be
   * attached, using its own default timeout (30s) when none is given
   * here. On an element that never appears — or that has already
   * disappeared — this blocks for the full timeout and then rejects; it
   * does NOT resolve immediately with null (docs/DECISIONS.md, Build log
   * entry 6). Callers must check `count()` first and only call this once
   * the element is known to exist, and should still pass a short
   * `timeout` as a second line of defence against the gap between the
   * two calls.
   */
  textContent(options?: { readonly timeout?: number }): Promise<string | null>;
}

/**
 * The slice of Playwright's FrameLocator this module depends on. Every
 * checkout element lives inside iframe.razorpay-checkout-frame, a
 * cross-origin frame reachable only through this API, never through the
 * parent's DOM (docs/CHECKOUT-FLOW.md section 1).
 */
export interface FrameLocatorLike {
  locator(selector: string): LocatorLike;
}

/**
 * The slice of Playwright's Page this module depends on. A real
 * playwright.Page satisfies this structurally, so nothing in this module
 * imports the playwright package: the flow logic stays unit-testable with
 * a plain fake, matching how the rest of the gateway fakes Queryable
 * rather than importing pg types.
 *
 * `locator` reaches the top-level document only, used for the one thing
 * that genuinely lives there: `div.Payment-Completed`, checked both
 * pre-flight and as the primary outcome signal. Everything else
 * checkout-shaped goes through `frameLocator`. `click` is for the mock
 * bank popup's Success/Failure buttons, which live directly on ITS
 * top-level document, not inside a frame.
 */
export interface PageLike {
  goto(
    url: string,
    options?: {
      readonly timeout?: number;
      readonly waitUntil?: 'domcontentloaded';
    },
  ): Promise<unknown>;
  locator(selector: string): LocatorLike;
  frameLocator(selector: string): FrameLocatorLike;
  click(selector: string, options?: { readonly timeout?: number }): Promise<void>;
  waitForEvent(
    event: 'popup',
    options?: { readonly timeout?: number },
  ): Promise<PageLike>;
  /**
   * The popup opens on an intermediate URL that carries the payment id
   * before navigating to the mocksharp bank page; this is how the driver
   * waits for that navigation rather than the popup's initial load.
   */
  waitForURL(url: string, options?: { readonly timeout?: number }): Promise<void>;
  screenshot(options?: { readonly path?: string }): Promise<unknown>;
}

/** The slice of a Playwright Request this module depends on. */
export interface RequestLike {
  url(): string;
}

/**
 * The slice of Playwright's BrowserContext this module depends on.
 * Context-level, not page- or popup-level: it observes requests from
 * every page/frame/popup in the context, which is what makes it possible
 * to catch the popup's initial navigation — the only place the payment id
 * appears — regardless of exactly when the popup handle itself becomes
 * available (docs/CHECKOUT-FLOW.md section 11).
 */
export interface ContextLike {
  on(event: 'request', handler: (request: RequestLike) => void): void;
}

/**
 * Ids captured from popup navigations, in the order observed. Built once
 * per checkout session (payment-id-capture.ts) and shared across every
 * attempt on that session, since each attempt's popup fires its own
 * matching request against the same context.
 */
export interface PaymentIdCapture {
  /** Ids observed so far, oldest first, each already `pay_`-prefixed. */
  list(): readonly string[];
  /**
   * Resolves once list().length exceeds `fromLength`, or rejects on
   * timeout. Reading list()[list().length - 1] immediately after
   * triggering an attempt can still miss the newest id by a few
   * milliseconds (docs/CHECKOUT-FLOW.md section 11) — this is what
   * waiting properly looks like instead.
   */
  waitForGrowth(fromLength: number, timeoutMs: number): Promise<void>;
}

export type CheckoutOutcome = 'captured' | 'failed';

export interface AttemptFlowOptions {
  readonly contact?: string;
  readonly expiry?: string;
  readonly cvv?: string;
  /** Budget given to every individual Playwright action, and to outcome polling overall. Should be >= 30s. */
  readonly timeoutMs?: number;
  /** Directory for failure screenshots. Omit to skip screenshots entirely. */
  readonly screenshotDir?: string;
  /** Injected so outcome polling is instant and deterministic in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AttemptFlowResult {
  readonly outcome: CheckoutOutcome;
  /** From the popup's initial navigation, via PaymentIdCapture. Null only if capture genuinely failed. */
  readonly paymentId: string | null;
}

/** One checkout session, positioned at the entry point attempt() expects. */
export interface CheckoutSession {
  readonly page: PageLike;
  readonly cardNumber: string;
  readonly outcome: 'success' | 'failure';
  readonly capture: PaymentIdCapture;
}

/**
 * Resolves one execute() call to a page ready at [data-testid="card"], plus
 * the card number and target bank outcome to drive.
 *
 * Deliberately not built in this module: AttemptExecutor.execute()'s input
 * (transactionId, attemptNumber, idempotencyKey, action) carries no payment
 * link URL, card number, or target bank outcome, so something has to
 * supply them — and which payment link, which card, and which outcome to
 * drive are batch/orchestration decisions, not browser-automation ones.
 *
 * On the first attempt this means opening the link and filling contact
 * (openCheckout in checkout-flow.ts) before handing back the page; on a
 * retry it means handing back the SAME page, already sitting on the retry
 * surface from the previous failed attempt (docs/CHECKOUT-FLOW.md,
 * "Consequence: one link supports multiple attempts") — page lifecycle
 * across attempts on one transaction is this port's responsibility, as is
 * constructing the one PaymentIdCapture shared across those attempts.
 */
export interface CheckoutSessionProvider {
  prepare(input: {
    readonly transactionId: string;
    readonly attemptNumber: number;
    readonly idempotencyKey: string;
    readonly action: RecoveryAction;
  }): Promise<Result<CheckoutSession>>;
}
