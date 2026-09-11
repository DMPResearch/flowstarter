import {
  ajWithRateLimit,
  createBlockedResponse,
  getRateLimitHeaders,
} from '@/lib/arcjet';
import {
  clerkClient,
  clerkMiddleware,
  createRouteMatcher,
} from '@clerk/nextjs/server';
import {
  getAllowedRedirectOrigins,
  isSafeRedirectUrl,
} from '@flowstarter/platform-config';
import { NextResponse, type NextRequest } from 'next/server';
import {
  forcedPasswordChangeRedirect,
  type ForcedPasswordClaims,
} from '@/lib/auth/forced-password-change';
import { KNOWN_APP_ROUTES, PUBLIC_ROUTES } from '@/lib/route-manifest';
import { applySecurityHeaders } from './utils/security-headers';

/**
 * Generate a cryptographically secure nonce for CSP using Web Crypto API
 * (Edge Runtime compatible)
 */
function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, Array.from(array)));
}

/**
 * Timing-safe string comparison using Web Crypto API
 * (Edge Runtime compatible)
 */
async function _timingSafeCompare(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;

  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // Use subtle crypto to create keys and compare in constant time
  const key = await crypto.subtle.importKey(
    'raw',
    aBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig1 = await crypto.subtle.sign('HMAC', key, aBytes);
  const sig2 = await crypto.subtle.sign('HMAC', key, bBytes);

  const sig1Array = new Uint8Array(sig1);
  const sig2Array = new Uint8Array(sig2);

  if (sig1Array.length !== sig2Array.length) return false;

  let result = 0;
  for (let i = 0; i < sig1Array.length; i++) {
    result |= sig1Array[i] ^ sig2Array[i];
  }

  return result === 0;
}

/**
 * Log security event (Edge Runtime compatible - console only)
 * Full database logging happens in API routes, not middleware
 */
/**
 * @flowstarter.* primary emails auto-resolve to admin so internal hires
 * don't need a manual Clerk metadata edit before they can use /admin/*.
 */
const TEAM_EMAIL_DOMAINS = new Set([
  'flowstarter.net',
  'flowstarter.app',
  'flowstarter.dev',
  'flowstarter.com',
]);

function emailDomainRole(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain && TEAM_EMAIL_DOMAINS.has(domain) ? 'admin' : undefined;
}

/**
 * Short-lived in-memory cache for resolved user roles.
 * Prevents a Clerk Backend API roundtrip (`users.getUser`) on every
 * middleware invocation when the role is absent from session claims.
 * TTL = 120 s; evicts the oldest entry when the map exceeds 500 users.
 */
const _roleCache = new Map<string, { role: string | undefined; exp: number }>();
const ROLE_CACHE_TTL_MS = 120_000;
const ROLE_CACHE_MAX = 500;

/**
 * Resolve the effective role for a Clerk user. Used by middleware to gate
 * /admin/* routes. Mirrors `resolveUserRole` in src/lib/api-auth.ts —
 * keep them in sync.
 */
async function resolveRoleEdge(
  userId: string,
  sessionClaims:
    | { metadata?: { role?: string }; email?: string }
    | null
    | undefined
): Promise<string | undefined> {
  const claimRole = sessionClaims?.metadata?.role?.toLowerCase();
  if (claimRole) return claimRole;

  // Check in-memory cache before hitting the Clerk Backend API.
  const cached = _roleCache.get(userId);
  if (cached && Date.now() < cached.exp) return cached.role;

  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const metaRole = (
      user.publicMetadata as { role?: string } | undefined
    )?.role?.toLowerCase();
    let resolved: string | undefined = metaRole;

    if (!resolved) {
      const primaryEmail = user.emailAddresses.find(
        (e) => e.id === user.primaryEmailAddressId
      )?.emailAddress;
      resolved = emailDomainRole(primaryEmail);
    }

    // Evict oldest entry when cache is full.
    if (_roleCache.size >= ROLE_CACHE_MAX) {
      const oldest = _roleCache.keys().next().value;
      if (oldest !== undefined) _roleCache.delete(oldest);
    }
    _roleCache.set(userId, {
      role: resolved,
      exp: Date.now() + ROLE_CACHE_TTL_MS,
    });
    return resolved;
  } catch {
    return undefined;
  }
}

/**
 * When a team member is already signed in but hits `/admin/login`, send them
 * onward without dropping `redirect_url` or `next` (editor deep-links, return
 * paths after middleware bounced them to login).
 */
function redirectAuthenticatedTeamFromAdminLogin(
  req: NextRequest
): NextResponse {
  const hostHeader = req.headers.get('host') ?? '';
  const host = hostHeader.split(':')[0] ?? '';

  const redirectParam = req.nextUrl.searchParams.get('redirect_url');
  if (redirectParam && isSafeRedirectUrl(redirectParam, host)) {
    try {
      const parsed = new URL(redirectParam);
      const isCrossDomain = parsed.hostname !== host;
      if (isCrossDomain) {
        const transferUrl = req.nextUrl.clone();
        transferUrl.pathname = '/api/auth/transfer-redirect';
        transferUrl.search = '';
        transferUrl.searchParams.set('redirect_url', redirectParam);
        return NextResponse.redirect(transferUrl);
      }
      return NextResponse.redirect(redirectParam);
    } catch {
      /* fall through */
    }
  }

  const nextParam = req.nextUrl.searchParams.get('next');
  if (nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//')) {
    try {
      const dest = new URL(nextParam, req.nextUrl.origin);
      if (dest.origin === req.nextUrl.origin) {
        return NextResponse.redirect(dest);
      }
    } catch {
      /* fall through */
    }
  }

  const fallback = req.nextUrl.clone();
  fallback.pathname = '/admin/dashboard';
  fallback.search = '';
  return NextResponse.redirect(fallback);
}

function logSecurityEventEdge(
  event: string,
  context?: { route?: string; method?: string }
): void {
  const logParts = [
    `[SECURITY]`,
    `event=${event}`,
    context?.route ? `route=${context.route}` : null,
    context?.method ? `method=${context.method}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  if (event.includes('blocked') || event.includes('csrf')) {
    console.warn(logParts);
  } else {
    console.info(logParts);
  }
}

// Create a middleware matcher to determine which routes should be public
// The lists themselves live in `@/lib/route-manifest` so
// `src/__tests__/route-manifest.test.ts` can assert every page entry against
// the pages that exist under `src/app` without booting Clerk or the Edge
// runtime. Add a route there, not here.
const isPublicRoute = createRouteMatcher([...PUBLIC_ROUTES]);

// Routes that only exist if they match a known app path prefix.
// Everything else is a 404 — let Next.js render it instead of redirecting to login.
const isKnownAppRoute = createRouteMatcher([...KNOWN_APP_ROUTES]);

export default clerkMiddleware(async (auth, req) => {
  // ── Workflow showcase subdomain rewrite ──────────────────────────────────
  // Keep the public demo URL clean while preserving the real app route and
  // its same-origin video assets under the hood.
  {
    const host = (req.headers.get('host') ?? '').toLowerCase().split(':')[0];
    if (host === 'workflows.flowstarter.dev' && req.nextUrl.pathname === '/') {
      const url = req.nextUrl.clone();
      url.pathname = '/workflow-showcase';
      return NextResponse.rewrite(url);
    }
  }

  // ── Library subdomain rewrite ─────────────────────────────────────────────
  // The library lives at https://library.flowstarter.net but is served from
  // the same Next.js app under /library/*. Rewrite the host to the internal
  // route segment so the address bar stays clean (no /library/ prefix).
  // Static asset paths (preview iframes, showcase images, _next, api) must
  // pass through unchanged so the Astro previews and Next runtime keep
  // working from the library subdomain.
  {
    const host = (req.headers.get('host') ?? '').toLowerCase();
    const reqPath = req.nextUrl.pathname;
    const isLibrarySubdomain = host.startsWith('library.');
    const passThrough =
      reqPath.startsWith('/library') ||
      reqPath.startsWith('/_next') ||
      reqPath.startsWith('/api') ||
      reqPath.startsWith('/preview') ||
      reqPath.startsWith('/showcase') ||
      reqPath.startsWith('/favicon') ||
      reqPath === '/robots.txt' ||
      reqPath === '/sitemap.xml' ||
      reqPath === '/manifest.json';
    if (isLibrarySubdomain && !passThrough) {
      const url = req.nextUrl.clone();
      url.pathname = `/library${reqPath === '/' ? '' : reqPath}`;
      return NextResponse.rewrite(url);
    }
  }

  // Generate nonce for CSP - must be forwarded as a REQUEST header so
  // server components (layout.tsx) can read it via headers(). Setting it
  // only on the response headers is not visible to server components.
  const nonce = generateNonce();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  // Also set on response so it can be inspected during debugging
  res.headers.set('x-nonce', nonce);

  // --- Path traversal protection ---
  // Block any request with path traversal patterns in the URL
  const rawUrl = req.url;
  const pathname = req.nextUrl.pathname;
  // Static template previews must be embeddable by the same-origin library
  // detail page (DeferredPreviewFrame), so relax frame-ancestors/X-Frame-Options
  // to 'self'/SAMEORIGIN for /preview/* only — everything else stays locked.
  // The client editor renders the tenant's site in a same-origin iframe from
  // /api/client/site/<id>/preview; without this exception the response is
  // stamped frame-ancestors 'none' and every client sees a blank pane.
  // Local concierge previews are proxied under
  // /api/discovery/preview/live/frame/<demoId> for the same reason: the
  // wizard is often HTTPS while astro is HTTP loopback.
  const frameable =
    pathname.startsWith('/preview') ||
    /^\/api\/client\/site\/[0-9a-f-]{36}\/preview(?:\/|$)/i.test(pathname) ||
    /^\/api\/discovery\/preview\/live\/frame\/[0-9a-f-]{36}(?:\/|$)/i.test(
      pathname
    );

  // Check for path traversal patterns (including URL-encoded variants)
  const pathTraversalPatterns = [
    /\.\.\//g, // ../
    /\.\.%2[Ff]/gi, // URL-encoded ../
    /%2[Ee]%2[Ee]%2[Ff]/gi, // Double URL-encoded
    /\.\.[\\/]/g, // ..\ or ../
    /%2[Ee]{2}/gi, // %2E%2E (encoded ..)
  ];

  const hasPathTraversal = pathTraversalPatterns.some(
    (pattern) => pattern.test(rawUrl) || pattern.test(pathname)
  );

  if (hasPathTraversal) {
    logSecurityEventEdge('security.path_traversal_blocked', {
      route: pathname,
      method: req.method,
    });
    const response = NextResponse.json(
      { error: 'Invalid request path', code: 'BAD_REQUEST' },
      { status: 400 }
    );
    applySecurityHeaders(response, nonce);
    return response;
  }

  // --- CORS, Rate limiting, and CSRF for API routes ---
  try {
    const isApi = pathname.startsWith('/api');
    const isWebhook = pathname.startsWith('/api/webhooks');
    const isHealth = pathname.startsWith('/api/health');

    // CORS allowlist
    if (isApi) {
      const origin = req.headers.get('origin') || '';
      const referer = req.headers.get('referer') || '';
      const siteOrigin = req.nextUrl.origin;
      const allowedOrigins = [
        process.env.NEXT_PUBLIC_SITE_URL,
        process.env.NEXT_PUBLIC_APP_URL,
        process.env.NEXT_PUBLIC_VERCEL_URL
          ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
          : undefined,
        // editor.${domain} subdomains are included in getAllowedRedirectOrigins
        // (see @flowstarter/platform-config). No separate EDITOR_URL needed
        // post master-doc realignment.
        ...getAllowedRedirectOrigins(req.headers.get('host') ?? undefined),
      ].filter(Boolean) as string[];
      const isAllowedOrigin = !!origin && allowedOrigins.includes(origin);
      // Standard browser-attested same-origin check: the Origin header must
      // match the request's Host. Origin is browser-set and unspoofable
      // from page JS, so `Origin === <proto>://<Host>` IS same-origin by
      // definition. Works uniformly for localhost dev, LAN/tunnel dev
      // (e.g. http://192.168.x.y, ngrok), and prod — independent of
      // `req.nextUrl.origin`, which in Next dev uses the bind host instead
      // of the request Host and therefore 403s legitimate LAN browsers.
      const host = req.headers.get('host') || '';
      const proto =
        req.headers.get('x-forwarded-proto') ||
        req.nextUrl.protocol.replace(':', '') ||
        'http';
      const hostOrigin = host ? `${proto}://${host}` : '';
      const isSameOrigin =
        (!!origin &&
          (origin === siteOrigin || (!!hostOrigin && origin === hostOrigin))) ||
        referer.startsWith(siteOrigin) ||
        (!!hostOrigin && referer.startsWith(hostOrigin));

      const applyCorsHeaders = (response: NextResponse) => {
        if (isAllowedOrigin) {
          response.headers.set('Access-Control-Allow-Origin', origin);
          response.headers.set('Vary', 'Origin');
          response.headers.set(
            'Access-Control-Allow-Methods',
            'GET,POST,PUT,PATCH,DELETE,OPTIONS'
          );
          response.headers.set(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, X-CSRF-Token'
          );
          response.headers.set('Access-Control-Allow-Credentials', 'true');
        }
      };

      // Preflight handling
      if (req.method === 'OPTIONS') {
        if (!isAllowedOrigin) {
          return new NextResponse(null, { status: 403 });
        }
        const preflight = new NextResponse(null, { status: 204 });
        applyCorsHeaders(preflight);
        applySecurityHeaders(preflight, nonce);
        return preflight;
      }

      // CSRF: rely on same-origin checks; block cross-origin unsafe methods
      // Skip CSRF for team API routes, AI routes, and integration routes (protected by Clerk auth)
      const isTeamApi = pathname.startsWith('/api/admin/');
      const isAiApi = pathname.startsWith('/api/ai/');
      const isAuthApi = pathname.startsWith('/api/auth/'); // Protected by Clerk auth
      const isIntegrationsApi = pathname.startsWith('/api/integrations/'); // Protected by Clerk auth
      const isAnalyticsApi = pathname.startsWith('/api/analytics/'); // Protected by Clerk auth
      // Service-to-service callbacks (the build worker's deploy). A CSRF check
      // asks "did a browser on another site cause this?", and these callers are
      // not browsers: they send no Origin or Referer, so a same-origin test can
      // only ever reject them. Each route authenticates its caller with a shared
      // secret, which is the defence that fits a service.
      const isInternalApi = pathname.startsWith('/api/internal/');
      const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
      if (
        unsafe &&
        !isWebhook &&
        !isInternalApi &&
        !isTeamApi &&
        !isAiApi &&
        !isAuthApi &&
        !isIntegrationsApi &&
        !isAnalyticsApi
      ) {
        if (!isSameOrigin) {
          // Log CSRF block
          logSecurityEventEdge('security.csrf_blocked', {
            route: pathname,
            method: req.method,
          });
          const resp = NextResponse.json(
            { error: 'Forbidden' },
            { status: 403 }
          );
          applyCorsHeaders(resp);
          applySecurityHeaders(resp, nonce);
          return resp;
        }
      }

      // No CSRF cookie needed when relying on same-origin checks

      // Rate limiting and security using Arcjet (skip webhooks/health)
      const hasArcjet = !!process.env.ARCJET_KEY;
      if (hasArcjet && !isWebhook && !isHealth) {
        try {
          const decision = await ajWithRateLimit.protect(req);

          // Check if request is denied
          const blockedResponse = createBlockedResponse(decision);
          if (blockedResponse) {
            // Log security block (rate limit, bot, or shield)
            const reason = decision.reason;
            const eventType = reason.isRateLimit()
              ? 'security.rate_limited'
              : reason.isBot()
              ? 'security.bot_blocked'
              : 'security.shield_blocked';
            logSecurityEventEdge(eventType, { route: pathname });

            applyCorsHeaders(blockedResponse);
            applySecurityHeaders(blockedResponse, nonce);
            return blockedResponse;
          }

          // Add rate limit headers to successful responses
          const rateLimitHeaders = getRateLimitHeaders(decision);
          Object.entries(rateLimitHeaders).forEach(([key, value]) => {
            res.headers.set(key, value);
          });
        } catch (arcjetError) {
          // Fail-open: if Arcjet fails, allow the request through
          console.error('[Arcjet] Error during protection:', arcjetError);
        }
      }

      // Attach CORS headers to normal flow response
      applyCorsHeaders(res);
    }
  } catch {
    // Fail-open for infra issues
  }

  try {
    const existing = req.cookies.get('fs_country')?.value;
    if (!existing) {
      // Prefer platform geo detection when available
      // Fallback to Accept-Language header
      const geoCountry = (req as unknown as { geo?: { country?: string } })?.geo
        ?.country;
      const acceptLanguage = req.headers.get('accept-language') || '';
      const inferred =
        geoCountry ||
        (acceptLanguage.toLowerCase().includes('ro') ? 'RO' : undefined);
      if (inferred) {
        res.cookies.set('fs_country', inferred, {
          path: '/',
          sameSite: 'lax',
          httpOnly: true,
          secure: true,
          maxAge: 60 * 60 * 24 * 30, // 30 days
        });
      }
    }
  } catch {
    // ignore cookie/geo issues
  }

  // Check if user is authenticated and redirect based on role
  if (pathname === '/') {
    try {
      const { userId, sessionClaims } = await auth();
      if (userId) {
        // Reuse the cached resolveRoleEdge helper so the landing page
        // redirect doesn't burn a Clerk Backend API call on every hit.
        const role = await resolveRoleEdge(
          userId,
          sessionClaims as
            | { metadata?: { role?: string }; email?: string }
            | undefined
        );
        const isTeamMember = role === 'team' || role === 'admin';

        // Team users → /admin/dashboard, Clients → /dashboard
        const targetPath = isTeamMember ? '/admin/dashboard' : '/dashboard';

        const url = req.nextUrl.clone();
        url.pathname = targetPath;
        return NextResponse.redirect(url);
      }
    } catch {
      // User not authenticated, continue to landing page
    }
  }

  // Unknown route — not a known app path at all. Let Next.js serve the 404.
  // (Static /preview/* assets also fall through here.)
  if (!isKnownAppRoute(req)) {
    applySecurityHeaders(res, nonce, frameable);
    return res;
  }

  if (isPublicRoute(req)) {
    // If user is already authenticated and trying to access auth pages, redirect to dashboard
    const pathname = req.nextUrl.pathname;
    if (
      pathname.startsWith('/login') ||
      pathname.startsWith('/sign-up') ||
      pathname.startsWith('/admin/login')
    ) {
      try {
        const { userId, sessionClaims } = await auth();
        if (userId) {
          // If there's a safe cross-domain redirect_url, redirect through
          // the transfer-token API route (runs in Node, not Edge).
          const redirectUrl = req.nextUrl.searchParams.get('redirect_url');
          if (redirectUrl) {
            const isSafe = isSafeRedirectUrl(
              redirectUrl,
              req.headers.get('host') ?? undefined
            );
            if (isSafe) {
              try {
                const parsed = new URL(redirectUrl);
                const isCrossDomain =
                  parsed.hostname !==
                  (req.headers.get('host')?.split(':')[0] ?? '');
                if (isCrossDomain) {
                  // Redirect to the transfer-token page route which creates
                  // a Clerk sign-in token and redirects with __clerk_ticket.
                  const transferUrl = req.nextUrl.clone();
                  transferUrl.pathname = '/api/auth/transfer-redirect';
                  transferUrl.searchParams.set('redirect_url', redirectUrl);
                  return NextResponse.redirect(transferUrl);
                }
              } catch {
                // invalid URL — fall through
              }
              return NextResponse.redirect(redirectUrl);
            }
          }

          const url = req.nextUrl.clone();
          const role = await resolveRoleEdge(
            userId,
            sessionClaims as
              | { metadata?: { role?: string }; email?: string }
              | undefined
          );
          const isTeamMember = role === 'team' || role === 'admin';

          // /admin/login: only team members may proceed to /admin/dashboard.
          // Non-admins stay on the page with reason=not_admin so the form can
          // render an error state and offer a sign-out.
          if (pathname.startsWith('/admin/login')) {
            if (isTeamMember) {
              return redirectAuthenticatedTeamFromAdminLogin(req);
            }
            if (req.nextUrl.searchParams.get('reason') !== 'not_admin') {
              url.searchParams.set('reason', 'not_admin');
              return NextResponse.redirect(url);
            }
            // Already on /admin/login?reason=not_admin — fall through and
            // render the page with the rejection state.
          } else {
            url.pathname = isTeamMember ? '/admin/dashboard' : '/dashboard';
            return NextResponse.redirect(url);
          }
        }
      } catch {
        // ignore auth errors for public routes
      }
      // Prevent caching of login/sign-up pages
      res.headers.set(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      );
      res.headers.set('Pragma', 'no-cache');
      res.headers.set('Expires', '0');
    }
    // Apply baseline security headers even on public routes
    applySecurityHeaders(res, nonce, frameable);
    return res;
  }

  // If the route is protected, authenticate the user.
  // For API routes: return 401 JSON response
  // For page routes: redirect to login with return path

  // ── E2E dev bypass — skip Clerk check when secret header present ──────────
  if (process.env.NODE_ENV !== 'production' && process.env.E2E_SECRET) {
    const e2eSecret = req.headers.get('x-e2e-secret');
    if (e2eSecret === process.env.E2E_SECRET) {
      return NextResponse.next();
    }
  }

  // ── Clerk ticket pass-through ─────────────────────────────────────────────
  // Allow __clerk_ticket params through on any page — Clerk JS processes the
  // ticket client-side to establish a session. Redirecting away strips the
  // ticket and the session is never created. The ticket is HMAC-signed by
  // Clerk and single-use, so this is safe.
  if (req.nextUrl.searchParams.has('__clerk_ticket')) {
    return NextResponse.next();
  }

  try {
    const authResult = await auth();
    const userId = authResult?.userId;

    if (!userId) {
      // User is not authenticated
      if (pathname.startsWith('/api')) {
        // For API routes, return 401 JSON response
        logSecurityEventEdge('security.api_unauthorized', {
          route: pathname,
          method: req.method,
        });
        const response = NextResponse.json(
          { error: 'Authentication required', code: 'UNAUTHORIZED' },
          { status: 401 }
        );
        applySecurityHeaders(response, nonce);
        return response;
      }

      // For page routes, redirect to login with explanatory message and return path
      // Team routes → team login, everything else → client login
      const url = req.nextUrl.clone();
      const next = req.nextUrl.pathname + (req.nextUrl.search || '');
      // /new?template= is an operator flow — send to team login
      const isTeamRoute =
        req.nextUrl.pathname.startsWith('/admin/') ||
        (req.nextUrl.pathname === '/new' &&
          req.nextUrl.searchParams.has('template'));
      url.pathname = isTeamRoute ? '/admin/login' : '/login';
      url.searchParams.set('reason', 'unauthenticated');
      url.searchParams.set('next', next);
      return NextResponse.redirect(url);
    }

    // ── Forced password change ────────────────────────────────────────────
    // A client who paid as a guest was given an account with a password WE
    // chose and emailed. Until they replace it, the only app page they can
    // reach is the one that replaces it. Public pages have already returned
    // above, and API routes are exempt so the change itself can be saved.
    //
    // The test is `=== true`, so the moment the flag is cleared a stale session
    // token stops matching and the gate opens; the page refreshes the token
    // itself rather than relying on that.
    const passwordChangePath = forcedPasswordChangeRedirect(
      pathname,
      authResult?.sessionClaims as ForcedPasswordClaims | undefined
    );
    if (passwordChangePath) {
      const url = req.nextUrl.clone();
      url.pathname = passwordChangePath;
      url.search = '';
      return NextResponse.redirect(url);
    }

    // Authenticated /admin/* (page routes only — API routes do their own
    // role checks) requires team-or-admin role. Non-admins get bounced to
    // /admin/login with a rejection notice.
    if (
      pathname.startsWith('/admin/') &&
      !pathname.startsWith('/admin/login') &&
      !pathname.startsWith('/admin/join') &&
      !pathname.startsWith('/api')
    ) {
      const sessionClaims = authResult?.sessionClaims as
        | { metadata?: { role?: string }; email?: string }
        | undefined;
      const role = await resolveRoleEdge(userId, sessionClaims);
      if (role !== 'team' && role !== 'admin') {
        const redirectParam = req.nextUrl.searchParams.get('redirect_url');
        const hostHeader = req.headers.get('host') ?? '';
        const host = hostHeader.split(':')[0] ?? '';

        const url = req.nextUrl.clone();
        url.pathname = '/admin/login';
        url.search = '';
        url.searchParams.set('reason', 'not_admin');
        if (redirectParam && isSafeRedirectUrl(redirectParam, host)) {
          url.searchParams.set('redirect_url', redirectParam);
        }
        const returnTo = pathname + (req.nextUrl.search || '');
        if (
          returnTo.startsWith('/admin/') &&
          !returnTo.startsWith('/admin/login') &&
          !returnTo.startsWith('/admin/join')
        ) {
          url.searchParams.set('next', returnTo);
        }
        return NextResponse.redirect(url);
      }
    }

    // User is authenticated, allow the request
    applySecurityHeaders(res, nonce);
    return res;
  } catch (authError) {
    // If auth check fails, block the request for safety
    console.error('[Middleware] Auth error:', authError);
    if (pathname.startsWith('/api')) {
      const response = NextResponse.json(
        { error: 'Authentication failed', code: 'UNAUTHORIZED' },
        { status: 401 }
      );
      applySecurityHeaders(response, nonce);
      return response;
    }
    // For page routes, redirect to login
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('reason', 'error');
    return NextResponse.redirect(url);
  }
});

export const config = {
  matcher: [
    // Run middleware on app routes EXCEPT static assets, Next.js internals,
    // and common static files. The narrower the matcher, the fewer cold-start
    // function invocations we pay on a fresh deploy.
    '/((?!_next/static|_next/image|_next/data|favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest\\.json|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|css|js|map|woff|woff2|ttf|otf|eot|mp4|webm)).*)',
    '/api/:path*',
  ],
};
