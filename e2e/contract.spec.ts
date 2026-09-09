/**
 * Tier 1: keyless contract checks against the Deploy Preview.
 *
 * Runs unauthenticated in the existing `chromium` project against
 * `PLAYWRIGHT_BASE_URL`, so it needs no Clerk session, no Stripe key and no
 * database. Every assertion below is derived from code in this repository,
 * named in the comment above it, so a drift between the code and the
 * deployment fails here instead of in front of a client:
 *
 *   - apps/flowstarter-main/src/middleware.ts       public routes, CSRF, 401/redirect
 *   - apps/flowstarter-main/src/utils/security-headers.ts   CSP and the header set
 *   - apps/flowstarter-main/src/app/api/health/database/route.ts
 *   - apps/flowstarter-main/src/app/api/webhooks/stripe/route.ts
 *   - apps/flowstarter-main/src/app/api/discovery/intake-chat/route.ts
 *   - apps/flowstarter-main/next.config.mjs         headers(), rewrites()
 *
 * Nothing here writes. The one POST that is expected to succeed is the
 * intake-chat request below, and it is shaped so the route returns before it
 * reaches a model, a mailbox or Supabase.
 */
import { expect, test } from './support/coverage-fixture';

const BASE_URL = (
  process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
).replace(/\/$/, '');
const ORIGIN = new URL(BASE_URL).origin;

/** Every page in the app titles itself with the product name. */
const SITE_TITLE = /Flowstarter/;

/**
 * Public routes from the `isPublicRoute` matcher in middleware.ts that are
 * real pages with no dynamic segment, so an anonymous GET must render them.
 *
 * Deliberately absent, and why:
 *   - `/unlock`, `/welcome`             pages exist only under a dynamic
 *                                       segment (`/unlock/[workspaceId]`,
 *                                       `/welcome/[previewId]`), so the bare
 *                                       path is a 404 by design.
 *   - `/forgot-password`, `/reset-password`, `/verify`
 *                                       listed as public in middleware.ts but
 *                                       no page.tsx exists for them; they 404.
 *   - `/gdpr`, `/guides`, `/blogs`, `/sitemap`, `/accessibility`,
 *     `/cookie-policy`, `/term-of-service`, `/privacy-policy`
 *                                       same: allow-listed in middleware.ts
 *                                       with nothing behind them. See the
 *                                       findings note at the bottom of this
 *                                       file.
 *   - `/api/*`                          checked as API contracts above.
 */
const PUBLIC_PAGES = [
  '/',
  '/about',
  '/pricing',
  '/contact',
  '/faq',
  '/help',
  '/privacy',
  '/terms',
  '/cookies',
  '/relaunch',
  '/library',
  // Public auth surfaces: reachable signed out, which is the whole point.
  '/login',
  '/assistant',
  '/admin/login',
  '/admin/join',
];

/**
 * Public pages whose only job is to forward. Both redirects live in the page
 * component, not in middleware.ts, so they are asserted as the contract they
 * are rather than followed:
 *   - admin/page.tsx    redirect('/admin/login'), forwarding the query
 *   - sign-up/page.tsx  redirect('/login'); self-serve sign-up is off, an
 *                       account is created after the discovery call
 */
const PUBLIC_REDIRECTS = [
  ['/admin', '/admin/login'],
  ['/sign-up', '/login'],
] as const;

test.describe('Contract: health', () => {
  // src/app/api/health/database/route.ts: 200 {status:'healthy',...} when the
  // Supabase round trip works, 503 {status:'error',...} when it does not.
  //
  // The status code is checked as "200 or 503, never anything else" rather
  // than a flat 200 because a keyless Deploy Preview is not given a reachable
  // database, so a red here would say nothing about the pull request. The
  // production synthetic (e2e/prod-synthetic.spec.ts) demands a hard 200,
  // which is where an unhealthy database belongs as a failure.
  test('the database health endpoint answers 200 or 503 with the documented JSON shape', async ({
    request,
  }) => {
    const response = await request.get('/api/health/database');
    expect([200, 503]).toContain(response.status());
    expect(response.headers()['content-type']).toContain('application/json');

    const body = await response.json();
    expect(['healthy', 'error']).toContain(body.status);
    expect(typeof body.message).toBe('string');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);

    if (response.status() === 200) {
      expect(body.status).toBe('healthy');
      expect(body.database).toBe('supabase');
    } else {
      test.info().annotations.push({
        type: 'finding',
        description: `health/database returned 503 at ${BASE_URL}: ${body.message}`,
      });
    }
  });

  test('the database health endpoint answers HEAD without a body', async ({
    request,
  }) => {
    const response = await request.head('/api/health/database');
    expect([200, 503]).toContain(response.status());
  });
});

test.describe('Contract: Stripe webhook', () => {
  // src/app/api/webhooks/stripe/route.ts returns 401 {error:'Invalid
  // signature'} when constructEvent rejects the payload. It returns 500
  // {error:'Webhook not configured'} when STRIPE_WEBHOOK_SECRET is unset,
  // which is why the 500 is asserted against separately: a 500 here means the
  // deployment is missing the secret, not that an attacker was turned away.
  // /api/webhooks is CSRF-exempt in middleware.ts, so no Origin is needed.
  test('an unsigned POST is rejected and never 500s', async ({ request }) => {
    const response = await request.post('/api/webhooks/stripe', {
      headers: { 'content-type': 'application/json' },
      data: { id: 'evt_contract_check', type: 'contract.check' },
    });

    expect(
      response.status(),
      'a 500 means STRIPE_WEBHOOK_SECRET is unset on this deployment',
    ).not.toBe(500);
    expect([400, 401]).toContain(response.status());

    const body = await response.json();
    expect(body.error).toBe('Invalid signature');
  });
});

test.describe('Contract: authentication guards', () => {
  // middleware.ts, protected + /api prefix: 401 with this exact JSON.
  for (const [label, path] of [
    ['admin', '/api/admin/dashboard/stats'],
    // A syntactically valid workspace id that belongs to nobody. The route is
    // never reached: middleware.ts rejects before it runs.
    ['client', '/api/client/booking/00000000-0000-0000-0000-000000000000'],
  ] as const) {
    test(`the ${label} API answers 401 without a session, not 500`, async ({
      request,
    }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(401);
      expect(await response.json()).toEqual({
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
    });
  }

  // middleware.ts, protected + page route: 307 to the login that matches the
  // audience, carrying reason and the path to return to.
  for (const [path, login] of [
    ['/dashboard', '/login'],
    ['/admin/dashboard', '/admin/login'],
  ] as const) {
    test(`${path} sends an anonymous visitor to ${login}`, async ({
      request,
    }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(307);

      const location = new URL(response.headers()['location'], BASE_URL);
      expect(location.pathname).toBe(login);
      expect(location.searchParams.get('reason')).toBe('unauthenticated');
      expect(location.searchParams.get('next')).toBe(path);
    });
  }
});

test.describe('Contract: discovery intake', () => {
  // src/app/api/discovery/intake-chat/route.ts is the start of the
  // conversational intake. Its Zod schema requires `answers`; `transcript`
  // and `locale` are optional.
  //
  // The valid payload carries MAX_INTAKE_QUESTIONS (4) agent turns, so the
  // route takes its `questionsAsked >= MAX_INTAKE_QUESTIONS` early return and
  // answers 200 before it moderates, checks the funnel budget or looks for a
  // model key. That keeps this check keyless, free and free of side effects
  // while still proving the whole request path: CSRF, Zod, and the
  // sufficiency gate that decides what is missing.
  const validPayload = {
    answers: {},
    transcript: [
      { role: 'agent', text: 'contract check turn 1' },
      { role: 'agent', text: 'contract check turn 2' },
      { role: 'agent', text: 'contract check turn 3' },
      { role: 'agent', text: 'contract check turn 4' },
    ],
    locale: 'en',
  };

  test('a minimal valid payload is accepted', async ({ request }) => {
    const response = await request.post('/api/discovery/intake-chat', {
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      data: validPayload,
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('complete');
    expect(body.questionsAsked).toBe(4);
    expect(body.maxQuestions).toBe(4);
    expect(Array.isArray(body.missing)).toBe(true);
    // The gate ran deterministically in code, not in a prompt: an empty
    // intake must be missing the hero image it always asks for.
    expect(body.missing.map((item: { code: string }) => item.code)).toContain(
      'hero_image_missing',
    );
  });

  test('a payload that fails the schema is rejected with 400', async ({
    request,
  }) => {
    const response = await request.post('/api/discovery/intake-chat', {
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      // `answers` is required and `transcript` must be an array of turns.
      data: { transcript: 'not an array' },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid intake chat request',
    });
  });

  test('a cross-origin POST is refused by the CSRF check', async ({
    request,
  }) => {
    const response = await request.post('/api/discovery/intake-chat', {
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
      },
      data: validPayload,
    });

    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
  });
});

test.describe('Contract: security headers', () => {
  // next.config.mjs sets no security headers at all: its headers() block only
  // sets Cache-Control and the client hints. Everything asserted here comes
  // from applySecurityHeaders() in src/utils/security-headers.ts, applied in
  // middleware.ts on every response.
  test('the landing page carries the security headers the app sets', async ({
    request,
  }) => {
    const response = await request.get('/');
    expect(response.status()).toBe(200);
    const headers = response.headers();

    // buildCSPHeader(): the directive list is fixed, frame-ancestors is
    // 'none' for everything except /preview/* and the client site preview.
    const csp = headers['content-security-policy'];
    expect(csp, 'no Content-Security-Policy on /').toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");

    // applySecurityHeaders() sets these explicitly.
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['permissions-policy']).toBe(
      'camera=(), microphone=(), geolocation=()',
    );
  });

  // Two headers that the app intends to set and does not. Both fail today;
  // both are one line to fix and neither line is in this pull request.
  //
  //  1. Referrer-Policy. security-headers.ts asks next-secure-headers for
  //     `referrerPolicy: 'strict-origin-when-cross-origin'`, but
  //     createSecureHeaders() returns an ARRAY of {key, value} pairs and
  //     applySecurityHeaders() walks it with Object.entries(). The loop
  //     therefore sets headers literally named "0" through "5" whose value is
  //     the string "[object Object]", and no Referrer-Policy (nor the
  //     730-day HSTS it also configures) ever reaches the client. Fix at the
  //     source: iterate the array and use each entry's key and value.
  //
  //  2. X-Powered-By. next.config.mjs never sets `poweredByHeader: false`, so
  //     Next.js advertises itself on every response. We were asked not to
  //     touch next.config.mjs in this pull request; that one key is the fix.
  test('the landing page sets Referrer-Policy and hides X-Powered-By', async ({
    request,
  }) => {
    const response = await request.get('/');
    const headers = response.headers();

    expect(
      headers['referrer-policy'],
      'security-headers.ts iterates createSecureHeaders() with Object.entries over an array, so Referrer-Policy is never set',
    ).toBe('strict-origin-when-cross-origin');

    expect(
      headers['x-powered-by'],
      'next.config.mjs is missing poweredByHeader: false',
    ).toBeUndefined();

    // The same bug leaks these placeholders. Asserted so the fix is verified
    // by the absence, not just by the presence of Referrer-Policy.
    for (const junk of ['0', '1', '2', '3', '4', '5']) {
      expect(headers[junk], `numeric header "${junk}" leaked`).toBeUndefined();
    }
  });
});

test.describe('Contract: public pages', () => {
  for (const path of PUBLIC_PAGES) {
    test(`${path} renders for an anonymous visitor`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), `${path} did not return 200`).toBe(200);

      const html = await response.text();
      const title = /<title[^>]*>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
      expect(title, `${path} has no <title>`).toMatch(SITE_TITLE);
    });
  }

  for (const [path, target] of PUBLIC_REDIRECTS) {
    test(`${path} forwards an anonymous visitor to ${target}`, async ({
      request,
    }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(307);
      expect(new URL(response.headers()['location'], BASE_URL).pathname).toBe(
        target,
      );
    });
  }

  // middleware.ts allow-lists these as public, and none of them has a page.
  // A visitor who follows a link to one gets a 404, not a login prompt, which
  // is the safe direction; the list is still stale and should be pruned.
  const PUBLIC_BUT_ABSENT = [
    '/gdpr',
    '/guides',
    '/blogs',
    '/sitemap',
    '/accessibility',
    '/cookie-policy',
    '/term-of-service',
    '/privacy-policy',
    '/forgot-password',
    '/reset-password',
    '/verify',
  ];

  test('public routes with no page 404 instead of redirecting to login', async ({
    request,
  }) => {
    for (const path of PUBLIC_BUT_ABSENT) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), `${path} should be a 404`).toBe(404);
    }
    test.info().annotations.push({
      type: 'finding',
      description: `isPublicRoute in middleware.ts allow-lists ${PUBLIC_BUT_ABSENT.length} paths with no page behind them`,
    });
  });
});
