/**
 * Browser driver vocabulary.
 */
import type { RecoveryAction, Result } from '@revenant/contracts';

/** The slice of Playwright's Locator this module depends on. */
export interface LocatorLike {
  click(options?: { readonly timeout?: number }): Promise<void>;
  waitFor(options?: {
    readonly state?: 'visible' | 'attached';
    readonly timeout?: number;
  }): Promise<void>;
}

/**
 * The slice of Playwright's Page this module depends on. A real
 * playwright.Page satisfies this structurally, so nothing in this module
 * imports the playwright package: the flow logic stays unit-testable with
 * a plain fake, matching how the rest of the gateway fakes Queryable
 * rather than importing pg types.
 */
export interface PageLike {
  goto(url: string, options?: { readonly timeout?: number }): Promise<unknown>;
  fill(
    selector: string,
    value: string,
    options?: { readonly timeout?: number },
  ): Promise<void>;
  click(selector: string, options?: { readonly timeout?: number }): Promise<void>;
  locator(selector: string): LocatorLike;
  waitForEvent(
    event: 'popup',
    options?: { readonly timeout?: number },
  ): Promise<PageLike>;
  waitForSelector(
    selector: string,
    options?: { readonly timeout?: number },
  ): Promise<unknown>;
  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
    options?: { readonly timeout?: number },
  ): Promise<void>;
  screenshot(options?: { readonly path?: string }): Promise<unknown>;
}

export type CheckoutOutcome = 'captured' | 'failed';

export interface AttemptFlowOptions {
  readonly contact?: string;
  readonly expiry?: string;
  readonly cvv?: string;
  /** Budget given to every individual Playwright action. */
  readonly timeoutMs?: number;
  /** Shorter budget for the conditional save-card prompt check. */
  readonly saveCardGuardMs?: number;
  /** Directory for failure screenshots. Omit to skip screenshots entirely. */
  readonly screenshotDir?: string;
}

export interface AttemptFlowResult {
  readonly outcome: CheckoutOutcome;
}

/** One checkout session, positioned at the entry point attempt() expects. */
export interface CheckoutSession {
  readonly page: PageLike;
  readonly cardNumber: string;
  readonly outcome: 'success' | 'failure';
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
 * across attempts on one transaction is this port's responsibility.
 */
export interface CheckoutSessionProvider {
  prepare(input: {
    readonly transactionId: string;
    readonly attemptNumber: number;
    readonly idempotencyKey: string;
    readonly action: RecoveryAction;
  }): Promise<Result<CheckoutSession>>;
}
