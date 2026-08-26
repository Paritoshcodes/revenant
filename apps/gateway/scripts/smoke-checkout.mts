/**
 * Manual smoke test for the Playwright checkout driver.
 * Not part of the test suite. Drives one real payment link headed so you
 * can watch it, then immediately drives a second attempt on the same page
 * to prove the retry surface loop works.
 *
 *   npx tsx scripts/smoke-checkout.mts <scenario>
 *
 * scenario defaults to insufficient_fund and selects which test card to
 * use, resolved from packages/contracts/data/decline-taxonomy.json (or
 * 'success' for the baseline card that captures). It does NOT determine
 * the outcome: the mock bank page's Success/Failure button does that
 * (docs/DECISIONS.md), which is why attempt 1 below is driven as a
 * failure and attempt 2 as a success regardless of which card was picked.
 *
 * Creates its OWN fresh payment link every run rather than reading one
 * from a fixed sample file: a payment link can only ever be driven to a
 * captured outcome once (docs/CHECKOUT-FLOW.md section 10, "A PAID link
 * does not offer a payable checkout"), so a snapshot of pre-created links
 * is single-use and goes stale the first time this script runs each one.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DECLINE_TAXONOMY, BASELINE_SUCCESS_CARD_DIGITS } from '@revenant/contracts';
import { chromium } from 'playwright';

import { openCheckout, attempt, capturePaymentIds } from '../src/browser/index.js';
import { loadConfig } from '../src/config.js';
import { createRazorpayClient } from '../src/razorpay/client.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const scenario = process.argv[2] ?? 'insufficient_fund';

const resolveCard = (name: string): string => {
  if (name === 'success') return BASELINE_SUCCESS_CARD_DIGITS;

  const reason = DECLINE_TAXONOMY.find((r) => r.error_reason === name);
  if (reason === undefined) {
    console.error(`unknown scenario '${name}'. available:`);
    console.error(['success', ...DECLINE_TAXONOMY.map((r) => r.error_reason)].join(', '));
    process.exit(1);
  }
  const card = reason.test_cards[0];
  if (card === undefined) {
    console.error(
      `scenario '${name}' has no test card: it only reproduces via a real user action ` +
        `(docs/DECISIONS.md), not a card simulation. Try 'success' or another scenario.`,
    );
    process.exit(1);
  }
  return card.replace(/\s/g, '');
};

const card = resolveCard(scenario);

const config = loadConfig();
const client = createRazorpayClient(config.razorpay);

const created = await client.createPaymentLink({
  amount_paise: 49_900,
  description: `smoke test (${scenario})`,
});
if (!created.ok) {
  console.error('payment link creation failed:', created.error);
  process.exit(1);
}

console.log(`scenario ${scenario}\ncard     ${card}\nurl      ${created.value.short_url}\n`);

const browser = await chromium.launch({ headless: false, slowMo: 300 });
const context = await browser.newContext();
const capture = capturePaymentIds(context as never);
const page = await context.newPage();

const opts = {
  contact: '9000090000',
  expiry: '12/30',
  cvv: '123',
  timeoutMs: 30_000,
  screenshotDir: join(repoRoot, 'tmp'),
};

const opened = await openCheckout(page as never, created.value.short_url, opts);
if (!opened.ok) {
  console.error('openCheckout failed:', opened.error);
  await browser.close();
  process.exit(1);
}
console.log('openCheckout ok');

// Attempt 1: take the Failure path so we land on the retry surface.
const first = await attempt(page as never, card, 'failure', capture, opts);
console.log('attempt 1:', JSON.stringify(first));

if (!first.ok || first.value.outcome !== 'failed') {
  console.error('expected a failed outcome on attempt 1');
  await browser.close();
  process.exit(1);
}

// Attempt 2 on the SAME page. This is the claim the whole batch design
// rests on: the retry surface re-exposes the card entry point.
console.log('\nretrying on the same page...');
const second = await attempt(page as never, card, 'success', capture, opts);
console.log('attempt 2:', JSON.stringify(second));

console.log('\npayment ids captured:', capture.list());

console.log(
  second.ok && second.value.outcome === 'captured'
    ? '\nretry loop works'
    : '\nretry loop did NOT reach a captured outcome',
);

await new Promise((r) => setTimeout(r, 3000));
await browser.close();
