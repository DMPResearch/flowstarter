/**
 * Where the app itself is publicly reachable, as two separate questions.
 *
 * `resolvePlatformDomain()` answers "which DNS zone does this environment
 * mint hostnames under" — `flowstarter.net` or `flowstarter.dev` — and every
 * generated *client* site hangs off that zone at `{slug}.{domain}`. Two call
 * sites quietly assumed that was also the answer to "where does the app
 * itself answer requests", and were wrong everywhere that assumption did not
 * happen to hold:
 *
 *   - `leadCaptureEndpoint()` built `https://{siteRootDomain()}/api/leads/...`,
 *     which resolves to the bare `flowstarter.dev` apex in development and on
 *     the shared staging box. Nothing answers there outside production — the
 *     staging app lives at `staging.flowstarter.dev`, a developer's app lives
 *     on localhost — so a client site built from a dev or staging stack
 *     posted every enquiry into a 404.
 *   - The Cal.com booking page printed its webhook subscriber URL, and the
 *     self-hosted Cal provisioning webhook was registered, from
 *     `NEXT_PUBLIC_SITE_URL`, which on a laptop is a LAN address Cal.com's
 *     servers cannot reach.
 *
 * `publicAppOrigin()` is the one rule for "where is the app": an explicit
 * override first, then the shape every environment in this codebase already
 * agrees the app takes — the bare domain in production, `staging.` in front
 * of it in staging (matching `deploy/hetzner-staging`), and whatever the
 * developer's own machine says otherwise (`NEXT_PUBLIC_SITE_URL`, or
 * `localhost` on its own port when even that is unset).
 *
 * `publicCallbackOrigin()` answers a narrower question for a narrower
 * audience: where must a *third party's servers* — Cal.com's webhook
 * delivery, never Stripe, which is handed a URL rather than asked to reach
 * one on its own — be able to send a request. It defaults to the app origin,
 * which is right everywhere that origin is itself reachable from the
 * internet, and is overridable on its own so a developer can put a tunnel in
 * front of a laptop without changing where the app tells a human visitor, or
 * a CSP header, that it lives.
 *
 * Both are pure. Every input is a field on the env record, never a live
 * `process.env` read buried in a branch, so a test can describe an
 * environment it is not running in and a caller elsewhere in the monorepo
 * (the build worker included) can pass its own validated env instead of
 * trusting the ambient process.
 */
import { resolvePlatformDomain } from './index';

/** Overrides where the app is publicly served, in full. */
export const PUBLIC_APP_ORIGIN_ENV = 'FLOWSTARTER_PUBLIC_APP_ORIGIN';
/** Overrides where a third party's servers must reach the app. */
export const PUBLIC_CALLBACK_ORIGIN_ENV = 'FLOWSTARTER_PUBLIC_CALLBACK_ORIGIN';

export interface PublicOriginEnvInput {
  /** `FLOWSTARTER_ENV`. Authoritative when set. */
  readonly flowstarterEnv?: string;
  /** `NODE_ENV`. Consulted only when `flowstarterEnv` is absent. */
  readonly nodeEnv?: string;
  /** `PLATFORM_DOMAIN` / `NEXT_PUBLIC_PLATFORM_DOMAIN`. */
  readonly platformDomain?: string;
  /** `FLOWSTARTER_PUBLIC_APP_ORIGIN`. Wins outright when set. */
  readonly publicAppOrigin?: string;
  /** `FLOWSTARTER_PUBLIC_CALLBACK_ORIGIN`. Wins outright when set. */
  readonly publicCallbackOrigin?: string;
  /** `NEXT_PUBLIC_SITE_URL`, the development-only fallback. */
  readonly siteUrl?: string;
  /** `PORT`, the floor beneath that: `http://localhost:{PORT}`. */
  readonly port?: string;
}

function readProcessEnvVar(key: string): string | undefined {
  return typeof process !== 'undefined' ? process.env[key] : undefined;
}

/** Reads every field above from the real environment. */
export function readPublicOriginEnvFromProcess(): PublicOriginEnvInput {
  return {
    flowstarterEnv: readProcessEnvVar('FLOWSTARTER_ENV'),
    nodeEnv: readProcessEnvVar('NODE_ENV'),
    platformDomain:
      readProcessEnvVar('PLATFORM_DOMAIN') ||
      readProcessEnvVar('NEXT_PUBLIC_PLATFORM_DOMAIN'),
    publicAppOrigin: readProcessEnvVar(PUBLIC_APP_ORIGIN_ENV),
    publicCallbackOrigin: readProcessEnvVar(PUBLIC_CALLBACK_ORIGIN_ENV),
    siteUrl: readProcessEnvVar('NEXT_PUBLIC_SITE_URL'),
    port: readProcessEnvVar('PORT'),
  };
}

type EnvironmentKind = 'development' | 'staging' | 'production';

/**
 * The same three-way split `resolveFlowstarterEnv()` (the app) and
 * `isDevelopmentEnvironment()` (`auth-transfer-policy.ts`, this package)
 * already make: `FLOWSTARTER_ENV` is authoritative when it names one of the
 * three, staging can only ever be named explicitly (it runs with
 * `NODE_ENV=production`, like a real production build, precisely so that it
 * cannot be told apart from one by `NODE_ENV` alone), and anything else —
 * `development`, `test`, unset, or a value nobody recognises — is treated as
 * development. That is the side of this line where guessing wrong is merely
 * inconvenient, rather than a lead posted into the void or a credential
 * handed to a host nobody runs.
 */
function resolveEnvironmentKind(env: PublicOriginEnvInput): EnvironmentKind {
  if (env.flowstarterEnv === 'staging') return 'staging';
  if (env.flowstarterEnv === 'production') return 'production';
  if (env.flowstarterEnv) return 'development';
  return env.nodeEnv === 'production' ? 'production' : 'development';
}

const SLASH_CHAR_CODE = '/'.charCodeAt(0);

/**
 * Trims one or more trailing `/` off an already-trimmed string, with a plain
 * index walk rather than a regex.
 *
 * `value` here is env-controlled input (`FLOWSTARTER_PUBLIC_APP_ORIGIN`,
 * `NEXT_PUBLIC_SITE_URL`, ...), not attacker-controlled in the way a request
 * body is, but CodeQL still flags a `/\/+$/`-shaped pattern as a polynomial
 * regex over "library input" (js/polynomial-redos) wherever the string it
 * runs against is not provably bounded. A bounded loop has no backtracking
 * to be slow in the first place, so it settles the question rather than
 * arguing that this particular input happens to be short.
 */
function stripTrailingSlash(value: string): string {
  const trimmed = value.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === SLASH_CHAR_CODE) {
    end -= 1;
  }
  return trimmed.slice(0, end);
}

/**
 * Where the app is publicly served, as an origin (`https://host`, no path,
 * no trailing slash).
 *
 * `FLOWSTARTER_PUBLIC_APP_ORIGIN` always wins outright — the one case none of
 * the three environment guesses covers on its own, such as a PR staging slot
 * answering at `pr-7.staging.{domain}` rather than its environment's default
 * subdomain.
 */
export function publicAppOrigin(
  env: PublicOriginEnvInput = readPublicOriginEnvFromProcess(),
): string {
  const override = env.publicAppOrigin?.trim();
  if (override) return stripTrailingSlash(override);

  const kind = resolveEnvironmentKind(env);
  const domain = resolvePlatformDomain({
    override: env.platformDomain,
    flowstarterEnv: env.flowstarterEnv,
    nodeEnv: env.nodeEnv,
  });

  if (kind === 'production') return `https://${domain}`;
  if (kind === 'staging') return `https://staging.${domain}`;

  const siteUrl = env.siteUrl?.trim();
  if (siteUrl) return stripTrailingSlash(siteUrl);

  const port = env.port?.trim() || '3000';
  return `http://localhost:${port}`;
}

/**
 * Where a third party's servers must be able to reach this app — Cal.com's
 * webhook delivery and the self-hosted Cal provisioning webhook. Stripe is
 * deliberately not this: it is handed a URL to verify a signature against, it
 * never has to dial back in on its own.
 *
 * Defaults to `publicAppOrigin()`, which is right everywhere that origin is
 * itself reachable from the internet (production, staging).
 * `FLOWSTARTER_PUBLIC_CALLBACK_ORIGIN` overrides it for the one case it is
 * not — a developer's laptop, whose app origin is `localhost` or a LAN
 * address Cal.com cannot reach, and who has put a tunnel in front of it.
 */
export function publicCallbackOrigin(
  env: PublicOriginEnvInput = readPublicOriginEnvFromProcess(),
): string {
  const override = env.publicCallbackOrigin?.trim();
  if (override) return stripTrailingSlash(override);
  return publicAppOrigin(env);
}
