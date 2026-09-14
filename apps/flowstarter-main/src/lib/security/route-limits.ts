import 'server-only';
import type { NextRequest } from 'next/server';
import { slidingWindow, type ArcjetDecision } from '@arcjet/next';
import { aj } from '@/lib/arcjet';
import {
  SlidingWindowRateLimiter,
  consumeRateLimit,
  namedIntEnv,
  upstashCredentials,
} from '@/lib/rate-limit';

/**
 * The shape every route's Arcjet client is narrowed to once
 * `aj.withRule(...)` has added its per-route rule. The SDK's own return type
 * is a generic whose `protect()` tuple arity depends on which characteristics
 * were declared (zero args for the built-in `ip.src`, one props object for a
 * custom characteristic like `email`/`token`) — awkward to carry through a
 * `Record` keyed by route name with mixed characteristics, so this file
 * narrows to the one call shape it actually uses and lets `decisionFromArcjet`
 * work from the real `ArcjetDecision` the SDK returns either way.
 */
interface RouteArcjetClient {
  protect(
    request: NextRequest,
    props?: Record<string, string>
  ): Promise<ArcjetDecision>;
}

/**
 * Per-route rate limiting, backed in priority order by:
 *
 *   1. Arcjet — `aj.withRule(slidingWindow(...))`, a per-route rule layered
 *      onto the same client `src/middleware.ts` already runs shield and bot
 *      detection through. One provider, one dashboard, one outage to plan
 *      for, instead of a second system (Upstash) that exists only for this.
 *   2. Upstash — the fixed-window counter `consumeRateLimit` already
 *      implements (PR #113/#124), unchanged, for anyone running without an
 *      Arcjet key but with a shared Redis.
 *   3. The in-memory `SlidingWindowRateLimiter` — one process's own view,
 *      which is enough in development and nowhere else. Production without
 *      Arcjet or Upstash configured is refused at boot by
 *      `src/lib/security/protection-posture.ts` (via `src/instrumentation.ts`,
 *      security audit 2026-09-13 H2 — see `docs/security/rate-limits.md`)
 *      unless `FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1` opts in explicitly —
 *      this module honours that same override so its own fallback story
 *      matches the one the startup gate enforces.
 *
 * See `docs/security/rate-limits.md` for the full route table and the
 * documented fail-open/fail-closed rule referenced below.
 */

export type RouteLimitCharacteristic = 'ip' | 'email' | 'token';

export interface RouteLimitDecision {
  /** `true` when the request may proceed. */
  ok: boolean;
  /** Seconds until a caller may retry; `0` when `ok` is `true`. */
  retryAfter: number;
}

export interface RouteLimiter {
  readonly name: string;
  check(request: NextRequest, key: string): Promise<RouteLimitDecision>;
}

interface RouteLimitDefinition {
  name: string;
  characteristic: RouteLimitCharacteristic;
  /** Env var that overrides {@link defaultLimit}, matching the pattern
   * `discoveryPreviewLiveLimit()` already established in `rate-limit.ts`. */
  limitEnvVar: string;
  /** Env var that overrides {@link defaultWindowMs}. Optional: most routes
   * have never needed a configurable window, only a configurable ceiling. */
  windowEnvVar?: string;
  defaultLimit: number;
  defaultWindowMs: number;
  /**
   * Whether an Arcjet *error* (not a deny decision — a thrown/rejected
   * `protect()` call, e.g. the service is unreachable) refuses the request
   * in production.
   *
   * The rule: routes that are expensive to let through unlimited — a real
   * generation run, a Stripe Checkout session — fail closed in production.
   * Everything else, and every route in every non-production environment,
   * fails open with a logged warning: an Arcjet outage must not be able to
   * turn itself into an outage of the contact form or the lead-capture
   * widget on every client's site.
   */
  failClosedInProduction: boolean;
}

/** Arcjet's own name for the characteristic, and the key `protect()` needs
 * it under when it isn't one of Arcjet's built-in ones (`ip.src` needs no
 * extra prop — Arcjet derives it from the request itself). */
const ARCJET_CHARACTERISTIC_NAME: Record<RouteLimitCharacteristic, string> = {
  ip: 'ip.src',
  email: 'email',
  token: 'token',
};

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Mirrors the override `FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1` that
 * `src/lib/security/protection-posture.ts` gates the process-local tier on
 * at startup (see the module doc comment above), so the two never
 * disagree about what "deliberately single-instance" means. */
function localTierAllowed(): boolean {
  return (
    !isProduction() || process.env.FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT === '1'
  );
}

function resolvedLimit(def: RouteLimitDefinition): number {
  return namedIntEnv(def.limitEnvVar, def.defaultLimit);
}

function resolvedWindowMs(def: RouteLimitDefinition): number {
  return def.windowEnvVar
    ? namedIntEnv(def.windowEnvVar, def.defaultWindowMs)
    : def.defaultWindowMs;
}

interface RouteLimiterRuntime {
  arcjetClient: RouteArcjetClient | null;
  inMemory: SlidingWindowRateLimiter;
}

const runtimeCache = new Map<string, RouteLimiterRuntime>();

/** Built once per route name and cached: the Arcjet client and the
 * in-memory fallback both hold state (or a rule identity) that must not be
 * recreated on every request. */
function runtimeFor(def: RouteLimitDefinition): RouteLimiterRuntime {
  const cached = runtimeCache.get(def.name);
  if (cached) return cached;

  const limit = resolvedLimit(def);
  const windowMs = resolvedWindowMs(def);

  const arcjetClient = process.env.ARCJET_KEY
    ? (aj.withRule(
        slidingWindow({
          mode: 'LIVE',
          characteristics: [ARCJET_CHARACTERISTIC_NAME[def.characteristic]],
          interval: Math.max(1, Math.ceil(windowMs / 1000)),
          max: limit,
        })
      ) as unknown as RouteArcjetClient)
    : null;

  const runtime: RouteLimiterRuntime = {
    arcjetClient,
    inMemory: new SlidingWindowRateLimiter({ limit, windowMs }),
  };
  runtimeCache.set(def.name, runtime);
  return runtime;
}

function decisionFromArcjet(
  decision: ArcjetDecision,
  windowMs: number
): RouteLimitDecision {
  if (!decision.isDenied()) {
    return { ok: true, retryAfter: 0 };
  }
  const reason = decision.reason;
  if (reason.isRateLimit()) {
    const resetMs = reason.resetTime?.getTime();
    const retryAfter =
      resetMs !== undefined
        ? Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
        : Math.max(1, Math.ceil(windowMs / 1000));
    return { ok: false, retryAfter };
  }
  // Shield / bot / any other Arcjet denial reached through the same client:
  // still a refusal, just not one with its own reset clock to report.
  return { ok: false, retryAfter: Math.max(1, Math.ceil(windowMs / 1000)) };
}

function onArcjetError(
  def: RouteLimitDefinition,
  error: unknown
): RouteLimitDecision {
  const production = isProduction();
  const windowMs = resolvedWindowMs(def);

  if (production && def.failClosedInProduction) {
    console.error(
      `[route-limit:${def.name}] Arcjet error; failing closed in production ` +
        `(documented rule: expensive anonymous endpoints fail closed):`,
      error
    );
    return { ok: false, retryAfter: Math.max(1, Math.ceil(windowMs / 1000)) };
  }

  console.warn(
    `[route-limit:${def.name}] Arcjet error; failing open` +
      (production ? ' in production' : ' in development') +
      ':',
    error
  );
  return { ok: true, retryAfter: 0 };
}

function createRouteLimiter(def: RouteLimitDefinition): RouteLimiter {
  return {
    name: def.name,
    async check(request, key) {
      const runtime = runtimeFor(def);
      const windowMs = resolvedWindowMs(def);

      if (runtime.arcjetClient) {
        try {
          const props =
            def.characteristic === 'ip'
              ? undefined
              : { [def.characteristic]: key };
          const decision = await runtime.arcjetClient.protect(request, props);
          return decisionFromArcjet(decision, windowMs);
        } catch (error) {
          return onArcjetError(def, error);
        }
      }

      const upstash = upstashCredentials();
      if (upstash) {
        const limit = resolvedLimit(def);
        const limited = await consumeRateLimit(
          `route-limit:${def.name}:${key}`,
          { limit, windowMs },
          upstash
        );
        return {
          ok: !limited,
          retryAfter: limited ? Math.max(1, Math.ceil(windowMs / 1000)) : 0,
        };
      }

      if (localTierAllowed()) {
        const result = runtime.inMemory.check(key);
        return {
          ok: !result.limited,
          retryAfter: result.limited
            ? Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
            : 0,
        };
      }

      // Nothing configured, in production, without the explicit override.
      // The startup posture gate (`src/lib/security/protection-posture.ts`)
      // exists precisely so this branch is unreachable in a real deployment;
      // it stays defensive — and fails closed, not open — in case that gate
      // is ever bypassed.
      console.error(
        `[route-limit:${def.name}] no rate-limit backend is configured in ` +
          'production; refusing the request. Set ARCJET_KEY or the Upstash ' +
          'pair (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).'
      );
      return { ok: false, retryAfter: Math.max(1, Math.ceil(windowMs / 1000)) };
    },
  };
}

/**
 * Every route limit in the product, by name. Limits are env-overridable
 * (never a bare literal at the call site) with the documented default as
 * the fallback — see `docs/security/rate-limits.md` for the full table.
 */
const ROUTE_LIMIT_DEFINITIONS = {
  contact: {
    name: 'contact',
    characteristic: 'ip',
    limitEnvVar: 'RATE_LIMIT_CONTACT_MAX',
    windowEnvVar: 'RATE_LIMIT_CONTACT_WINDOW_MS',
    defaultLimit: 5,
    defaultWindowMs: 60_000,
    failClosedInProduction: false,
  },
  'discovery-preview-live': {
    name: 'discovery-preview-live',
    characteristic: 'ip',
    // Keeps the env var name `discoveryPreviewLiveLimit()` already used, so
    // an operator's existing config keeps meaning the same thing.
    limitEnvVar: 'DISCOVERY_PREVIEW_LIVE_RATE_LIMIT',
    defaultLimit: 5,
    defaultWindowMs: 60_000,
    // The funnel's most expensive endpoint (a real Pi generation run,
    // `maxDuration = 300`): an unlimited burst here is a real cost, so an
    // Arcjet outage refuses rather than opens the gate in production.
    failClosedInProduction: true,
  },
  'lead-capture-token': {
    name: 'lead-capture-token',
    characteristic: 'token',
    // Env var name and default (10/60s) kept identical to
    // `leadCaptureLimits()`'s `tokenPerMinute` in
    // `@/lib/flowstarter/lead-capture` (PR #152) — that function is still
    // the config the route itself reads for its replay window and body cap,
    // so this stays the same knob rather than a second, easy-to-miss one.
    limitEnvVar: 'FLOWSTARTER_LEAD_CAPTURE_TOKEN_PER_MINUTE',
    defaultLimit: 10,
    defaultWindowMs: 60_000,
    failClosedInProduction: false,
  },
  'lead-capture-ip': {
    name: 'lead-capture-ip',
    characteristic: 'ip',
    // Same reasoning as `lead-capture-token` above, matching
    // `leadCaptureLimits()`'s `ipPerMinute`.
    limitEnvVar: 'FLOWSTARTER_LEAD_CAPTURE_IP_PER_MINUTE',
    defaultLimit: 20,
    defaultWindowMs: 60_000,
    failClosedInProduction: false,
  },
  'guest-deposit-checkout-ip': {
    name: 'guest-deposit-checkout-ip',
    characteristic: 'ip',
    limitEnvVar: 'RATE_LIMIT_GUEST_DEPOSIT_CHECKOUT_IP_MAX',
    windowEnvVar: 'RATE_LIMIT_GUEST_DEPOSIT_CHECKOUT_IP_WINDOW_MS',
    defaultLimit: 5,
    defaultWindowMs: 60_000,
    // Mints a Stripe Checkout session — money-adjacent, fails closed.
    failClosedInProduction: true,
  },
  'guest-deposit-checkout-email': {
    name: 'guest-deposit-checkout-email',
    characteristic: 'email',
    // Env var name and default (3) kept as #141 (security audit 2026-09-13,
    // H4/F06) already shipped them on `main` before this branch rebased onto
    // it — an operator's existing config keeps meaning the same thing.
    limitEnvVar: 'DISCOVERY_GUEST_DEPOSIT_EMAIL_RATE_LIMIT',
    defaultLimit: 3,
    defaultWindowMs: 60_000,
    failClosedInProduction: true,
  },
  // The `booking-deposit-ip` / `booking-deposit-email` pair stood here, for
  // `POST /api/discovery/deposit`. That route was retired on 2026-09-14 with
  // the pre-call booking deposit it charged -- the discovery call is free --
  // so both definitions went with it. `DISCOVERY_DEPOSIT_EMAIL_RATE_LIMIT` is
  // no longer read anywhere; `DISCOVERY_GUEST_DEPOSIT_EMAIL_RATE_LIMIT`, the
  // near-identical name above it, is a different route and is still live.
  'discovery-scope': {
    name: 'discovery-scope',
    characteristic: 'ip',
    limitEnvVar: 'DISCOVERY_SCOPE_RATE_LIMIT',
    defaultLimit: 10,
    defaultWindowMs: 60_000,
    // One model call and, on the custom branch, two emails. Cheaper than a
    // generation run, dearer than a page view, and it sits in front of the
    // decision that stops a generation run -- so an Arcjet outage refuses
    // rather than letting a burst through. The funnel's own fallback when
    // this route answers 429 is the preview, which is the honest default and
    // is what would have happened before this route existed.
    failClosedInProduction: true,
  },
  'discovery-call-enquiry': {
    name: 'discovery-call-enquiry',
    characteristic: 'ip',
    limitEnvVar: 'RATE_LIMIT_DISCOVERY_CALL_ENQUIRY_MAX',
    windowEnvVar: 'RATE_LIMIT_DISCOVERY_CALL_ENQUIRY_WINDOW_MS',
    defaultLimit: 5,
    defaultWindowMs: 60_000,
    // A contact form by another name, and held to the same rule as
    // `contact`: it writes a row and sends mail, but it mints nothing and
    // spends nothing, so an Arcjet outage must not take the last way of
    // reaching a person off the site.
    failClosedInProduction: false,
  },
  'support-chat': {
    name: 'support-chat',
    characteristic: 'ip',
    // #141 (security audit 2026-09-13, Claude H4 / Codex F06) already
    // shipped this env var name and default (10) for the route's own
    // ad hoc `consumeRateLimit` call; kept identical now that the route is
    // wired through `routeLimiter` instead.
    limitEnvVar: 'SUPPORT_CHAT_RATE_LIMIT',
    defaultLimit: 10,
    defaultWindowMs: 60_000,
    failClosedInProduction: false,
  },
} as const satisfies Record<string, RouteLimitDefinition>;

export type RouteLimitName = keyof typeof ROUTE_LIMIT_DEFINITIONS;

const limiterCache = new Map<RouteLimitName, RouteLimiter>();

/**
 * The one entry point route handlers use. Same name in, same limiter
 * instance out — callers do not need to know or care which backend is
 * actually deciding.
 */
export function routeLimiter(name: RouteLimitName): RouteLimiter {
  const cached = limiterCache.get(name);
  if (cached) return cached;

  const def = ROUTE_LIMIT_DEFINITIONS[name];
  const limiter = createRouteLimiter(def);
  limiterCache.set(name, limiter);
  return limiter;
}

/** Test seam: route limit state (Arcjet client cache, in-memory counters)
 * is module-level and suites must be able to reset it between cases. */
export function __resetRouteLimitersForTest(): void {
  runtimeCache.forEach((runtime) => runtime.inMemory.destroy());
  runtimeCache.clear();
  limiterCache.clear();
}
