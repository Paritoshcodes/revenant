/**
 * Local webhook receiver. Doubles as the probe and as the basis for the
 * gateway's real endpoint.
 *
 *   npx tsx scripts/webhook-receiver.mts
 *
 * Logs every request to tmp/webhook-events.jsonl with the RAW body, all
 * headers, and an offline HMAC check. Acknowledges in under 5s always,
 * because Razorpay retries on timeout (docs: webhooks/faqs).
 *
 * Needs a public URL. webhook.site, ngrok.io and loca.lt are BLACKLISTED by
 * Razorpay. Use cloudflared or zrok (zrok is what Razorpay recommends):
 *
 *   cloudflared tunnel --url http://localhost:4000
 *   zrok share public localhost:4000
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.WEBHOOK_PORT ?? 4000);
const SECRET = process.env.RZP_WEBHOOK_SECRET ?? 'revenant_probe_secret';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
mkdirSync(join(repoRoot, 'tmp'), { recursive: true });
const LOG = join(repoRoot, 'tmp', 'webhook-events.jsonl');

function verify(raw: string, signature: string | undefined) {
  if (!signature) return { present: false, matches: null as boolean | null };
  const expected = createHmac('sha256', SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  const matches = a.length === b.length && timingSafeEqual(a, b);
  return { present: true, matches, expected };
}

let n = 0;

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // Acknowledge FIRST. Razorpay retries if we take over 5s.
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');

    const raw = Buffer.concat(chunks).toString('utf8');
    const sig = req.headers['x-razorpay-signature'] as string | undefined;
    const check = verify(raw, sig);

    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { /* keep raw */ }

    const record = {
      seq: ++n,
      receivedAt: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      eventId: req.headers['x-razorpay-event-id'] ?? null,
      signaturePresent: check.present,
      signatureMatches: check.matches,
      event: parsed?.event ?? null,
      contains: parsed?.contains ?? null,
      entities: parsed?.payload ? Object.keys(parsed.payload) : null,
      rawLength: raw.length,
      raw,
      parsed,
    };

    appendFileSync(LOG, JSON.stringify(record) + '\n');
    console.log(
      `#${record.seq} ${record.event ?? '(unparsed)'}  sig=${check.matches}  ` +
      `eventId=${record.eventId}  status=${parsed?.payload?.payment?.entity?.status ?? '-'}`,
    );
  });
}).listen(PORT, () => {
  console.log(`receiver on http://localhost:${PORT}`);
  console.log(`secret: ${SECRET}`);
  console.log(`logging to tmp/webhook-events.jsonl\n`);
  console.log('Now expose it:  cloudflared tunnel --url http://localhost:' + PORT);
});
