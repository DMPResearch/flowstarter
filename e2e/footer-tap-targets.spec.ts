/**
 * Regression for the MVP readiness review, "Accessibility": on a phone
 * viewport the footer's nav links (`packages/flow-design-system/src/components/layout/Footer.tsx`)
 * measured 20px tall against a 24px WCAG 2.2 AA minimum target size, ten
 * links in a row. A unit test on the class tokens lives alongside
 * `src/components/__tests__/Footer.test.tsx`; this is the pixel measurement.
 *
 * Runs unauthenticated in the existing `chromium` project against
 * `PLAYWRIGHT_BASE_URL`, no Clerk session or database needed.
 */
import { expect, test } from './support/coverage-fixture';

const MIN_TARGET_PX = 24;

test.use({ viewport: { width: 390, height: 900 } });

test('every footer nav link is at least 24px tall on a phone viewport', async ({
  page,
}) => {
  await page.goto('/about');

  const footer = page.locator('footer');
  await expect(footer).toBeVisible();
  await footer.scrollIntoViewIfNeeded();

  const nav = footer.locator('nav').first();
  const links = nav.locator('a');
  const count = await links.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i += 1) {
    const box = await links.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  }
});
