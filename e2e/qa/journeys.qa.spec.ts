/**
 * The deterministic half of the daily QA lane.
 *
 * Five journeys, one test each, run against a live deployment
 * (`PLAYWRIGHT_BASE_URL`, production by default) by
 * `.depot/workflows/daily-qa.yml`. The other half is the QA agent, which
 * reads this file's JSON report and then explores the same site in a browser;
 * this file exists so the agent starts from facts rather than from a blank
 * page, and so a regression is caught even on a day the model provider is
 * down.
 *
 * Runs only in the `qa-journeys` project, which only exists when
 * QA_JOURNEYS=1 (see playwright.config.ts). Same reason the visual and
 * prod-synthetic projects are opt-in: `playwright test` with no --project runs
 * every project in that array, and the pre-push hook plus
 * `pnpm run ci:smoke:platform` both do exactly that. Nothing here should ever
 * run against localhost by accident.
 *
 * WHERE THIS DIFFERS FROM e2e/prod-synthetic.spec.ts. That lane writes
 * nothing at all, which is what lets it run every six hours and block on
 * failure. This one is read-MOSTLY: journey qa-01 answers the intake
 * conversation, and that writes a `funnel_previews` row and spends real model
 * budget. That is the price of checking the flow the business actually sells,
 * and it is why this lane runs once a day and not on a six-hour timer. Every
 * other journey reads.
 *
 * The rules every journey obeys:
 *   - the only business it ever describes is the canary in ./intake-canary.ts
 *   - it never completes a payment and never types card details
 *   - it signs in only as the two QA users, and only when their credentials
 *     are present; absent, the journey skips with a warning
 *   - it never opens another tenant's workspace
 */
import type { Page } from '@playwright/test';
import { signInThroughForm } from '../support/clerk-sign-in';
// `test` comes from the fixture, not from @playwright/test: it records the
// routes each journey reaches so scripts/e2e-route-coverage.mjs can merge
// them. Every spec in e2e/ imports it this way; a bare import records
// nothing. See AGENTS.md.
import { expect, test } from '../support/coverage-fixture';
import { CANARY, answerScriptedIntake, openConversation } from './intake-canary';

/**
 * How long the journey watches a generation before it stops watching.
 *
 * A real build takes three to six minutes (`usePreviewProgress.ts`), and the
 * route's own watchdog runs to twenty. Waiting for the full twenty every night
 * buys nothing: the question this journey answers is "did the build start and
 * did it move", not "did it finish". So it watches for six minutes, records
 * the furthest phase it saw as an annotation, and stops.
 */
const GENERATION_WATCH_MS = 6 * 60_000;

/** The NOW line before the first server phase arrives. */
const NOW_STARTING = 'Getting your build started';
/** The NOW line when the live build was refused and the JSON preview ran. */
const NOW_STEPPED_DOWN = 'Putting your preview together';
/** The two NOW lines that mean the build is over, one way or the other. */
const NOW_READY = 'Your preview is ready';
const NOW_FAILED = 'The build stopped';

/**
 * Reduce the NOW line to the phase the server actually reported.
 *
 * `[data-testid="concierge-now"]` wraps three things: the literal label
 * "Now", the phase, and the elapsed seconds. `textContent` returns them
 * glued together ("NowGetting your build started0s"), so an equality test
 * against a phase string silently never matches. Strip the wrapper instead.
 */
function phaseOf(nowLine: string): string {
  return nowLine
    .trim()
    .replace(/^Now/, '')
    .replace(/\d+\s*s$/, '')
    .trim();
}

const clientEmail = process.env.E2E_CLERK_CLIENT_EMAIL?.trim();
const clientPassword = process.env.E2E_CLERK_CLIENT_PASSWORD?.trim();
const operatorEmail = process.env.E2E_CLERK_OPERATOR_EMAIL?.trim();
const operatorPassword = process.env.E2E_CLERK_OPERATOR_PASSWORD?.trim();

/** Optional fixtures that unlock the two payment legs of journey qa-05. */
const unlockWorkspaceId = process.env.QA_UNLOCK_WORKSPACE_ID?.trim();
const stripeCheckoutUrl = process.env.QA_STRIPE_CHECKOUT_URL?.trim();

function credentialsMissing(kind: 'client' | 'operator'): string | false {
  const [email, password] =
    kind === 'client'
      ? [clientEmail, clientPassword]
      : [operatorEmail, operatorPassword];
  const missing = [
    email ? null : `E2E_CLERK_${kind.toUpperCase()}_EMAIL`,
    password ? null : `E2E_CLERK_${kind.toUpperCase()}_PASSWORD`,
  ].filter(Boolean);
  if (missing.length === 0) return false;
  return `${missing.join(' and ')} not set, so the ${kind} journey cannot sign in`;
}

function note(description: string, type = 'journey'): void {
  test.info().annotations.push({ type, description });
}

/**
 * Sign in through the form a person uses.
 *
 * Not `@clerk/testing`'s `clerk.signIn()`, which never touches the form:
 * this lane fills `#email` and `#password` and clicks "Sign in" itself,
 * because the form is the thing under test here. `signInThroughForm`
 * (`e2e/support/clerk-sign-in.ts`, shared with `global.setup.ts`) installs
 * the Testing Token bypass for bot/CAPTCHA protection first, then answers
 * Client Trust's "Verify this device" step with Clerk's fixed
 * development-instance code if it appears, which it will on a fresh CI
 * browser signing in as one of the two `+clerk_test` QA identities.
 */
async function signIn(
  page: Page,
  path: '/login' | '/admin/login',
  email: string,
  password: string,
): Promise<void> {
  const result = await signInThroughForm(page, path, email, password);
  if (!result.botProtectionBypassed) {
    note(
      'CLERK_SECRET_KEY not set, so this sign-in ran without the Testing Token bypass; a bot-protection or Client Trust check may have failed it the way a wrong password would.',
      'warning',
    );
  }
}

test.describe('Daily QA journeys', () => {
  /**
   * (a) A visitor starts the intake conversation, answers it as the canary,
   * and reaches the point where the preview begins generating.
   *
   * This is the one journey that writes. What it writes is a
   * `funnel_previews` row keyed by the demoId annotated below, tagged in the
   * only way that table allows: the business name the canary gave. See
   * docs/daily-qa.md.
   */
  test('qa-01-intake-canary: a visitor answers the intake and the preview starts generating', async ({
    page,
  }) => {
    // The scripted turns are paced by the agent, and the generation watch
    // below runs to six minutes on its own.
    test.setTimeout(GENERATION_WATCH_MS + 8 * 60_000);
    note('qa-01-intake-canary', 'journey-id');
    note(`canary business: ${CANARY.businessName} (${CANARY.tag})`);

    // Captured before the wizard can fire it. An array rather than a
    // reassigned `let`: the assignment happens inside a listener, and
    // TypeScript cannot see that it ever runs.
    const liveStarts: { status: number; body: unknown }[] = [];
    page.on('response', (response) => {
      if (!response.url().includes('/api/discovery/preview/live')) return;
      if (response.request().method() !== 'POST') return;
      void response
        .json()
        .then((body) => liveStarts.push({ status: response.status(), body }))
        .catch(() => liveStarts.push({ status: response.status(), body: null }));
    });

    const dialog = await openConversation(page);
    await expect(dialog).toContainText('what should I call you?', {
      timeout: 30_000,
    });

    await answerScriptedIntake(page);

    // Step 7 is the live info-agent interview. A first-time visitor may or may
    // not answer it; the QA canary has nothing further to add, and the app
    // offers exactly this escape hatch.
    const straightToPreview = dialog.getByRole('button', {
      name: 'Skip and show me the preview',
      exact: true,
    });
    await expect(
      straightToPreview,
      'The intake never reached the info-agent step',
    ).toBeVisible({ timeout: 90_000 });
    await straightToPreview.click();

    // Step 8. Generation kicks off on mount.
    const panes = page.getByTestId('concierge-panes');
    await expect(panes, 'The build panes never appeared').toBeVisible({
      timeout: 60_000,
    });
    const nowLine = page.getByTestId('concierge-now');
    await expect(nowLine).toBeVisible({ timeout: 60_000 });

    // Watch the NOW line and collect every distinct phase the server sends.
    // The phase strings are authored in
    // packages/agentic-codegen/src/flowstarter/workflows.ts and rendered
    // verbatim, so they are recorded rather than matched against a list this
    // file would have to keep in step.
    const phases: string[] = [];
    const deadline = Date.now() + GENERATION_WATCH_MS;
    let finished = false;
    while (Date.now() < deadline) {
      const phase = phaseOf((await nowLine.textContent()) ?? '');
      if (phase && phases[phases.length - 1] !== phase) phases.push(phase);
      if (phase === NOW_READY || phase === NOW_FAILED) {
        finished = true;
        break;
      }
      await page.waitForTimeout(2_000);
    }

    // When the build reports a failure the visitor is told why in the
    // conversation pane. That sentence is the whole value of the finding, so
    // carry it into the report rather than making someone open a trace.
    if (phases.includes(NOW_FAILED)) {
      const transcript = await page
        .getByTestId('concierge-conversation-pane')
        .innerText()
        .catch(() => '');
      note(
        `build failure, as the visitor saw it: ${transcript.replace(/\s+/g, ' ').slice(-600) || '(the conversation pane said nothing)'}`,
        'evidence',
      );
    }

    const liveStart = liveStarts[0];
    const demoId =
      liveStart &&
      typeof liveStart.body === 'object' &&
      liveStart.body !== null &&
      'demoId' in liveStart.body
        ? String((liveStart.body as { demoId: unknown }).demoId)
        : '';
    note(
      demoId
        ? `funnel preview created: demoId ${demoId}, left tagged ${CANARY.tag}`
        : 'no demoId was returned; nothing was created to clean up',
      'canary-row',
    );
    note(`phases seen: ${phases.join(' -> ') || '(none)'}`, 'phases');
    note(
      finished
        ? `generation settled on "${phases[phases.length - 1]}" inside the ${GENERATION_WATCH_MS / 60_000}-minute watch`
        : `still building when the ${GENERATION_WATCH_MS / 60_000}-minute watch ended, furthest phase "${phases[phases.length - 1] ?? '(none)'}"`,
      'generation',
    );

    await page.screenshot({
      path: 'e2e/screenshots/qa-01-intake-canary.png',
      fullPage: false,
    });

    // The live route answers `{ skip: true }` rather than an error when it
    // refuses (blank business name, funnel budget exhausted). That is a
    // finding, not a pass, because the journey exists to check the real build.
    expect(
      liveStarts,
      'The wizard never called POST /api/discovery/preview/live, so no generation was started',
    ).not.toEqual([]);
    expect(
      demoId,
      `The live preview route returned no demoId (status ${liveStart?.status}, body ${JSON.stringify(liveStart?.body)}). ` +
        'A `{ skip: true }` here means the live build was refused and the wizard stepped down to the JSON preview.',
    ).not.toBe('');

    // "Generation phases appear" means the server got past the opening label
    // and told the visitor what it was doing.
    const serverPhases = phases.filter(
      (phase) => phase !== NOW_STARTING && phase !== NOW_STEPPED_DOWN,
    );
    expect(
      serverPhases,
      `The NOW line never moved past "${NOW_STARTING}" in ${GENERATION_WATCH_MS / 60_000} minutes, so no generation phase was reported. Seen: ${phases.join(' -> ') || '(none)'}`,
    ).not.toEqual([]);
    expect(
      phases,
      `The build reported a failure to the visitor. Phases: ${phases.join(' -> ')}`,
    ).not.toContain(NOW_FAILED);
  });

  /** (b) The client QA user signs in, sees the dashboard, and opens the editor. */
  test('qa-02-client-dashboard: the client signs in and the dashboard, then the editor, loads', async ({
    page,
  }) => {
    test.setTimeout(3 * 60_000);
    note('qa-02-client-dashboard', 'journey-id');
    const missing = credentialsMissing('client');
    test.skip(Boolean(missing), missing || '');

    await signIn(page, '/login', clientEmail!, clientPassword!);

    // /dashboard is a router: no workspace stays put, one redirects into the
    // project, several redirect to the picker.
    await expect(page).toHaveURL(/\/(dashboard|admin\/dashboard)/, {
      timeout: 45_000,
    });
    const landed = new URL(page.url()).pathname;
    note(`signed-in client landed on ${landed}`, 'evidence');

    expect(
      landed.startsWith('/admin/'),
      'The client QA user carries a team role. It must be an ordinary client, or this journey checks the wrong surface.',
    ).toBe(false);

    if (landed === '/dashboard') {
      await expect(page.getByRole('heading', { level: 1 })).toContainText(
        'Nothing here yet',
      );
      note('no workspace is linked to the client QA user; editor leg skipped', 'evidence');
      await page.screenshot({ path: 'e2e/screenshots/qa-02-client-empty.png' });
      return;
    }

    if (landed === '/dashboard/projects') {
      await expect(page.getByRole('heading', { level: 1 })).toContainText(
        'Pick a project',
      );
      await page.locator('main a[href^="/dashboard/projects/"]').first().click();
      await page.waitForURL(/\/dashboard\/projects\/[^/]+$/, { timeout: 30_000 });
    }

    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    note(`project page heading: ${(await heading.textContent())?.trim()}`, 'evidence');
    await page.screenshot({ path: 'e2e/screenshots/qa-02-client-project.png' });

    const editorLink = page.getByTestId('site-editor-link');
    if (!(await editorLink.isVisible().catch(() => false))) {
      note('this workspace has no site to edit yet; editor leg skipped', 'evidence');
      return;
    }

    await editorLink.click();
    await page.waitForURL(/\/dashboard\/projects\/[^/]+\/editor$/, {
      timeout: 30_000,
    });
    // Either landmark proves the editor mounted: the tab strip is client-side,
    // the iframe is the site itself.
    await expect(
      page.getByTestId('editor-tab-text').or(page.getByTestId('site-preview-frame')),
      'The editor route loaded but neither the tab strip nor the preview frame rendered',
    ).toBeVisible({ timeout: 45_000 });
    note('editor loaded', 'evidence');
    await page.screenshot({ path: 'e2e/screenshots/qa-02-client-editor.png' });
  });

  /** (c) The operator QA user signs in and sees the pipeline board and the project list. */
  test('qa-03-operator-pipeline: the operator signs in and the pipeline board and project list load', async ({
    page,
  }) => {
    test.setTimeout(3 * 60_000);
    note('qa-03-operator-pipeline', 'journey-id');
    const missing = credentialsMissing('operator');
    test.skip(Boolean(missing), missing || '');

    await signIn(page, '/admin/login', operatorEmail!, operatorPassword!);
    await expect(page).toHaveURL(/\/admin\/dashboard/, { timeout: 45_000 });

    // The masthead greets by time of day; anything else means the operator was
    // bounced or the dashboard failed to hydrate.
    await expect(
      page.getByRole('heading', { level: 1 }),
      'The admin dashboard did not render its masthead, so the QA user is probably not a team member',
    ).toContainText(/^Good (morning|afternoon|evening|night), /, {
      timeout: 45_000,
    });
    await expect(page.getByRole('heading', { name: 'Workflow board' })).toBeVisible({
      timeout: 30_000,
    });
    note('admin dashboard and its embedded workflow board rendered', 'evidence');
    await page.screenshot({ path: 'e2e/screenshots/qa-03-operator-dashboard.png' });

    // The dedicated board. Columns are the concierge states, in order.
    await page.goto('/admin/dashboard/pipeline', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Pipeline', {
      timeout: 45_000,
    });
    for (const column of [
      'Intake',
      'Preview ready',
      'Deposit paid',
      'Agents working',
      'Human QA',
      'Live',
    ]) {
      await expect(
        page.getByRole('heading', { level: 2, name: column, exact: true }),
        `The pipeline board is missing the "${column}" column`,
      ).toBeVisible({ timeout: 30_000 });
    }
    note('pipeline board rendered all six columns', 'evidence');
    await page.screenshot({ path: 'e2e/screenshots/qa-03-operator-pipeline.png' });

    // The project list is a table, not a list of links.
    await page.goto('/admin/dashboard/projects', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Projects', {
      timeout: 45_000,
    });
    const table = page.getByRole('table').first();
    await expect(
      table,
      'The project directory rendered no table. An empty account shows "No projects yet" instead, which is also a finding for a production QA run.',
    ).toBeVisible({ timeout: 30_000 });
    const rows = await table.locator('tbody tr').count();
    note(`project directory listed ${rows} rows`, 'evidence');
    await page.screenshot({ path: 'e2e/screenshots/qa-03-operator-projects.png' });
  });

  /** (d) The pricing and contact pages work, and the contact form validates. */
  test('qa-04-pricing-contact: pricing and contact render and the contact form validates', async ({
    page,
  }) => {
    test.setTimeout(2 * 60_000);
    note('qa-04-pricing-contact', 'journey-id');

    // A hard guard, not an assertion: whatever this journey does below, no
    // contact message can leave the browser.
    let contactPosts = 0;
    await page.route('**/api/contact**', async (route) => {
      contactPosts += 1;
      await route.abort();
    });

    await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/Pricing \| Flowstarter/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'One setup fee.',
    );
    for (const plan of ['Starter care', 'Pro care', 'Store care']) {
      await expect(
        page.getByText(plan, { exact: true }).first(),
        `The pricing page is missing the "${plan}" plan`,
      ).toBeVisible({ timeout: 30_000 });
    }
    note('pricing page rendered its headline and all three care plans', 'evidence');
    await page.screenshot({ path: 'e2e/screenshots/qa-04-pricing.png', fullPage: true });

    await page.goto('/contact', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/Contact \| Flowstarter/);
    for (const id of ['#contact-name', '#contact-email', '#contact-subject', '#contact-message']) {
      await expect(
        page.locator(id),
        `The contact form is missing ${id}`,
      ).toBeVisible({ timeout: 30_000 });
    }

    // Empty submit. Validation is native constraint validation, so the browser
    // blocks the submit and no handler runs; there is no error string in the
    // DOM to assert against.
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      page.locator('#contact-name'),
      'An empty contact form submitted anyway: the name field reports itself as valid',
    ).toHaveJSProperty('validity.valueMissing', true);

    // A malformed address must be caught the same way.
    await page.locator('#contact-name').fill(CANARY.fullName);
    await page.locator('#contact-email').fill('not-an-email');
    await page.locator('#contact-subject').selectOption('General');
    await page
      .locator('#contact-message')
      .fill('Automated daily QA check. No reply needed.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      page.locator('#contact-email'),
      'The contact form accepted "not-an-email" as an address',
    ).toHaveJSProperty('validity.typeMismatch', true);

    expect(
      contactPosts,
      'The contact form reached the network during a validation-only check',
    ).toBe(0);
    note('contact form blocked both an empty and a malformed submit, no request sent', 'evidence');
    await page.screenshot({ path: 'e2e/screenshots/qa-04-contact.png', fullPage: true });
  });

  /**
   * (e) The deposit checkout is reachable and the deployment is in test mode.
   *
   * WHAT THIS CANNOT DO, and why it is written this way. Reaching Stripe's
   * hosted Checkout means creating a Checkout Session, which is a write to
   * Stripe and needs a signed-in client whose workspace is PREVIEW_READY with
   * an unpaid deposit and a quote. A nightly job on production has none of
   * that, and manufacturing it would mean writing to a paying customer's
   * workspace. So the always-on part of this journey proves the entry point is
   * deployed and guarded, and the two legs that actually touch Stripe run only
   * when an operator nominates a disposable fixture.
   *
   * Test mode is likewise not visible from the page. The app ships no Stripe
   * publishable key to the browser (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is
   * declared in src/env.ts and read nowhere), so there is no `pk_test` in the
   * page source to assert on. What IS in the page source is the Clerk
   * publishable key, and docs/preview-environment.md records that production
   * runs on the same test-mode Stripe account and development-instance Clerk
   * as the previews do. A `pk_live_` there is the tell that the split
   * happened, and this journey is the place that would notice.
   */
  test('qa-05-deposit-checkout: the deposit checkout is reachable and the deployment is in test mode', async ({
    page,
    request,
  }) => {
    test.setTimeout(3 * 60_000);
    note('qa-05-deposit-checkout', 'journey-id');

    // The route exists and refuses an anonymous caller before it looks at
    // anything else. Sending a nil-ish UUID keeps this away from real data.
    // The `origin` header is not decoration: middleware.ts rejects a
    // cross-origin state-changing request with 403 before auth ever runs, so
    // without it this checks the CSRF guard instead of the auth guard.
    const anonymous = await request.post(
      '/api/flowstarter/projects/00000000-0000-4000-8000-000000000000/deposit-checkout',
      {
        headers: {
          'content-type': 'application/json',
          origin: new URL(
            process.env.PLAYWRIGHT_BASE_URL ?? 'https://flowstarter.net',
          ).origin,
        },
        data: {},
      },
    );
    expect(
      anonymous.status(),
      'The deposit checkout route did not answer 401 to an anonymous POST',
    ).toBe(401);
    expect((await anonymous.json()).code).toBe('UNAUTHORIZED');
    note('deposit-checkout is deployed and refuses anonymous callers', 'evidence');

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const clerkKey = await page
      .locator('script[data-clerk-publishable-key]')
      .first()
      .getAttribute('data-clerk-publishable-key');
    note(`Clerk publishable key kind: ${clerkKey?.slice(0, 8) ?? '(absent)'}`, 'evidence');
    expect(
      clerkKey,
      'The deployment ships a live-mode Clerk key. Payments are wired to the same account split, so re-read docs/preview-environment.md before this lane touches checkout again.',
    ).toMatch(/^pk_test_/);

    if (!unlockWorkspaceId) {
      note(
        'QA_UNLOCK_WORKSPACE_ID is not set, so the unlock page leg was skipped. ' +
          'Point it at a disposable workspace to check the deposit button.',
        'skipped-leg',
      );
    } else {
      await page.goto(`/unlock/${unlockWorkspaceId}`, {
        waitUntil: 'domcontentloaded',
      });
      const payButton = page.getByRole('button', {
        name: /^Pay .* and start the build$/,
      });
      await expect(
        payButton,
        'The unlock page rendered no deposit button for the nominated workspace',
      ).toBeVisible({ timeout: 30_000 });
      await expect(payButton).toBeEnabled();
      // Deliberately not clicked: the click creates a Stripe Checkout Session.
      note(
        `unlock page offers "${(await payButton.textContent())?.trim()}"; not clicked`,
        'evidence',
      );
      await page.screenshot({ path: 'e2e/screenshots/qa-05-unlock.png' });
    }

    if (!stripeCheckoutUrl) {
      note(
        'QA_STRIPE_CHECKOUT_URL is not set, so the hosted Checkout leg was skipped. ' +
          'The browser cannot tell test mode from live mode on this site, because the ' +
          'app ships no Stripe publishable key; set this to a disposable session URL to check it.',
        'skipped-leg',
      );
      return;
    }

    // Reached, never completed. No card details are typed anywhere below.
    expect(
      stripeCheckoutUrl,
      'QA_STRIPE_CHECKOUT_URL must be a Stripe hosted Checkout URL',
    ).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    await page.goto(stripeCheckoutUrl, { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByText('TEST MODE', { exact: false }).first(),
      'Stripe hosted Checkout did not show its test-mode banner. Stop this lane before it runs again.',
    ).toBeVisible({ timeout: 30_000 });
    note('hosted Checkout reached and is in test mode; no card details entered', 'evidence');
    await page.screenshot({ path: 'e2e/screenshots/qa-05-checkout.png' });
  });
});
