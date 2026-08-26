/**
 * Smoke test for the batch primitive (src/recovery/create-link-batch.ts)
 * against real Razorpay. Never run before this: Layer 1 depends on it, so
 * this verifies it creates real, fetchable payment links, and reports how
 * long a batch of this size actually takes — the per-endpoint write
 * throttle on /payment_links (src/razorpay/throttle.ts) paces every
 * create, which is exactly the number that matters for planning the full
 * Layer 1 run.
 *
 *   npx tsx scripts/smoke-batch.mts [n]
 *
 * n defaults to 5.
 */
import { createLinkBatch } from '../src/recovery/create-link-batch.js';
import { loadConfig } from '../src/config.js';
import { createRazorpayClient } from '../src/razorpay/client.js';

const n = Number(process.argv[2] ?? '5');
if (!Number.isInteger(n) || n < 1) {
  console.error(`n must be a positive integer, got ${process.argv[2]}`);
  process.exit(1);
}

const config = loadConfig();
const client = createRazorpayClient(config.razorpay);

console.log(`creating a batch of ${n} payment links...\n`);
const t0 = Date.now();

const batch = await createLinkBatch(client, n, { description: 'smoke:batch' });

const createElapsedMs = Date.now() - t0;

if (!batch.ok) {
  console.error('createLinkBatch failed:', batch.error);
  console.error(`(after ${(createElapsedMs / 1000).toFixed(1)}s)`);
  process.exit(1);
}

console.log(`created ${batch.value.length} links in ${(createElapsedMs / 1000).toFixed(1)}s:\n`);
for (const item of batch.value) {
  console.log(`  ${item.paymentLinkId}  ${item.shortUrl}`);
}

console.log('\nverifying each link exists via GET /payment_links/<id>...\n');
const t1 = Date.now();

let verifiedCount = 0;
let failedCount = 0;

for (const item of batch.value) {
  const fetched = await client.fetchPaymentLink(item.paymentLinkId);
  if (!fetched.ok) {
    failedCount += 1;
    console.log(`  ${item.paymentLinkId}  FAILED: ${fetched.error.message}`);
    continue;
  }
  const matches = fetched.value.short_url === item.shortUrl && fetched.value.status === 'created';
  if (matches) {
    verifiedCount += 1;
    console.log(`  ${item.paymentLinkId}  ok (status=${fetched.value.status})`);
  } else {
    failedCount += 1;
    console.log(
      `  ${item.paymentLinkId}  MISMATCH: status=${fetched.value.status} short_url=${fetched.value.short_url}`,
    );
  }
}

const verifyElapsedMs = Date.now() - t1;
const totalElapsedMs = Date.now() - t0;

console.log(
  `\nverified ${verifiedCount}/${batch.value.length} (${failedCount} failed) in ${(verifyElapsedMs / 1000).toFixed(1)}s`,
);
console.log(`\ncreate:  ${(createElapsedMs / 1000).toFixed(1)}s`);
console.log(`verify:  ${(verifyElapsedMs / 1000).toFixed(1)}s`);
console.log(`total:   ${(totalElapsedMs / 1000).toFixed(1)}s`);
console.log(`average: ${(createElapsedMs / n / 1000).toFixed(1)}s per link created`);

if (failedCount > 0) process.exit(1);
