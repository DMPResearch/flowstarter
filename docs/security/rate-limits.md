# Rate limits and Arcjet policy

Answers two questions: **what stops one caller from hammering an endpoint?**
and **which endpoints get bot detection?**

## Backend order

Every route-specific limit goes through `routeLimiter(name)` in
[`src/lib/security/route-limits.ts`](../../apps/flowstarter-main/src/lib/security/route-limits.ts).
One name, one limiter, backed — in priority order — by:

1. **Arcjet**, when `ARCJET_KEY` is set:
   `ajRouteLimit.withRule(slidingWindow({ mode: 'LIVE', characteristics: [...], interval, max }))`.
   Same provider as the blanket middleware protection, different client:
   `ajRouteLimit` declares **no rules of its own** — no shield, no
   `detectBot` — so a route limiter can only ever deny for a rate limit. See
   "Why the route limiter has its own client" below; this was not always
   true, and the day it was not cost a showcase run.
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

## Why the route limiter has its own client

`routeLimiter` used to layer its sliding window onto `aj`, the base client
that carries `shield` and `detectBot` at `LIVE`. Every rate-limit check
therefore re-ran bot detection and shield against a request `src/middleware.ts`
had already run both against.

`decisionFromArcjet` turns _any_ denial into `{ ok: false }`, and a route
turns `{ ok: false }` into a 429 with `Retry-After` set from the configured
window. So a bot denial at the route arrived at the caller as a rate limit
with a sixty-second clock that would never run down — the window was
refilling correctly the whole time, and nothing was ever counted against it.

That is exactly what stopped the showcase run on 2026-09-15. The recorder
passed the middleware under the #178 allowance (bot detection at `DRY_RUN`),
then hit `aj`'s `detectBot` at `LIVE` inside `routeLimiter`, and was told four
times — single calls, ninety seconds apart — that it had exhausted
`discovery-scope`'s ten-per-minute window. Five of eight scenarios could not
be filmed.

A route limiter limits rate. Shield and bot detection belong to the
middleware, which runs them once per request and reports them as the **403**
they are, not as a 429. `src/__tests__/arcjet-route-limit-policy.test.ts` pins
`ajRouteLimit`'s empty rule list and that `route-limits.ts` builds on it, the
same way `arcjet-machine-policy.test.ts` pins `ajMachine`'s.

If a non-rate-limit denial ever does reach `decisionFromArcjet` again, it
still refuses — and now logs
`[route-limit:<name>] Arcjet denied this request for a reason that is not a rate limit`
at `console.warn`, so the misdiagnosis is visible in one grep instead of
taking a day.

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
| `POST /api/discovery/scope`                                   | `discovery-scope`              | ip             | 10 / 60s | `DISCOVERY_SCOPE_RATE_LIMIT` (limit only)                                       | **yes** — one model call, and it gates a generation   |

`discovery-scope` answers a refusal with `429` and
`{"route":"hold","reason":"unavailable"}`. It used to answer
`{"route":"self-serve",...}` — the one value in that feature's vocabulary that
means _generate_ — and the wizard believed it, so a rate limit produced a
generated preview and a deposit offer for a brief that should have been a
discovery call. A limiter that cannot decide is not a limiter that said yes;
see `unavailable()` in
[`src/app/api/discovery/scope/route.ts`](../../apps/flowstarter-main/src/app/api/discovery/scope/route.ts)
and the retry rule in `useScopeRoute`.
| `POST /api/discovery-call/lead` | `discovery-call-enquiry` | ip | 5 / 60s | `RATE_LIMIT_DISCOVERY_CALL_ENQUIRY_MAX` / `..._WINDOW_MS` | no |
| `POST /api/support-chat` | `support-chat` | ip | 10 / 60s | `SUPPORT_CHAT_RATE_LIMIT` | no |

The checkout route carries a pair: IP catches one caller minting many
sessions, email catches the same address spread across many IPs. Neither
alone sees both shapes of abuse. There were two such routes until
2026-09-14, when `POST /api/discovery/deposit` was retired along with the
pre-call booking deposit it charged; `DISCOVERY_DEPOSIT_EMAIL_RATE_LIMIT` is
no longer read by anything, and an operator who set it can drop it. Do not
confuse it with `DISCOVERY_GUEST_DEPOSIT_EMAIL_RATE_LIMIT` above, which is a
different route and is still live. The two email limiters' env var names and
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

## Recorder allowance

The showcase recorder (Playwright, headless and headed Chrome) cannot pass
Arcjet's bot rule on staging.flowstarter.dev: no cookies, no prior
navigation, the exact fingerprint `detectBot` exists to catch. The existing
E2E bypass (`x-e2e-secret`, checked in `src/middleware.ts` and
`src/lib/api-auth.ts`) is gated on `NODE_ENV !== 'production'`, and the
staging Next.js build runs with `NODE_ENV=production` like any deployed
build, so that bypass never applies there.

A request that carries the header `x-flowstarter-recorder` set to the value
of `FLOWSTARTER_RECORDER_SECRET`, and is not running with
`FLOWSTARTER_ENV=production`, runs the `detectBot` rule at `DRY_RUN` for
that one request instead of `LIVE`. Shield and the sliding-window rate limit
in the same client keep running at `LIVE`, so the allowance narrows exactly
one rule and nothing else. Arcjet still evaluates and logs a bot decision
under `DRY_RUN`, it just never turns into a 403.

The decision is made by `isRecorderRequestAllowed` in
[`packages/platform-config/src/recorder-allowance.ts`](../../packages/platform-config/src/recorder-allowance.ts),
wired into `src/middleware.ts` right where the `browser`/`machine` Arcjet
client is picked (see `ajWithRateLimitBotDryRun` in
[`src/lib/arcjet.ts`](../../apps/flowstarter-main/src/lib/arcjet.ts)). It
only ever applies to the `browser` policy: `machine` routes carry no
`detectBot` rule to relax, and `none` routes skip Arcjet entirely.

Two independent reasons keep this closed in production, not one:

1. `prod.env` never sets `FLOWSTARTER_RECORDER_SECRET`, so the rule is
   inert there regardless of the header a caller sends.
2. `isRecorderRequestAllowed` refuses outright whenever
   `FLOWSTARTER_ENV === "production"`, before it even reads the header, so a
   secret leaked or accidentally set in a production env file still cannot
   reopen the gate.

The header comparison itself is constant time (Web Crypto `crypto.subtle`,
so it runs in the Edge middleware), matching the constant-time comparisons
used elsewhere in this app (`node:crypto`'s `timingSafeEqual`, e.g.
`src/lib/webhook-verification.ts`).

Every time the allowance fires, `src/middleware.ts` logs
`security.recorder_allowance` with the route through the same
`logSecurityEventEdge` helper that logs every other Arcjet outcome
(`security.rate_limited`, `security.bot_blocked`, `security.shield_blocked`).
There is no separate audit path to keep in sync with this one.

Rejecting an Arcjet-wide `DRY_RUN` for all of staging was a deliberate
choice, not an oversight: staging.flowstarter.dev is a public URL, and a
blanket dry-run would relax bot detection for every visitor, not only the
recorder.

### The allowance also skips the per-route rate limits

The bot allowance above was not enough on its own. Filming one scenario end
to end costs several `POST /api/discovery/scope` calls inside a minute —
the take itself, its preflight probes, and any retry — against a limit of
**10 per 60s per IP**, all from the recorder's single address. On 2026-09-15
that ceiling blocked scenarios 1, 2, 3, 6 and 7 outright.

So `routeLimiter(name).check()` asks `isRecorderRequestAllowed` before it
asks any backend, and a proven recorder request skips the route's limit
entirely:

- **Same decision function, same policy.** It is literally the call the
  middleware makes. Production is closed for the same two independent
  reasons: `prod.env` never sets `FLOWSTARTER_RECORDER_SECRET`, and
  `isRecorderRequestAllowed` refuses outright when
  `FLOWSTARTER_ENV === "production"` before it reads the header at all.
- **Before every backend**, not just the Arcjet one, so a box running on
  Upstash or the in-memory tier behaves identically and a recorder run is
  not quietly stopped by whichever tier happens to be configured.
- **Logged every time**, as
  `[SECURITY] event=security.recorder_allowance limit=<name> detail=route_rate_limit_bypassed`
  — the same `[SECURITY] event=...` shape `src/middleware.ts` emits, so one
  grep finds both. Written with `console.warn` and **not** `console.info`:
  `next.config.mjs` strips every console call except `error` and `warn` from
  a production bundle, and staging builds with `NODE_ENV=production`, so an
  `info` line would be compiled out of the one environment the allowance
  exists for. The secret itself is never logged.
- **Nothing else changes.** Shield still runs, the middleware's own
  sliding-window limit still runs at `LIVE`, and the route's own validation,
  body caps and acceptable-use gate are all untouched. The allowance removes
  a ceiling on request volume for one authenticated caller in one
  environment; it is not an authentication bypass.

`src/lib/security/__tests__/route-limits.test.ts` covers staging-allowed,
production-refused, wrong-secret-refused, no-secret-inert, and
ordinary-visitor-unaffected.

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
