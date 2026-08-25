/**
 * Environment parsing. Fails loudly at boot rather than at the first
 * outbound call, so a missing key is never discovered mid-batch.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

// .env lives at the repo root, but npm runs workspace scripts with cwd set to
// the workspace directory, so bare `dotenv/config` looks in apps/gateway and
// silently finds nothing. Resolve from this file instead. See DECISIONS.md.
// src/ -> apps/gateway/ -> apps/ -> repo root
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '..', '..', '..', '.env') });

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
};

/**
 * Constants, not configuration.
 *
 * A value belongs in .env only if it is a SECRET or genuinely differs
 * between machines. Everything else lives here, where it cannot drift out
 * of sync with the things derived from it. The gateway port, the zrok share
 * name and the public webhook URL are all fixed for this project, and the
 * URL is derived from the name rather than stored separately so the two can
 * never disagree.
 */
export const GATEWAY_PORT = 4000;
export const ZROK_NAME = 'revenant';
export const WEBHOOK_PUBLIC_URL = `https://${ZROK_NAME}.shares.zrok.io`;

export interface Config {
  readonly port: number;
  readonly databaseUrl: string;
  readonly engineUrl: string;
  readonly razorpay: {
    readonly key: string;
    readonly secret: string;
  };
  readonly webhookSecret: string;
}

export const loadConfig = (): Config => ({
  port: GATEWAY_PORT,
  databaseUrl: required('DATABASE_URL'),
  engineUrl: process.env['ENGINE_URL'] ?? 'http://localhost:8000',
  razorpay: {
    key: required('RZP_KEY'),
    secret: required('RZP_SECRET'),
  },
  webhookSecret: required('RZP_WEBHOOK_SECRET'),
});
