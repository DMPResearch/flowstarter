/**
 * Sign in through the real form, past both of Clerk's protections.
 *
 * Shared by `e2e/qa/journeys.qa.spec.ts` and `e2e/global.setup.ts`, which
 * used to sign in two different ways (a filled form, and `clerk.signIn()`
 * against `window.Clerk` directly). Only the form path can ever show the
 * "Verify this device" step `LoginForm.tsx` now renders for
 * `needs_client_trust`, so both use this.
 *
 * Two protections, two different answers:
 *
 *   - Bot/CAPTCHA: `bypassClerkBotProtection` (./clerk-testing-token.ts)
 *     installs a Testing Token before the first navigation.
 *   - Client Trust (device verification): answered here, in the form, with
 *     Clerk's fixed development-instance code (`424242`). That code only
 *     works for an identity whose email carries a `+clerk_test`
 *     subaddress (https://clerk.com/docs/testing/test-emails-and-phones),
 *     which is why the two QA users are
 *     `qa-client+clerk_test@example.com` and
 *     `qa-operator+clerk_test@flowstarter.net` (see docs/daily-qa.md). A
 *     Testing Token does not reach this: verified against production with
 *     the token active, `client.captcha_bypass` was `true` on the wire and
 *     `needs_client_trust` still came back.
 */
import { expect, type Page } from '@playwright/test';
import { bypassClerkBotProtection } from './clerk-testing-token';

/**
 * Clerk's fixed development-instance verification code. Valid only for
 * `+clerk_test` identities; see the module doc above.
 */
export const CLERK_TEST_CODE = '424242';

export interface SignInResult {
  /** Whether the Testing Token bypass (bot/CAPTCHA) was installed. */
  readonly botProtectionBypassed: boolean;
  /** Whether the "Verify this device" step appeared and was answered. */
  readonly clientTrustAnswered: boolean;
}

/**
 * Fills `#email`/`#password`, clicks "Sign in", and answers Client Trust's
 * "Verify this device" step with the fixed code if it appears, before
 * waiting for the resulting redirect off `path`.
 */
export async function signInThroughForm(
  page: Page,
  path: '/login' | '/admin/login',
  email: string,
  password: string,
): Promise<SignInResult> {
  const botProtectionBypassed = await bypassClerkBotProtection(page);

  await page.goto(path, { waitUntil: 'domcontentloaded' });
  const emailField = page.locator('#email');
  await expect(
    emailField,
    `${path} did not render its sign-in form`,
  ).toBeVisible({ timeout: 30_000 });
  await emailField.fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Present only when Clerk answers `needs_client_trust`; absent, this
  // waits out its timeout once and moves on, which only costs time on a
  // sign-in that was never going to hit it.
  const codeField = page.locator('#client-trust-code');
  const clientTrustAnswered = await codeField
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (clientTrustAnswered) {
    await codeField.fill(CLERK_TEST_CODE);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
  }

  await page.waitForURL((url) => !url.pathname.endsWith(path), {
    timeout: 45_000,
  });

  return { botProtectionBypassed, clientTrustAnswered };
}
