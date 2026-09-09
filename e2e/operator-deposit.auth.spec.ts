/**
 * The one browser-observable leg of the concierge deposit flow.
 *
 * An operator opens a workspace's Billing tab and sends the 20% deposit
 * invoice. That click is where the chain starts; everything after it —
 * Stripe's webhook, the ledger, the build worker, the PR — is server-to-server
 * and is covered by
 * `apps/flowstarter-main/src/lib/flowstarter/__tests__/e2e/full-flow.test.ts`.
 *
 * Safety: this spec mutates workspace state and creates a real Stripe invoice
 * (test mode). It therefore refuses to touch an arbitrary project — it only
 * runs against a workspace you nominate via `E2E_WORKSPACE_ID`, or one whose
 * name starts with "E2E". Otherwise it skips with instructions.
 */

import { expect, test } from './support/coverage-fixture';
import { clerkConfigured, clerkSkipReason } from './support/clerk-env';

const WORKSPACE_ID = process.env.E2E_WORKSPACE_ID?.trim();

test.describe('Operator sends the 20% deposit invoice', () => {
  test.skip(!clerkConfigured(), clerkSkipReason());

  test('signed-in operator reaches the admin dashboard', async ({ page }) => {
    await page.goto('/admin/dashboard');
    // Not bounced to sign-in — the storageState session carries a team role.
    await expect(page).toHaveURL(/\/admin\/dashboard/);
    await expect(page.locator('body')).not.toContainText('Sign in', {
      timeout: 10_000,
    });
  });

  test('deposit invoice can be sent from the Billing tab', async ({ page }) => {
    if (WORKSPACE_ID) {
      await page.goto(`/admin/dashboard/projects/${WORKSPACE_ID}`);
    } else {
      await page.goto('/admin/dashboard/projects');
      const candidate = page.getByRole('link', { name: /^E2E/ }).first();
      const found = await candidate.isVisible().catch(() => false);
      test.skip(
        !found,
        'No E2E workspace found. Set E2E_WORKSPACE_ID to a disposable workspace ' +
          '(needs client_email and setup_fee > 0), or name one starting with "E2E". ' +
          'This spec creates a real Stripe test-mode invoice, so it will not touch an arbitrary project.',
      );
      await candidate.click();
    }

    await page.getByRole('tab', { name: 'Billing' }).click();

    const depositButton = page.getByRole('button', {
      name: /(Send|Resend) deposit/,
    });
    await expect(depositButton).toBeVisible({ timeout: 15_000 });

    // `canSendDeposit` in BillingTab requires client_email + setup_fee > 0 and
    // an unpaid deposit. A disabled button means the fixture is wrong, not the
    // feature — say so rather than timing out on a toast that never comes.
    await expect(
      depositButton,
      'Deposit button is disabled: the workspace needs client_email, setup_fee > 0, and an unpaid deposit',
    ).toBeEnabled();

    await depositButton.click();

    await expect(page.getByText('Deposit invoice sent')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Hosted invoice/i).first()).toBeVisible({
      timeout: 15_000,
    });

    await page.screenshot({
      path: 'e2e/screenshots/06-deposit-invoice-sent.png',
      fullPage: true,
    });
  });
});
