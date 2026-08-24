/**
 * Applies migrations/*.sql in filename order with psql.
 *
 * Plain SQL, no migration framework: the schema is five tables and the
 * audit table is append only, so a tool that rewrites rows would be the
 * wrong shape. Cross-platform wrapper only, the SQL is the artefact.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// .env lives at the repo root; npm runs this with cwd = apps/gateway.
loadEnv({ path: join(here, '..', '..', '..', '.env') });

const migrationsDir = join(here, '..', 'migrations');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of files) {
  console.log(`applying ${file}`);
  const result = spawnSync(
    'psql',
    [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', join(migrationsDir, file)],
    { stdio: 'inherit' },
  );
  if (result.error) {
    console.error(`psql not found on PATH: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${file} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`applied ${files.length} migration(s)`);
