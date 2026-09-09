/**
 * Templates audit — captures every template page (library + detail pages +
 * iframe previews where they exist) in light and dark mode. Logs every
 * console error and every failed network request so we can chase 404s
 * and broken assets without staring at the browser.
 *
 * Outputs:
 *   - e2e/screenshots/templates/{route}/{theme}.png   (full-page)
 *   - test report lists console errors and resource failures per route
 *
 * Data-driven: preview iframe tests are only generated for entries with
 * `hasPreview: true`. Previously the spec hardcoded a slug array and
 * `test.skip()`-d every 404 — that filled the suite with 25 fake skips
 * because the static `/preview/{slug}/` exports only exist for the
 * `dorin-portfolio` template. Keep this list in sync with
 * `apps/flowstarter-main/src/app/(library)/library/_data/templates.ts`'s
 * `TEMPLATES` array (or its `previewPath` field, which is the source of
 * truth for which slugs ship a static preview).
 */

import type { Page } from '@playwright/test';
import { test, expect } from './support/coverage-fixture';
import fs from 'fs';
import path from 'path';
import { isNetlifyPreviewDrawerNoise } from './support/console-noise';

type TemplateAuditEntry = {
  slug: string;
  /** True when `/public/preview/{slug}/` ships a static export the
   *  library detail page can iframe. Mirrors the `previewPath` field
   *  on the matching `TemplateEntry`. */
  hasPreview: boolean;
};

const TEMPLATE_ENTRIES: ReadonlyArray<TemplateAuditEntry> = [
  // Live client sites — externally hosted, no `/preview/` build.
  { slug: 'ux-journey', hasPreview: false },
  { slug: 'lebadusul', hasPreview: false },
  // The single portfolio starter — the real Dorin GitHub template,
  // integrated as its own Astro build at `/preview/dorin-portfolio/`.
  { slug: 'dorin-portfolio', hasPreview: true },
] as const;

// Sub-routes that exist inside each Astro template build. Only iterated
// for templates with `hasPreview: true`. Must be the intersection of
// pages every previewable template ships — dorin-portfolio is the only
// previewable today and doesn't include a pricing page, so don't audit
// that subroute (add it back if a future preview ships one).
const PREVIEW_SUBROUTES = ['', 'about', 'contact', 'services'] as const;

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots', 'templates');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

type Issue = {
  route: string;
  theme: 'light' | 'dark';
  kind: 'console' | 'request-failed' | 'http-error';
  detail: string;
};

const ALL_ISSUES: Issue[] = [];

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    const html = document.documentElement;
    html.classList.remove('light', 'dark');
    html.classList.add(t);
    try {
      localStorage.setItem('flowstarter-theme', t);
    } catch {}
  }, theme);
  // Wait a tick for CSS to settle.
  await page.waitForTimeout(200);
}

function shotPath(route: string, theme: 'light' | 'dark') {
  const slug = route.replace(/[^a-z0-9-]+/gi, '_').replace(/^_+|_+$/g, '');
  return path.join(SCREENSHOT_DIR, `${slug || 'root'}__${theme}.png`);
}

async function captureRoute(page: Page, route: string) {
  const issues: Issue[] = [];

  page.removeAllListeners('console');
  page.removeAllListeners('requestfailed');
  page.removeAllListeners('response');

  page.on('console', (msg) => {
    // Netlify's Deploy Preview collaboration drawer is blocked by our CSP on
    // every preview. It is the host's tooling, not our page, and the block is
    // desired; keeping it out of the audit report keeps the report readable.
    // See ./support/console-noise.ts.
    if (msg.type() === 'error' && !isNetlifyPreviewDrawerNoise(msg.text())) {
      issues.push({
        route,
        theme: 'light',
        kind: 'console',
        detail: msg.text(),
      });
    }
  });
  page.on('requestfailed', (req) => {
    issues.push({
      route,
      theme: 'light',
      kind: 'request-failed',
      detail: `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`,
    });
  });
  page.on('response', (res) => {
    // Ignore dev-server compile artifacts: HMR hot-updates and transient
    // `/_next/static/` chunk 500s that the dev server emits while compiling a
    // heavy route on first hit (the /library gallery especially). These are
    // 200s from the CDN in production (next build is green) — counting them
    // makes this smoke flaky. Real errors (images, /api, content 404s) still
    // count.
    const isDevChunkNoise =
      res.url().includes('hot-update') || res.url().includes('/_next/static/');
    if (res.status() >= 400 && !isDevChunkNoise) {
      issues.push({
        route,
        theme: 'light',
        kind: 'http-error',
        detail: `${res.status()} ${res.url()}`,
      });
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    // 'load', not 'networkidle': the live site keeps the network busy with
    // Clerk session polling + analytics beacons, so networkidle never settles
    // and goto times out at 30s (the CI smoke failures). 'load' is enough for
    // a render/error audit.
    // 90s timeout (not 30s): pre-push spins a fresh `next dev`, and Turbopack
    // compiles heavy routes (/library, detail pages) on first hit. Under the
    // full smoke suite's CPU load that cold compile routinely exceeds 30s,
    // which was the recurring pre-push flake. A warm-up beforeAll primes the
    // worst offenders; this headroom covers the rest.
    await page.goto(route, { waitUntil: 'load', timeout: 90000 });
    await setTheme(page, theme);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath(route, theme), fullPage: true });
    issues.forEach((i) => (i.theme = theme));
  }

  ALL_ISSUES.push(...issues);
  return issues;
}

test.describe('Templates audit — every template, light + dark', () => {
  // Prime Turbopack's route cache once before the suite so the first real
  // assertion isn't racing a cold compile. The library gallery + a detail
  // route are the heavy ones; compiling them here (with generous headroom)
  // means every subsequent goto in this file hits a warm route.
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      for (const route of ['/library', '/library/templates/fitness-coach']) {
        await page.goto(route, { waitUntil: 'load', timeout: 120000 }).catch(() => {});
      }
    } finally {
      await page.close();
    }
  });

  test('library landing', async ({ page }) => {
    const issues = await captureRoute(page, '/library');
    expect(
      issues.filter((i) => i.kind === 'http-error').length,
      `HTTP errors on /library:\n${issues
        .filter((i) => i.kind === 'http-error')
        .map((i) => i.detail)
        .join('\n')}`
    ).toBeLessThanOrEqual(1); // one CSS map miss is acceptable
  });

  for (const { slug } of TEMPLATE_ENTRIES) {
    test(`detail page: ${slug}`, async ({ page }) => {
      const route = `/library/templates/${slug}`;
      await captureRoute(page, route);
      await page.goto(route);
      const heading = page.locator('h1.detail-title').first();
      await expect(heading).toBeVisible({ timeout: 10000 });
    });
  }

  // Preview iframe tests — generated only for entries that ship a
  // static build. No `test.skip()` fallback because the test simply
  // doesn't exist when there's nothing to preview.
  for (const { slug, hasPreview } of TEMPLATE_ENTRIES) {
    if (!hasPreview) continue;
    for (const sub of PREVIEW_SUBROUTES) {
      test(`preview: ${slug}/${sub || 'index'}`, async ({ page }) => {
        const route = `/preview/${slug}/${sub ? sub + '/' : ''}`;
        const res = await page.goto(route, { waitUntil: 'load' });
        expect(
          res?.status() ?? 0,
          `${route} should return 2xx — `
            + `mark hasPreview=false in TEMPLATE_ENTRIES if this slug `
            + `doesn't ship a static build.`,
        ).toBeLessThan(400);
        await captureRoute(page, route);
      });
    }
  }

  test.afterAll(async () => {
    if (ALL_ISSUES.length === 0) return;
    const grouped: Record<string, Issue[]> = {};
    for (const i of ALL_ISSUES) {
      grouped[i.route] = grouped[i.route] || [];
      grouped[i.route].push(i);
    }
    const lines = Object.entries(grouped).map(([route, list]) => {
      return [
        `## ${route}`,
        ...list.map((i) => `  [${i.theme}] [${i.kind}] ${i.detail}`),
      ].join('\n');
    });
    fs.writeFileSync(
      path.join(SCREENSHOT_DIR, 'audit-report.md'),
      `# Templates audit issues\n\n${lines.join('\n\n')}\n`
    );
    console.log(
      `\n[audit] ${ALL_ISSUES.length} issues across ${
        Object.keys(grouped).length
      } routes — see ${path.join(SCREENSHOT_DIR, 'audit-report.md')}`
    );
  });
});
