# Self-hosted Cal.com

The platform runs its own Cal.com. Every client workspace gets a booking page
on it, created by the platform on claim, and the link goes into the same
`workspaces.cal_com_url` column a pasted link would have gone into — so the
built site, the dashboard embed and the bookings tile all work unchanged.

| Fact            | Value                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staging URL     | https://cal.flowstarter.dev                                                                                                                         |
| Production URL  | `cal.flowstarter.net` — **does not exist yet**, see "What production needs"                                                                         |
| Host            | `fs-sites-01`, 178.104.218.87, alongside the app slots and the Supabase CLI stack                                                                   |
| Web image       | `calcom/cal.com:v6.2.0` (digest pinned by tag; published 2026-03-02)                                                                                |
| Database        | its own Postgres 16 container, named volume `flowstarter-cal-db-data`                                                                               |
| Compose project | `flowstarter-cal`, from `deploy/hetzner-staging/cal/docker-compose.yml`                                                                             |
| Ports           | `127.0.0.1:3200` web, `127.0.0.1:5433` Postgres. Nothing published publicly                                                                         |
| Caddy vhost     | `deploy/hetzner-staging/cal/cal.caddy` → `/etc/caddy/platform/cal.caddy`                                                                            |
| DNS             | `cal.flowstarter.dev` A `178.104.218.87`, dns-only, TTL 60, record id `401c3c48bdd20f48c5878e7b17172558` (new record, nothing existing was touched) |
| Secrets         | `/etc/flowstarter/cal.env`, root, mode 600                                                                                                          |
| Operator script | `deploy/hetzner-staging/scripts/cal-stack.sh`                                                                                                       |

## The version pin, and why it is where the story starts

**Cal.com went closed source in April 2026.** The repository now known as
`calcom/cal.diy` is the community edition; the product running on app.cal.com
moved somewhere that cannot be read. Two consequences decide everything below:

- The last **published** image on Docker Hub is `calcom/cal.com:v6.2.0`, from
  2026-03-02. `calcom/cal.diy` exists as a Docker Hub repository but has never
  had a tag pushed to it (registered 2026-04-14, zero pulls, zero tags as of
  2026-09-13). So the choice of image is not really a choice: v6.2.0 or build
  the web app yourself.
- The community edition dropped API v1 entirely. At the `v6.2.0` tag it is
  still there, which matters for the evaluation below, but it is not coming
  back.

So the pin is `v6.2.0`, deliberately, and it will not float. When it is time to
move, the things to re-check are listed under "What a Cal upgrade has to
re-prove".

## How the platform provisions — and the two paths that were rejected

The brief was to find the least brittle way to create a user, a schedule, an
event type and a webhook **without driving a browser session**. Three
candidates, evaluated on the box:

### 1. The web image's own HTTP routes — not enough on their own

`calcom/cal.com:v6.2.0` ships exactly one app:

```
$ docker run --rm --entrypoint sh calcom/cal.com:v6.2.0 -c 'ls /calcom/apps'
web
```

Its route manifest carries `/api/auth/setup`, `/api/auth/signup`,
`/api/auth/forgot-password` and a long list of cron and OAuth endpoints —
**and nothing that creates a schedule, an event type or a webhook.** Those live
behind tRPC, which wants a NextAuth session cookie. The web app can make a
user; it cannot make a bookable calendar.

One of those routes is still load-bearing and is used: `POST /api/auth/setup`
creates the **first** admin user and refuses once any user exists, which is
exactly the idempotent bootstrap an operator wants (`cal-stack.sh admin`).

### 2. Cal.com's API v1 — the obvious answer, and it is licensed

`apps/api/v1` at the pinned tag is the documented, key-authenticated API for
precisely the four resources this product needs, and Cal never published an
image for it. Building one from the pinned source was authorised, and was
attempted: the Dockerfile worked through two real failures (the root
`postinstall` runs `husky install`, which exits non-zero with no `.git`, so
`HUSKY=0` is needed; and `packages/platform/utils` type-checks itself against
`luxon`, whose `@types` are declared only in `apps/api/v2`, so v2 has to be
copied into the build context even though it is never built).

**Then the licence check ended it.** `apps/api/v1/LICENSE` is the Cal.com
Commercial License: production use requires an Enterprise subscription, with
copying and modification permitted only "for development and testing
purposes". And the code enforces it — `apps/api/v1/lib/helpers/verifyApiKey.ts`:

```ts
const hasValidLicense = await licenseKeyService.checkLicense();
if (!hasValidLicense && IS_PRODUCTION) {
  return res
    .status(401)
    .json({
      message: 'Invalid or missing CALCOM_LICENSE_KEY environment variable',
    });
}
```

with `checkLicense()` returning false for any self-hoster without a key
(`NoopLicenseKeyService`, used whenever `CALCOM_LICENSE_KEY` is unset, returns
`process.env.NEXT_PUBLIC_IS_E2E === "1"`). There **is** an env var that would
switch the gate off — `IS_PRODUCTION` is `CALCOM_ENV || NODE_ENV`, so
`CALCOM_ENV=development` makes every request pass — and setting it would be
circumventing a paid licence on a production system. **That is Darius's call to
make with money, not a flag for an agent to flip.** The build was stopped, the
image was never deployed, and the Dockerfile is not in this repo.

### 3. Cal's own Postgres, as a least-privilege role — what shipped

The provisioner writes to the database Cal owns, over loopback, as a role that
can do six things and nothing else. Cal's web app (AGPLv3, self-hosting it is
what the licence is for) serves the booking pages, the login and the password
reset; the platform writes the rows.

The trade is honest and worth stating: **this couples the product to one
pinned version of a schema it does not own.** That is mitigated three ways —
the pin above, the six statements being isolated in one file
(`apps/flowstarter-main/src/lib/flowstarter/cal-provisioning.ts`, all
parameterised, none interpolated), and the rules around them being pure and
tested separately from anything that touches Cal.

What a provisioning run writes, in order:

| #   | Table                           | Why                                                                                                                                                                                 |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `users`                         | the client's Cal account: workspace slug as username, workspace email, `completedOnboarding` true (we did the onboarding), `emailVerified` set (the address came from a paid claim) |
| 2   | `Schedule` + `Availability`     | weekday hours from config; also becomes the user's `defaultScheduleId` when they have none                                                                                          |
| 3   | `EventType` + `_user_eventtype` | the "Intro call", with one extra booking question                                                                                                                                   |
| 4   | `Webhook`                       | `BOOKING_CREATED` / `BOOKING_RESCHEDULED` / `BOOKING_CANCELLED` → `POST /api/integrations/cal/{workspaceId}`, signed with the workspace's own secret                                |

**`_user_eventtype` is the row that is easy to miss.** Cal resolves a public
booking page through the event type's `users` relation, not through its
`userId` column. Without that join row `/{username}/{slug}` answers 404 while
the event type sits in the database looking perfectly correct. Measured on
v6.2.0, both ways round.

Everything is idempotent: the user is found by email, the schedule by name, the
event type by slug, and the webhook by the `(userId, subscriberUrl)` pair Cal
already makes unique. A rerun changes nothing and re-reports the same link,
which is what makes it safe on the claim path, on a re-claim, and on a button a
client can press twice.

### The client's password

We never set one. The "your booking page is ready" email sends the client to
Cal's own reset flow at `{CAL_BASE_URL}/auth/forgot-password`, so the only
person who ever knows their password is them. They can ignore the email
entirely: the booking page works from the moment it is provisioned.

## Configuration

`/etc/flowstarter/cal.env` (root, 600) — **keys only, never values**:

```
CAL_POSTGRES_USER  CAL_POSTGRES_DB  POSTGRES_PASSWORD
DATABASE_URL  DATABASE_DIRECT_URL  DATABASE_HOST
NEXTAUTH_SECRET  NEXTAUTH_URL  CALENDSO_ENCRYPTION_KEY
NEXT_PUBLIC_WEBAPP_URL  CALCOM_TELEMETRY_DISABLED  NEXT_PUBLIC_DISABLE_SIGNUP
API_KEY_PREFIX
EMAIL_FROM  EMAIL_FROM_NAME  EMAIL_SERVER_HOST  EMAIL_SERVER_PORT
EMAIL_SERVER_USER  EMAIL_SERVER_PASSWORD
CAL_ADMIN_EMAIL  CAL_ADMIN_USERNAME  CAL_ADMIN_PASSWORD
CAL_PROVISIONER_ROLE  CAL_PROVISIONER_PASSWORD
```

No licence key is set, and none should be: `CALCOM_LICENSE_KEY` and
`NEXT_PUBLIC_LICENSE_CONSENT` are both absent, which is what keeps this a
plain AGPL self-host. Email goes out through Resend's SMTP endpoint with the
same key the platform already uses.

`NEXT_PUBLIC_DISABLE_SIGNUP=true` closes public signup in the app, and the
Caddy vhost answers 404 for `/signup` and `/api/auth/signup` besides. Two
layers, because the whole point of this instance is that every account on it
was created by us.

### What the app reads

In `/etc/flowstarter/staging.env` and `/etc/flowstarter/prod.env`:

| Key                | Staging                                      | Production                               |
| ------------------ | -------------------------------------------- | ---------------------------------------- |
| `CAL_BASE_URL`     | `https://cal.flowstarter.dev`                | empty until `cal.flowstarter.net` exists |
| `CAL_DATABASE_URL` | the least-privilege role on `127.0.0.1:5433` | empty                                    |

Both empty is a supported state, and it is the state a developer's laptop is
in: `isCalProvisioningConfigured()` is false, provisioning is skipped, the tile
says "Not yet" rather than "Failed", and no claim is affected. The optional
knobs — event title, slug, length, schedule name, weekdays, hours, default
timezone and locale, and the extra booking question — are listed at the top of
`cal-provisioning.ts` with their defaults, and none of them is a literal buried
in the logic.

`CAL_BASE_URL` does one more thing worth knowing: it is what teaches
`cal-link.ts` and the site generator's `normalizeCalTarget` that this host is
a legitimate booking host. An environment with no instance keeps exactly the
old, narrower cal.com-only allow list, so a production build can never embed a
staging calendar.

### The provisioner role

Created and refreshed by `cal-stack.sh provisioner-role`. `SELECT`, `INSERT`
and `UPDATE` on six tables (`users`, `Schedule`, `Availability`, `EventType`,
`_user_eventtype`, `Webhook`) and `USAGE, SELECT` on their sequences. No
`DELETE`, no DDL, nothing on `Booking`, `ApiKey`, `UserPassword` or any other
table. If the app is ever compromised, what it can do to Cal is bounded by
that grant rather than by our intentions.

## Running it

```sh
cal-stack.sh up                # start web + db, wait for both to be healthy
cal-stack.sh status            # what is running, on which ports, from which image
cal-stack.sh check             # REQUIRED: every published port is loopback-only
cal-stack.sh admin             # create the first admin user (idempotent)
cal-stack.sh provisioner-role  # create/refresh the least-privilege role
cal-stack.sh health            # login page 200 over HTTPS, /signup 404
cal-stack.sh down              # stop. It will refuse `-v`: the volume is client data
```

`check` is not decoration. `/etc/docker/daemon.json`'s `{"ip":"127.0.0.1"}`
only covers the **default** bridge; a compose-created network ignores it and
would publish on `0.0.0.0`, which is how the Supabase stack once ended up
exposed on this same box. The compose file pins
`com.docker.network.bridge.host_binding_ipv4` and binds every port to
`127.0.0.1` explicitly, and `check` is what proves both are still true.

## Backups

`deploy/hetzner-staging/scripts/backup.sh` dumps the Cal database nightly,
alongside every Supabase stack, and the dump is listed in that night's
`manifest.sha256`. This is not optional data: it holds every client's booking
page and every booking taken through it, and none of it is reproducible from
git. Restores go through `restore.sh`, same as any other dump.

## What a Cal upgrade has to re-prove

Moving off `v6.2.0` means re-checking, on a throwaway workspace, that:

1. the six statements in `cal-provisioning.ts` still match the schema — in
   particular that `users` still takes `uuid`/`completedOnboarding`, that
   `Availability` still stores `days` as an int array, and that `Webhook`
   still has the `(userId, subscriberUrl)` unique pair;
2. `_user_eventtype` is still what makes a public booking page resolve;
3. `POST /api/auth/setup` still bootstraps the first admin;
4. the booking page still posts a `BOOKING_CREATED` our webhook accepts —
   the signature header is `x-cal-signature-256` and the body shape is
   documented in `docs/integrations/cal-com.md`.

## What production needs

Nothing here is production. To get there, in order:

1. **Decide the licence question.** Everything above is AGPL self-hosting and
   costs nothing. If Darius wants Cal's own API v1 instead of the SQL client —
   fewer coupling worries, a supported contract — that is a Cal.com Enterprise
   subscription, and then `CALCOM_LICENSE_KEY` goes in `cal.env` and a second
   implementation of `CalProvisioningClient` replaces the Postgres one. The
   interface exists for exactly that swap.
2. **Create `cal.flowstarter.net`.** A new A record in the `flowstarter.net`
   zone, a second compose project (or the same one on a production box), its
   own `cal.env` with fresh secrets, its own admin account.
3. **Fill in `CAL_BASE_URL` and `CAL_DATABASE_URL` in `/etc/flowstarter/prod.env`.**
   Until then production claims skip provisioning silently, which is the
   intended behaviour and not a failure.
4. **Point production's webhook URL at production.** The subscriber URL is
   built from `NEXT_PUBLIC_SITE_URL`, so it follows the environment; a
   workspace provisioned on staging keeps a staging webhook, which is one more
   reason not to migrate staging workspaces into production.
5. **Consider where Cal runs.** It is two containers and about 800 MB resident
   next to seven app slots and a Supabase stack. It fits on the current box; it
   is also the obvious first thing to move when the box gets busy.
