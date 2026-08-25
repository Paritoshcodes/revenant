/**
 * One-command setup for a fresh clone.
 *
 *   node scripts/setup.mjs
 *
 * Plain Node, zero dependencies, so it runs before `npm install`.
 * Does everything that can be automated, verifies it worked, and prints
 * exactly what is left. The remaining steps are account-bound (Razorpay
 * keys, a zrok account, a dashboard webhook) and cannot be scripted for
 * someone else's accounts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manual = [];
const failed = [];

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m' };
const ok = (m) => console.log(`  ${c.green}ok${c.reset}   ${m}`);
const warn = (m) => console.log(`  ${c.yellow}warn${c.reset} ${m}`);
const bad = (m) => console.log(`  ${c.red}fail${c.reset} ${m}`);
const step = (m) => console.log(`\n${m}`);

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: root, shell: true, encoding: 'utf8', ...opts });

const has = (cmd, args = ['--version']) => sh(cmd, args, { stdio: 'ignore' }).status === 0;

// ---------------------------------------------------------------- prerequisites
step('Checking prerequisites');

const nodeMajor = Number(process.versions.node.split('.')[0]);
nodeMajor >= 20
  ? ok(`node ${process.versions.node}`)
  : failed.push(`node ${process.versions.node} is too old, need >= 20`);

/** The engine pins 3.11: newer versions often lack wheels for the science stack. */
const python = ['py -3.11', 'python3.11', 'python'].find((p) => {
  const r = sh(p, ['--version']);
  return r.status === 0 && /3\.1[1-9]/.test(r.stdout + r.stderr);
});
python ? ok(`python (${python})`) : failed.push('python 3.11+ not found; install 3.11');

const psql = has('psql') ? 'psql' : null;
psql ? ok('psql') : failed.push('psql not on PATH; install PostgreSQL and add its bin/ to PATH');

/** zrok is only needed to expose webhooks publicly. The rest works without it. */
const zrok = ['zrok', 'zrok2'].find((b) => has(b, ['version']));
zrok ? ok(`zrok (${zrok})`) : warn('zrok not found; webhooks cannot be exposed publicly');

if (failed.length) {
  console.log(`\n${c.red}Missing prerequisites:${c.reset}`);
  failed.forEach((f) => console.log(`  - ${f}`));
  console.log('\nInstall those, then run this again.');
  process.exit(1);
}

// ------------------------------------------------------------------------ .env
step('Environment file');

const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  ok('created .env from .env.example');
} else {
  ok('.env exists');
}

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const REQUIRED = ['DATABASE_URL', 'RZP_KEY', 'RZP_SECRET', 'RZP_WEBHOOK_SECRET'];
const placeholder = (v) => !v || v.startsWith('<') || v.includes('CHANGE_ME');
const unset = REQUIRED.filter((k) => placeholder(env[k]));

if (unset.length) {
  warn(`needs real values: ${unset.join(', ')}`);
  manual.push(
    `Fill these in .env:\n     ${unset.join('\n     ')}\n` +
      `   Razorpay test keys: dashboard -> Account & Settings -> API Keys (test mode).\n` +
      `   RZP_WEBHOOK_SECRET is any string you choose; it must match the dashboard.`,
  );
} else {
  ok('all required secrets set');
}

// -------------------------------------------------------------- node + browser
step('Installing node dependencies');
const install = sh('npm', ['install'], { stdio: 'inherit' });
install.status === 0 ? ok('npm install') : bad('npm install failed');

step('Installing Chromium for Playwright');
const pw = sh('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
pw.status === 0 ? ok('chromium') : warn('chromium install failed; browser driver will not run');

// ------------------------------------------------------------------- database
step('Database');

if (placeholder(env.DATABASE_URL)) {
  warn('skipped: DATABASE_URL not set yet');
  manual.push('Set DATABASE_URL in .env, then re-run: node scripts/setup.mjs');
} else {
  let dbName = null;
  let adminUrl = null;
  try {
    const u = new URL(env.DATABASE_URL);
    dbName = u.pathname.replace(/^\//, '');
    u.pathname = '/postgres';
    adminUrl = u.toString();
  } catch {
    bad('DATABASE_URL is not a valid URL. A password containing @ must be percent-encoded as %40');
  }

  if (adminUrl) {
    const exists = sh(psql, [`"${adminUrl}"`, '-tAc',
      `"SELECT 1 FROM pg_database WHERE datname='${dbName}'"`]);
    if ((exists.stdout ?? '').trim() === '1') {
      ok(`database ${dbName} exists`);
    } else {
      const created = sh(psql, [`"${adminUrl}"`, '-c', `"CREATE DATABASE ${dbName}"`]);
      created.status === 0
        ? ok(`created database ${dbName}`)
        : bad(`could not create ${dbName}: ${(created.stderr ?? '').trim().slice(0, 140)}`);
    }

    const migrated = sh('npm', ['run', 'db:migrate'], { stdio: 'inherit' });
    migrated.status === 0 ? ok('migrations applied') : bad('migrations failed');
  }
}

// --------------------------------------------------------------------- engine
step('Python engine');

const engineDir = join(root, 'apps', 'engine');
const venvPython = process.platform === 'win32'
  ? join(engineDir, '.venv', 'Scripts', 'python.exe')
  : join(engineDir, '.venv', 'bin', 'python');

if (!existsSync(engineDir)) {
  warn('apps/engine not present yet, skipping');
} else {
  if (!existsSync(venvPython)) {
    const venv = sh(python, ['-m', 'venv', '.venv'], { cwd: engineDir, stdio: 'inherit' });
    venv.status === 0 ? ok('created .venv') : bad('venv creation failed');
  } else {
    ok('.venv exists');
  }

  if (existsSync(venvPython)) {
    const dep = sh(`"${venvPython}"`, ['-m', 'pip', 'install', '-e', '.', '-q'],
      { cwd: engineDir, stdio: 'inherit' });
    dep.status === 0 ? ok('engine dependencies') : warn('pip install failed');
  }
}

// ---------------------------------------------------------------------- zrok
step('Webhook tunnel');

if (!zrok) {
  warn('zrok not installed');
  manual.push(
    'Install zrok (https://zrok.io), then:\n' +
      '     zrok invite                       # free account\n' +
      '     zrok enable <token>\n' +
      '     zrok create name -n public revenant',
  );
} else {
  const names = sh(zrok, ['list', 'names']);
  if ((names.stdout ?? '').includes('revenant')) {
    ok('reserved name "revenant" exists');
  } else {
    warn('reserved name "revenant" not found');
    manual.push(
      'Reserve the webhook name (once per account):\n' +
        `     ${zrok} enable <token>              # if not already enabled\n` +
        `     ${zrok} create name -n public revenant`,
    );
  }
}

// -------------------------------------------------------------------- summary
manual.push(
  'Register the webhook in the Razorpay dashboard (once):\n' +
    '     Settings -> Webhooks -> Add New Webhook\n' +
    '     URL    : https://revenant.shares.zrok.io/webhooks/razorpay   (INCLUDE the path)\n' +
    '     Secret : the RZP_WEBHOOK_SECRET from your .env\n' +
    '     OTP    : 754081   (fixed, test mode)\n' +
    '     Events : payment.authorized, payment.failed, payment.captured,\n' +
    '              order.paid, payment_link.paid,\n' +
    '              payment.downtime.started/.updated/.resolved',
);

console.log(`\n${'-'.repeat(64)}`);
if (manual.length) {
  console.log(`${c.yellow}Left to do by hand${c.reset} ${c.dim}(account-bound, cannot be scripted)${c.reset}\n`);
  manual.forEach((m, i) => console.log(`  ${i + 1}. ${m}\n`));
} else {
  console.log(`${c.green}Setup complete.${c.reset}\n`);
}

console.log('Then:\n');
console.log('  npm test                          run the suite');
console.log('  npm run webhooks -w apps/gateway  gateway + tunnel, with a self-check');
console.log('  npm run smoke -w apps/gateway     drive a real payment end to end\n');
