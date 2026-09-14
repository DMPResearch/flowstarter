/**
 * Screenshots of the agent activity timeline, light and dark.
 *
 * It drives `/design-gallery`, which renders the real components on fixture
 * data rather than a lookalike, so what lands in /tmp/fs-activity is the
 * product's own markup. The theme is set the way the product sets it -- the
 * `data-theme` attribute on `<html>`, which is what `applyTheme` writes --
 * and the page is given a beat to repaint before each capture, because the
 * glass reads its fill and its rim from tokens that change with it.
 *
 * Run it against a dev server you started yourself:
 *   node scripts/activity-shots.mjs http://localhost:3068
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://localhost:3068';
const OUT = '/tmp/fs-activity';

/** Each shot: a file name, the section to frame, and how tall to make it. */
const SHOTS = [
  {
    name: 'agent-activity',
    selector: 'section[aria-labelledby="design-gallery-agent-activity"]',
  },
  {
    name: 'client-dashboard',
    selector: 'section[aria-labelledby="design-gallery-client-dashboard"]',
  },
  {
    name: 'admin-pipeline',
    selector: 'section[aria-labelledby="design-gallery-admin-pipeline"]',
  },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // The dev overlay's issue badge is Next's, not ours, and it floats over the
  // bottom-left of every capture. Hidden rather than dismissed, because
  // dismissing it is a click that can land on the page underneath.
  await page.addStyleTag({
    content: 'nextjs-portal { display: none !important; }',
  }).catch(() => undefined);

  await page.goto(`${BASE}/design-gallery`, {
    waitUntil: 'networkidle',
    timeout: 120_000,
  });

  await page.addStyleTag({
    content: 'nextjs-portal { display: none !important; }',
  });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
      document.documentElement.classList.toggle('dark', value === 'dark');
      document.documentElement.style.colorScheme = value;
    }, theme);
    await page.waitForTimeout(700);

    for (const shot of SHOTS) {
      const node = page.locator(shot.selector).first();
      if ((await node.count()) === 0) {
        console.warn(`missing section: ${shot.selector}`);
        continue;
      }
      await node.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const path = `${OUT}/${shot.name}-${theme}.png`;
      await node.screenshot({ path });
      console.log(`saved ${path}`);
    }

    // One full page per theme, so the sections can be read in context.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const full = `${OUT}/design-gallery-${theme}.png`;
    await page.screenshot({ path: full, fullPage: true });
    console.log(`saved ${full}`);
  }

  await browser.close();
}

await main();
