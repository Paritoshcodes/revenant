/**
 * Probes the three remaining unverified behaviours. Run once, commit the
 * output. Uses the flow verified in docs/CHECKOUT-FLOW.md.
 *
 *   npx tsx scripts/probe-open-questions.mts
 *
 * A) abandon      close the page mid-checkout. Does a payment record exist?
 * B) otp          does an OTP page ever appear instead of the bank buttons?
 * C) third-attempt  can a link carry attempt 3? can a CAPTURED link be reused?
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Page, type Browser } from 'playwright';

const KEY = process.env.RZP_KEY!;
const SECRET = process.env.RZP_SECRET!;
const API = 'https://api.razorpay.com/v1';
const FRAME = 'iframe.razorpay-checkout-frame';
const CARD = '4100280000001007';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
mkdirSync(join(repoRoot, 'tmp'), { recursive: true });

const auth = 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64');
const findings: any[] = [];

async function api(path: string, init?: RequestInit) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
  });
  return { status: r.status, body: await r.json() };
}

async function newLink(tag: string) {
  const r = await api('/payment_links', {
    method: 'POST',
    body: JSON.stringify({
      amount: 49900, currency: 'INR', description: `probe ${tag}`,
      customer: { name: 'Test Customer', email: 'test@example.com', contact: '+919000090000' },
      notify: { sms: false, email: false },
      reference_id: `probe_${tag}_${Date.now()}`,
    }),
  });
  if (r.status !== 200) throw new Error(`link create failed: ${JSON.stringify(r.body)}`);
  await new Promise((s) => setTimeout(s, 6000)); // rate limit
  return r.body as { id: string; short_url: string };
}

/** Fill contact, pick cards, fill card fields, submit. Returns the popup. */
async function driveToBank(page: Page, shortUrl: string) {
  await page.goto(shortUrl, { waitUntil: 'domcontentloaded' });
  const cf = page.frameLocator(FRAME);
  await cf.locator('input[name="contact"]').fill('9000090000', { timeout: 30000 });
  await cf.locator('[data-testid="card"]').waitFor({ timeout: 15000 });
  await cf.locator('[data-testid="card"]').click();
  await cf.locator('input[name="card.number"]').waitFor({ timeout: 15000 });
  await cf.locator('input[name="card.number"]').fill(CARD);
  await cf.locator('input[name="card.expiry"]').fill('12/30');
  await cf.locator('input[name="card.cvv"]').fill('123');

  const popupPromise = page.waitForEvent('popup', { timeout: 25000 }).catch(() => null);
  await cf.locator('[data-testid="bottom-cta-button"]').click();

  // conditional tokenisation dialog
  const later = cf.locator('button[name="pay_without_saving_card"]');
  try {
    await later.waitFor({ timeout: 4000 });
    await later.click();
  } catch { /* absent on retries */ }

  return popupPromise;
}

/** Click the bank button and wait for the outcome to settle. */
async function settle(page: Page, popup: Page, choice: 'S' | 'F') {
  await popup.waitForURL('**/gateway/mocksharp/**', { timeout: 25000 });
  await popup.click(`button[data-val="${choice}"]`);
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (await page.locator('.Payment-Completed').count()) return 'captured';
    try {
      if (await page.frameLocator(FRAME).locator('[data-testid="retry-surface"]').count()) return 'failed';
    } catch { /* frame detached => success in progress */ }
    await page.waitForTimeout(500);
  }
  return 'timeout';
}

// ---------------------------------------------------------------- A: abandon
async function probeAbandon(browser: Browser) {
  console.log('\n=== A: abandonment ===');
  const link = await newLink('abandon');
  const before = (await api('/payments?count=1')).body.items[0]?.id ?? null;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Stage 1: abandon BEFORE submitting (card form filled, never clicked pay)
  await page.goto(link.short_url, { waitUntil: 'domcontentloaded' });
  const cf = page.frameLocator(FRAME);
  await cf.locator('input[name="contact"]').fill('9000090000', { timeout: 30000 });
  await cf.locator('[data-testid="card"]').waitFor({ timeout: 15000 });
  await cf.locator('[data-testid="card"]').click();
  await cf.locator('input[name="card.number"]').waitFor({ timeout: 15000 });
  await cf.locator('input[name="card.number"]').fill(CARD);
  await page.waitForTimeout(2000);
  await ctx.close();
  await new Promise((s) => setTimeout(s, 8000));

  const afterPre = (await api('/payments?count=3')).body.items;
  const newPre = afterPre.filter((p: any) => p.id !== before);

  const linkState = (await api(`/payment_links/${link.id}`)).body;
  const orderPayments = { items: [] as any[] };
  if (linkState.order_id) {
    orderPayments.items = (await api(`/orders/${linkState.order_id}/payments`)).body.items ?? [];
  }

  const f = {
    probe: 'abandon_before_submit',
    newPaymentRecords: newPre.map((p: any) => ({ id: p.id, status: p.status, reason: p.error_reason })),
    paymentLinkStatus: linkState.status,
    paymentLinkAmountPaid: linkState.amount_paid,
    paymentLinkOrderId: linkState.order_id ?? null,
    orderPaymentCount: orderPayments.items.length,
    conclusion: newPre.length === 0
      ? 'ABANDONMENT IS INVISIBLE at /payments. Detect via payment_link.status instead.'
      : 'abandonment DOES create a payment record',
  };
  findings.push(f);
  console.log(JSON.stringify(f, null, 2));
}

// -------------------------------------------------------------------- B: OTP
async function probeOtp(browser: Browser) {
  console.log('\n=== B: OTP page ===');
  const link = await newLink('otp');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const popup = await driveToBank(page, link.short_url);
  let f: any;

  if (!popup) {
    f = { probe: 'otp', popupAppeared: false, conclusion: 'no popup; investigate' };
  } else {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await popup.waitForTimeout(4000);
    const shape = await popup.evaluate(`(() => ({
      url: location.href,
      hasBankButtons: !!document.querySelector('button[data-val]'),
      inputs: [...document.querySelectorAll('input')].map(i => ({
        name: i.name, type: i.type, maxLength: i.maxLength,
        placeholder: i.placeholder, visible: !!i.offsetParent })),
      buttons: [...document.querySelectorAll('button')].map(b => ({
        dataVal: b.dataset.val, text: b.textContent.trim().slice(0,25) })),
      bodyText: document.body.innerText.replace(/\\s+/g,' ').slice(0, 300),
    }))()`);
    f = {
      probe: 'otp',
      popupAppeared: true,
      ...(shape as any),
      conclusion: (shape as any).hasBankButtons
        ? 'NO OTP PAGE on this account. Bank Success/Failure buttons only. Drop the OTP action from the menu.'
        : 'OTP-style page found; capture selectors above',
    };
    await settle(page, popup, 'F').catch(() => {});
  }

  findings.push(f);
  console.log(JSON.stringify(f, null, 2));
  await ctx.close();
}

// ------------------------------------------------- C: attempt 3, reuse capture
async function probeAttemptLimit(browser: Browser) {
  console.log('\n=== C: third attempt + reuse after capture ===');
  const link = await newLink('attemptlimit');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const attempts: any[] = [];

  // three consecutive failures on one link
  for (let n = 1; n <= 3; n++) {
    let popup: Page | null = null;
    let outcome = 'not_reached';
    try {
      if (n === 1) {
        popup = await driveToBank(page, link.short_url);
      } else {
        const cf = page.frameLocator(FRAME);
        await cf.locator('[data-testid="card"]').waitFor({ timeout: 20000 });
        await cf.locator('[data-testid="card"]').click();
        await cf.locator('input[name="card.number"]').waitFor({ timeout: 15000 });
        await cf.locator('input[name="card.number"]').fill(CARD);
        await cf.locator('input[name="card.expiry"]').fill('12/30');
        await cf.locator('input[name="card.cvv"]').fill('123');
        const pp = page.waitForEvent('popup', { timeout: 25000 }).catch(() => null);
        await cf.locator('[data-testid="bottom-cta-button"]').click();
        const later = cf.locator('button[name="pay_without_saving_card"]');
        try { await later.waitFor({ timeout: 4000 }); await later.click(); } catch {}
        popup = await pp;
      }
      const payId = popup ? (popup.url().match(/payments\/([A-Za-z0-9]+)\//)?.[1] ?? null) : null;
      outcome = popup ? await settle(page, popup, n === 3 ? 'S' : 'F') : 'no_popup';
      attempts.push({ n, popupSeen: !!popup, payIdFromUrl: payId, outcome });
    } catch (e: any) {
      attempts.push({ n, error: String(e.message).slice(0, 160), outcome });
      break;
    }
    console.log(`  attempt ${n}: ${JSON.stringify(attempts[attempts.length - 1])}`);
  }
  return { link, ctx, page, attempts };
}

// ------------------------------------------------------------------ C part 2
async function probeReuseAfterCapture(browser: Browser, link: any, prevPage: Page) {
  console.log('\n  reuse after capture...');
  const linkState = (await api(`/payment_links/${link.id}`)).body;
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto(link.short_url, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(6000);

  const reuse = await page2.evaluate(`(() => ({
    url: location.href,
    hasCheckoutFrame: !!document.querySelector('iframe.razorpay-checkout-frame'),
    paymentCompleted: document.querySelectorAll('.Payment-Completed').length,
    bodyText: document.body.innerText.replace(/\\s+/g,' ').slice(0, 300),
  }))()`);

  const f = {
    probe: 'reuse_after_capture',
    paymentLinkStatus: linkState.status,
    amountPaid: linkState.amount_paid,
    reopened: reuse,
    conclusion: (reuse as any).hasCheckoutFrame
      ? 'A PAID link still opens checkout. Verify server-side before re-attempting.'
      : 'A PAID link does NOT reopen checkout. One capture ends the link; a batch needs one link per intended capture.',
  };
  findings.push(f);
  console.log(JSON.stringify(f, null, 2));
  await ctx2.close();
}

// ----------------------------------------------------------------------- main
const browser = await chromium.launch({ headless: false, slowMo: 150 });
try {
  await probeAbandon(browser);
  await probeOtp(browser);
  const c = await probeAttemptLimit(browser);
  findings.push({
    probe: 'attempt_limit',
    attempts: c.attempts,
    conclusion: c.attempts.filter((a) => a.outcome === 'failed' || a.outcome === 'captured').length >= 3
      ? 'A link supports at least 3 attempts.'
      : 'A link stopped short of 3 attempts. See the attempts array.',
  });
  await probeReuseAfterCapture(browser, c.link, c.page);
  await c.ctx.close();
} finally {
  writeFileSync(join(repoRoot, 'tmp', 'open-questions.json'), JSON.stringify(findings, null, 2));
  console.log('\nwrote tmp/open-questions.json');
  await browser.close();
}
