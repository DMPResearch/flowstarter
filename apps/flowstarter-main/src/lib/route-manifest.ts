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
