/**
 * Brings the whole webhook stack up with one command:
 *
 *   npm run webhooks -w apps/gateway
 *
 * Starts the gateway, opens the zrok tunnel on the reserved name, restarts
 * either if it dies, and verifies on startup that an unsigned request is
 * rejected. No setup: port, share name and public URL are constants in
 * src/config.ts, and the zrok binary is auto-detected. The only thing this
 * needs from .env is what config.ts already needs.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATEWAY_PORT, ZROK_NAME, WEBHOOK_PUBLIC_URL } from '../src/config.js';
import { WEBHOOK_PATH } from '../src/webhooks/handler.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const children: ChildProcess[] = [];
let shuttingDown = false;

/** The binary is `zrok` on a normal install and `zrok2` on v2 side-installs. */
const zrokBin = (): string => {
  for (const bin of ['zrok', 'zrok2']) {
    const r = spawnSync(bin, ['version'], { shell: true, stdio: 'ignore' });
    if (r.status === 0) return bin;
  }
  throw new Error('neither `zrok` nor `zrok2` is on PATH');
};

const run = (label: string, cmd: string, args: string[]) => {
  const child = spawn(cmd, args, { cwd: repoRoot, shell: true, stdio: 'pipe' });
  children.push(child);
  const emit = (d: unknown) =>
    String(d).split('\n').filter(Boolean).forEach((l) => console.log(`[${label}] ${l}`));
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`[${label}] exited (${code}), restarting in 3s`);
    setTimeout(() => run(label, cmd, args), 3000);
  });
};

const ZROK = zrokBin();

/**
 * A share left running from a previous session holds the reserved name, and
 * every restart then 409s ("name already in use by another share"). zrok v2
 * has no release command; `delete share` takes a share TOKEN, which has to
 * come from `list shares`. Parse that table for a row carrying our name.
 */
const releaseStaleShare = () => {
  const list = spawnSync(ZROK, ['list', 'shares'], { shell: true, encoding: 'utf8' });
  const row = (list.stdout ?? '')
    .split('\n')
    .find((l) => l.includes(`${ZROK_NAME}.shares.zrok.io`));
  if (!row) return;

  const token = row.split('│').map((c) => c.trim()).filter(Boolean)[0];
  if (!token) return;

  const del = spawnSync(ZROK, ['delete', 'share', token], { shell: true, encoding: 'utf8' });
  console.log(
    del.status === 0
      ? `[zrok] released stale share ${token} holding ${ZROK_NAME}`
      : `[zrok] could not release ${token}: ${(del.stderr ?? '').trim().slice(0, 120)}`,
  );
};

console.log(`gateway    http://localhost:${GATEWAY_PORT}`);
console.log(`webhook    ${WEBHOOK_PUBLIC_URL}${WEBHOOK_PATH}`);
console.log(`zrok       ${ZROK} public:${ZROK_NAME}\n`);

releaseStaleShare();
// Spawn tsx directly rather than `npm run dev`. Going through npm -> cmd ->
// node -> `tsx watch` adds layers that swallow stdout and leave `tsx watch`
// waiting on a TTY that isn't there, so the gateway never binds and produces
// no error either. No watch mode here: this is the run-it stack, not the
// edit-it stack.
run('gateway', 'npx', ['tsx', join(repoRoot, 'apps', 'gateway', 'src', 'index.ts')]);
run('zrok', ZROK, ['share', 'public', `localhost:${GATEWAY_PORT}`, '-n', `public:${ZROK_NAME}`, '--headless']);

/**
 * Startup check. An unsigned request must be rejected: the endpoint is
 * public, so signature verification is the only thing between an attacker
 * and forged payment events (docs/API-BEHAVIOUR.md section 8).
 */
const probeUnsigned = async (url: string, label: string, attempts = 1) => {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ probe: 1 }),
      });
      // A freshly recreated share takes a few seconds to propagate to the
      // zrok frontend, and reports 404 until it does. Retry before judging.
      if (r.status === 404 && i < attempts) {
        await new Promise((s) => setTimeout(s, 4000));
        continue;
      }
      const verdict = r.status >= 400 ? 'rejected (correct)' : 'ACCEPTED — verification not wired';
      console.log(`[check] ${label} unsigned -> ${r.status} ${verdict}`);
      return;
    } catch (e) {
      if (i === attempts) {
        console.log(`[check] ${label} unreachable: ${String((e as Error).message).slice(0, 80)}`);
        return;
      }
      await new Promise((s) => setTimeout(s, 4000));
    }
  }
};

void (async () => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://localhost:${GATEWAY_PORT}/health`)).ok) break;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (Date.now() >= deadline) {
    console.log(`[check] gateway never answered /health on :${GATEWAY_PORT}`);
    return;
  }
  console.log(`[check] gateway up`);
  await probeUnsigned(`http://localhost:${GATEWAY_PORT}${WEBHOOK_PATH}`, 'local ');
  await probeUnsigned(`${WEBHOOK_PUBLIC_URL}${WEBHOOK_PATH}`, 'tunnel', 5);
})();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    shuttingDown = true;
    children.forEach((c) => c.kill());
    process.exit(0);
  });
}
