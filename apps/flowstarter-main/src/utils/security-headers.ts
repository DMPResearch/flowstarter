import { calEmbedOrigins, publicAppOrigin } from '@flowstarter/platform-config';
import { previewZone } from '@/lib/hosting/site-hostnames';
import { createSecureHeaders } from 'next-secure-headers';
import { NextResponse } from 'next/server';

/**
 * Security Headers Configuration
 *
 * CSP Strategy:
 * - We use 'strict-dynamic' with nonces for scripts (Next.js generates nonces automatically)
 * - 'unsafe-inline' is kept for styles due to CSS-in-JS limitations, but with strict source restrictions
 * - All external resources are explicitly allowlisted
 */

// Allowed external domains
const ALLOWED_SCRIPT_DOMAINS = [
  "'self'",
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
  'https://*.clerk.accounts.dev',
  // Cal.com booking widget used inside Astro template previews
  'https://app.cal.com',
  'https://cal.com',
  publicAppOrigin(),
];

/**
 * Every origin a booking calendar may be served from in this deployment.
 *
 * Read per call, not frozen at import: `CAL_BASE_URL` is a deployment's own
 * setting, and a module-level constant would bake whatever it was at the
 * moment Next.js first loaded this file into every response for the life of
 * the process. `calEmbedOrigins` keeps the hosted cal.com entries and adds the
 * self-hosted instance, so the funnel's discovery-call embed renders wherever
 * the funnel's own `bookingUrl` points.
 */
function calOrigins(): string[] {
  return calEmbedOrigins({
    CAL_BASE_URL: process.env.CAL_BASE_URL,
    DMPRESEARCH_DISCOVERY_CAL_URL: process.env.DMPRESEARCH_DISCOVERY_CAL_URL,
  });
}

const ALLOWED_CONNECT_DOMAINS = [
  "'self'",
  // Supabase
  'https://*.supabase.co',
  'wss://*.supabase.co',
  // Clerk
  'https://api.clerk.com',
  'https://api.clerk.dev',
  'https://*.clerk.accounts.dev',
  // Google Analytics
  'https://www.google-analytics.com',
  'https://analytics.google.com',
  // Clerk telemetry
  'https://clerk-telemetry.com',
];

const ALLOWED_IMG_DOMAINS = [
  "'self'",
  'data:',
  'blob:',
  'https://*.supabase.co',
  'https://*.supabase.com',
  'https://images.unsplash.com',
  'https://*.unsplash.com',
  'https://img.clerk.com',
  'https://img.clerk.dev',
  'https://*.clerk.com',
  'https://*.clerk.dev',
  'https://www.google-analytics.com',
  // Template thumbnails served from Cloudflare R2
  'https://assets.flowstarter.dev',
  // Avatar placeholders in the Dorin portfolio template demo testimonials
  'https://i.pravatar.cc',
];

const ALLOWED_FONT_DOMAINS = ["'self'", 'https://fonts.gstatic.com', 'data:'];

/**
 * In dev, allow browser calls to the same machine on a LAN IP when the app's
 * own origin (`publicAppOrigin()`) or `NEXT_PUBLIC_EDITOR_URL` point at
 * http://192.168.x.x:…
 */
function devHttpWsConnectSrcExtras(): string {
  const urls = [publicAppOrigin(), process.env.NEXT_PUBLIC_EDITOR_URL];
  const parts: string[] = [];
  for (const raw of urls) {
    const u = raw?.trim();
    if (!u?.startsWith('http')) continue;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      parts.push(parsed.origin);
      const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      parts.push(`${wsProto}//${parsed.host}`);
    } catch {
      /* skip */
    }
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * `frame-src`, as a function rather than a constant.
 *
 * Two of its entries are derived from environment (`previewZone()` and
 * `calOrigins()`), and a constant evaluated at import time would freeze both
 * at whatever the first module load saw.
 */
function allowedFrameDomains(): string[] {
  return [
    // Same-origin so the library detail page can embed the static template
    // previews at /preview/<slug>/ (DeferredPreviewFrame). Without 'self' the
    // parent page's frame-src blocks the iframe even though the preview itself
    // allows being framed (frame-ancestors 'self').
    "'self'",
    'https://accounts.google.com', // Google OAuth
    'https://*.clerk.accounts.dev', // Clerk OAuth
    'https://challenges.cloudflare.com', // Turnstile if used
    'https://calendly.com', // Calendly inline embed
    // Every Cal.com this deployment can frame: the hosted cal.com the Astro
    // templates embed a client's own booking link from, plus whatever
    // CAL_BASE_URL / DMPRESEARCH_DISCOVERY_CAL_URL resolve to. Derived, so the
    // discovery-call embed on the funnel's custom work branch renders at the
    // same origin the gate's own `bookingUrl` points at instead of showing
    // "This content is blocked".
    ...calOrigins(),
    // Library "Live template" iframes for shipped client work. The detail
    // page at /library/templates/<slug> renders the client's live site
    // when the entry sets `externalPreviewUrl`. Each origin must be
    // allowlisted explicitly here or the browser will block the frame
    // under our own CSP (the client site can ALSO block framing via its
    // own X-Frame-Options / frame-ancestors — that we can't override).
    'https://ux-journey.com',
    'https://lebadusularticoledepescuit.ro',
    // OpenStreetMap embed used by the Dorin portfolio template contact map
    'https://www.openstreetmap.org',
    // Concierge discovery funnel (step 7): the live preview embeds the
    // generated site. Since previews moved onto Flowstarter's own platform
    // that is `https://<slug>.preview.<platform domain>`, derived from the
    // same `previewZone()` rule the publisher mints the hostname with rather
    // than written out twice — a literal here would be wrong in exactly one
    // environment and blank the wizard's iframe there.
    `https://*.${previewZone()}`,
    // The Daytona publisher is still selectable by name
    // (FLOWSTARTER_PREVIEW_PUBLISHER=daytona), and it frames
    // https://<port>-<sandboxId>.daytonaproxy01.net — without this the browser
    // blocks the frame under our own CSP and the preview stays permanently
    // blank.
    'https://*.daytonaproxy01.net',
  ];
}

// Create headers without CSP (we'll add it dynamically with nonce).
//
// `createSecureHeaders` returns an ARRAY of `{ key, value }` pairs, not a
// record. Walking it with `Object.entries` produced headers literally named
// "0" through "5" whose value was the string "[object Object]", so neither
// `Referrer-Policy` nor the 730-day HSTS below ever reached a browser. The
// loop in `applySecurityHeaders` reads `entry.key` / `entry.value` instead.
const baseHeaders: { key: string; value: string }[] = createSecureHeaders({
  forceHTTPSRedirect: [
    true,
    { maxAge: 60 * 60 * 24 * 730, includeSubDomains: true },
  ],
  referrerPolicy: 'strict-origin-when-cross-origin',
  frameGuard: 'deny',
  nosniff: 'nosniff',
});

/**
 * Build CSP header value
 * @param nonce - Optional nonce for inline scripts (generated per-request)
 */
export function buildCSPHeader(nonce?: string, frameable = false): string {
  const isDev = process.env.NODE_ENV === 'development';
  // `nonce` is intentionally unused for script-src — see below.
  void nonce;

  // In development, use relaxed CSP to allow Next.js hot reload and dev scripts.
  //
  // In production we use `'unsafe-inline'` + a host allowlist for scripts —
  // NOT a per-request nonce. The middleware regenerates a fresh nonce on every
  // request and writes it into the CSP header, but flowstarter.net's pages are
  // statically rendered + CDN-cached (cache HIT, max-age=300), so the cached
  // HTML carries a *build-time* nonce on its <script> tags. The per-request
  // header nonce therefore never matches the cached script nonce → every
  // inline script is blocked → blank page. Dropping the nonce (browsers ignore
  // 'unsafe-inline' whenever a nonce is also present) lets the cached inline
  // bootstrap scripts run. The host allowlist still constrains third-party
  // script sources; we also do NOT emit 'strict-dynamic' (it would block
  // Clerk's nonce-less external SDK <script src> and break auth).
  const scriptSrc = isDev
    ? ["'self'", "'unsafe-inline'", "'unsafe-eval'", ...ALLOWED_SCRIPT_DOMAINS]
    : ["'self'", "'unsafe-inline'", ...ALLOWED_SCRIPT_DOMAINS];

  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    `worker-src 'self' blob:`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`, // CSS-in-JS requires unsafe-inline
    `img-src ${ALLOWED_IMG_DOMAINS.join(' ')}`,
    // The Cal.com embed script fetches its own availability from the instance
    // it is framed from, so an origin allowed in `frame-src` and refused here
    // renders an empty calendar rather than a blocked one, which is the
    // harder failure to recognise.
    `connect-src ${[...ALLOWED_CONNECT_DOMAINS, ...calOrigins()].join(' ')}${
      isDev
        ? `${devHttpWsConnectSrcExtras()} ws://localhost:* http://localhost:*`
        : ''
    }`,
    `font-src ${ALLOWED_FONT_DOMAINS.join(' ')}`,
    // FLOWSTARTER_LOCAL_PREVIEW serves the generated site from a local
    // `astro dev` on its own port — a different origin than 'self', so
    // without this the browser blocks the wizard's preview iframe exactly
    // like the un-allowlisted Daytona case: an empty white frame whose
    // `load` event still fires (which is why the skeleton got out of its
    // way). Dev-only by construction; the env flag is never set in prod.
    `frame-src ${allowedFrameDomains().join(' ')}${
      isDev && process.env.FLOWSTARTER_LOCAL_PREVIEW === 'true'
        ? ' http://127.0.0.1:* http://localhost:*'
        : ''
    }`,
    // Static template previews under /preview/* must be embeddable by the
    // same-origin library detail page; everything else stays 'none' to block
    // clickjacking.
    `frame-ancestors ${frameable ? "'self'" : "'none'"}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    // Only upgrade insecure requests when the site is actually served over HTTPS.
    // Staging / LAN access over plain HTTP would break all sub-resource loads
    // because the browser would silently rewrite http→https.
    !isDev && publicAppOrigin().startsWith('https://')
      ? 'upgrade-insecure-requests'
      : '',
  ].filter(Boolean);

  return directives.join('; ');
}

/**
 * Apply security headers to a NextResponse
 * @param response - The NextResponse to modify
 * @param nonce - Optional nonce for CSP (when available from Next.js)
 */
export function applySecurityHeaders(
  response: NextResponse,
  nonce?: string,
  frameable = false
) {
  // Apply base headers. `createSecureHeaders` hands back an array of
  // `{ key, value }` pairs; iterate the pairs, never `Object.entries`.
  for (const { key, value } of baseHeaders) {
    if (key && value !== undefined && value !== null) {
      response.headers.set(key, String(value));
    }
  }

  // Apply CSP with nonce if provided
  response.headers.set(
    'Content-Security-Policy',
    buildCSPHeader(nonce, frameable)
  );

  // Additional security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN (not DENY) for framable previews so the library detail page can
  // embed /preview/* from the same origin; DENY everywhere else.
  response.headers.set('X-Frame-Options', frameable ? 'SAMEORIGIN' : 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
}

/**
 * Get CSP header for use in Next.js metadata
 * This is for the static CSP without nonces
 */
export function getStaticCSPHeader(): string {
  return buildCSPHeader();
}
