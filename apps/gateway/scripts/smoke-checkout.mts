/**
 * Manual smoke test for the Playwright checkout driver.
 * Not part of the test suite. Drives one real payment link headed so you
 * can watch it, then immediately drives a second attempt on the same page
 * to prove the retry surface loop works.
 *
 *   npx tsx scripts/smoke-checkout.mts <scenario>
 *
 * scenario defaults to insufficient_fund and must exist in
 * data/samples/link_map.json.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { openCheckout, attempt } from '../src/browser/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const scenario = process.argv[2] ?? 'insufficient_fund';
const linkMap = JSON.parse(
  readFileSync(join(repoRoot, 'data', 'samples', 'link_map.json'), 'utf8'),
);

const entry = linkMap[scenario];
if (!entry) {
  console.error(`unknown scenario '${scenario}'. available:`);
  console.error(Object.keys(linkMap).join(', '));
  process.exit(1);
}

const card = entry.card.replace(/\s/g, '');
console.log(`scenario ${scenario}\ncard     ${card}\nurl      ${entry.short_url}\n`);

const browser = await chromium.launch({ headless: false, slowMo: 300 });
const page = await browser.newPage();

const opts = {
  contact: '9000090000',
  expiry: '12/30',
  cvv: '123',
  timeoutMs: 30_000,
  screenshotDir: join(repoRoot, 'tmp'),
};

const opened = await openCheckout(page as never, entry.short_url, opts);
if (!opened.ok) {
  console.error('openCheckout failed:', opened.error);
  await browser.close();
  process.exit(1);
}
console.log('openCheckout ok');

// Attempt 1: take the Failure path so we land on the retry surface.
const first = await attempt(page as never, card, 'failure', opts);
console.log('attempt 1:', JSON.stringify(first));

if (!first.ok || first.value.outcome !== 'failed') {
  console.error('expected a failed outcome on attempt 1');
  await browser.close();
  process.exit(1);
}

// Attempt 2 on the SAME page. This is the claim the whole batch design
// rests on: the retry surface re-exposes the card entry point.
console.log('\nretrying on the same page...');
const second = await attempt(page as never, card, 'success', opts);
console.log('attempt 2:', JSON.stringify(second));

console.log(
  second.ok && second.value.outcome === 'captured'
    ? '\nretry loop works'
    : '\nretry loop did NOT reach a captured outcome',
);

await new Promise((r) => setTimeout(r, 3000));
await browser.close();
