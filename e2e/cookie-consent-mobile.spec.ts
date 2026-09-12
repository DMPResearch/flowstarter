/**
 * Regression for the MVP readiness review, "Landing, desktop and phone":
 * on a phone (390x844, cookie banner not yet dismissed), the cookie-consent
 * banner (`src/components/CookieConsent.tsx`) covered the hero's primary
 * "Build my site" CTA (`data-testid="open-discovery"` in
 * `src/app/(dynamic-pages)/(main-pages)/components/LandingHero.tsx`).
 * `document.elementFromPoint` at the CTA's centre returned the banner's own
 * `<h3>We use cookies</h3>`, so neither a real thumb nor Playwright's
 * actionability check could reach the button.
 *
 * The effective viewport a phone browser leaves for page content is smaller
 * than its full screen height once the browser chrome (address bar, tab
 * strip) is accounted for — the review measured 664px of a 390x844 device.
 * This spec uses that same 390x664 viewport: at the full 844px height there
 * is enough room that the original bug would not even reproduce, which
 * would make the check worthless as a regression guard.
 *
 * Runs unauthenticated in the existing `chromium` project against
 * `PLAYWRIGHT_BASE_URL`, no Clerk session or database needed.
 */
import { expect, test } from './support/coverage-fixture';

test.use({ viewport: { width: 390, height: 664 } });

test('the cookie banner never covers the hero CTA on a phone viewport', async ({
  page,
}) => {
  // Fresh visitor — no `flowstarter_cookie_consent` in localStorage — so the
  // banner shows on its own 1.5s timer (see CookieConsent.tsx).
  await page.goto('/');

  const banner = page.getByTestId('cookie-consent-banner');
  await expect(banner).toBeVisible();

  const cta = page.getByTestId('open-discovery');
  await expect(cta).toBeVisible();

  const ctaBox = await cta.boundingBox();
  expect(ctaBox).not.toBeNull();
  const cx = ctaBox!.x + ctaBox!.width / 2;
  const cy = ctaBox!.y + ctaBox!.height / 2;

  // The direct test the review used: whatever sits at the CTA's own centre
  // point must be the CTA itself (or a child of it, e.g. the arrow icon),
  // not the banner painted on top of it.
  const hitTestsTheCta = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      const cta = document.querySelector('[data-testid="open-discovery"]');
      return !!(el && cta && cta.contains(el));
    },
    [cx, cy],
  );
  expect(hitTestsTheCta).toBe(true);

  // Belt and braces: an actual Playwright click must land without a
  // different element intercepting the pointer event.
  await cta.click({ trial: true });
});
