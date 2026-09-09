/**
 * Tier 4: production synthetic, run after every deploy.
 *
 * Runs only in the `prod-synthetic` Playwright project, which only exists
 * when PROD_SYNTHETIC=1 (see playwright.config.ts), against
 * PLAYWRIGHT_BASE_URL, default https://flowstarter.net. The lane that runs it
 * is .depot/workflows/prod-synthetic.yml.
 *
 * This one is blocking by design. It reads production and writes nothing:
 * no account, no lead, no canary row, no deposit. The only POST it makes is
 * an unsigned Stripe webhook, which the route is required to reject before it
 * touches anything.
 *
 * Where it differs from the per-pull-request contract spec
 * (e2e/contract.spec.ts): the contract spec tolerates an unreachable database
 * because a keyless Deploy Preview is not given one. Production is, so the
 * health check here is a hard 200.
 */
import { expect, test } from './support/coverage-fixture';

const BASE_URL = (
  process.env.PLAYWRIGHT_BASE_URL ?? 'https://flowstarter.net'
).replace(/\/$/, '');

/** Hard ceiling. Over this the page is broken, not slow. */
const BUDGET_FAIL_MS = 5_000;
/** Soft ceiling. Over this we annotate the report and keep going. */
const BUDGET_WARN_MS = 2_000;

/**
 * A generated site served from our own host.
 *
 * src/lib/hosting/preview-publisher.ts publishes deployed sites at
 * `{slug}.preview.flowstarter.net` and src/lib/hosting/site-urls.ts prefers a
 * client's own domain over that. No slug on either pattern is public: the
 * preview hosts belong to paying clients and the repository commits none of
 * them, so there is nothing safe to hard-code. That tier is skipped below
 * unless PROD_SYNTHETIC_SITE_URL names a host that is safe to poll.
 *
 * What IS public and generated is the static template bundle Next.js serves
 * from /preview/{slug}/ (next.config.mjs rewrites the directory URL onto
 * index.html; the library detail page frames it). That is checked instead.
 */
const GENERATED_SITE_URL = process.env.PROD_SYNTHETIC_SITE_URL?.trim() || '';
const STATIC_PREVIEW_PATH = '/preview/dorin-portfolio/';

async function timedGoto(
  page: import('@playwright/test').Page,
  path: string,
): Promise<number> {
  const startedAt = Date.now();
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  const elapsed = Date.now() - startedAt;

  expect(response, `no response for ${path}`).not.toBeNull();
  expect(response!.status(), `${path} returned ${response!.status()}`).toBe(
    200,
  );

  test.info().annotations.push({
    type: elapsed > BUDGET_WARN_MS ? 'slow' : 'timing',
    description: `${path} responded in ${elapsed} ms`,
  });
  expect(
    elapsed,
    `${path} took ${elapsed} ms, over the ${BUDGET_FAIL_MS} ms budget`,
  ).toBeLessThan(BUDGET_FAIL_MS);

  return elapsed;
}

test.describe('Production synthetic', () => {
  for (const [name, path, title] of [
    ['landing', '/', /Flowstarter/],
    ['pricing', '/pricing', /Pricing \| Flowstarter/],
    ['sign-in', '/login', /Flowstarter/],
  ] as const) {
    test(`the ${name} page loads inside the response-time budget`, async ({
      page,
    }) => {
      await timedGoto(page, path);
      await expect(page).toHaveTitle(title);
    });
  }

  // src/app/api/health/database/route.ts. Production has a database, so the
  // only acceptable answer is the healthy one.
  test('the database health endpoint is healthy', async ({ request }) => {
    const startedAt = Date.now();
    const response = await request.get('/api/health/database');
    const elapsed = Date.now() - startedAt;

    test.info().annotations.push({
      type: elapsed > BUDGET_WARN_MS ? 'slow' : 'timing',
      description: `/api/health/database responded in ${elapsed} ms`,
    });

    const body = await response.json();
    expect(
      response.status(),
      `health/database said: ${body.message ?? ''} ${body.error ?? ''}`.trim(),
    ).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.database).toBe('supabase');
    expect(elapsed).toBeLessThan(BUDGET_FAIL_MS);
  });

  // src/app/api/webhooks/stripe/route.ts. An unsigned event must never be
  // processed. This POST carries no signature and no real event, so the route
  // rejects it at constructEvent, before any handler runs.
  test('the Stripe webhook rejects an unsigned POST', async ({ request }) => {
    const response = await request.post('/api/webhooks/stripe', {
      headers: { 'content-type': 'application/json' },
      data: { id: 'evt_prod_synthetic', type: 'contract.check' },
    });

    expect(response.status()).not.toBe(500);
    expect([400, 401]).toContain(response.status());
    expect((await response.json()).error).toBe('Invalid signature');
  });

  test('a generated site is reachable', async ({ page }) => {
    test.skip(
      GENERATED_SITE_URL === '' && BASE_URL !== 'https://flowstarter.net',
      'no public generated-site host is known for this base URL; set PROD_SYNTHETIC_SITE_URL to check one',
    );

    if (GENERATED_SITE_URL) {
      const startedAt = Date.now();
      const response = await page.goto(GENERATED_SITE_URL, {
        waitUntil: 'domcontentloaded',
      });
      const elapsed = Date.now() - startedAt;
      expect(response?.status()).toBe(200);
      expect(elapsed).toBeLessThan(BUDGET_FAIL_MS);
      return;
    }

    test.info().annotations.push({
      type: 'note',
      description:
        'No {slug}.preview.flowstarter.net host is public, so the static template bundle at ' +
        `${STATIC_PREVIEW_PATH} stands in for a generated site.`,
    });
    await timedGoto(page, STATIC_PREVIEW_PATH);
    await expect(page.locator('body')).not.toBeEmpty();
  });
});
