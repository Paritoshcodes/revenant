/**
 * Webhook delivery, end to end, for real.
 *
 * src/webhooks/ has only ever been tested against fixtures; a real
 * Razorpay-signed delivery has only ever been observed by eye in a
 * terminal (docs/API-BEHAVIOUR.md section 8's "Verified end to end").
 * This starts the gateway, drives one real failed payment via the browser
 * driver, waits for the real payment.failed webhook Razorpay sends, and
 * asserts: the event arrived, its x-razorpay-event-id was recorded in
 * webhook_events, and the dispatched payment id matches the one the
 * driver captured. Separately, it POSTs one deliberately bad-signature
 * request straight at the tunnel and asserts it is rejected and never
 * recorded — directly exercising verifySignature in both directions,
 * rather than only trusting that the genuine delivery above implies it
 * passed.
 *
 * Live tier: gated on RUN_LIVE_TESTS=1, checked in beforeAll — FAILS
 * LOUDLY, never silently skips, if it is unset. This test additionally
 * requires a reachable public tunnel (WEBHOOK_PUBLIC_URL): if one is not
 * already running (e.g. via `npm run webhooks` in another terminal), this
 * file tries to start its own gateway + zrok share and fails loudly, with
 * a clear message, if that does not come up within the hook timeout — per
 * the task's own instruction, that is the correct behaviour here, not
 * something to work around with a longer wait or a retry.
 *
 * Razorpay's dashboard-registered webhook URL is fixed
 * (docs/API-BEHAVIOUR.md section 12: "no API for webhook registration"),
 * so this test cannot create its own throwaway endpoint — it uses the
 * real one, on the real GATEWAY_PORT and the real WEBHOOK_PUBLIC_URL.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';

import { chromium } from 'playwright';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';

import { attempt, capturePaymentIds, openCheckout } from '../../src/browser/index.js';
import { GATEWAY_PORT, WEBHOOK_PUBLIC_URL, ZROK_NAME, loadConfig } from '../../src/config.js';
import { createApp } from '../../src/index.js';
import { WEBHOOK_PATH } from '../../src/webhooks/handler.js';
import { createRazorpayClient } from '../../src/razorpay/client.js';

const HEALTH_URL = `http://localhost:${GATEWAY_PORT}/health`;
const TUNNEL_URL = `${WEBHOOK_PUBLIC_URL}${WEBHOOK_PATH}`;
const STARTUP_DEADLINE_MS = 100_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isReachable = async (url: string, init?: RequestInit): Promise<boolean> => {
  try {
    const res = await fetch(url, init);
    return res.ok;
  } catch {
    return false;
  }
};

/**
 * A zrok reserved name persists even when no `zrok share` process is
 * actively backing it — that's the whole point of reserve-once,
 * share-many-times — so hitting the tunnel URL with nothing currently
 * proxying to it still gets a response (502/503 from zrok's own edge, not
 * a network error). "Reachable" for this specific probe therefore means
 * "a response that could only have come from our own handler": an
 * unsigned POST always gets rejected with exactly 401
 * (verifyWebhookSignature), so that is the one status that proves a real
 * zrok share is live and actually proxying to a live gateway — anything
 * else (502/503/timeout) means start one.
 */
const isTunnelLive = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return res.status === 401;
  } catch {
    return false;
  }
};

/** Mirrors scripts/webhooks-up.mts's own detection: `zrok` on a normal install, `zrok2` on a v2 side-install. */
const zrokBin = (): string | null => {
  for (const bin of ['zrok', 'zrok2']) {
    const r = spawnSync(bin, ['version'], { shell: true, stdio: 'ignore' });
    if (r.status === 0) return bin;
  }
  return null;
};

/**
 * Mirrors scripts/webhooks-up.mts's releaseStaleShare(): a share left
 * running from an earlier session (this repo's own dev workflow, or a
 * prior run of this very test that didn't shut down cleanly) holds the
 * reserved name, and a fresh `zrok share` for the same name 409s. zrok v2
 * has no direct "release my reservation's active share" command; `delete
 * share` takes a share TOKEN, which only `list shares` can supply.
 */
const releaseStaleShare = (bin: string): void => {
  const list = spawnSync(bin, ['list', 'shares'], { shell: true, encoding: 'utf8' });
  const row = (list.stdout ?? '').split('\n').find((l) => l.includes(`${ZROK_NAME}.shares.zrok.io`));
  if (row === undefined) return;
  const token = row.split('│').map((c) => c.trim()).filter(Boolean)[0];
  if (token === undefined) return;
  spawnSync(bin, ['delete', 'share', token], { shell: true, stdio: 'ignore' });
};

describe('webhook delivery: real Razorpay-signed payment.failed, end to end', () => {
  let pool: pg.Pool | null = null;
  let httpServer: Server | null = null;
  let zrokChild: ChildProcess | null = null;
  let browser: Browser;
  const recordedEventIds: string[] = [];

  beforeAll(async () => {
    if (process.env.RUN_LIVE_TESTS !== '1') {
      throw new Error(
        'tests/live/webhook-delivery.live.test.ts requires RUN_LIVE_TESTS=1 ' +
          '(it drives a real payment and waits for a real Razorpay webhook). ' +
          'Run `RUN_LIVE_TESTS=1 npm run test:live` instead of skipping this file.',
      );
    }

    const config = loadConfig();

    // -- gateway: reuse if already running (e.g. `npm run webhooks`), else start our own --

    const gatewayAlreadyUp = await isReachable(HEALTH_URL);
    if (!gatewayAlreadyUp) {
      pool = new pg.Pool({ connectionString: config.databaseUrl });
      const app = createApp({ webhooks: { db: pool, secret: config.webhookSecret } });
      await new Promise<void>((resolve, reject) => {
        const server = app.listen(GATEWAY_PORT, () => resolve());
        server.on('error', reject);
        httpServer = server;
      });
    }

    // -- tunnel: reuse if already live, else start our own zrok share --

    const tunnelAlreadyUp = await isTunnelLive(TUNNEL_URL);
    if (!tunnelAlreadyUp) {
      const bin = zrokBin();
      if (bin === null) {
        throw new Error(
          'tests/live/webhook-delivery.live.test.ts: WEBHOOK_PUBLIC_URL ' +
            `(${WEBHOOK_PUBLIC_URL}) is unreachable and neither \`zrok\` nor ` +
            '\`zrok2\` is on PATH to start one. Run `npm run webhooks` in ' +
            'another terminal first, or install zrok.',
        );
      }
      releaseStaleShare(bin);
      // A share just released still needs a moment to clear on zrok's own
      // backend before the same reserved name can register a fresh share
      // (scripts/webhooks-up.mts's own probeUnsigned has the mirror-image
      // wait: "a freshly recreated share takes a few seconds to propagate
      // ... and reports 404 until it does"). The 100s polling loop below
      // is the real retry mechanism; this is just enough of a head start
      // that the first few polls aren't spent on a registration that was
      // always going to fail.
      await sleep(3_000);
      zrokChild = spawn(
        bin,
        ['share', 'public', `localhost:${GATEWAY_PORT}`, '-n', `public:${ZROK_NAME}`, '--headless'],
        { shell: true, stdio: 'ignore' },
      );

      const deadline = Date.now() + STARTUP_DEADLINE_MS;
      let reachable = false;
      while (Date.now() < deadline) {
        if (await isTunnelLive(TUNNEL_URL)) {
          reachable = true;
          break;
        }
        await sleep(2_000);
      }
      if (!reachable) {
        throw new Error(
          `tests/live/webhook-delivery.live.test.ts: WEBHOOK_PUBLIC_URL ` +
            `(${WEBHOOK_PUBLIC_URL}) never became reachable within ` +
            `${STARTUP_DEADLINE_MS}ms after starting a zrok share. Check that ` +
            `the '${ZROK_NAME}' share name is registered and not held by a ` +
            'stale process, and that Razorpay\'s dashboard webhook is ' +
            `pointed at ${TUNNEL_URL}.`,
        );
      }
    }

    browser = await chromium.launch({ headless: true });
  }, STARTUP_DEADLINE_MS + 30_000);

  afterAll(async () => {
    await browser?.close();

    // Leave anything reused exactly as found; only tear down what this
    // file itself started.
    if (zrokChild !== null) zrokChild.kill();
    if (httpServer !== null) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }

    if (pool !== null) {
      if (recordedEventIds.length > 0) {
        await pool.query('DELETE FROM webhook_events WHERE event_id = ANY($1)', [recordedEventIds]);
      }
      await pool.end();
    } else if (recordedEventIds.length > 0) {
      // Reused someone else's gateway/pool: clean up through a throwaway
      // connection instead.
      const config = loadConfig();
      const cleanupPool = new pg.Pool({ connectionString: config.databaseUrl });
      await cleanupPool.query('DELETE FROM webhook_events WHERE event_id = ANY($1)', [recordedEventIds]);
      await cleanupPool.end();
    }
  });

  const pollForWebhookEvent = async (
    db: pg.Pool,
    paymentId: string,
    timeoutMs: number,
  ): Promise<{ event_id: string } | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await db.query(
        `SELECT event_id FROM webhook_events
          WHERE event_type = 'payment.failed'
            AND payload -> 'payload' -> 'payment' -> 'entity' ->> 'id' = $1
          LIMIT 1`,
        [paymentId],
      );
      if (result.rows.length > 0) {
        return result.rows[0] as { event_id: string };
      }
      await sleep(2_000);
    }
    return null;
  };

  it('a real failed payment produces a real, signature-verified webhook_events row matching the driver-captured payment id', async () => {
    const config = loadConfig();
    const dbForAssertions = pool ?? new pg.Pool({ connectionString: config.databaseUrl });
    const razorpay = createRazorpayClient(config.razorpay);

    const created = await razorpay.createPaymentLink({
      amount_paise: 49_900,
      description: 'webhook delivery live test',
    });
    if (!created.ok) throw new Error(`payment link creation failed: ${created.error.message}`);

    const context = await browser.newContext();
    const capture = capturePaymentIds(context as never);
    const page = await context.newPage();
    let driverPaymentId: string | null;

    try {
      const opened = await openCheckout(page as never, created.value.short_url, { timeoutMs: 30_000 });
      if (!opened.ok) throw new Error(`openCheckout failed: ${opened.error.message}`);

      const driven = await attempt(page as never, '4100280000001007', 'failure', capture, {
        timeoutMs: 30_000,
      });
      if (!driven.ok) throw new Error(`attempt failed: ${driven.error.message}`);
      driverPaymentId = driven.value.paymentId;
    } finally {
      await context.close();
    }

    expect(driverPaymentId).not.toBeNull();

    const found = await pollForWebhookEvent(dbForAssertions, driverPaymentId!, 45_000);
    expect(found).not.toBeNull();
    if (found === null) return;

    recordedEventIds.push(found.event_id);
    expect(found.event_id.length).toBeGreaterThan(0);

    if (pool === null) await dbForAssertions.end();
  });

  it('rejects an unsigned/forged webhook and never records it', async () => {
    const config = loadConfig();
    const dbForAssertions = pool ?? new pg.Pool({ connectionString: config.databaseUrl });

    const fakeEventId = `evt_forged_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const body = JSON.stringify({
      entity: 'event',
      account_id: 'acc_forged',
      event: 'payment.failed',
      contains: ['payment'],
      payload: { payment: { entity: { id: 'pay_forged_not_real' } } },
      created_at: Math.floor(Date.now() / 1000),
    });

    const res = await fetch(TUNNEL_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Deliberately wrong: not computed with webhookSecret.
        'x-razorpay-signature': 'deadbeef'.repeat(8),
        'x-razorpay-event-id': fakeEventId,
      },
      body,
    });

    expect(res.status).toBe(401);

    // Give the (rejected, so this should be a no-op) async path a moment,
    // then confirm nothing was recorded.
    await sleep(1_000);
    const rows = await dbForAssertions.query('SELECT event_id FROM webhook_events WHERE event_id = $1', [
      fakeEventId,
    ]);
    expect(rows.rows).toHaveLength(0);

    if (pool === null) await dbForAssertions.end();
  });
});
