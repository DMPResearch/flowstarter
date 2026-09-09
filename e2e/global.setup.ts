/**
 * Clerk global setup + one-time operator sign-in.
 *
 * Runs as a Playwright *project* rather than a `globalSetup` function: the
 * function form runs in a separate process, so `clerkSetup()`'s
 * CLERK_TESTING_TOKEN would never reach the test workers.
 *
 * The signed-in state is written to `e2e/.auth/operator.json` and reused by the
 * `chromium-auth` project, so the sign-in happens once per run rather than once
 * per test.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { clerk, clerkSetup, setupClerkTestingToken } from '@clerk/testing/playwright';
import { test as setup, expect } from '@playwright/test';
import {
  assertDevelopmentInstance,
  clerkConfigured,
  clerkSkipReason,
  operatorEmail,
  operatorPassword,
  STORAGE_STATE,
} from './support/clerk-env';
import { signInThroughForm } from './support/clerk-sign-in';

setup.describe.configure({ mode: 'serial' });

setup('clerk global setup', async () => {
  setup.skip(!clerkConfigured(), clerkSkipReason());
  assertDevelopmentInstance();
  await clerkSetup();
});

setup('authenticate as operator', async ({ page }) => {
  setup.skip(!clerkConfigured(), clerkSkipReason());

  await mkdir(dirname(STORAGE_STATE), { recursive: true });

  if (operatorPassword) {
    // The same path a person and the QA journeys use
    // (e2e/support/clerk-sign-in.ts): fills the real form, and answers
    // Client Trust's "Verify this device" step with Clerk's fixed
    // development-instance code if it appears, which it will on a fresh CI
    // browser signing in as `operatorEmail`'s `+clerk_test` identity.
    await signInThroughForm(page, '/login', operatorEmail, operatorPassword);
  } else {
    // No password on hand: fall back to a pre-authenticated ticket, minted
    // from CLERK_SECRET_KEY, which never asks a first factor at all and so
    // never meets Client Trust either.
    await setupClerkTestingToken({ page });
    // Land on /login rather than /. ClerkProvider wraps the root layout, but
    // Clerk v7 boots its JS lazily, so `window.Clerk.loaded` never flips on
    // a page with no Clerk component and clerk.signIn() times out waiting
    // for it. The sign-in form mounts on this route, which forces the load.
    await page.goto('/login');
    await clerk.loaded({ page });
    await clerk.signIn({ page, emailAddress: operatorEmail });
  }

  // Prove the session is real *and* carries a team/admin role before saving it:
  // a signed-in user without that role still bounces off /admin/dashboard, and
  // debugging that from a downstream spec is far harder than failing here.
  await page.goto('/admin/dashboard');
  await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 20_000 });

  await page.context().storageState({ path: STORAGE_STATE });
});
