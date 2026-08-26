/**
 * Closes the API-side gaps. Pure HTTP, no browser, no Playwright.
 *
 *   npx tsx scripts/probe-api.mts
 *
 * Writes tmp/api-probe.json. COLLECTS EVIDENCE ONLY, draws no conclusions.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = process.env.RZP_KEY!;
const SECRET = process.env.RZP_SECRET!;
const API = 'https://api.razorpay.com/v1';
const auth = 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
mkdirSync(join(repoRoot, 'tmp'), { recursive: true });
const out: Record<string, unknown> = {};

async function call(path: string, method = 'GET', body?: unknown) {
  const t0 = Date.now();
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown;
  const text = await r.text();
  try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 300); }
  return { status: r.status, ms: Date.now() - t0, body: parsed as any,
           retryAfter: r.headers.get('retry-after') };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ref = (t: string) => `probe_${t}_${Date.now()}`;

function linkBody(tag: string, extra: Record<string, unknown> = {}) {
  return {
    amount: 49900, currency: 'INR', description: `probe ${tag}`,
    customer: { name: 'Test Customer', email: 'test@example.com', contact: '+919000090000' },
    notify: { sms: false, email: false },
    reference_id: ref(tag),
    ...extra,
  };
}

// ---- 1. order lifecycle: when does a link get an order_id? -------------------
async function orderLifecycle() {
  const created = await call('/payment_links', 'POST', linkBody('order'));
  const id = created.body.id;
  const atCreate = created.body.order_id ?? null;
  await sleep(3000);
  const refetched = await call(`/payment_links/${id}`);
  out.orderLifecycle = {
    linkId: id,
    orderIdAtCreation: atCreate,
    orderIdOnRefetch: refetched.body.order_id ?? null,
    statusOnRefetch: refetched.body.status,
    note: 'compare against a link that HAS had an attempt, below',
  };

  // a link known to have had one attempt (from the abandonment probe)
  const known = await call('/payment_links/plink_TTf6SqNFXDOgg0');
  out.orderLifecycleAfterAttempt = {
    linkId: 'plink_TTf6SqNFXDOgg0',
    order_id: known.body.order_id ?? null,
    status: known.body.status,
    amount_paid: known.body.amount_paid,
    payments: known.body.payments ?? null,
  };
  return id;
}

// ---- 2. duplicate reference_id: capture the exact error body ----------------
async function duplicateReference() {
  const body = linkBody('dup');
  const first = await call('/payment_links', 'POST', body);
  await sleep(6000);
  const second = await call('/payment_links', 'POST', body); // same reference_id
  out.duplicateReferenceId = {
    firstStatus: first.status,
    secondStatus: second.status,
    secondBody: second.body,
    sameReferenceId: body.reference_id,
  };

  // and the order equivalent: duplicate receipt (known to ALLOW duplicates)
  const o1 = await call('/orders', 'POST', { amount: 49900, currency: 'INR', receipt: 'probe_dup_receipt' });
  const o2 = await call('/orders', 'POST', { amount: 49900, currency: 'INR', receipt: 'probe_dup_receipt' });
  out.duplicateOrderReceipt = {
    first: { status: o1.status, id: o1.body.id },
    second: { status: o2.status, id: o2.body.id },
    distinctIds: o1.body.id !== o2.body.id,
  };
}

// ---- 3. rate limit scope: reads vs writes, per endpoint ---------------------
async function rateLimitScope() {
  const reads: any[] = [];
  for (let i = 0; i < 25; i++) {
    const r = await call('/payments?count=1');
    reads.push({ i, status: r.status, ms: r.ms, retryAfter: r.retryAfter });
    if (r.status === 429) break;
  }
  out.rateLimitReads = {
    attempts: reads.length,
    hit429: reads.some((r) => r.status === 429),
    firstFailureIndex: reads.findIndex((r) => r.status === 429),
    sample: reads.slice(-3),
  };
}

async function rateLimitWrites() {
  const writes: any[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await call('/orders', 'POST', { amount: 49900, currency: 'INR', receipt: `rl_${i}_${Date.now()}` });
    writes.push({ i, status: r.status, ms: r.ms, retryAfter: r.retryAfter,
                  err: r.status !== 200 ? r.body : undefined });
    if (r.status === 429) break;
  }
  out.rateLimitOrderWrites = {
    attempts: writes.length,
    hit429: writes.some((w) => w.status === 429),
    firstFailureIndex: writes.findIndex((w) => w.status === 429),
    all: writes,
  };

  // If /orders 429'd, is /payments (a read) also blocked? -> shared vs per-endpoint
  if (writes.some((w) => w.status === 429)) {
    const readDuring = await call('/payments?count=1');
    out.rateLimitCrossEndpoint = {
      ordersWere429: true,
      readStatusWhileOrdersLimited: readDuring.status,
      interpretation_raw: 'if read is 200, the limit is per-endpoint, not global',
    };
  }
}

// ---- 4. pagination ---------------------------------------------------------
async function pagination() {
  const c100 = await call('/payments?count=100');
  const c101 = await call('/payments?count=101');
  const skip = await call('/payments?count=2&skip=2');
  const c1 = await call('/payments?count=2');
  out.pagination = {
    count100: { status: c100.status, returned: c100.body.items?.length ?? null, total: c100.body.count },
    count101: { status: c101.status, error: c101.status !== 200 ? c101.body : null,
                returned: c101.body.items?.length ?? null },
    skipWorks: skip.status === 200 && c1.status === 200
      ? { firstPageIds: c1.body.items?.map((p: any) => p.id),
          skippedPageIds: skip.body.items?.map((p: any) => p.id) }
      : { skipStatus: skip.status, body: skip.body },
  };
}

// ---- 5. payment link states: expired, cancelled ----------------------------
async function linkStates() {
  // expire_by must be a future unix timestamp; use the minimum Razorpay allows
  const soon = Math.floor(Date.now() / 1000) + 16 * 60;
  const exp = await call('/payment_links', 'POST', linkBody('expiry', { expire_by: soon }));
  out.linkExpiry = {
    createStatus: exp.status,
    body: exp.status !== 200 ? exp.body : { id: exp.body.id, expire_by: exp.body.expire_by, status: exp.body.status },
    note: 'expiry cannot be observed within this run; records the accepted minimum window',
  };

  await sleep(6000);
  const toCancel = await call('/payment_links', 'POST', linkBody('cancel'));
  await sleep(4000);
  const cancelled = await call(`/payment_links/${toCancel.body.id}/cancel`, 'POST');
  out.linkCancel = {
    cancelStatus: cancelled.status,
    statusAfter: cancelled.body?.status ?? null,
    body: cancelled.status !== 200 ? cancelled.body : undefined,
  };

  // cancelling an already-cancelled link, and a paid one
  await sleep(3000);
  const twice = await call(`/payment_links/${toCancel.body.id}/cancel`, 'POST');
  const paid = await call('/payment_links/plink_TTf93iURPeCqTo/cancel', 'POST');
  out.linkCancelEdgeCases = {
    cancelTwice: { status: twice.status, body: twice.body },
    cancelPaidLink: { status: paid.status, body: paid.body },
  };
}

// ---- 6. what a fetched payment link exposes about its payments -------------
async function linkPaymentsShape() {
  const r = await call('/payment_links/plink_TTfAvpJgjQzfmp');
  out.linkPaymentsShape = {
    status: r.body.status,
    order_id: r.body.order_id ?? null,
    payments: r.body.payments ?? null,
    topLevelKeys: Object.keys(r.body ?? {}),
  };
}

// ---- 7. order payments endpoint + payment fetch shape ----------------------
async function orderPayments() {
  const link = await call('/payment_links/plink_TTf93iURPeCqTo'); // the captured one
  const orderId = link.body.order_id;
  if (orderId) {
    const r = await call(`/orders/${orderId}/payments`);
    out.orderPayments = {
      orderId,
      status: r.status,
      count: r.body.count,
      items: (r.body.items ?? []).map((p: any) => ({
        id: p.id, status: p.status, error_reason: p.error_reason,
        error_source: p.error_source, error_step: p.error_step,
      })),
    };
    const ord = await call(`/orders/${orderId}`);
    out.orderShape = { status: ord.body.status, attempts: ord.body.attempts,
                       amount_paid: ord.body.amount_paid, keys: Object.keys(ord.body ?? {}) };
  } else {
    out.orderPayments = { note: 'captured link had no order_id', link: link.body.status };
  }
}

// ---------------------------------------------------------------------- main
const steps: [string, () => Promise<unknown>][] = [
  ['orderLifecycle', orderLifecycle],
  ['duplicateReference', duplicateReference],
  ['pagination', pagination],
  ['linkPaymentsShape', linkPaymentsShape],
  ['orderPayments', orderPayments],
  ['linkStates', linkStates],
  ['rateLimitReads', rateLimitScope],
  ['rateLimitWrites', rateLimitWrites],
];

for (const [name, fn] of steps) {
  process.stdout.write(`${name} ... `);
  try { await fn(); console.log('ok'); }
  catch (e: any) { console.log('ERR'); out[`${name}_error`] = String(e.message).slice(0, 200); }
  await sleep(4000);
}

writeFileSync(join(repoRoot, 'tmp', 'api-probe.json'), JSON.stringify(out, null, 2));
console.log('\nwrote tmp/api-probe.json');
