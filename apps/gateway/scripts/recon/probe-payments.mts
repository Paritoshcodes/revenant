/**
 * Drives payments to generate webhook traffic and find the attempt ceiling.
 * Run webhook-receiver.mts + a tunnel FIRST, and register the tunnel URL in
 * the Razorpay dashboard (test-mode OTP is 754081).
 *
 *   npx tsx scripts/probe-payments.mts
 *
 * Writes tmp/payment-probe.json. Cross-check against tmp/webhook-events.jsonl.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const KEY = process.env.RZP_KEY!;
const SECRET = process.env.RZP_SECRET!;
const API = 'https://api.razorpay.com/v1';
const FRAME = 'iframe.razorpay-checkout-frame';
const CARD = '4100280000001007';
const MAX_PROBE = 6; // 5 failures then a capture, to find the ceiling

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
mkdirSync(join(repoRoot, 'tmp'), { recursive: true });
const auth = 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64');

async function rzp(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
}

/**
 * Payment ids are captured from CONTEXT-LEVEL request events, not from
 * popup.url(). The popup navigates away from /v1/payments/<id>/authenticate
 * before we can read it, especially headless. Request events cannot be missed.
 */
const seenPayIds: string[] = [];
function watchPayIds(context: any) {
  context.on('request', (req: any) => {
    const m = req.url().match(/\/v1\/payments\/([A-Za-z0-9]+)\/authenticate/);
    if (m && !seenPayIds.includes(m[1])) seenPayIds.push(m[1]);
  });
}

async function dumpFrame(page: any, label: string) {
  try {
    const d = await page.frameLocator(FRAME).locator('body').evaluate(`(b) => {
      const doc = b.ownerDocument;
      return {
        inputs: [...doc.querySelectorAll('input')].map(i => ({ name: i.name, value: i.value })),
        errors: [...doc.querySelectorAll('[class*="error"],[class*="danger"],[role="alert"]')]
                  .map(e => e.textContent.trim().slice(0,60)).filter(Boolean).slice(0,6),
        cta: [...doc.querySelectorAll('[data-testid="bottom-cta-button"]')]
                  .map(b2 => ({ text: b2.textContent.trim(), disabled: b2.disabled })),
        testids: [...doc.querySelectorAll('[data-testid]')].map(e => e.dataset.testid)
                  .filter(Boolean).slice(0,40),
      };
    }`);
    console.log(`  [dump ${label}]`, JSON.stringify(d));
    return d;
  } catch (e: any) { return { dumpError: String(e.message).slice(0, 120) }; }
}

async function attempt(page: any, first: boolean, choice: 'S' | 'F') {
  const cf = page.frameLocator(FRAME);
  if (!first) {
    await cf.locator('[data-testid="card"]').waitFor({ timeout: 25000 });
    await cf.locator('[data-testid="card"]').click();
    await page.waitForTimeout(1500);
  }
  await cf.locator('input[name="card.number"]').waitFor({ timeout: 20000 });
  // Clear before filling: fields RETAIN values across a retry.
  for (const [sel, val] of [['card.number', CARD], ['card.expiry', '12/30'], ['card.cvv', '123']] as const) {
    const el = cf.locator(`input[name="${sel}"]`);
    await el.fill('');
    await page.waitForTimeout(150);
    await el.fill(val);
    await page.waitForTimeout(150);
  }
  const before = await dumpFrame(page, `pre-submit-${first ? 1 : 'retry'}`);

  const popupPromise = page.waitForEvent('popup', { timeout: 30000 }).catch(() => null);
  await cf.locator('[data-testid="bottom-cta-button"]').click();
  const later = cf.locator('button[name="pay_without_saving_card"]');
  try { await later.waitFor({ timeout: 4000 }); await later.click(); } catch {}

  const popup = await popupPromise;
  if (!popup) {
    await dumpFrame(page, 'popup-timeout');
    throw new Error('no popup after submit; see dump above. pre-submit=' + JSON.stringify(before));
  }
  const payId = seenPayIds.at(-1) ?? null;
  await popup.waitForURL('**/gateway/mocksharp/**', { timeout: 30000 });
  const tClick = Date.now();
  await popup.click(`button[data-val="${choice}"]`);

  const deadline = Date.now() + 45000;
  let outcome = 'timeout';
  let retryDesc: string | null = null;
  while (Date.now() < deadline) {
    if (await page.locator('.Payment-Completed').count()) { outcome = 'captured'; break; }
    try {
      const rs = page.frameLocator(FRAME).locator('[data-testid="retry-surface"]');
      if (await rs.count()) {
        outcome = 'failed';
        retryDesc = await page.frameLocator(FRAME)
          .locator('[data-testid="retry-description"]').textContent().catch(() => null);
        break;
      }
    } catch { /* frame detached => success in flight */ }
    await page.waitForTimeout(400);
  }
  return { payId, outcome, retryDesc, settleMs: Date.now() - tClick };
}

const link = await rzp('/payment_links', 'POST', {
  amount: 49900, currency: 'INR', description: 'probe payments',
  customer: { name: 'Test Customer', email: 'test@example.com', contact: '+919000090000' },
  notify: { sms: false, email: false }, reference_id: `pp_${Date.now()}`,
});
console.log('link', link.body.short_url, '\n');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
watchPayIds(context);
const page = await context.newPage();
await page.goto(link.body.short_url, { waitUntil: 'domcontentloaded' });
const cf = page.frameLocator(FRAME);
await cf.locator('input[name="contact"]').fill('9000090000', { timeout: 30000 });
await cf.locator('[data-testid="card"]').waitFor({ timeout: 20000 });
await cf.locator('[data-testid="card"]').click();

const attempts: any[] = [];
for (let n = 1; n <= MAX_PROBE; n++) {
  const choice = n === MAX_PROBE ? 'S' : 'F';
  try {
    const r = await attempt(page, n === 1, choice);
    attempts.push({ n, choice, ...r });
    console.log(`  attempt ${n} (${choice}):`, JSON.stringify(r));
    if (r.outcome === 'captured' || r.outcome === 'timeout') break;
  } catch (e: any) {
    attempts.push({ n, choice, error: String(e.message).slice(0, 200) });
    console.log(`  attempt ${n} ERROR:`, attempts.at(-1).error);
    break;
  }
}
await browser.close();

console.log('\nwaiting 45s for webhook delivery...');
await new Promise((r) => setTimeout(r, 45000));

// API-side truth for every payment we created
console.log('payment ids seen on the wire:', seenPayIds);
const verified = [];
for (const id of seenPayIds) {
  const a = attempts.find((x) => x.payId === id) ?? { n: null, outcome: 'unknown' };
  const p = await rzp(`/payments/pay_${id}`);
  verified.push({
    n: a.n, payId: `pay_${id}`, driverSaid: a.outcome,
    apiStatus: p.body.status, apiReason: p.body.error_reason,
    apiSource: p.body.error_source, apiStep: p.body.error_step,
    agrees: (a.outcome === 'captured') === (p.body.status === 'captured'),
  });
  await new Promise((r) => setTimeout(r, 1500));
}

const linkFinal = await rzp(`/payment_links/${link.body.id}`);
writeFileSync(join(repoRoot, 'tmp', 'payment-probe.json'), JSON.stringify({
  linkId: link.body.id, attempts, verified,
  linkFinal: { status: linkFinal.body.status, amount_paid: linkFinal.body.amount_paid,
               order_id: linkFinal.body.order_id ?? null },
}, null, 2));
console.log(JSON.stringify(verified, null, 2));
console.log('\nwrote tmp/payment-probe.json');
