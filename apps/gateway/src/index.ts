/**
 * Gateway entrypoint. Health and the webhook receiver so far. The
 * Razorpay client, throttle, idempotency store, recovery state machine,
 * guardrails, audit chain and Playwright driver mount here as they land.
 */
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { POLICY_GRID, OBSERVED_REASONS } from '@revenant/contracts';

import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createWebhookRouter } from './webhooks/handler.js';
import type { WebhookHandlerDeps } from './webhooks/handler.js';

export interface AppDeps {
  readonly webhooks: WebhookHandlerDeps;
}

export const createApp = (deps: AppDeps): express.Express => {
  const app = express();

  // Registered before the global JSON parser: the webhook route needs
  // the RAW body for signature verification, and a request body stream
  // can only be consumed once. If express.json() ran first here, it
  // would already have parsed and drained the body, leaving nothing for
  // the webhook route's own raw-body middleware to read.
  app.use(createWebhookRouter(deps.webhooks));

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'gateway',
      grid_rows: POLICY_GRID.length,
      observed_reasons: OBSERVED_REASONS,
    });
  });

  return app;
};

const entry = argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);
  const app = createApp({ webhooks: { db, secret: config.webhookSecret } });
  app.listen(config.port, () => {
    console.log(`gateway listening on ${config.port}`);
  });
}
