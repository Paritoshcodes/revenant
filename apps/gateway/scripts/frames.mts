/**
 * Diagnostic: dump every frame on a payment link page and report which one
 * contains the contact input. Run when a selector times out.
 *
 *   npx tsx scripts/frames.mts <scenario>
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const scenario = process.argv[2] ?? 'insufficient_fund';
const linkMap = JSON.parse(
  readFileSync(join(repoRoot, 'data', 'samples', 'link_map.json'), 'utf8'),
);
const entry = linkMap[scenario];

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto(entry.short_url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

for (const frame of page.frames()) {
  const count = await frame.locator('input[name="contact"]').count();
  const cardCount = await frame.locator('[data-testid="card"]').count();
  console.log(
    `frame  name=${frame.name() || '(none)'}\n` +
      `  url=${frame.url().slice(0, 100)}\n` +
      `  contact=${count}  card=${cardCount}\n`,
  );
}

console.log('iframe elements in main frame:');
console.log(
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe'))
      .map((f) => `${f.className || '(no class)'} | ${f.id || '(no id)'} | ${f.src.slice(0, 80)}`)
      .join('\n'),
  ),
);

await page.waitForTimeout(5000);
await browser.close();
