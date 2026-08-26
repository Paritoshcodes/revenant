/**
 * HISTORICAL. Not runnable as-is: it reads data/samples/link_map.json,
 * a snapshot of payment links created 2026-08-24, since deleted (all 13
 * were consumed; the quota those links existed to conserve is gone too,
 * see docs/API-BEHAVIOUR.md and docs/DECISIONS.md). Kept for the record
 * of how the original DOM reconnaissance was done, not as a live tool.
 *
 * Its findings are already captured in docs/CHECKOUT-FLOW.md and
 * docs/DECISIONS.md's build log, which supersede anything this script
 * would print. It also predates fixes made since (e.g. it drives
 * `[data-testid="bottom-cta-button"]` directly rather than the
 * `:visible`-scoped selector in src/browser/selectors.ts), so treat any
 * output as informative only, not as current DOM ground truth.
 *
 * If reconnaissance like this is needed again, prefer creating a fresh
 * payment link via `client.createPaymentLink` (see scripts/smoke-checkout.mts)
 * over resurrecting this script's link_map.json dependency.
 *
 * Original description follows.
 *
 * Full checkout reconnaissance. Walks every step of the flow and dumps the
 * real DOM state at each one, into tmp/recon.json.
 *
 * Uses the same Playwright API the driver uses, so what it records is what
 * the driver will actually encounter.
 *
 *   npx tsx scripts/recon.mts <scenario>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Frame, type Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const outDir = join(repoRoot, 'tmp');
mkdirSync(outDir, { recursive: true });

const scenario = process.argv[2] ?? 'payment_timed_out';
const linkMap = JSON.parse(
  readFileSync(join(repoRoot, 'data', 'samples', 'link_map.json'), 'utf8'),
);
const entry = linkMap[scenario];
if (!entry) {
  console.error(`unknown scenario. available: ${Object.keys(linkMap).join(', ')}`);
  process.exit(1);
}
const CARD = entry.card.replace(/\s/g, '');

const steps: unknown[] = [];

/**
 * Dump every interactive element in a frame or page.
 *
 * The body is a STRING, not a function: tsx/esbuild injects a `__name`
 * helper for named functions, which does not exist in the page context and
 * fails with "ReferenceError: __name is not defined".
 */
const PROBE_JS = `(() => {
  const q = (sel) => Array.from(document.querySelectorAll(sel));
  return {
    url: location.href,
    testids: q('[data-testid]').map((e) => ({
      testid: e.dataset.testid,
      tag: e.tagName.toLowerCase(),
      text: (e.textContent || '').trim().slice(0, 40),
      visible: !!e.offsetParent,
    })),
    inputs: q('input').map((e) => ({
      name: e.name, type: e.type, placeholder: e.placeholder,
      visible: !!e.offsetParent,
    })),
    buttons: q('button').map((e) => ({
      name: e.name, dataVal: e.dataset.val,
      cls: String(e.className).slice(0, 40),
      text: (e.textContent || '').trim().slice(0, 30),
    })),
    markers: {
      paymentCompleted: q('.Payment-Completed').length,
      retrySurface: q('[data-testid="retry-surface"]').length,
    },
  };
})()`;

async function probe(ctx: Frame | Page, label: string) {
  const data = (await ctx.evaluate(PROBE_JS)) as any;
  steps.push({ step: label, ...data });
  console.log(`\n=== ${label} ===`);
  console.log(`  testids: ${data.testids.filter((t: any) => t.visible).map((t: any) => t.testid).join(', ')}`);
  console.log(`  inputs:  ${data.inputs.filter((i: any) => i.visible).map((i: any) => i.name).join(', ')}`);
  console.log(`  markers: completed=${data.markers.paymentCompleted} retry=${data.markers.retrySurface}`);
}

const FRAME = 'iframe.razorpay-checkout-frame';

const browser = await chromium.launch({ headless: false, slowMo: 400 });
const page = await browser.newPage();

console.log(`scenario ${scenario}  card ${CARD}\n${entry.short_url}`);
await page.goto(entry.short_url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const cf = () => page.frameLocator(FRAME);
const frame = () => page.frames().find((f) => f.url().includes('checkout/public'))!;

await probe(page, '01_parent_on_load');
await probe(frame(), '02_frame_on_load');

// contact
await cf().locator('input[name="contact"]').fill('9000090000');
await page.waitForTimeout(2000);
await probe(frame(), '03_frame_after_contact');

// card method
await cf().locator('[data-testid="card"]').click();
await page.waitForTimeout(2000);
await probe(frame(), '04_frame_after_card_click');

// card details
await cf().locator('input[name="card.number"]').fill(CARD);
await cf().locator('input[name="card.expiry"]').fill('12/30');
await cf().locator('input[name="card.cvv"]').fill('123');
await page.waitForTimeout(1000);
await probe(frame(), '05_frame_card_filled');

// submit, watching for the popup
const popupPromise = page.waitForEvent('popup', { timeout: 20000 }).catch(() => null);
await cf().locator('[data-testid="bottom-cta-button"]').click();
await page.waitForTimeout(3000);
await probe(frame(), '06_frame_after_continue');

// save-card prompt is conditional
const saveCard = cf().locator('button[name="pay_without_saving_card"]');
if (await saveCard.count()) {
  console.log('\n  save-card prompt PRESENT');
  await saveCard.click();
} else {
  console.log('\n  save-card prompt ABSENT');
}

const popup = await popupPromise;
if (!popup) {
  console.log('\n  NO POPUP CAPTURED');
  writeFileSync(join(outDir, 'recon.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  process.exit(1);
}

await popup.waitForURL('**/gateway/mocksharp/**', { timeout: 20000 });
await popup.waitForLoadState('domcontentloaded');
await probe(popup, '07_popup_bank_page');

// second CLI arg: 'S' for success, anything else for failure
const bankButton = process.argv[3] === 'S' ? 'S' : 'F';
console.log(`\n  clicking bank button data-val="${bankButton}"`);
await popup.click(`button[data-val="${bankButton}"]`);
// Probe repeatedly: outcome markers may pass through a transient state.
const t0 = Date.now();
for (const ms of [400, 800, 1500, 3000, 6000, 10000]) {
  const wait = ms - (Date.now() - t0);
  if (wait > 0) await page.waitForTimeout(wait);
  const snap = (await frame().evaluate(`(() => {
    const g = (s) => document.querySelector(s);
    const txt = (s) => { const e = g(s); return e ? e.textContent.trim().slice(0,60) : null; };
    return {
      heading: txt('[data-testid="payment-status-heading"]'),
      retrySurface: !!g('[data-testid="retry-surface"]'),
      retryDesc: txt('[data-testid="retry-description"]'),
      modal: !!g('[data-testid="payment-status-modal"]'),
    };
  })()`)) as any;
  console.log(`  t+${ms}ms  heading=${JSON.stringify(snap.heading)}  retry=${snap.retrySurface}  desc=${JSON.stringify(snap.retryDesc)}`);
  steps.push({ step: `timeline_${ms}ms`, ...snap });
}

await probe(page, '08_parent_after_outcome');
await probe(frame(), '09_frame_after_outcome');

writeFileSync(join(outDir, 'recon.json'), JSON.stringify(steps, null, 2));
console.log(`\nwrote tmp/recon.json (${steps.length} steps)`);
await page.waitForTimeout(4000);
await browser.close();
