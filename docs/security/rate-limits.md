# Rate limits and Arcjet policy

Answers two questions: **what stops one caller from hammering an endpoint?**
and **which endpoints get bot detection?**

## Backend order

Every route-specific limit goes through `routeLimiter(name)` in
[`src/lib/security/route-limits.ts`](../../apps/flowstarter-main/src/lib/security/route-limits.ts).
One name, one limiter, backed — in priority order — by:

1. **Arcjet**, when `ARCJET_KEY` is set: `aj.withRule(slidingWindow({ mode:
'LIVE', characteristics: [...], interval, max }))`, layered onto the same
   client `src/middleware.ts` already runs shield and (for browser-facing
   routes) bot detection through. One provider for both the blanket
   middleware protection and every per-endpoint cap.
2. **Upstash**, when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
   are both set and Arcjet is not: the fixed-window counter
   `consumeRateLimit` already implemented (PR #113 / #124), unchanged.
3. **In-memory**, in development only (`NODE_ENV !== 'production'`), or in
   production when `FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1` is set explicitly.
   One process's own view — enough for development and a single node, not
   enough for a public endpoint running on more than one instance.

`ARCJET_KEY` alone is sufficient in production: Upstash becomes optional, not
required. See "Startup posture" below for what happens when neither is set.

Arcjet decisions map onto `{ ok: boolean; retryAfter: number }` — `retryAfter`
is seconds, `0` when `ok` is `true`. Callers 429 with a `Retry-After` header
built straight from it.

## On Arcjet errors

A _decision_ to deny (rate limit exceeded, shield, bot) always means `ok:
false`. A separate case is an Arcjet _error_ — `protect()` throwing or
rejecting, e.g. the service is unreachable:

- **Development (any route): fail open**, with a `console.warn`. An Arcjet
  outage in development must not block a working session.
- **Production, most routes: fail open**, with a `console.warn`. An Arcjet
  outage must not be able to turn itself into an outage of the contact form
  or the lead-capture widget on every client's site.
- **Production, the routes marked `failClosedInProduction` below: fail
  closed**, with a `console.error`. These mint a Stripe Checkout session or
  run a real, expensive generation job — an unlimited burst here is a real
  cost, so the documented rule picks refusing new load over letting it
  through unchecked.

If neither Arcjet nor Upstash is configured and the process is in production
without the override, `routeLimiter` itself refuses the request
(`ok: false`) rather than falling back to the in-memory tier. In a real
deployment this is unreachable: `src/instrumentation.ts` refuses to boot on
the process-local-only tier first (see "Startup posture").

## Every route limit

| Route                                                         | Limiter name                   | Characteristic | Default  | Env override (limit / window)                                                   | Fails closed on Arcjet error?                         |
| ------------------------------------------------------------- | ------------------------------ | -------------- | -------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `POST /api/contact`                                           | `contact`                      | ip             | 5 / 60s  | `RATE_LIMIT_CONTACT_MAX` / `RATE_LIMIT_CONTACT_WINDOW_MS`                       | no                                                    |
| `POST /api/discovery/preview/live`                            | `discovery-preview-live`       | ip             | 5 / 60s  | `DISCOVERY_PREVIEW_LIVE_RATE_LIMIT` (limit only)                                | **yes** — a real Pi generation run, `maxDuration=300` |
| `POST /api/leads/capture/[token]`                             | `lead-capture-token`           | token          | 10 / 60s | `RATE_LIMIT_LEAD_CAPTURE_TOKEN_MAX` / `RATE_LIMIT_LEAD_CAPTURE_TOKEN_WINDOW_MS` | no                                                    |
| `POST /api/leads/capture/[token]`                             | `lead-capture-ip`              | ip             | 20 / 60s | `RATE_LIMIT_LEAD_CAPTURE_IP_MAX` / `RATE_LIMIT_LEAD_CAPTURE_IP_WINDOW_MS`       | no                                                    |
| `POST /api/discovery/preview/[demoId]/guest-deposit-checkout` | `guest-deposit-checkout-ip`    | ip             | 5 / 60s  | `RATE_LIMIT_GUEST_DEPOSIT_CHECKOUT_IP_MAX` / `..._WINDOW_MS`                    | **yes** — mints a Stripe Checkout session             |
| `POST /api/discovery/preview/[demoId]/guest-deposit-checkout` | `guest-deposit-checkout-email` | email          | 3 / 60s  | `DISCOVERY_GUEST_DEPOSIT_EMAIL_RATE_LIMIT`                                      | **yes**                                               |
| `POST /api/discovery/deposit`                                 | `booking-deposit-ip`           | ip             | 5 / 60s  | `RATE_LIMIT_BOOKING_DEPOSIT_IP_MAX` / `..._WINDOW_MS`                           | **yes** — mints a Stripe Checkout session             |
| `POST /api/discovery/deposit`                                 | `booking-deposit-email`        | email          | 3 / 60s  | `DISCOVERY_DEPOSIT_EMAIL_RATE_LIMIT`                                            | **yes**                                               |
| `POST /api/support-chat`                                      | `support-chat`                 | ip             | 10 / 60s | `SUPPORT_CHAT_RATE_LIMIT`                                                       | no                                                    |

Two checkout routes each carry a pair: IP catches one caller minting many
sessions, email catches the same address spread across many IPs. Neither
alone sees both shapes of abuse. The two email limiters' env var names and
defaults (3/60s) are [PR #141](https://github.com/DMPResearch/flowstarter/pull/141)'s
(security audit 2026-09-13, Claude H4 / Codex F06) — kept as-is here rather
than renamed, so an operator's existing config keeps meaning the same thing.
Same for `support-chat`'s `SUPPORT_CHAT_RATE_LIMIT` (10/60s): #141 added the
route and its ad hoc limiter in the same PR; it is wired through
`routeLimiter('support-chat')` here instead, with the env var and default
unchanged.

The blanket middleware limit (`ajWithRateLimit` / `ajMachine`, see below) is
separate from this table: it is a floor under every API route regardless of
whether the route also has its own `routeLimiter` entry.

## Arcjet policy: browser, machine, none

`src/middleware.ts` runs Arcjet on every request before a route handler ever
sees it. Which client it runs is decided once, by `arcjetPolicyFor(pathname)`
in [`src/lib/route-manifest.ts`](../../apps/flowstarter-main/src/lib/route-manifest.ts)
— pure and dependency-free, so a unit test can call it directly without
booting Clerk, Arcjet or the Edge runtime.

| Policy              | Client             | Rules                                     | Who                                                                                                                                                                        |
| ------------------- | ------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser` (default) | `ajWithRateLimit`  | shield, detectBot, sliding window         | everything not listed below                                                                                                                                                |
| `machine`           | `ajMachine`        | shield, sliding window — **no detectBot** | the signature/shared-secret allow-list: `/api/internal/*` (the build worker's callbacks, e.g. its deploy callback), `/api/integrations/cal/*` (Cal.com's webhook delivery) |
| `none`              | — (Arcjet skipped) | —                                         | `/api/webhooks/*`, `/api/health*`                                                                                                                                          |

Why `machine` exists: Arcjet's `detectBot` fingerprints exactly what a
signature-authenticated server caller looks like — no browser headers, no
session, an HTTP client's own `User-Agent` (`curl`, `python-requests`, the
build worker's own client). Running the full `browser` policy against them
would 403 a correctly-signed delivery before the route itself ever got to
check the signature, which is the caller's real authentication. `machine`
keeps shield (common attack patterns) and a rate-limit ceiling, and drops
only bot detection. A request that fails the route's own signature check
still answers **401**, from the route, not 403 from Arcjet — the two
policies never change what a route decides, only whether Arcjet's bot check
runs ahead of it.

The allow-list lives in `route-manifest.ts`, next to the already-existing
`PUBLIC_ROUTES` entries for the same two callers (both are also exempt from
the Clerk session check, for the same reason: a server, not a person). It is
not repeated as scattered `pathname.startsWith(...)` checks in the
middleware.

## Startup posture

`src/instrumentation.ts` (security audit 2026-09-13, Claude H2 —
[PR #141](https://github.com/DMPResearch/flowstarter/pull/141)) names the
active route-limit backend at boot, via
[`src/lib/security/protection-posture.ts`](../../apps/flowstarter-main/src/lib/security/protection-posture.ts),
and refuses to start in `staging`/`production` on the process-local tier
alone, unless `FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1` is set. It accepts
either shared tier alone:

- **Arcjet alone** — `ARCJET_KEY` set. The startup log names this tier
  `"arcjet"` (`protectionPosture()` joins whichever of `arcjet`/`upstash` are
  configured with `+`; Arcjet alone is just `"arcjet"`).
- **Upstash alone** — both `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN` set.

`routeLimiter` honours the same `FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1`
override for its own in-memory fallback (see "Backend order" above), so the
two never disagree about what "deliberately single-instance" means.

## Client IP

Every `ip` characteristic above is computed once, per request, by
[`clientIp(headers)`](../../apps/flowstarter-main/src/lib/request-ip.ts)
(security audit 2026-09-13, Claude H3) — the trusted-proxy walk of
`X-Forwarded-For` from the right, never the naive leftmost entry. Arcjet's
own `ip.src` characteristic (used for the `ip` rows above and by the
middleware's `browser`/`machine` policies) is derived independently by
the Arcjet SDK itself from the request; `clientIp` is what feeds the
Upstash/in-memory fallback tiers and the `email`/`token` call sites that also
compute an IP for logging or a second dimension of the same limit.
