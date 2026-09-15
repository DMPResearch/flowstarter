import 'server-only';
import arcjet, {
  ArcjetDecision,
  ArcjetRuleResult,
  detectBot,
  shield,
  slidingWindow,
  tokenBucket,
} from '@arcjet/next';
import { NextRequest, NextResponse } from 'next/server';

// Validate that ARCJET_KEY is set
if (!process.env.ARCJET_KEY) {
  console.warn(
    '[Arcjet] ARCJET_KEY environment variable is not set. Security features will be disabled.'
  );
}

/**
 * Base Arcjet client with shield protection enabled.
 * Shield provides protection against common attacks like SQL injection, XSS, etc.
 */
export const aj = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ['ip.src'], // Rate limit by IP address
  rules: [
    // Shield protects against common attacks (SQLi, XSS, etc.)
    shield({
      mode: 'LIVE',
    }),
    // Detect and optionally block bots
    detectBot({
      mode: 'LIVE',
      allow: [
        // Allow search engine crawlers
        'CATEGORY:SEARCH_ENGINE',
        // Allow monitoring services
        'CATEGORY:MONITOR',
        // Allow preview bots (social media, etc.)
        'CATEGORY:PREVIEW',
      ],
    }),
  ],
});

/**
 * Arcjet client with standard API rate limiting.
 * 100 requests per minute per IP (matches previous Upstash config).
 */
export const ajWithRateLimit = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ['ip.src'],
  rules: [
    shield({ mode: 'LIVE' }),
    detectBot({
      mode: 'LIVE',
      allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:MONITOR', 'CATEGORY:PREVIEW'],
    }),
    // Sliding window rate limit: 20 requests per 60 seconds
    slidingWindow({
      mode: 'LIVE',
      interval: '1m',
      max: 20,
    }),
  ],
});

/**
 * Same shape as `ajWithRateLimit`, except `detectBot` runs at `DRY_RUN`
 * instead of `LIVE`: Arcjet still evaluates and logs a bot decision, it just
 * never turns into a 403.
 *
 * Selected in `src/middleware.ts` for exactly one caller: a request that has
 * already proved itself the staging showcase recorder via
 * `isRecorderRequestAllowed` (`@flowstarter/platform-config` —
 * see `recorder-allowance.ts` there for the full policy, including why it is
 * inert in production). Shield and the sliding-window rate limit are
 * unchanged at `LIVE`; only bot detection is relaxed, and only for that one
 * request. This is deliberately its own client, not a per-request rule
 * override, so the `browser` policy's rules stay declared in one place each
 * and a test can pin "this client's detectBot is DRY_RUN" the same way
 * `arcjet-machine-policy.test.ts` already pins `ajMachine`'s.
 */
export const ajWithRateLimitBotDryRun = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ['ip.src'],
  rules: [
    shield({ mode: 'LIVE' }),
    detectBot({
      mode: 'DRY_RUN',
      allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:MONITOR', 'CATEGORY:PREVIEW'],
    }),
    // Sliding window rate limit: 20 requests per 60 seconds — unchanged from
    // ajWithRateLimit. The recorder allowance only ever relaxes bot
    // detection; rate limits still apply.
    slidingWindow({
      mode: 'LIVE',
      interval: '1m',
      max: 20,
    }),
  ],
});

/**
 * The base client `routeLimiter` layers its per-route sliding window onto.
 *
 * **No rules of its own, and that is the entire point.** This used to be
 * `aj`, which carries shield and `detectBot` at `LIVE`, so every call to
 * `routeLimiter(...).check()` ran bot detection and shield a SECOND time --
 * after `src/middleware.ts` had already run both for the same request, and
 * after the recorder allowance had already decided, for that request, that
 * bot detection should be relaxed.
 *
 * That second evaluation is what stopped the 2026-09-15 showcase run.
 * `decisionFromArcjet` turns any denial into `{ ok: false }`, and
 * `POST /api/discovery/scope` turns `{ ok: false }` into
 * `429 Retry-After: 60`. So an automated browser -- which passes the
 * middleware under `ajWithRateLimitBotDryRun` and is then denied by `aj`'s
 * `detectBot` at the route -- was told, over and over, that it had exhausted a
 * ten-per-minute window it had never touched. Four single calls ninety seconds
 * apart, all 429. The window was refilling exactly as configured; the refusal
 * was never a rate limit at all.
 *
 * A route limiter limits rate. Shield and bot detection belong to the
 * middleware, which runs them once, on every request, and reports them as the
 * 403 they are. `arcjet-route-limit-policy.test.ts` pins this client's empty
 * rule list the same way `arcjet-machine-policy.test.ts` pins `ajMachine`'s.
 */
export const ajRouteLimit = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ['ip.src'],
  rules: [],
});

/**
 * Arcjet client for the middleware's `machine` policy: signature/shared-secret
 * callers (Cal.com's webhook delivery, the build worker's callbacks) rather
 * than a browser. See `arcjetPolicyFor` in `@/lib/route-manifest` for the
 * allow-list and the reasoning.
 *
 * Shield and the same rate limit as `ajWithRateLimit`, deliberately without
 * `detectBot`: every legitimate caller on these routes IS a bot by Arcjet's
 * own definition, so bot detection would 403 a correctly-signed delivery
 * before the route itself ever gets to check the signature. The signature
 * check inside each route is the real authentication; this client's job is
 * only shield (common attack patterns) and a ceiling on request volume.
 */
export const ajMachine = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ['ip.src'],
  rules: [
    shield({ mode: 'LIVE' }),
    slidingWindow({
      mode: 'LIVE',
      interval: '1m',
      max: 20,
    }),
  ],
});

/**
 * Arcjet client for AI endpoints with stricter rate limiting.
 * Uses token bucket for burst protection.
 */
export const ajAI = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ['ip.src'],
  rules: [
    shield({ mode: 'LIVE' }),
    detectBot({
      mode: 'LIVE',
      allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:MONITOR'],
    }),
    // Token bucket: 10 tokens max, refills at 5 per minute
    // Allows bursts but limits sustained usage
    tokenBucket({
      mode: 'LIVE',
      refillRate: 5,
      interval: '1m',
      capacity: 10,
    }),
  ],
});

/**
 * Arcjet client for sensitive endpoints (auth, feedback, etc.)
 * with stricter rate limiting.
 */
export const ajSensitive = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ['ip.src'],
  rules: [
    shield({ mode: 'LIVE' }),
    detectBot({
      mode: 'LIVE',
      allow: ['CATEGORY:MONITOR'],
    }),
    // Stricter rate limit for sensitive endpoints
    slidingWindow({
      mode: 'LIVE',
      interval: '1m',
      max: 20,
    }),
  ],
});

/**
 * Arcjet client for public/read-only endpoints with generous limits.
 */
export const ajPublic = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ['ip.src'],
  rules: [
    shield({ mode: 'LIVE' }),
    detectBot({
      mode: 'LIVE',
      allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:MONITOR', 'CATEGORY:PREVIEW'],
    }),
    // More generous limit for public endpoints
    slidingWindow({
      mode: 'LIVE',
      interval: '1m',
      max: 200,
    }),
  ],
});

/**
 * Helper type for Arcjet clients
 */
export type ArcjetClient =
  | typeof aj
  | typeof ajRouteLimit
  | typeof ajWithRateLimit
  | typeof ajWithRateLimitBotDryRun
  | typeof ajMachine
  | typeof ajAI
  | typeof ajSensitive
  | typeof ajPublic;

/**
 * Creates a standardized error response for blocked requests
 */
export function createBlockedResponse(
  decision: ArcjetDecision
): NextResponse | null {
  if (decision.isDenied()) {
    // Find the reason for denial
    const reason = decision.reason;

    if (reason.isRateLimit()) {
      return NextResponse.json(
        {
          error: 'Too many requests',
          message: 'Rate limit exceeded. Please try again later.',
        },
        {
          status: 429,
          headers: {
            'Retry-After': '60',
            'X-RateLimit-Limit': String(reason.max),
            'X-RateLimit-Remaining': String(reason.remaining),
            'X-RateLimit-Reset': String(
              Math.floor(reason.resetTime?.getTime() ?? 0 / 1000)
            ),
          },
        }
      );
    }

    if (reason.isBot()) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          message: 'Bot activity detected.',
        },
        { status: 403 }
      );
    }

    if (reason.isShield()) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          message: 'Request blocked for security reasons.',
        },
        { status: 403 }
      );
    }

    // Generic denial
    return NextResponse.json(
      {
        error: 'Forbidden',
        message: 'Request denied.',
      },
      { status: 403 }
    );
  }

  return null;
}

/**
 * Higher-order function to wrap API route handlers with Arcjet protection.
 *
 * @example
 * ```ts
 * import { withArcjet, ajAI } from '@/lib/arcjet';
 *
 * export const POST = withArcjet(ajAI, async (request) => {
 *   // Your handler logic
 *   return NextResponse.json({ success: true });
 * });
 * ```
 */
export function withArcjet<T extends ArcjetClient>(
  client: T,
  handler: (request: NextRequest) => Promise<NextResponse>
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest) => {
    // Skip protection if ARCJET_KEY is not configured
    if (!process.env.ARCJET_KEY) {
      return handler(request);
    }

    const decision = await client.protect(request, { requested: 1 });

    const blockedResponse = createBlockedResponse(decision);
    if (blockedResponse) {
      return blockedResponse;
    }

    // Add rate limit headers to successful responses
    const response = await handler(request);

    // Find rate limit result if present
    const rateLimitResult = decision.results.find((r: ArcjetRuleResult) =>
      r.reason.isRateLimit()
    );
    if (rateLimitResult && rateLimitResult.reason.isRateLimit()) {
      const reason = rateLimitResult.reason;
      response.headers.set('X-RateLimit-Limit', String(reason.max));
      response.headers.set('X-RateLimit-Remaining', String(reason.remaining));
      response.headers.set(
        'X-RateLimit-Reset',
        String(Math.floor(reason.resetTime?.getTime() ?? 0 / 1000))
      );
    }

    return response;
  };
}

/**
 * Protect a request using the standard rate-limited client.
 * Returns a blocked response if denied, or null if allowed.
 */
export async function protectRequest(
  request: NextRequest
): Promise<NextResponse | null> {
  if (!process.env.ARCJET_KEY) {
    return null;
  }

  const decision = await ajWithRateLimit.protect(request);
  return createBlockedResponse(decision);
}

/**
 * Get rate limit info from a decision for adding to response headers
 */
export function getRateLimitHeaders(
  decision: ArcjetDecision
): Record<string, string> {
  const headers: Record<string, string> = {};

  const rateLimitResult = decision.results.find((r: ArcjetRuleResult) =>
    r.reason.isRateLimit()
  );
  if (rateLimitResult && rateLimitResult.reason.isRateLimit()) {
    const reason = rateLimitResult.reason;
    headers['X-RateLimit-Limit'] = String(reason.max);
    headers['X-RateLimit-Remaining'] = String(reason.remaining);
    headers['X-RateLimit-Reset'] = String(
      Math.floor(reason.resetTime?.getTime() ?? 0 / 1000)
    );
  }

  return headers;
}
