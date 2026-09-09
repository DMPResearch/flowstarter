/**
 * Concierge Flow — Smoke Tests (Root Level)
 *
 * Quick sanity checks on the main platform.
 * In CI: runs against PLAYWRIGHT_BASE_URL — the per-PR Netlify Deploy Preview
 * for `feature/**` branches and pull_request runs, falling back to the
 * staging URL for pushes to main if the preview lookup is skipped.
 * Locally: runs against localhost:3000.
 *
 * These do NOT require auth and do NOT hit real AI/Daytona.
 */

import { test, expect } from './support/coverage-fixture';

test.describe('Concierge Flow — Platform Smoke', () => {
  test.describe('Main Platform', () => {
    test('Landing page loads with header', async ({ page }) => {
      await page.goto('/');
      const header = page.locator('header').first();
      await expect(header).toBeVisible({ timeout: 15000 });
      await page.screenshot({ path: 'e2e/screenshots/01-landing-page.png', fullPage: true });
    });

    test('Team dashboard redirects to auth when unauthenticated', async ({ page }) => {
      await page.goto('/admin/dashboard');
      await page.waitForTimeout(2000);
      const url = page.url();
      const isAuthPage =
        url.includes('login') ||
        url.includes('sign-in') ||
        url.includes('signin');
      const hasAuthPrompt = await page.locator('text=Sign in').isVisible().catch(() => false);
      expect(isAuthPage || hasAuthPrompt).toBeTruthy();
      await page.screenshot({ path: 'e2e/screenshots/02-team-auth-required.png', fullPage: true });
    });

    test('Client dashboard redirects to auth when unauthenticated', async ({ page }) => {
      await page.goto('/dashboard');
      await page.waitForTimeout(2000);
      const url = page.url();
      const isAuthPage =
        url.includes('login') ||
        url.includes('sign-in') ||
        url.includes('signin');
      const hasAuthPrompt = await page.locator('text=Sign in').isVisible().catch(() => false);
      expect(isAuthPage || hasAuthPrompt).toBeTruthy();
      await page.screenshot({ path: 'e2e/screenshots/03-client-auth-required.png', fullPage: true });
    });

    test('Pricing page loads', async ({ page }) => {
      await page.goto('/pricing');
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'e2e/screenshots/05-pricing-page.png', fullPage: true });
    });
  });
});
