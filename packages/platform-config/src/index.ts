/**
 * @flowstarter/platform-config
 *
 * Shared platform domain and URL configuration.
 *
 * All domain logic derives from the current hostname or environment variables —
 * no domain strings are hardcoded. To run the platform on a new domain,
 * set PLATFORM_DOMAIN (e.g. "flowstarter.app") and everything adapts.
 *
 * The domain a running process mints hostnames under is decided by
 * environment, not by hand: `resolvePlatformDomain` below is the one place
 * that decides `flowstarter.net` (production) vs `flowstarter.dev`
 * (development, test, staging, or anything else it does not recognise).
 * Every preview subdomain, staging URL template and cookie domain the
 * platform mints derives from it, directly or through `getPlatformDomain`,
 * so the two zones can never drift out of step with each other.
 */

// ---------------------------------------------------------------------------
// Browser hostname (no `dom` lib required)
// ---------------------------------------------------------------------------

/**
 * `window.location.hostname`, or undefined outside a browser.
 *
 * Written as a `globalThis` property access rather than the bare `window`
 * identifier so this file type-checks under consumers that build without the
 * `dom` lib (the build worker, the deploy-agent): those never run in a
 * browser, so `window` genuinely does not exist there, and referencing the
 * ambient `Window` type would make this whole module fail to compile for
 * them the moment they import anything from it.
 */
function browserHostname(): string | undefined {
  const win = (globalThis as { window?: { location?: { hostname?: string } } })
    .window;
  return win?.location?.hostname;
}

// ---------------------------------------------------------------------------
// Core: extract the root domain from any hostname
// ---------------------------------------------------------------------------

/**
 * Extracts the root domain (e.g. "flowstarter.dev") from a hostname.
 * Returns undefined for localhost / IP addresses.
 *
 * Examples:
 *   "code.flowstarter.dev"  → "flowstarter.dev"
 *   "flowstarter.app"       → "flowstarter.app"
 *   "localhost"              → undefined
 */
function isIpv4DottedQuad(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * True for bracketed or unbracketed IPv6-looking hostnames (not domain names).
 */
function isLikelyIpLiteral(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (h.startsWith('[')) return true;
  if (isIpv4DottedQuad(h)) return true;
  // Unbracketed IPv6 contains colons without dots-as-TLD ambiguity
  if (h.includes(':') && !h.includes('.')) return true;
  return false;
}

export function getRootDomain(hostname: string): string | undefined {
  const normalized = hostname.trim().toLowerCase();

  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    hostname.startsWith('[')
  ) {
    return undefined;
  }

  if (isLikelyIpLiteral(normalized)) {
    return undefined;
  }

  const parts = hostname.split('.');
  if (parts.length < 2) return undefined;

  // Take the last two segments (covers .dev, .app, .com, etc.)
  return parts.slice(-2).join('.');
}

// ---------------------------------------------------------------------------
// Resolve the platform domain
// ---------------------------------------------------------------------------

/** The two live DNS zones. Never a third one, and never picked by hand. */
const PRODUCTION_PLATFORM_DOMAIN = 'flowstarter.net';
const DEFAULT_PLATFORM_DOMAIN = 'flowstarter.dev';

function readProcessEnvVar(key: string): string | undefined {
  return typeof process !== 'undefined' ? process.env[key] : undefined;
}

/** `PLATFORM_DOMAIN`, else `NEXT_PUBLIC_PLATFORM_DOMAIN`, from real env. */
function readPlatformDomainOverrideFromEnv(): string | undefined {
  return (
    readProcessEnvVar('PLATFORM_DOMAIN') ||
    readProcessEnvVar('NEXT_PUBLIC_PLATFORM_DOMAIN') ||
    undefined
  );
}

export interface ResolvePlatformDomainInput {
  /**
   * The app's own environment name (`development` | `test` | `staging` |
   * `production`, e.g. from `resolveFlowstarterEnv()`). Authoritative when
   * given: only an exact `"production"` mints the production zone. Any other
   * value, including one this does not recognise, mints the dev zone.
   */
  flowstarterEnv?: string;
  /** Falls back to this when `flowstarterEnv` is not given. */
  nodeEnv?: string;
  /** Wins over both, when set. Usually `PLATFORM_DOMAIN` from the caller. */
  override?: string;
}

/**
 * The one place that decides which of the two live zones a process mints
 * hostnames under: `flowstarter.net` for production, `flowstarter.dev` for
 * everything else (development, test, staging, or an environment value
 * this does not recognise).
 *
 * Called with no arguments, it reads `PLATFORM_DOMAIN` /
 * `NEXT_PUBLIC_PLATFORM_DOMAIN`, `FLOWSTARTER_ENV` and `NODE_ENV` straight
 * from `process.env`, which is what every call site in this app wants: the
 * process's own environment decides its own domain. Pass explicit fields
 * (as the build worker does, since it validates a caller-supplied `env`
 * object rather than trusting `process.env` directly) to make the decision
 * a pure function of those fields instead.
 */
export function resolvePlatformDomain(
  input: ResolvePlatformDomainInput = {
    override: readPlatformDomainOverrideFromEnv(),
    flowstarterEnv: readProcessEnvVar('FLOWSTARTER_ENV'),
    nodeEnv: readProcessEnvVar('NODE_ENV'),
  },
): string {
  if (input.override) return input.override;

  const isProduction = input.flowstarterEnv
    ? input.flowstarterEnv === 'production'
    : input.nodeEnv === 'production';

  return isProduction ? PRODUCTION_PLATFORM_DOMAIN : DEFAULT_PLATFORM_DOMAIN;
}

/**
 * Resolves the platform's root domain from (in priority order):
 *   1. `PLATFORM_DOMAIN` env var (or `NEXT_PUBLIC_PLATFORM_DOMAIN`)
 *   2. `VITE_PLATFORM_DOMAIN`, in a Vite-bundled app
 *   3. The current hostname (browser or request): what the process is
 *      actually being reached on always wins over a guess
 *   4. `resolvePlatformDomain()`, meaning `flowstarter.net` in production
 *      and `flowstarter.dev` otherwise
 */
export function getPlatformDomain(hostname?: string): string {
  // Check env vars (works in Node & Vite)
  const envDomain = readPlatformDomainOverrideFromEnv();
  if (envDomain) return envDomain;

  // Vite env (safe access to avoid TS issues across bundlers)
  try {
    const meta: { env?: Record<string, string | undefined> } =
      import.meta as unknown as { env?: Record<string, string | undefined> };
    if (meta.env?.VITE_PLATFORM_DOMAIN) return meta.env.VITE_PLATFORM_DOMAIN;
  } catch {
    // Not in a Vite context
  }

  // Derive from hostname
  const host = hostname ?? browserHostname();

  if (host) {
    const root = getRootDomain(host);
    if (root) return root;
  }

  return resolvePlatformDomain();
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

/** Main platform URL: `https://flowstarter.dev` */
export function getMainUrl(hostname?: string): string {
  return `https://${getPlatformDomain(hostname)}`;
}

/** Subdomain URL: `https://code.flowstarter.dev` */
export function getSubdomainUrl(sub: string, hostname?: string): string {
  return `https://${sub}.${getPlatformDomain(hostname)}`;
}

/** Team login URL with optional redirect */
export function getTeamLoginUrl(
  redirectUrl?: string,
  hostname?: string,
): string {
  const base = `${getMainUrl(hostname)}/admin/login`;
  if (!redirectUrl) return base;
  const url = new URL(base);
  url.searchParams.set('redirect_url', redirectUrl);
  return url.toString();
}

/** Client login URL */
export function getLoginUrl(hostname?: string): string {
  return `${getMainUrl(hostname)}/login`;
}

// ---------------------------------------------------------------------------
// Cookie domain
// ---------------------------------------------------------------------------

/**
 * Returns the shared cookie domain (e.g. `.flowstarter.dev`)
 * for cross-subdomain session sharing.
 * Returns undefined for localhost.
 */
export function getSharedCookieDomain(hostname?: string): string | undefined {
  const host = hostname ?? browserHostname();

  if (!host) return undefined;

  const root = getRootDomain(host);
  return root ? `.${root}` : undefined;
}

/**
 * Server-side variant: extracts cookie domain from a request URL string.
 */
export function getSharedCookieDomainFromUrl(requestUrl: string): string | undefined {
  try {
    return getSharedCookieDomain(new URL(requestUrl).hostname);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Dev / LAN redirect origins (explicit env — never a hostname wildcard)
// ---------------------------------------------------------------------------

type RedirectEnvSource = Record<string, string | undefined>;

function readRedirectEnv(): RedirectEnvSource {
  if (typeof process === 'undefined' || !process.env) return {};
  return process.env;
}

const DEV_REDIRECT_URL_ENV_KEYS = [
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_EDITOR_URL',
] as const;

const EXTRA_REDIRECT_ORIGINS_ENV = 'NEXT_PUBLIC_EXTRA_REDIRECT_ORIGINS';

/**
 * Absolute origins (scheme + host + port) parsed from env. Used for Clerk
 * `allowedRedirectOrigins`, CORS allowlists, and `isSafeRedirectUrl` when you
 * dev from a LAN host (e.g. iPad → `http://192.168.x.x:3000`).
 *
 * Sources: `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_EDITOR_URL`,
 * plus comma-separated `NEXT_PUBLIC_EXTRA_REDIRECT_ORIGINS`.
 * Clerk Dashboard must still list the same origins for satellite flows.
 */
export function collectDevRedirectOriginsFromEnv(
  env: RedirectEnvSource = readRedirectEnv(),
): string[] {
  const origins = new Set<string>();
  for (const key of DEV_REDIRECT_URL_ENV_KEYS) {
    const raw = env[key]?.trim();
    if (!raw?.startsWith('http')) continue;
    try {
      origins.add(new URL(raw).origin);
    } catch {
      /* skip malformed */
    }
  }
  const csv = env[EXTRA_REDIRECT_ORIGINS_ENV]?.trim();
  if (csv) {
    for (const piece of csv.split(',')) {
      const t = piece.trim();
      if (!t.startsWith('http')) continue;
      try {
        origins.add(new URL(t).origin);
      } catch {
        /* skip */
      }
    }
  }
  return Array.from(origins);
}

function trustedDevRedirectHostnamesFromEnv(
  env: RedirectEnvSource = readRedirectEnv(),
): Set<string> {
  const hosts = new Set<string>();
  for (const o of collectDevRedirectOriginsFromEnv(env)) {
    try {
      hosts.add(new URL(o).hostname.toLowerCase());
    } catch {
      /* skip */
    }
  }
  return hosts;
}

// ---------------------------------------------------------------------------
// Trust checks
// ---------------------------------------------------------------------------

/**
 * Returns true if the hostname belongs to the same platform.
 * Works for any domain — no hardcoded list.
 *
 * Checks:
 *   - Same root domain as current platform
 *   - Localhost (always trusted in dev)
 *   - Hostnames appearing in `NEXT_PUBLIC_*` / `NEXT_PUBLIC_EXTRA_REDIRECT_ORIGINS`
 *     (so LAN IP dev matches any port you configured in those URLs)
 */
export function isTrustedHost(
  hostname: string,
  currentHostname?: string,
): boolean {
  const hn = hostname.trim().toLowerCase();
  if (hn === 'localhost' || hn === '127.0.0.1') return true;

  if (typeof process !== 'undefined' && trustedDevRedirectHostnamesFromEnv().has(hn)) {
    return true;
  }

  const platformDomain = getPlatformDomain(currentHostname);
  const targetRoot = getRootDomain(hostname);

  return targetRoot === platformDomain;
}

/**
 * Validates that a redirect URL is safe (same platform or localhost).
 */
export function isSafeRedirectUrl(
  url: string,
  currentHostname?: string,
): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (collectDevRedirectOriginsFromEnv().includes(parsed.origin)) {
      return true;
    }
    return isTrustedHost(parsed.hostname, currentHostname);
  } catch {
    return false;
  }
}

/**
 * Returns true if running on a deployed platform domain (not localhost).
 */
export function isDeployedHost(hostname?: string): boolean {
  const host = hostname ?? browserHostname();

  if (!host) return false;
  return getRootDomain(host) !== undefined;
}

// ---------------------------------------------------------------------------
// Team email domains
// ---------------------------------------------------------------------------

/**
 * Returns the list of email domains considered "internal team".
 * Derives from the platform domain + common TLD variants.
 */
export function getTeamEmailDomains(hostname?: string): string[] {
  const root = getPlatformDomain(hostname);
  const base = root.split('.')[0]; // e.g. "flowstarter"

  // Include common TLD variants for the same brand
  const tlds = ['app', 'dev', 'com', 'net'];
  return tlds.map((tld) => `${base}.${tld}`);
}

/**
 * Returns true if the email belongs to an internal team domain.
 */
export function isTeamEmail(
  email: string | null | undefined,
  hostname?: string,
): boolean {
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return getTeamEmailDomains(hostname).includes(domain);
}

// ---------------------------------------------------------------------------
// Allowed redirect origins (for Clerk, CORS, etc.)
// ---------------------------------------------------------------------------

/**
 * Returns the list of allowed redirect origins for auth providers.
 * Includes common subdomains + localhost for dev, plus any origins from
 * `collectDevRedirectOriginsFromEnv()` (LAN / alternate dev hosts).
 */
export function getAllowedRedirectOrigins(hostname?: string): string[] {
  const domain = getPlatformDomain(hostname);
  const base = [
    `https://${domain}`,
    `https://code.${domain}`,
    `https://editor.${domain}`,
    `https://library.${domain}`,
    'http://localhost:3000',
    'http://localhost:3100',
    'http://localhost:5173',
    'http://localhost:5733',
    'http://localhost:5773',
  ];
  const extra = collectDevRedirectOriginsFromEnv();
  return Array.from(new Set([...base, ...extra]));
}
