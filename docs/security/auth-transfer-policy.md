# Auth-transfer destination policy

Answers one question: **where may a Clerk sign-in ticket be sent?**

A sign-in ticket (`__clerk_ticket`) is a bearer credential. Whoever holds one
inside its lifetime becomes the user it was minted for — and for an operator
account that is every workspace on the platform, because `requireWorkspaceAccess`
lets operators through by design.

Two routes mint one:

| Route                             | Shape                                          | Caller                                                         |
| --------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `GET /api/auth/transfer-redirect` | 302 to the destination with `?__clerk_ticket=` | the middleware, on a cross-domain bounce out of `/admin/login` |
| `POST /api/auth/transfer-token`   | JSON `{ url }` carrying the ticket             | `AuthRedirectWrapper` and the login forms                      |

## What was wrong (Codex audit F01, Critical)

Both routes gated the destination with `isSafeRedirectUrl()`, which asks "is
this a page on our platform?" and decides by comparing the last two hostname
labels. Generated client sites are served at `{slug}.{platformDomain}`, so they
pass — and so does plain `http`. A tenant could publish a link to

```
/api/auth/transfer-redirect?redirect_url=https://attacker.flowstarter.net/collect
```

and be handed the ticket of whichever signed-in client or operator followed it.

## The rule now

`decideAuthTransferDestination()` in
[`packages/platform-config/src/auth-transfer-policy.ts`](../../packages/platform-config/src/auth-transfer-policy.ts).
It is pure: every answer is a function of the candidate URL and an environment
record, and `readAuthTransferEnvFromProcess()` is the only part that reads
`process.env`.

It is an **allow-list of origins**, not a shape test. In order:

1. The candidate must parse as an absolute URL with no backslash and no encoded
   separator (`%2f`, `%5c`) — otherwise `malformed`.
2. No userinfo. `https://code.flowstarter.net@attacker.example` is an authority
   in disguise — `embedded-credentials`.
3. `https` only. `http` is refused outside development — `insecure-scheme`.
4. No host carrying a `preview` label or a `pr-<n>` label, whatever else says
   so — `untrusted-origin`.
5. The origin must appear in the allow-list — `untrusted-origin`.
6. The path must match one of that surface's prefixes, on segment boundaries,
   and must not be under `/api` — `path-not-allowed`.

The refusal reason and the refused origin are logged by both routes.

### The allow-list

Derived from `resolvePlatformDomain()`, so it moves with the zone rather than
being written down twice:

| Surface | Origins                                            | Paths a ticket may land on                     |
| ------- | -------------------------------------------------- | ---------------------------------------------- |
| app     | `https://{domain}`                                 | `/admin`, `/dashboard`, `/projects`, `/unlock` |
| editor  | `https://code.{domain}`, `https://editor.{domain}` | any page                                       |
| library | `https://library.{domain}`                         | any page                                       |

plus, per environment, whatever the three env names below point at.

### What is refused, and why it is named here

- **Tenant sites** (`{slug}.{platformDomain}`) — the finding. Operator-owned
  hostname, tenant-owned contents.
- **Hosted previews** (`p-<id>.preview.{domain}`) — same: generated output.
- **PR staging slots** (`pr-<n>.staging.{domain}`) — ephemeral, deployed from
  an unmerged branch. Credentials never go there; the transfer flow is simply
  not available on a PR slot, by design.
- **Any `http` destination** outside development.
- **Any `/api/...` path**, on every surface: a ticket belongs on a page a person
  is about to look at, not on a machine endpoint that would log it.

Points 1–4 also run over the _configured_ origins, so a mistyped
`AUTH_TRANSFER_EDITOR_ORIGIN` cannot reopen the hole by naming one of them.

### Binding the ticket to the destination

- A ticket is minted **only after** the destination is allowed, never before,
  so a refusal costs nothing and leaks nothing.
- It lives 60 seconds.
- `POST /api/auth/transfer-token` hands a ticket only to a browser already on
  an allow-listed origin: the request's `Origin` header has to name one, and
  that check runs before the session is even read. A tenant page cannot fetch
  a ticket for itself whatever it puts in the body.
- Both responses carry `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`, so the ticket is not stored by a cache and
  does not travel onward in a `Referer`.
- A failed mint on the GET route lands the visitor on the dashboard. It does
  **not** fall back to forwarding them to the destination.

Clerk's backend API takes no destination parameter on a sign-in token
(`createSignInToken` accepts `userId`, `orgId`, `expiresInSeconds` and nothing
else), so the ticket cannot be cryptographically bound to the origin it was
minted for. The allow-list plus the caller-origin check plus the 60-second
lifetime are what bounds it today. A single-use nonce keyed to the destination
origin, redeemed by the destination rather than carried in the URL, is the next
step and needs storage this change does not add.

## `isSafeRedirectUrl` is still there

It stays for ordinary navigation, where the worst outcome is landing on the
wrong page of the platform. It must never gate a credential, and
`src/app/api/auth/__tests__/transfer-routes.test.ts` enforces that as a lint: it
reads both route files off disk, strips their comments, and fails if either one
names `isSafeRedirectUrl`, `isTrustedHost`, `getAllowedRedirectOrigins` or
`getRootDomain`.

## Environment

Defaults come from the platform domain and need no configuration in production.
Set these when a surface answers somewhere else — a staging slot, a LAN dev
machine, a self-hosted editor:

| Name                           | Means                          | Falls back to                                      |
| ------------------------------ | ------------------------------ | -------------------------------------------------- |
| `AUTH_TRANSFER_APP_ORIGIN`     | origin of the main app         | `NEXT_PUBLIC_SITE_URL`, then `NEXT_PUBLIC_APP_URL` |
| `AUTH_TRANSFER_EDITOR_ORIGIN`  | origin of the editor           | `NEXT_PUBLIC_EDITOR_URL`                           |
| `AUTH_TRANSFER_LIBRARY_ORIGIN` | origin of the template library | —                                                  |

Each takes one absolute origin. An `http` value is accepted **only** when the
process resolves to `development` (`FLOWSTARTER_ENV=development`, or a
`NODE_ENV` that is neither `production` nor `staging`) — which is how
`http://localhost:3000` and a LAN address work on a laptop and cannot work on a
deployed host. Staging runs with `NODE_ENV=production` and names itself through
`FLOWSTARTER_ENV`, so it never reaches that branch.

## Tests

- `packages/platform-config/test/auth-transfer-policy.test.ts` — the rule
  itself: every destination class, every refusal reason, the environment matrix,
  and the open-redirect shapes (`//`, `@`, backslash, `%2f`, unicode homograph).
- `apps/flowstarter-main/src/app/api/auth/__tests__/transfer-routes.test.ts` —
  the same destination table driven through **both real handlers**, asserting
  that an allowed destination gets a ticket and a refused one gets no ticket at
  all, plus the caller-origin rule and the lint above.
