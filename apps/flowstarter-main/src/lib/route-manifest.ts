/**
 * The route lists `middleware.ts` matches on, kept in their own module so a
 * test can read them without booting Clerk, Arcjet and the Edge runtime.
 *
 * `src/__tests__/route-manifest.test.ts` checks every page entry here against
 * the pages that actually exist under `src/app`, so an entry whose page is
 * deleted, renamed or never written fails the unit suite. That check is why
 * eleven paths were removed from `PUBLIC_ROUTES` on 2026-09-09: `/gdpr`,
 * `/guides`, `/blogs`, `/sitemap`, `/accessibility`, `/cookie-policy`,
 * `/term-of-service`, `/privacy-policy`, `/forgot-password`,
 * `/reset-password` and `/verify` had no page behind them and nothing in the
 * app linked to them. The password reset and email verification flows are not
 * separate pages: they are steps inside the Clerk `useSignIn` state machine in
 * `packages/flow-design-system/src/components/auth/LoginForm.tsx`, rendered on
 * `/login`.
 *
 * Every entry uses Clerk's `createRouteMatcher` syntax, so `(.*)` means "this
 * path and everything under it".
 */

/**
 * Reachable without a Clerk session. The middleware decides auth from this
 * list; `NavigationWrapper`'s `publicRoutePrefixes` mirrors it only to decide
 * whether the shell may paint before Clerk finishes loading, and the two
 * drifting apart is what once left `/unlock` behind a permanent loader.
 */
export const PUBLIC_ROUTES = [
  '/',
  '/about(.*)',
  '/login(.*)',
  '/assistant(.*)', // Client-facing "Flowstarter Assistant" sign-in (reached from workspace landings)
  '/sign-up(.*)',
  '/api/webhooks(.*)',
  // Service callers, not people: no Clerk session exists to check. Every route
  // under it verifies a shared secret itself (see api/internal/build/deploy).
  '/api/internal(.*)',
  '/api/health(.*)',
  '/api/auth/session(.*)', // Session check
  '/api/contact(.*)', // Public contact form API
  '/api/support-chat(.*)', // Public support bot LLM endpoint
  '/api/discovery(.*)', // Public discovery wizard: lead capture + booking deposit
  // The contact form on a client's own generated site. There is no session to
  // check: the person filling it in is a visitor to somebody else's business,
  // not a Flowstarter user. What stands in for one is the workspace's public
  // capture token in the path plus an origin check against that workspace's
  // own hostnames, both inside the route. See docs/integrations/lead-capture.md.
  '/api/leads/capture/(.*)',
  // Cal.com's webhook. Same shape of caller as the two above: a server, not a
  // person, with no Clerk session to check. What stands in for one is the
  // per-workspace HMAC in `X-Cal-Signature-256`, verified against the raw bytes
  // inside the route before a single row is read.
  //
  // It has to be listed here or the delivery never reaches that check: the
  // middleware answered every POST with 401 "Authentication required", which
  // is indistinguishable, from Cal's side, from a subscriber URL that is
  // simply wrong. Measured against a real Cal.com instance on 2026-09-13 —
  // bookings were being made and none of them ever reached a dashboard.
  '/api/integrations/cal/(.*)',
  // The portrait connect flows. Public because the visitor has no session yet
  // (the whole point is a preview built before anybody is anybody) and because
  // the callback arrives as a provider's redirect, which carries no cookie of
  // ours at all. What stands in for a session is the signed state: see
  // `app/api/connect/connect-flow.ts`.
  '/api/connect(.*)',
  '/unlock(.*)', // Preview unlock landing: reached from a generated site, viewer may be signed out
  '/welcome(.*)', // Guest deposit landing: Stripe returns here before the account exists
  '/contact(.*)',
  '/help(.*)', // Public help page
  '/privacy(.*)', // Public privacy policy
  '/terms(.*)', // Public terms of service
  '/pricing(.*)', // Public pricing page
  '/cookies(.*)', // Public cookie policy
  '/admin', // Admin index (redirects to login)
  '/admin/login(.*)', // Admin login page (public, auth handled by Clerk)
  '/admin/join(.*)', // Admin join/invitation page (public)

  // Public static pages — landing sections, legal, support
  '/relaunch(.*)',
  '/faq(.*)',
  '/library(.*)', // Public template library (also reachable via library.* subdomain rewrite)

  // Development-only screenshot surface. Public so a reviewer can open it
  // without a Clerk session; the page itself calls `notFound()` unless
  // `NODE_ENV` is non-production or `FLOWSTARTER_DESIGN_GALLERY=1`, so the
  // middleware letting it through never means production serves it. It used
  // to hide under `/about/design-gallery` to borrow that prefix's public
  // entry, which is also how it inherited the marketing header and the
  // marketing content column it has no business rendering inside.
  '/design-gallery(.*)',
] as const;

/**
 * Routes that only exist if they match a known app path prefix. Everything
 * else is a 404 — let Next.js render it instead of redirecting to login.
 */
export const KNOWN_APP_ROUTES = [
  '/',
  '/unlock(.*)',
  '/welcome(.*)',
  '/account/password(.*)', // Forced password change for guest-provisioned clients
  '/about(.*)',
  '/login(.*)',
  '/assistant(.*)', // Client-facing "Flowstarter Assistant" sign-in (reached from workspace landings)
  '/sign-up(.*)',
  '/contact(.*)',
  '/help(.*)',
  '/privacy(.*)',
  '/terms(.*)',
  '/pricing(.*)',
  '/cookies(.*)',
  '/faq(.*)',
  '/relaunch(.*)',
  '/admin(.*)',
  '/dashboard(.*)',
  '/new(.*)',
  '/api(.*)',
  '/library(.*)',
  '/design-gallery(.*)',
] as const;

/**
 * Signature/shared-secret callers, not browsers: Cal.com's webhook delivery
 * (`X-Cal-Signature-256`, verified inside `api/integrations/cal/[workspaceId]`)
 * and the build worker's callbacks to this app (`Authorization: Bearer
 * <FLOWSTARTER_BUILD_WORKER_SECRET>`, verified inside
 * `api/internal/build/deploy` — every route under `/api/internal` is the same
 * shape, see its own comment in `PUBLIC_ROUTES` above).
 *
 * Arcjet's bot detection fingerprints exactly what these callers look like —
 * no browser headers, no session, a server posting a signed request — so
 * running it against them would 403 a legitimate delivery before the route
 * itself ever gets to check the signature. `arcjetPolicyFor` below routes a
 * path here to the `machine` policy (shield and the route's own rate limit,
 * no bot detection) instead of `browser`'s full set. The allow-list lives
 * here, next to the same-shaped `PUBLIC_ROUTES` entries, rather than as
 * scattered `pathname.startsWith(...)` checks in the middleware itself.
 */
const MACHINE_ROUTE_PREFIXES = [
  '/api/internal',
  '/api/integrations/cal',
] as const;

/** Never protected by Arcjet at all — verified (or trivially safe) before
 * Arcjet would ever run, same as today. */
const UNPROTECTED_ROUTE_PREFIXES = ['/api/webhooks', '/api/health'] as const;

export type ArcjetPolicy = 'browser' | 'machine' | 'none';

/** `pathname` is `prefix` itself, or `prefix` followed by `/…` — not merely
 * a string that happens to start with the same characters (so a future
 * `/api/integrations/calendly` route, say, is not accidentally caught by the
 * `/api/integrations/cal` prefix). */
function isUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The one place a request path becomes an Arcjet policy. Pure and
 * dependency-free so a test can call it directly without booting Clerk,
 * Arcjet or the Edge runtime — same reasoning as the route lists above.
 *
 *   - `none`: webhooks and the health check.
 *   - `machine`: {@link MACHINE_ROUTE_PREFIXES} — shield and the per-route
 *     rate limit, no bot detection.
 *   - `browser`: everything else, the default — shield, bot detection and
 *     the blanket rate limit.
 */
export function arcjetPolicyFor(pathname: string): ArcjetPolicy {
  if (
    UNPROTECTED_ROUTE_PREFIXES.some((prefix) => isUnderPrefix(pathname, prefix))
  ) {
    return 'none';
  }
  if (
    MACHINE_ROUTE_PREFIXES.some((prefix) => isUnderPrefix(pathname, prefix))
  ) {
    return 'machine';
  }
  return 'browser';
}
