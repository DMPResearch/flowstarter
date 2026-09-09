/**
 * Visual regression check — full-page screenshots of the key public pages,
 * compared against the committed Linux baselines.
 *
 * Runs only inside the `visual-desktop` / `visual-mobile` Playwright
 * projects (see playwright.config.ts — those projects are gated behind
 * `VISUAL_CHECK=1` so the default `pnpm run ci:smoke` / pre-push run never
 * picks them up). For each page we:
 *   - wait for the network to go idle and web fonts to finish loading, so
 *     async content (the discovery wizard's client-only bits, fonts,
 *     images) has settled before the shot;
 *   - hide chrome whose *timing* is non-deterministic rather than a real
 *     visual regression signal: the cookie-consent banner (appears 1.5s
 *     after load, gated by localStorage) and the landing page's
 *     support-chat launcher, via a small injected stylesheet;
 *   - mask anything else that legitimately changes between runs: elements
 *     opted in via `data-visual-mask`, the footer's copyright year, and any
 *     Clerk-rendered captcha/managed widget on the login page.
 *
 * Baselines live under e2e/visual/__screenshots__/{platform}/... per the
 * `snapshotPathTemplate` in playwright.config.ts. Only linux/ is committed
 * (darwin/ is gitignored — see e2e/visual/README.md for why, and for the
 * baseline-refresh procedure via workflow_dispatch).
 */

import type { Page } from '@playwright/test';
import { test, expect } from '../support/coverage-fixture';

const PAGES = [
  { name: 'landing', path: '/' },
  { name: 'pricing', path: '/pricing' },
  { name: 'about', path: '/about' },
  { name: 'contact', path: '/contact' },
  { name: 'help', path: '/help' },
  { name: 'login', path: '/login' },
];

// Selectors matched by attribute substring so we don't have to escape
// Tailwind's arbitrary-value class names (e.g. `z-[100]`) as CSS. Harmless
// on pages where the element isn't rendered — the rule just matches
// nothing.
const HIDE_CSS = `
  /* CookieConsent (src/components/CookieConsent.tsx) — a fixed, full-width
     bottom banner that appears 1.5s after load, gated by localStorage. Not
     part of the page's real layout. */
  div[class*="fixed"][class*="bottom-0"][class*="left-0"][class*="right-0"][class*="z-[100]"] {
    display: none !important;
  }
  /* SupportBot launcher (landing page only, see components/SupportBot.tsx)
     — a fixed bottom-right chat button/panel whose open/closed state is
     not something we assert on here. */
  button[class*="fixed"][class*="bottom-6"][class*="right-5"][class*="z-40"],
  div[class*="fixed"][class*="bottom-6"][class*="right-5"][class*="z-40"] {
    display: none !important;
  }
`;

async function prepareForScreenshot(page: Page) {
  await page.addStyleTag({ content: HIDE_CSS });
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
}

function masksFor(page: Page) {
  return [
    // Anything a page author explicitly flagged as non-deterministic.
    page.locator('[data-visual-mask]'),
    // Footer copyright ("© 2026 Flowstarter" etc, see
    // packages/flow-design-system/src/components/layout/Footer.tsx) —
    // rolls over every January 1st.
    page.getByText(/©\s*\d{4}/),
    // Clerk-rendered captcha / managed widget (login page only). Matches
    // 0 elements everywhere else, which is a no-op for `mask`.
    page.locator(
      '#clerk-captcha, [class*="cl-"], iframe[src*="challenges.cloudflare.com"]'
    ),
  ];
}

for (const { name, path } of PAGES) {
  test(`${name} page matches baseline`, async ({ page }) => {
    // Full-page screenshots (network idle + font wait + pixel diff) can run
    // long on a cold dev-server compile or a busy CI runner; the default
    // 30s test timeout is too tight for that, independent of the page's
    // real render cost.
    test.setTimeout(60_000);

    await page.goto(path, { waitUntil: 'load' });
    await prepareForScreenshot(page);

    await expect(page).toHaveScreenshot(`${name}.png`, {
      fullPage: true,
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
      mask: masksFor(page),
    });
  });
}
