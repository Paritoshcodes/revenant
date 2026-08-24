/**
 * Gateway entrypoint. Health only at this stage. The Razorpay client,
 * throttle, idempotency store, recovery state machine, guardrails, audit
 * chain and Playwright driver mount here as they land.
 */
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { POLICY_GRID, OBSERVED_REASONS } from '@revenant/contracts';

export const createApp = (): express.Express => {
  const app = express();
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
  const port = Number.parseInt(process.env['GATEWAY_PORT'] ?? '3001', 10);
  createApp().listen(port, () => {
    console.log(`gateway listening on ${port}`);
  });
}
