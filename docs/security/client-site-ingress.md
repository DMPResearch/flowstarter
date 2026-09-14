# What a client site can reach, and what it is worth

Every generated site is static HTML on a host we run, served over a domain the client
was sold. Its source is public — anyone can view it — and it may one day be hostile:
compromised through the client's own domain registrar, or malicious from birth because
someone paid for a site in order to get one.

So this document answers one question, and answers it from the platform's side rather
than the site's: **if a client site turned on us tomorrow, what could it do?**

The short answer is at the bottom. What comes first is every endpoint a site can
address, and the rule that guards each.

---

## 1. What a site is actually able to call

Two things bound this, and they are different in kind.

The **Content-Security-Policy** the deploy agent writes into each site's own Caddy
configuration (`apps/deploy-agent/src/site-csp.ts`, PR #134) is what a _browser on the
site_ is allowed to do:

```
connect-src 'self' <platform origin>
form-action 'self' <platform origin> mailto:
script-src  'self' 'sha256-…' (the managed inline blocks, by content)
base-uri 'none'; object-src 'none'; worker-src 'none'; frame-ancestors 'none'
```

A visitor's browser on a client site can therefore reach exactly two origins: the site
itself, and the platform. It cannot exfiltrate a visitor's form input to a third party,
cannot retarget the contact form at somebody else's collector, and cannot load a script
from anywhere but the site's own bundle and the named inline blocks.

The **platform's public route list** (`PUBLIC_ROUTES` in
`apps/flowstarter-main/src/lib/route-manifest.ts`) is what anything at all can reach on
the platform without a Clerk session. A site's HTML can only usefully call the entries
that take no session and expect a caller that is not a person. There are two:

| Endpoint                                   | Who is supposed to call it                 | Guard |
| ------------------------------------------ | ------------------------------------------ | ----- |
| `POST /api/leads/capture/{token}`          | the contact form on this client's own site | §2    |
| `OPTIONS /api/leads/capture/{token}`       | the browser's preflight for the above      | §2    |
| `POST /api/integrations/cal/{workspaceId}` | Cal.com's servers, not a site              | §3    |

Everything else public — `/api/contact`, `/api/discovery/*`, `/api/support-chat`,
`/api/connect/*` — is the marketing funnel and is reachable by anybody on the internet
with or without a client site. A compromised site gains nothing there that a browser
tab does not already have.

The two agents on the box (§4, §5) are **not** reachable from a site at all. They are
bound behind the host firewall and require a shared secret a site does not hold.

---

## 2. `POST /api/leads/capture/{token}` — the contact form

The only unauthenticated write in the product that creates a tenant row.
Route: `apps/flowstarter-main/src/app/api/leads/capture/[token]/route.ts`.
Rules: `lib/flowstarter/lead-capture.ts` and `lib/flowstarter/inbound-content.ts`.
Adversarial suite: `app/api/leads/capture/__tests__/hostile-site.test.ts`.

**What the token is.** `workspaces.lead_capture_token`: 32 random bytes in base64url,
unique per workspace, rotatable, with a check constraint on the column. It carries
exactly one capability — _create one lead in this workspace_ — and reads nothing. It is
not the workspace id, and the shape floor of 43 characters exists so that a canonical
UUID cannot be offered as one.

The rules, in the order they run:

1. **A preview token** (`preview.<id>`) → `403` with a sentence, before any query. The
   dot is outside base64url, so no minted token can ever collide with this shape.
2. **Anything that is not base64url** → the standard refusal, before any query.
3. **Rate**, per token and per address. Defaults in
   `DEFAULT_LEAD_CAPTURE_LIMITS`: ten a minute per token, twenty a minute per address,
   both overridable by environment. The address comes from `clientIp`
   (`lib/request-ip.ts`, PR #141) — the rightmost `X-Forwarded-For` entry outside a
   trusted-proxy CIDR, never the leftmost, which is the part the caller writes.
4. **The token resolves to a workspace**, and the stored value is compared to the
   presented one in constant time.
5. **Origin**, against the origins that workspace's own site is served from: the
   hostname its slug mints, the preview it was claimed from, and any custom domain on
   `workspace_hosts`. https only. Homoglyph domains punycode before comparison, so
   `sаlon-elena…` (Cyrillic а) becomes `xn--slon-elena-zqi…` and does not match.
6. **Body**, capped on the stream at 64 KB — not on `Content-Length`, which a chunked
   request does not carry and a dishonest one lies about.
7. **Content**, by `sanitiseInbound`: a NUL byte is refused, control and invisible
   characters (zero width, bidi overrides, BOM) are stripped, unicode is normalised to
   NFC, lengths come from configuration, and markup is refused in `name`, `email` and
   `phone` — fields an angle bracket is never a person in — and kept verbatim in
   `message`, which is prose and is escaped at render.
8. **Honeypot**: a submission carrying the trap field gets the same `201` a real one
   gets and is discarded.
9. **Replay**: the same payload for the same workspace inside ten minutes is answered
   exactly like the first and stored once.

**One refusal for four different failures.** An unknown token, a rotated token, another
workspace's token, and a real token submitted from somebody else's page all return the
same `404` with the same body and the same headers, byte for byte — asserted, not
assumed. The distinction goes to the log. An endpoint that said "wrong website" for a
real token and "no such form" for an invented one would publish, to an anonymous
caller, which of the tokens they scraped out of page source are still live.

**CORS.** The allow-origin is echoed only when it matched, never `*`. The preflight
does not confirm a token to a foreign origin and is counted on the same per-address
budget as the POST, because it is the cheaper half of the endpoint to walk a list with.

**What the response says on success.** `{ ok: true }` and nothing else. No lead id, no
workspace, no spam verdict.

### What Origin and Referer are and are not worth

`Origin` is set by the browser and cannot be set by a page, so the origin rule is a real
defence against _a browser on somebody else's site_ — the case a scraped token actually
looks like. It is not a defence against `curl`, which can send any header it likes.

That is not a gap being papered over; it is the honest shape of the problem. A caller
holding the token does not need to forge a header, because the token is the credential.
What bounds them is what the token is worth (§6) plus the rate and replay rules, and
those are what the suite exercises.

---

## 3. `POST /api/integrations/cal/{workspaceId}` — bookings

Route: `apps/flowstarter-main/src/app/api/integrations/cal/[workspaceId]/route.ts`.
Rules: `lib/flowstarter/cal-webhook.ts`.

A site cannot usefully call this and there is nothing in a site that helps: the proof of
who is calling is a per-workspace HMAC over the exact request bytes, in
`X-Cal-Signature-256`, compared with `timingSafeEqual`.

- No signature header → `401`, and not one row is read. Whatever workspace id is in the
  path, real or invented, the answer is the same and the database is never asked.
- A signature that does not verify → `401`, whether the workspace does not exist, has no
  calendar connected, or the bytes were signed with the wrong secret.
- A verified delivery's attendee name, address, title and slug go through the same
  `sanitiseInbound` rule the contact form's fields do — truncated rather than refused,
  and markup kept as text, because a booking is a meeting somebody is expecting to
  attend and is not worth losing over an attendee's punctuation. The dashboards escape
  it.
- Replays are idempotent on `(uid, trigger)` plus the ordering marker from #139, so a
  redelivered older event cannot put a cancelled meeting back on a dashboard.

---

## 4. The deploy agent (`apps/deploy-agent`, `sites` mode)

Not reachable from a site: bound behind the host firewall, and every endpoint but
`/tls-ask` requires the shared secret. It is in this document because it is the thing
that would matter most if a bearer token ever left the platform.

| Rule                                                                                                                                                                           | Where             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `Authorization: Bearer <secret>`, SHA-256 digests compared in constant time                                                                                                    | `bearer-auth.ts`  |
| An agent with **no** secret configured refuses everybody, rather than matching an empty bearer token                                                                           | `bearer-auth.ts`  |
| Slug must match `^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$`; anything with a path character in it is a `400`, and `new URL` normalises a traversal away before the router sees it | `index.ts`        |
| `DEPLOY_AGENT_ALLOWED_SLUGS`, when set, pins this host to the sites it serves — a deploy for anybody else's slug is a `403` even with a valid bearer                           | `index.ts`        |
| `artifact_sha256` is required and must be 64 hex characters; nothing is extracted without the caller having committed, out of band from the fetch, to what the bytes are       | `index.ts`        |
| No scheme but http/https, no credentials in the URL, and never a link-local or cloud metadata address — in every configuration, with no operator action                        | `artifact-url.ts` |
| `DEPLOY_AGENT_ARTIFACT_HOSTS`, when set, pins the origins an artifact may be fetched from                                                                                      | `artifact-url.ts` |
| Redirects are followed only to the same host as the URL we were given                                                                                                          | `index.ts`        |
| Response body bounded on the bytes that arrive, with a deadline over the whole fetch                                                                                           | `index.ts`        |
| Request body bounded the same way, for both the JSON envelope and a streamed tarball, whether or not a `Content-Length` was offered                                            | `index.ts`        |
| Every tar entry validated before extraction; staged, then renamed into place                                                                                                   | `tar-safety.ts`   |
| Per-slug lock, global deploy concurrency and a bounded queue                                                                                                                   | `index.ts`        |

Adversarial cases: `src/server-routes.test.ts` (`a hostile caller: …`),
`src/bearer-auth.test.ts`, `src/artifact-url.test.ts`.

## 5. The previews agent (`/previews/*` on the same host)

The **same binary**, started by a second systemd unit from a second env file with
`DEPLOY_AGENT_MODE=previews`. It is not a different service and it does not have a
different set of rules: the mode is read once at startup and changes only which Caddy
snippet gets written and whether the funnel may frame the result.

Every rule in §4 is upstream of that decision — authentication, the slug, the artifact
URL and the body cap all run in `routeRequest` and `handleDeploy` before the mode is
consulted. `server-routes.test.ts` asserts this from the source: the router mentions
`MODE` exactly once, in the health response, and never in front of a gate. If somebody
later adds a mode-dependent branch ahead of one, that test fails.

---

## 6. So what is a compromised site worth?

**It holds one token, and the token creates leads in one workspace.**

A site that has been taken over, or that was hostile from the day it was paid for, can:

- read its own `lead_capture_token` out of its own page source (so can any visitor);
- post enquiries into **its own** workspace, up to ten a minute, each of them
  deduplicated against an identical replay;
- send bodies that get refused — oversized, malformed, NUL-bearing, full of markup — at
  the cost of a 400 or a 413 per attempt, bounded by the same per-address rate;
- reach the marketing funnel endpoints any browser tab can already reach.

It **cannot**:

- read a lead, its own or anybody else's — the token is create-only and no read endpoint
  accepts it;
- write into another workspace — a token resolves to exactly one workspace id and every
  write goes through `withTenant`, so the tenant is structural rather than remembered;
- discover which other tokens exist — unknown, rotated and foreign tokens get one
  answer, and the per-address rate caps guessing at twenty attempts a minute;
- get anything through to a dashboard or an email as anything but text — React escapes
  what it renders, `email-templates/base.ts` escapes every block it draws, and
  `components/flowstarter/__tests__/hostile-content-rendering.test.tsx` asserts both;
- reach the deploy agent or the previews agent — different network position, and a
  shared secret it does not hold;
- cause a booking to appear — that needs a per-workspace HMAC it does not hold either;
- exfiltrate a visitor's form input to a third party from the page, because
  `connect-src` and `form-action` name only itself and the platform.

**The blast radius of losing a token is one rotation and one rebuild.** The dashboard's
rotate button mints a new one and the old one stops working that moment; the client's
site keeps posting the old token until it is rebuilt, and those posts are refused, which
is what a rotation means.

### What is accepted, and why

- **A server-side caller holding the token is not stopped by the origin rule.** It is
  slowed by the per-token rate and made idempotent by the replay window, and the worst
  it achieves is noise in one client's own enquiry list. Stopping it properly would mean
  a secret the site cannot publish, and the site publishes everything.
- **The token lookup is a Postgres index comparison, not a constant-time one.** The
  application-layer comparison is constant time and the four refusals are identical, so
  what remains is a timing signal on the database's own work. The per-address rate limit
  caps what can be done with it at twenty samples a minute.
- **`DEPLOY_AGENT_ALLOWED_SLUGS` and `DEPLOY_AGENT_ARTIFACT_HOSTS` are empty by
  default,** so an agent upgraded without new configuration behaves exactly as before.
  They are the two settings to add when a host is dedicated to a tenant.
