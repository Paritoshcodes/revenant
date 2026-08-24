/**
 * Environment parsing. Fails loudly at boot rather than at the first
 * outbound call, so a missing key is never discovered mid-batch.
 */
import 'dotenv/config';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
};

const optionalInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`environment variable ${name} is not an integer: ${raw}`);
  }
  return parsed;
};

export interface Config {
  readonly port: number;
  readonly databaseUrl: string;
  readonly engineUrl: string;
  readonly razorpay: {
    readonly key: string;
    readonly secret: string;
  };
}

export const loadConfig = (): Config => ({
  port: optionalInt('GATEWAY_PORT', 3001),
  databaseUrl: required('DATABASE_URL'),
  engineUrl: process.env['ENGINE_URL'] ?? 'http://localhost:8000',
  razorpay: {
    key: required('RZP_KEY'),
    secret: required('RZP_SECRET'),
  },
});
