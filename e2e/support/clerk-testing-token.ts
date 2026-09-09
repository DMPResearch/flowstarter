/**
 * Clerk Testing Tokens for specs that sign in through the real form.
 *
 * A Testing Token is Clerk's own, backend-API-issued bypass for bot
 * detection and Client Trust (device verification) on a development
 * instance: https://clerk.com/docs/testing/overview. It is the sanctioned
 * way to test *through* those protections without weakening them for real
 * traffic, which is why the daily QA lane and the release lane's
 * authenticated journey use it rather than asking Clerk to turn Client
 * Trust off.
 *
 * `clerkSetup()` (from `@clerk/testing`, already a dependency, see
 * `global.setup.ts`) is what mints the token: `POST
 * https://api.clerk.com/v1/testing_tokens` with `CLERK_SECRET_KEY`, wrapped
 * by `@clerk/backend`'s `testingTokens.createTestingToken()`. It also needs
 * a publishable key to resolve the Frontend API host the token is scoped
 * to. Nothing here ever logs the token or the secret key.
 *
 * `setupClerkTestingToken({ page })` then installs a request interceptor on
 * that page's browser context that appends the token to every call to
 * Clerk's Frontend API, which is what actually gets the `captcha_bypass`
 * flag set server-side. It has to run before the page's first navigation to
 * a Clerk-backed route: after that, the page has already asked Clerk
 * without the token attached.
 *
 * Unlike `global.setup.ts`'s one-time operator sign-in, this does not call
 * `clerk.signIn()`: the specs that use this still fill in `#email` and
 * `#password` and click "Sign in" themselves, because the sign-in form
 * being exercised is the point of those specs. Testing Tokens only remove
 * the device-trust and bot-detection gate in front of that form, not the
 * form itself.
 */
import { clerkSetup, setupClerkTestingToken } from '@clerk/testing/playwright';
import type { Page } from '@playwright/test';
import { clerkConfigured } from './clerk-env';

let setupPromise: Promise<boolean> | undefined;

/**
 * Mints the token once per worker process (Playwright reuses this module's
 * state across tests in the same worker; `qa-journeys` runs with a single
 * worker, so this runs once per lane invocation, not once per journey).
 * Resolves to whether a token is available to use.
 */
function ensureClerkTestingToken(): Promise<boolean> {
  setupPromise ??= (async () => {
    if (!clerkConfigured()) return false;
    try {
      await clerkSetup();
      return true;
    } catch {
      // A Backend API hiccup here should not fail the journey outright: the
      // caller falls back to signing in without the bypass, which is
      // today's behavior and may still work if this client already has an
      // established Client Trust state (unlikely in a fresh CI browser,
      // but not impossible).
      return false;
    }
  })();
  return setupPromise;
}

/**
 * Installs the bypass on `page`'s context, if a token could be minted.
 * Call before that page's first `goto` of a Clerk-backed route. Returns
 * whether the bypass is active, so a caller can note in its report that a
 * sign-in ran without it rather than fail silently into the slow path.
 */
export async function bypassClerkBotProtection(page: Page): Promise<boolean> {
  const ready = await ensureClerkTestingToken();
  if (!ready) return false;
  await setupClerkTestingToken({ page });
  return true;
}
