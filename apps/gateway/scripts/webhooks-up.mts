/**
 * Starts the webhook receiver and the zrok tunnel together, and keeps them
 * alive. One command instead of two terminals.
 *
 *   npm run webhooks -w apps/gateway
 *
 * Reads WEBHOOK_PORT, ZROK_NAME and WEBHOOK_PUBLIC_URL from the repo-root
 * .env. Restarts either process if it dies.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
loadEnv({ path: join(repoRoot, '.env') });

const PORT = process.env.WEBHOOK_PORT ?? '4000';
const NAME = process.env.ZROK_NAME ?? 'revenant';
const ZROK_BIN = process.env.ZROK_BIN ?? 'zrok2';
const PUBLIC_URL = process.env.WEBHOOK_PUBLIC_URL ?? '(not set)';

const children: ChildProcess[] = [];
let shuttingDown = false;

function run(label: string, cmd: string, args: string[]) {
  const child = spawn(cmd, args, { cwd: repoRoot, shell: true, stdio: 'pipe' });
  children.push(child);

  const tag = (line: string) => `[${label}] ${line}`;
  child.stdout?.on('data', (d) =>
    String(d).split('\n').filter(Boolean).forEach((l) => console.log(tag(l))));
  child.stderr?.on('data', (d) =>
    String(d).split('\n').filter(Boolean).forEach((l) => console.log(tag(l))));

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(tag(`exited (${code}), restarting in 3s`));
    setTimeout(() => run(label, cmd, args), 3000);
  });
  return child;
}

console.log(`receiver port : ${PORT}`);
console.log(`zrok name     : public:${NAME}`);
console.log(`public url    : ${PUBLIC_URL}`);
console.log(`\nRegister that URL once in the Razorpay dashboard (OTP 754081).\n`);

run('receiver', 'npx', ['tsx', join(here, 'webhook-receiver.mts')]);
run('zrok', ZROK_BIN, ['share', 'public', `localhost:${PORT}`, '-n', `public:${NAME}`, '--headless']);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    shuttingDown = true;
    console.log('\nshutting down...');
    children.forEach((c) => c.kill());
    process.exit(0);
  });
}
