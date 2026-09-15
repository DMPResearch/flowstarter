# Hetzner platform slots (flowstarter-main)

Runs the Next.js app in Docker on the **same Hetzner Caddy host** as client
sites, but **isolated** from deploy-agent. Three kinds of slot share one
compose file and one pair of scripts: `main` and `pr-N` for staging, and `prod`
for production at `flowstarter.net`.

| Path                           | Owner                                               |
| ------------------------------ | --------------------------------------------------- |
| `/var/www/sites/*`             | Client static sites (deploy-agent)                  |
| `/opt/flowstarter/staging`     | Platform compose + scripts (all slots)              |
| `/etc/caddy/platform/*.caddy`  | Platform vhosts (`main`, `pr-*`, `prod`)            |
| `/etc/flowstarter/staging.env` | Staging secrets, mode 600                           |
| `/etc/flowstarter/prod.env`    | Production secrets, mode 600                        |
| `/etc/flowstarter/tls/`        | Optional Cloudflare Origin CA cert for prod         |
| `/etc/flowstarter/backup.env`  | Backup config (retention, encryption, S3), mode 600 |
| `/var/backups/flowstarter/`    | Nightly backups, see `docs/operations/backups.md`   |
| `/opt/flowstarter/cal`         | Self-hosted Cal.com compose file + vhost snippet    |
| `/opt/flowstarter/editor`      | Flowstarter editor compose file + stack script      |
| `/etc/flowstarter/editor.env`  | Editor secrets, mode 600                            |
| `/etc/flowstarter/cal.env`     | Cal secrets and admin credentials, mode 600         |
| `/opt/flowstarter/build-worker` | Build worker compose file                          |
| `/etc/flowstarter/build-worker-staging.env` | Build worker secrets, mode 600         |
| `/srv/flowstarter/build-worker` | Build worker state: local sites repo, per-client worktrees, packaged artifacts, exported build output. Bind-mounted into the worker at this same absolute path — see "The build worker" |

The directory is still called `staging` so nothing that already references it
breaks. It holds every slot.

## Slots

| Slot   | URL                                    | Port   | Env file      | Container                  | Supabase        |
| ------ | -------------------------------------- | ------ | ------------- | -------------------------- | --------------- |
| `main` | `https://staging.flowstarter.dev`      | 3000   | `staging.env` | `flowstarter-staging-main` | local CLI stack |
| `pr-N` | `https://pr-N.staging.flowstarter.dev` | 3000+N | `staging.env` | `flowstarter-staging-pr-N` | local CLI stack |
| `prod` | `https://flowstarter.net` (+ `www`)    | 3100   | `prod.env`    | `flowstarter-prod`         | hosted project  |

`deploy-slot.sh <slot> <image> [port]` deploys one; `destroy-slot.sh <slot>`
tears it down. Destroying `prod` additionally needs `DESTROY_PROD=1` in the
environment, because nothing in CI ever asks for it and a typo should not take
the site down. Every deploy also runs an image-retention pass, and destroying
a slot cleans up its own image if nothing else still runs it — see "Disk"
below.

### What is different about `prod`

- It runs **none** of the Supabase CLI stack steps: no `ensure`, no `check`, no
  `migrate`, no `write-env`. It talks to the hosted Supabase project. Schema
  changes are applied to that project deliberately, by hand.
- Its health gate asserts `"env":"production"` from `/api/health` instead of
  `"target":"local"`. A staging image landed on port 3100 by mistake reports
  `"env":"staging"` and never gets a Caddy snippet.
- Its Caddy snippet serves two hostnames and 301-redirects `www` to the apex.

## Disk

2026-09-15 incident: the root disk (150 GB) on fs-sites-01 filled to 100%
because every deploy pulls its own tagged image
(`ghcr.io/dmpresearch/flowstarter-main:<sha>`, 1.6-2.05 GB each) and nothing
ever removed an old one — 173 images, 132.6 GB reclaimable by the time
anyone noticed, cleaned up by hand with `docker image prune -af --filter
until=1h` plus `docker builder prune -af`. The local Supabase DB container
went unhealthy on the full disk and every staging deploy lane (`main` and
every `pr-N`) failed at "ensure stack" — a disk problem was first visible as
a database problem, which is why the fix lives in the deploy path itself
rather than in a separate cron job nobody watches.

**`scripts/prune-images.sh`** is that fix. `deploy-slot.sh` runs it twice on
every deploy: once as a preflight, before anything else (including the
Supabase-stack steps), and once more after a successful deploy. The
retention rule: an image is kept if some running container uses it, or if
it is one of the `FLOWSTARTER_IMAGE_KEEP_COUNT` (default 5, see
`DEFAULT_IMAGE_KEEP_COUNT` in the script) most recently created images in
`FLOWSTARTER_IMAGE_REPO` (default `ghcr.io/dmpresearch/flowstarter-main`).
Everything else in that repo is removed with a non-forced `docker rmi`
(never `-f` — the daemon itself is the check that nothing else needs it),
and dangling build cache is pruned alongside it (`docker builder prune`, no
`-a`, so cache that could still save a future build is left alone). Run it
by hand any time, with `--dry-run` to see what a real pass would do without
removing anything:

```bash
sudo /opt/flowstarter/staging/prune-images.sh --dry-run
```

The preflight half additionally refuses to deploy — before the image pull,
before anything touches shared state — if free space on
`FLOWSTARTER_DISK_CHECK_PATH` (default `/`) is still below
`FLOWSTARTER_DISK_FLOOR_MB` (default 10240, 10 GiB) once that retention pass
has run. The post-deploy half is best-effort: a failure there is logged but
never turns an already-successful deploy into a failed one — the next
deploy's own preflight (or its own post-deploy pass) catches up regardless.

All four knobs (`FLOWSTARTER_IMAGE_REPO`, `FLOWSTARTER_IMAGE_KEEP_COUNT`,
`FLOWSTARTER_DISK_FLOOR_MB`, `FLOWSTARTER_DISK_CHECK_PATH`) are named
variables with defaults, never a literal buried in the deletion or the disk
check — same pattern as `backup.sh`'s `DEFAULT_KEEP_DAILY`/`WEEKLY`. Set them
as real environment variables, or write them into an optional
`/etc/flowstarter/staging-ops.env` (mode 600; nothing writes it but a
person, unlike `staging.env`/`prod.env`) so an operator can change either
knob without touching CI or either script — see `prune-images.sh`'s own
header comment for the exact precedence.

**`destroy-slot.sh`** resolves the image a slot's container was running
*before* removing the container, then removes that image too, but only if
no other container (any slot, any state) still references it — same
non-forced `docker rmi`. So a closed PR's image does not sit on disk until
`prune-images.sh`'s keep-count eventually gets around to it on its own.

Tests: `scripts/prune-images.test.sh` exercises the retention rule itself
against a stubbed `docker`; the "image retention" and "image cleanup" cases
in `scripts/deploy-slot.test.sh` prove `deploy-slot.sh` and `destroy-slot.sh`
call it at the right points and react correctly to its exit code.

## Hostnames and DNS

Do **not** CNAME these to the local Cloudflare tunnel (`flowstarter-dev`). That
tunnel still owns `www.flowstarter.dev`, `workflows`, the `flowstarter.dev`
apex, `admin`, and the generic `*.flowstarter.dev` catch-all for laptop demos,
see `scripts/cloudflared-flowstarter-workflows.yml`.

Staging (dns-only, so Caddy terminates TLS with a public certificate):

```
staging.flowstarter.dev      A      <HETZNER_IP>    DNS only
*.staging.flowstarter.dev    A      <HETZNER_IP>    DNS only
```

Production (**proxied**, orange cloud):

```
flowstarter.net              A      <HETZNER_IP>    Proxied
www.flowstarter.net          A      <HETZNER_IP>    Proxied
```

Caddy base file must include:

```caddy
import /etc/caddy/platform/*.caddy
```

Do **not** put these snippets under `/etc/caddy/sites/` (deploy-agent owns that).

## TLS for production

Cloudflare proxies `flowstarter.net`, so Caddy never sees a Let's Encrypt
HTTP-01 challenge and must not ask for a public certificate. `deploy-slot.sh`
picks one of two modes when it writes `/etc/caddy/platform/prod.caddy`:

1. **Cloudflare Origin CA (preferred).** If both
   `/etc/flowstarter/tls/flowstarter.net.crt` and `.key` exist, the snippet
   gets `tls <crt> <key>`. Set Cloudflare SSL/TLS to **Full (strict)**.

   Mint the certificate in the Cloudflare dashboard, SSL/TLS, Origin Server,
   Create Certificate, covering `flowstarter.net` and `*.flowstarter.net`, then:

   ```bash
   sudo mkdir -p /etc/flowstarter/tls
   sudo install -m 600 /dev/null /etc/flowstarter/tls/flowstarter.net.key
   sudo install -m 644 /dev/null /etc/flowstarter/tls/flowstarter.net.crt
   # paste the certificate and the private key into those two files
   sudo chown caddy:caddy /etc/flowstarter/tls/flowstarter.net.*
   ```

2. **`tls internal` (fallback).** With no Origin CA certificate on disk the
   snippet uses Caddy's own local CA. Cloudflare cannot chain that to a public
   root, so Cloudflare SSL/TLS must then be **Full**, _not_ Full (strict). The
   snippet carries that warning as a comment.

Re-running `deploy-slot.sh prod` after dropping the certificate in place is
what switches mode 2 to mode 1. Nothing else has to change.

## The production env file

`/etc/flowstarter/prod.env`, mode 600, owned by root. It is the only place on
the box that holds production credentials, and it is never written by CI.

```
FLOWSTARTER_ENV=production          # upserted by deploy-slot.sh, do not fight it
PLATFORM_DOMAIN=flowstarter.net     # @flowstarter/platform-config falls back to
                                    # flowstarter.dev when this is unset
NEXT_PUBLIC_SITE_URL=https://flowstarter.net
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<hosted project anon key>
SUPABASE_SERVICE_ROLE_KEY=<hosted project service role key>
CLERK_SECRET_KEY=<production Clerk secret>
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<production Clerk publishable>
STRIPE_SECRET_KEY=<test-mode key until launch>
STRIPE_WEBHOOK_SECRET=<test-mode webhook secret until launch>
HANDOFF_SECRET=<HMAC key>
RESEND_API_KEY=<transactional email key>
AUTH_TRANSFER_APP_ORIGIN=https://flowstarter.net     # optional; see below
AUTH_TRANSFER_EDITOR_ORIGIN=https://code.flowstarter.net
AUTH_TRANSFER_LIBRARY_ORIGIN=https://library.flowstarter.net
# FLOWSTARTER_PUBLIC_APP_ORIGIN=      # optional; unset here, see below
# FLOWSTARTER_PUBLIC_CALLBACK_ORIGIN= # optional; development-only, see below

# Discovery-funnel preview publishing (apps/flowstarter-main/src/lib/discovery).
# The previews deploy-agent's own instance, port and secret — never the
# paid-site deploy-agent's. Already set on this box: loopback 8444, and the
# previews agent's own shared secret (not the one at 8443).
FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL=http://127.0.0.1:8444
FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET=<previews deploy-agent's shared secret>
LINKEDIN_CLIENT_ID=                 # portrait from social, see the note below
LINKEDIN_CLIENT_SECRET=
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=

# Who operates Flowstarter, printed on /terms and /privacy. Empty here on
# purpose: there is no registered entity yet. See the note below.
FLOWSTARTER_LEGAL_ENTITY_NAME=
FLOWSTARTER_LEGAL_REGISTRATION_NUMBER=
FLOWSTARTER_LEGAL_VAT_NUMBER=
FLOWSTARTER_LEGAL_ADDRESS=
FLOWSTARTER_LEGAL_JURISDICTION=
FLOWSTARTER_LEGAL_COURT=
```

The six `FLOWSTARTER_LEGAL_*` lines are the operator identity the terms and
privacy pages print, and they are read at run time by
`apps/flowstarter-main/src/lib/legal/company.ts`. They are empty above because
they are empty on the box: Flowstarter is not incorporated yet.

**All six or none.** With any one of them missing, both pages say "Operator
identity pending registration" in place of a company name, the terms page
declines to name a governing law or a court, and the draft notice stays up on
terms, privacy and cookies. Filling five of six does not get you five sixths
of a disclosure; it gets you a page that reads as complete and is not, which
is the exact failure the module exists to prevent. Fill all six on the same
edit, restart the slot, and the draft notice disappears from all three pages
at once.

There is nothing to put here until Darius decides the company structure. Do
not write a placeholder: a plausible-looking registration number on a live
terms page is worse than the honest blank, because a blank invites a question
and a wrong number answers it.

The three `AUTH_TRANSFER_*_ORIGIN` lines name the only origins a Clerk sign-in
ticket may be sent to. They are optional here, because the policy already
derives exactly those three values from `PLATFORM_DOMAIN`; write them out when a
surface answers somewhere other than its default subdomain. They are **not**
optional on the `main` staging slot, which answers on `staging.flowstarter.dev`
rather than the bare domain — `NEXT_PUBLIC_SITE_URL` covers the app there, and
the editor and library need their own line if the handoff is used.

A `pr-N` slot gets none of them, and cannot: the policy refuses `pr-<n>.` and
`*.preview.*` hosts outright, so no ticket is ever minted for an ephemeral slot.
`http://` values are refused anywhere that is not a development process, which
is every slot on this box. See `docs/security/auth-transfer-policy.md`.

The four portrait lines may be left empty: unset, the LinkedIn and Instagram
connect buttons render disabled, saying "this connection is not switched on
yet", and nothing else in the funnel changes. See `docs/portrait-sources.md`
for the two developer apps that produce those credentials and for the
redirect URLs, which must match byte for byte: that URL is
`FLOWSTARTER_PUBLIC_APP_ORIGIN` (below) plus `/api/connect/<provider>/callback`
now, the same override every other public-origin call site reads, not a
redirect-base variable of its own — pin `FLOWSTARTER_PUBLIC_APP_ORIGIN` here
so a `pr-N` slot sends the URL the provider has on file rather than its own
ephemeral hostname.

The `NEXT_PUBLIC_*` values also exist as Depot secrets (`PROD_NEXT_PUBLIC_*`),
because those are inlined into the client bundle at **build** time while the
file above is read at **run** time. Keep the two in step; a mismatch shows up
as a browser talking to one project and the server to another.

`PLATFORM_DOMAIN` matters because `@flowstarter/platform-config` resolves the
platform domain from the request hostname first and falls back to
`flowstarter.dev`. That fallback is right for staging and wrong for production,
so production names its domain explicitly. Staging needs no such line.

**`FLOWSTARTER_PUBLIC_APP_ORIGIN` / `FLOWSTARTER_PUBLIC_CALLBACK_ORIGIN`**
(`packages/platform-config/src/public-origin.ts`) name where the app itself is
publicly served, and where a third party's servers (Cal.com's webhook
delivery) must be able to reach it — a different question from `PLATFORM_DOMAIN`,
which names the zone _client sites_ are hosted under. The two only agree in
production. Neither needs setting on `main` or `prod`: `publicAppOrigin()`
already derives `https://flowstarter.net` in production and
`https://staging.flowstarter.dev` in staging from `FLOWSTARTER_ENV` alone.
That is also why a client site's contact-form endpoint, its Cal.com webhook
subscriber URL, every Stripe checkout's success/cancel URL, every
notification email's dashboard link, and the portrait connect flows' OAuth
`redirect_uri` all now resolve correctly there without either variable —
before this rule existed (and before every one of those call sites read it),
each was built a different way: from the bare platform domain (a 404 on this
box outside production), from `NEXT_PUBLIC_SITE_URL` (a LAN address on a
developer's laptop, which is also what used to 500 the signed-in deposit
checkout on a LAN dev stack), or from its own redirect-base variable. Set
`FLOWSTARTER_PUBLIC_APP_ORIGIN` on a `pr-N` slot only if that slot's own
contact-form, Cal.com, Stripe and portrait-connect testing need to resolve to
its own ephemeral hostname (`https://pr-N.staging.flowstarter.dev`) rather
than the `main` slot's; leave it unset otherwise. Set
`FLOWSTARTER_PUBLIC_CALLBACK_ORIGIN` only in development, for a tunnel in
front of a laptop Cal.com's servers cannot otherwise reach.

`deploy-slot.sh` rewrites the `FLOWSTARTER_ENV` line on every deploy, so a slot
cannot inherit the wrong environment from a stale file.

## The DNS cutover (apex and www)

This is the only step that moves live traffic, and it is the only step no
workflow performs. Do it **after** the `prod` slot is deployed and answering,
never before: the slot is reachable on the box long before DNS points at it.

**Before you change anything, write the current records down.** They are the
rollback. In the Cloudflare dashboard, DNS, export or screenshot the two rows:

| Name                  | Type | Content                     | Proxy |
| --------------------- | ---- | --------------------------- | ----- |
| `flowstarter.net`     | ?    | record this before changing | ?     |
| `www.flowstarter.net` | ?    | record this before changing | ?     |

They currently point at Netlify. Netlify's shape is an apex `A` at its load
balancer address and a `www` `CNAME` at `<site>.netlify.app`, but read the
actual values rather than trusting that.

Then:

1. Confirm the slot answers on the box, with DNS still pointing at the old
   host:

   ```bash
   curl -fsS http://127.0.0.1:3100/api/health
   # expect {"ok":true,"supabase":{"env":"production",...}}
   ```

2. Confirm Caddy is serving both hostnames locally, bypassing DNS:

   ```bash
   curl -fsS -k --resolve flowstarter.net:443:127.0.0.1 https://flowstarter.net/api/health
   curl -fsS -k -o /dev/null -w '%{http_code} %{redirect_url}\n' \
     --resolve www.flowstarter.net:443:127.0.0.1 https://www.flowstarter.net/
   # expect 301 https://flowstarter.net/
   ```

3. Set the Cloudflare SSL/TLS mode **first**, before the records move:
   **Full (strict)** if the Origin CA certificate is installed, **Full**
   otherwise. Getting this wrong is what produces a 526 after the cutover.

4. Lower the TTL on both records to 60 seconds and wait out the old TTL. A
   rollback is only as fast as the TTL you set before you needed it.

5. Change both records to `A <HETZNER_IP>`, **Proxied**.

6. Verify from outside the box:

   ```bash
   curl -fsS https://flowstarter.net/api/health
   curl -fsS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.flowstarter.net/
   ```

   Then run the synthetic:

   ```sh
   gh api repos/DMPResearch/flowstarter/dispatches -f event_type=prod-deploy-succeeded
   ```

7. Raise the TTL back to automatic once it has been healthy for a day.

**Rollback.** Put the two recorded values back, restore the previous proxy
setting, and set the SSL/TLS mode the old host needed (Netlify wanted Full
(strict)). The `prod` slot can stay running; it is unreachable from the
internet the moment DNS stops pointing at it. To roll back the application
rather than the DNS, redeploy the previous release tag, see
`docs/release-process.md`.

## Database

Staging does not use a hosted Supabase project. It runs the **Supabase CLI
local stack ON THE HETZNER HOST**, the same `supabase start` developers and
the quality gate use, bound to loopback. Every staging slot, `main` and
every `pr-N`, talks to `http://127.0.0.1:54321` (API) and `127.0.0.1:54322`
(Postgres). There is exactly one stack per host, shared by every slot; slots
are not separate databases.

`docker-compose.yml` uses `network_mode: host` so the container's
`127.0.0.1:54321` is the host's stack, with no bridge NAT and no published
port. That is also how the container reaches the deploy-agents on
`127.0.0.1:8443` / `:8444`.

**Why the firewall is not optional.** The CLI stack signs every token with
the published Supabase CLI demo JWT secret
(`super-secret-jwt-token-with-at-least-32-characters-long`), the same string
every `supabase start` on every machine uses. That is fine for a throwaway
local stack and is exactly why it must never be reachable from the internet.
Two things make that true by construction, not by discipline:

1. `/etc/docker/daemon.json` must set the default publish address to
   loopback, because Docker normally publishes on `0.0.0.0` and bypasses
   `ufw` entirely:

   ```json
   { "ip": "127.0.0.1" }
   ```

   Restart Docker after changing it (`systemctl restart docker`).

2. A **Hetzner Cloud Firewall** (attached to the server, not `ufw`) allowing
   inbound only on 22, 80, and 443. This is enforced upstream of Docker, so a
   misconfigured `daemon.json` or a stray `-p 0.0.0.0:...` cannot reopen the
   stack to the world.

`scripts/supabase-stack.sh check` verifies the binding side of this (54321
and 54322 bound to 127.0.0.1 only, via `ss -ltn`) on every deploy; the
firewall side has to be set up once, by hand, in the Hetzner Cloud console or
API, and is not something a script running on the host can prove.

**The four subcommands** (`scripts/supabase-stack.sh <subcommand>`, run as
root):

| Subcommand  | What it does                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ensure`    | Installs the Supabase CLI (pinned 2.95.4) if missing, starts the stack if it is not already running. Idempotent.           |
| `migrate`   | `supabase migration up`, then prints `supabase migration list`.                                                            |
| `write-env` | Reads (or mints, if the CLI reports none) the anon/service_role keys and upserts them into `/etc/flowstarter/staging.env`. |
| `check`     | Fails unless 54321/54322 are loopback-only and the REST endpoint answers.                                                  |

**What CI does on every staging deploy of slot `main`:** first
`scripts/sync-supabase.sh` (see below), which replaces
`/opt/flowstarter/staging/repo/supabase` with exactly what the repo ships at
that commit -- files the repo no longer has are removed on the host, not
merely left alone -- and refuses, without touching the live tree, if the
incoming migrations collide on version. Then `scripts/deploy-slot.sh`: runs
`ensure` before starting the container; for slot `main` only, also runs
`migrate` and `write-env`, since PR slots share the schema slot `main` last
applied. The Caddy snippet that makes a slot reachable is written only after
the container is healthy and its own `/api/health` reports it is talking to
the local stack (`"target":"local"`), never a remote one.

**`scripts/sync-supabase.sh`** (run as root, reads a tar stream of the
repo's `supabase/` directory from stdin): extracts it into a throwaway
sibling directory, refuses if two of the migrations it just received share a
version (printing both filenames), and only then swaps it into
`REPO_DIR/supabase` with two directory renames, preserving file modes. Never
extracts in place on top of the live tree -- that was the previous approach
(`tar -xf - --overwrite`) and it does not delete files the repo dropped, which
is how a renamed migration once left two files sharing one version on the
host and broke every deploy of slot `main` until someone removed the stale
one by hand (see "What CI is allowed to run as root" above for why this is a
script rather than inline shell in the workflow).

**Slot `prod` runs none of this.** It talks to the hosted Supabase project, so
`ensure`, `check`, `migrate` and `write-env` are all skipped and its health
gate asserts `"env":"production"` instead. Nothing on this box migrates the
production database.

**Concurrent deploys.** Every staging slot shares this one stack and one
Caddy config directory, so `deploy-slot.sh` wraps the `ensure`/`check`/
`migrate` section, and separately the Caddy write-then-reload, in `flock` on
`STAGING_LOCK_FILE` (default `${STAGING_ROOT}/deploy.lock`). Two lanes
deploying in the same minute (`main` and a `pr-N`, or two `pr-N`s) queue for
those steps instead of racing them; a waiter gives up after
`STAGING_LOCK_TIMEOUT` seconds (default 300) and names the lock file and, if
available, which slot/pid last held it. Per-slot work -- the image pull,
`docker compose up`, the health wait -- is not locked and still runs in
parallel across slots.

**RAM.** The trimmed stack keeps gotrue, kong, postgrest, storage-api,
postgres-meta, and postgres, and excludes studio, edge-runtime, logflare,
vector, supavisor, imgproxy, mailpit, and realtime. It runs at roughly 1 GB.
A cx22 fits `main` plus a couple of PR slots; if PR slots pile up, prefer a
cx32.

## Cal.com

Client booking pages run on **self-hosted Cal.com on this same box**, one Cal
user per workspace, served at `https://cal.flowstarter.dev`. It is its own
compose project (`flowstarter-cal`, from `deploy/hetzner-staging/cal/`), and it
is deliberately not part of the platform slots or the Supabase CLI stack: Cal
owns its schema and runs `prisma migrate deploy` on every boot, so it gets its
own Postgres rather than sharing one with product migrations. Why the product
writes to that database directly, and why there is no Cal API container (the
`apps/api/v1` image is under the Cal.com Commercial License and refuses every
request without an Enterprise licence key in production), is written up with
the evidence in `docs/operations/cal.md`.

| Container             | Image                   | Published on     | What it is                             |
| --------------------- | ----------------------- | ---------------- | -------------------------------------- |
| `flowstarter-cal-db`  | `postgres:16-alpine`    | `127.0.0.1:5433` | Cal's own Postgres (`calcom`/`calcom`) |
| `flowstarter-cal-web` | `calcom/cal.com:v6.2.0` | `127.0.0.1:3200` | the app, proxied by Caddy              |

Both ports are loopback-only and Caddy on 443 is the only way in, for the same
reason the Supabase stack is (see "Database" above) — with one extra trap that
bit this box once already: `/etc/docker/daemon.json`'s `{"ip":"127.0.0.1"}`
only constrains the **default** bridge, and a compose-created network ignores
it. That is why the Cal network also carries
`com.docker.network.bridge.host_binding_ipv4: 127.0.0.1`, and why
`cal-stack.sh check` asserts both the per-port bindings and that driver option.
**Nobody should call this stack healthy until `check` passes**: a Cal database
and an unauthenticated first-user setup route published on `0.0.0.0` are past
`ufw` and reachable from the internet.

DNS is dns-only (grey cloud), so Caddy can answer the ACME challenge itself:

```
cal.flowstarter.dev          A      <HETZNER_IP>    DNS only
```

Public signup is closed twice over: `NEXT_PUBLIC_DISABLE_SIGNUP=true` inside
the app, and two `handle` blocks in `cal.caddy` that 404 `/signup*` and
`/api/auth/signup*` at the edge. Clients never sign up; they are provisioned
and set their password through Cal's own reset flow. `cal-stack.sh health`
checks the edge half of that on every run.

### `/etc/flowstarter/cal.env`

Mode 600, root-owned, written by hand, never by CI — the same rules as
`prod.env`. Keys only, values belong on the box:

```
POSTGRES_PASSWORD               # Cal's database password (cal-db and cal-web both read it)
DATABASE_URL                    # postgresql://calcom:<password>@cal-db:5432/calcom
NEXTAUTH_SECRET                 # Cal's session secret
CALENDSO_ENCRYPTION_KEY         # encrypts stored calendar credentials
NEXTAUTH_URL                    # https://cal.flowstarter.dev/api/auth
NEXT_PUBLIC_WEBAPP_URL          # https://cal.flowstarter.dev
NEXT_PUBLIC_DISABLE_SIGNUP      # true
CAL_ADMIN_USERNAME              # read by cal-stack.sh admin
CAL_ADMIN_EMAIL                 # read by cal-stack.sh admin
CAL_ADMIN_PASSWORD              # read by cal-stack.sh admin
CAL_PROVISIONER_PASSWORD        # generated and appended by cal-stack.sh provisioner-role
```

### Installing and driving it

`scripts/cal-stack.sh` is the only thing that should run `docker compose`
against the Cal compose file. Run as root:

```bash
sudo mkdir -p /opt/flowstarter/cal
sudo cp deploy/hetzner-staging/cal/docker-compose.yml /opt/flowstarter/cal/
sudo cp deploy/hetzner-staging/cal/cal.caddy /opt/flowstarter/cal/
sudo cp deploy/hetzner-staging/scripts/cal-stack.sh /opt/flowstarter/cal/
sudo chmod +x /opt/flowstarter/cal/cal-stack.sh
sudo install -m 600 /dev/null /etc/flowstarter/cal.env
# Fill cal.env in with the keys listed above, then:
sudo /opt/flowstarter/cal/cal-stack.sh up               # first boot takes minutes: Prisma migrations + app store seed
sudo /opt/flowstarter/cal/cal-stack.sh check            # must pass before going any further
sudo /opt/flowstarter/cal/cal-stack.sh install-caddy
sudo /opt/flowstarter/cal/cal-stack.sh admin
sudo /opt/flowstarter/cal/cal-stack.sh provisioner-role
sudo /opt/flowstarter/cal/cal-stack.sh health
```

| Subcommand         | What it does                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up`               | `compose up -d`, then waits (bounded, `CAL_HEALTH_TIMEOUT_SECONDS`, default 600s) for both containers to report healthy.                             |
| `down`             | `compose down`. Refuses `-v`/`--volumes`: that volume is every client's booking page and their bookings.                                             |
| `status`           | Container names, health, published ports, and the image tag actually running.                                                                        |
| `check`            | Fails unless every published port is loopback-only and the compose network carries the loopback `host_binding_ipv4` option. Run it after every `up`. |
| `admin`            | Creates the first Cal admin user from `cal.env`. Idempotent: Cal answers 400 "No setup needed." once any user exists, which counts as success.       |
| `provisioner-role` | Creates or refreshes `flowstarter_provisioner`, a login role with `SELECT, INSERT, UPDATE` on six tables and no `DELETE` or DDL anywhere.            |
| `health`           | `GET /auth/login` must be 200, `GET /signup` must be 404, and the loopback port must answer. Non-zero on any failure.                                |
| `install-caddy`    | Installs `cal.caddy` into `/etc/caddy/platform/` and reloads Caddy.                                                                                  |

Every tunable is an env var with a documented default at the top of the script
(`CAL_DIR`, `CAL_ENV_FILE`, `CAL_WEB_HOST_PORT`, `CAL_DB_HOST_PORT`,
`CAL_PUBLIC_URL`, ...). Tests: `bash deploy/hetzner-staging/scripts/cal-stack.test.sh`,
pure bash with stubbed `docker`/`curl`, no daemon required.

**Backups.** `backup.sh` dumps `flowstarter-cal-db` nightly alongside the
Supabase stack: it discovers containers by `BACKUP_DB_CONTAINER_PATTERN`
(default `^supabase_db_|^flowstarter-cal-db$`) and asks each container for its
own `POSTGRES_USER`/`POSTGRES_DB`, because Cal's are `calcom`/`calcom` and not
`postgres`. That database holds every client's booking page and every booking
made against it, and none of it is reproducible from git.

## Shipping the sigma model

The sigma classifier (`@flowstarter/sigma-flowstarter`, PR #160, dist build
and native `onnxruntime-node` dependency in PR #167) gates the discovery
funnel on acceptable use and commercial scope, locally: a pinned
multilingual-e5-small ONNX encoder (`packages/sigma-core/config/encoder.json`)
with `allowRemoteModels=false` at runtime — no outbound call from inside a
visitor's request, ever. Three separate things have to be true in this image
before that works, and Next's own build pipeline gets none of them right on
its own: the model weights have to be on disk (`sigma-model` stage), the
classifier's own runtime code — `@flowstarter/sigma-flowstarter`,
`@flowstarter/sigma-core`, `@huggingface/transformers`, `onnxruntime-node` —
has to actually be reachable at runtime (`sigma-runtime-deps` stage), and
both sigma packages' own asset lookups (`models/`, `config/`) have to point
somewhere real (`SIGMA_CORE_ROOT`/`SIGMA_FLOWSTARTER_ROOT`). Miss any one of
the three and the classifier fails open to human review on every check (by
design — see `packages/sigma-flowstarter/src/gate.ts`), silently, unless
someone is watching `/api/health`.

**The model weights: the `sigma-model` stage.** Runs
`packages/sigma-core/scripts/fetch-model.mjs` at build time — the pinned
Hugging Face revision, every file sha256-verified against
`packages/sigma-core/config/encoder.json`, into
`SIGMA_MODEL_CACHE_DIR=/opt/flowstarter/sigma-model-cache`. Needs neither
`pnpm install` nor the `deps` stage's `node_modules` (the script depends on
nothing but Node's own `fetch`/`crypto`/`fs`), so it runs in parallel with
every other stage, and retries a transient download failure with backoff
(observed in practice on a resource-constrained build host: a ~120MB file
dying mid-download to a generic "terminated" is common enough to be worth
not failing the whole build over). The `runner` stage copies the cache in at
the same fixed path (`--chown=node:node`; the `node` user never needs to
write to it) and sets the same env var, which
`packages/sigma-core/src/artifacts.ts`'s `resolveCacheDir()` reads.

**The runtime code: why `.next/standalone` cannot be trusted with it, and
the `sigma-runtime-deps` stage that doesn't.** Both sigma packages build to
`dist/` and are ordinary, untranspiled, `serverExternalPackages`-listed
external packages (#167) — every ingredient Next's own tracing usually needs
to carry a package into `.next/standalone` on its own. It still doesn't,
for either the classifier's package files or its own native dependencies,
and the two gaps fail differently:

- `@flowstarter/sigma-flowstarter` and `@flowstarter/sigma-core` themselves
  are simply absent from `.next/standalone` — no `packages/sigma-core`, no
  `node_modules/@flowstarter/*` — because Turbopack's tracing never follows
  the one code path that reaches them: `src/lib/sigma/warm.ts`'s dynamic
  `import()`, called only from `src/instrumentation.ts` (which is not
  route-traced the way an API route is), while `src/app/api/health/
  route.ts`'s STATIC import of the same file only touches `getSigmaHealth`,
  never the sigma-flowstarter runtime import in the same file, so
  tree-shaking drops it. A plain Node import of `@flowstarter/
  sigma-flowstarter` from an isolated copy of `.next/standalone` throws
  `Cannot find package` immediately. Inside the real container this was
  worse than a clean error before the fix below: `warmSigmaOrWarn()`'s
  dynamic `import()` never settled inside Turbopack's runtime module loader
  for a genuinely missing module, so the classifier's first warm-up
  attempt hung the process indefinitely instead of failing open.
- `@huggingface/transformers`, `onnxruntime-node`, `onnxruntime-common` and
  `sharp` ARE present in `.next/standalone` — Next's tracing does reach
  them, as externals — but incompletely: the native `.node` binding lands
  with no shared library beside it (`libonnxruntime.so.1: cannot open
  shared object file`), and `sharp` is missing outright despite
  apps/flowstarter-main's own direct dependency on it for `next/image`.
  Worse, once the files ARE all correctly present via a naive top-level
  copy, the compiled server chunk STILL fails: Turbopack's production
  "external module" wrapper resolves a dynamic import like
  `require('onnxruntime-node')` from inside `@huggingface/transformers`
  against the pnpm virtual-store path it saw AT BUILD TIME
  (`node_modules/.pnpm/onnxruntime-node@1.24.3/node_modules/
  onnxruntime-node`), not wherever the files land at runtime — the same
  class of bug as the `templates` build stage's astro-shim path baking,
  elsewhere in this file, just for a different package.

`deploy/hetzner-staging/scripts/stage-sigma-runtime.mjs` (run by the
`sigma-runtime-deps` stage, merged into the `runner` stage's
`node_modules`) does not trust tracing for any of this: it dereferences
pnpm's symlinks and copies the REAL files for the whole chain —
`@flowstarter/sigma-flowstarter` → `@flowstarter/sigma-core` →
`@huggingface/transformers` → `onnxruntime-node` (+ `onnxruntime-common`)
→ `sharp` (+ its platform-specific `@img/sharp-*` binary and plain
dependencies) — following each package's own resolution of the next
(this repo has two different `onnxruntime-node` versions installed for
unrelated reasons; resolving from the wrong anchor silently grabs the
wrong one), to a flat top-level `node_modules/<name>` AND, for every leaf
npm package, a second copy mirrored at the exact
`node_modules/.pnpm/<name>@<version>/node_modules/<name>` path Next's own
partial trace already created — the one Turbopack's baked-in resolution
actually reads. Also prunes `onnxruntime-node`'s bundled binaries (five
platform/arch combinations, 200MB+ together) down to the build's own
`process.platform`/`process.arch` in both copies.

**Asset lookups: `SIGMA_CORE_ROOT` / `SIGMA_FLOWSTARTER_ROOT`.** Even with
the runtime code correctly in place, `packages/sigma-core/src/
artifacts.ts`'s `CORE_ROOT` and `packages/sigma-flowstarter/src/
config.ts`'s `PACKAGE_ROOT` — both computed from `import.meta.url` at
module-load time, used to find `config/encoder.json`,
`models/centroids.json`, etc. — get baked in against wherever the package
sat AT BUILD TIME (`/app/packages/sigma-flowstarter` in the `builder`
stage), not wherever it actually ends up. The `runner` stage sets both env
vars (both roots already support this override, for exactly this kind of
case) to the flat copy the `sigma-runtime-deps` stage staged, sidestepping
the baked-in path the same way `SIGMA_MODEL_CACHE_DIR` sidesteps trusting
tracing for the model cache.

**Cross-chunk state: why `getSigmaHealth()` is `globalThis`-backed, not a
plain module variable.** `src/lib/sigma/warm.ts` is imported by both
`instrumentation.ts` and the health route, and Turbopack builds each entry
point as its own separate chunk graph — this file gets bundled into BOTH,
as two independent module instances with independent closures. A plain
`let health` would mean `register()`'s write and `route.ts`'s read never
see each other despite running in the same process; `globalThis` (keyed by
`Symbol.for(...)`, so every bundle's copy of this module resolves to the
same underlying value) is the one thing genuinely shared regardless of how
a bundler split the code that reaches it.

**Logging: `process.stdout`/`stderr.write`, not `console.log`/`.warn`.**
`next.config.mjs` sets `compiler.removeConsole` in production, which strips
every `console.*` CALL EXPRESSION from the compiled output. A
`console.log`/`console.warn` in `warm.ts` never made it into `docker logs`
at all — silently, the one failure mode this module exists to make loud.

**Warm-up, and what it costs.** `register()` calls `warmSigmaOrWarn()` once,
after the rate-limit posture gate, off the request path. It never throws —
unlike the rate-limit gate, a missing sigma model degrades the product
(every check falls open to a human) rather than corrupting it. `GET
/api/health` reports the result as `sigma: "ready" | "missing"`, additive
to the existing `ok`/`supabase`/`commit` fields — `ok` stays `true` either
way; a missing model is a deploy defect worth noticing, not a reason to
fail the liveness probe or block a rollout.

**Measured** (`docker build -f deploy/hetzner-staging/Dockerfile --target
runner .`, `docker run`, `curl /api/health`; native `onnxruntime-node`
built for and measured on linux/arm64 — the local Docker Desktop VM's
architecture — not the linux/amd64 CI actually ships; re-verify on an
amd64 runner before trusting the exact byte counts, though the mechanism
is architecture-agnostic):

| | |
| --- | --- |
| Baseline image (before this change) | 360,144,778 bytes (~343 MiB) |
| With the sigma model + runtime deps | 488,281,192 bytes (~465 MiB) |
| Delta | ~128 MiB |
| `sigma-model` layer (encoder weights) | 135 MB |
| `sigma-runtime-deps` layer (code, flat + `.pnpm`-mirrored) | 110 MB |
| Time from container start to `sigma: "ready"` | ~1s (`onnxruntime cpuid_info warning: Unknown CPU vendor` logs first — harmless, ONNX Runtime's CPU-feature detection doesn't recognize the vendor string this VM reports; warm-up completes normally after it) |

The `sigma-runtime-deps` layer carries every leaf npm package twice (flat +
mirrored) — a known, currently-accepted size cost of not trusting Next's
tracing for either copy independently; see that stage's comment before
trying to drop one without re-verifying the other still works. Re-measure
after touching `packages/sigma-core/config/encoder.json`'s
`model`/`revision` (a different encoder is a different size) or upgrading
`@huggingface/transformers` (a different onnxruntime-node pin).

If a future Next/Turbopack upgrade fixes the underlying tracing and
baked-path gaps, this whole mechanism can shrink back to nothing: check
with `docker run --rm <image> node -e
"require('@flowstarter/sigma-flowstarter')"` after a build, and confirm
`/api/health` reports `sigma: "ready"` shortly after start, before removing
either the `sigma-runtime-deps` stage or the two `SIGMA_*_ROOT` env vars.

**Local dev / Mac.** `pnpm --filter @flowstarter/sigma-core fetch-model`, a
one-off, documented in `apps/flowstarter-main/README.md` and `.env.example`.
Not run automatically by `pnpm install` — it fetches a ~135 MB pinned model,
not an npm package.

## The Flowstarter editor

The operator path from `docs/operations/operator-editor.md`: an operator opens
a client's site in a real coding agent from the admin project page, builds
whatever the client asked for, and ships it through the same build and the same
gates as every other change.

**One container**, `flowstarter-editor`, on this box. The editor server is
single-project-per-process, so the image's entrypoint is the router/supervisor
(`apps/flowstarter-editor/router`), which spawns one editor process per
workspace slug pinned to `/workspaces/<slug>` and idle-stops it. The isolation
boundary is that child process plus its own cwd and state dir; the auth
boundary is the editor's own Clerk gate, which still runs per child because
Caddy forwards the original `Host`.

**No new vhost.** The deploy-agent already writes
`<slug>.<domain>/editor/*  ->  reverse_proxy <upstream>` into every client
site's Caddy snippet. Point it here:

```
DEPLOY_AGENT_EDITOR_UPSTREAM=http://127.0.0.1:3773
```

`code.flowstarter.net` stays on the auth-transfer allow-list for a
root-mounted editor that does not exist yet; the operator hand-over goes to
`https://<slug>.<domain>/editor/`, built server-side from `workspaces.slug`.

**Two ways in, and only two.** A browser reaches `/editor/*` through Caddy on
the tenant vhost. `flowstarter-main` reaches `/__router/*` on
`127.0.0.1:3773` — the control plane that materialises a workspace's worktree
from its published manifest, commits it, and reads it back. That control plane
is protected twice: a constant-time bearer check against
`EDITOR_CONTROL_SECRET` (503 with no secret set, never open by default), and a
flat refusal of any request carrying `x-forwarded-host` or `x-forwarded-for`.
The second one matters because Caddy's `handle_path /editor/*` strips the
prefix, so a browser on a client site *can* reach `/__router/...` — but Caddy
stamps those headers on everything it forwards and an attacker cannot remove
them.

### The env file

`/etc/flowstarter/editor.env`, mode 600, owned by root. Template:
`deploy/hetzner-staging/editor/editor.env.example`.

```
EDITOR_PUBLIC_DOMAIN=flowstarter.net   # must equal the app slot's PLATFORM_DOMAIN
EDITOR_CONTROL_SECRET=                 # openssl rand -hex 32; shared with flowstarter-main
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ANTHROPIC_API_KEY=
IS_SANDBOX=1                           # REQUIRED; see below
```

`IS_SANDBOX=1` is not optional. The container runs as root, and "Full access"
runtime mode makes the Claude Agent SDK pass
`--dangerously-skip-permissions`, which Claude Code refuses under root — the
turn dies with *"Claude Code process exited with code 1 / Runtime error"*.
Each workspace is isolated in its own process with its own cwd and state dir,
so it genuinely is a sandbox. Without the line, default-permission threads
work and full-access ones fail, which is the confusing half-broken state.

`flowstarter-main` needs the other half of the pair in its own env file:

```
EDITOR_HOST_URL=http://127.0.0.1:3773
EDITOR_CONTROL_SECRET=<the same value>
```

### Installing and driving it

`scripts/editor-stack.sh` is the only thing that should run `docker compose`
against the editor compose file. Run as root:

```bash
sudo mkdir -p /opt/flowstarter/editor
sudo cp deploy/hetzner-staging/editor/docker-compose.yml /opt/flowstarter/editor/
sudo cp deploy/hetzner-staging/scripts/editor-stack.sh /opt/flowstarter/editor/
sudo chmod +x /opt/flowstarter/editor/editor-stack.sh
sudo install -m 600 /dev/null /etc/flowstarter/editor.env
# Fill editor.env in from editor.env.example, then:
sudo /opt/flowstarter/editor/editor-stack.sh up
sudo /opt/flowstarter/editor/editor-stack.sh check     # must pass before going further
sudo /opt/flowstarter/editor/editor-stack.sh health
```

| Subcommand | What it does |
| ---------- | ------------ |
| `up`       | `compose up -d`, then waits (bounded, `EDITOR_HEALTH_TIMEOUT`, default 120s) for the container to report healthy, then runs `check`. |
| `recreate` | `docker rm -f` then `up`. This is what applies an env-file change: `docker restart` does **not** re-read `--env-file`. |
| `down`     | `compose down`. Never `-v`: `/workspaces` can hold a session an operator has not shipped, and `/state` holds their conversation. |
| `status`   | Container name, health, published ports, and the image tag actually running. |
| `check`    | Fails unless 3773 is published loopback-only, `EDITOR_CONTROL_SECRET` is at least 32 characters, and `EDITOR_PUBLIC_DOMAIN` is set. Run it after every `up`. |
| `health`   | The router answers on loopback, **and** the control plane 404s a request carrying `x-forwarded-host`. The second assertion is the one that proves a client site cannot reach it. |

The image is built from the monorepo root:

```bash
docker build -f apps/flowstarter-editor/Dockerfile   --build-arg VITE_BASE_PATH=/editor/   --build-arg VITE_CLERK_PUBLISHABLE_KEY=<publishable>   -t ghcr.io/dmpresearch/flowstarter-editor:main .
```

`VITE_BASE_PATH=/editor/` is required for the sub-path mount: without it the
SPA emits root-absolute asset URLs and the tenant vhost serves them the static
site's `index.html` instead, which the SPA reports as *"Unexpected token '<'
… is not valid JSON"*.

## The build worker

`apps/build-worker` is what drains `flowstarter_agent_jobs`. flowstarter-main
writes one row per paid build, per paid change request and per operator editor
session shipped, then POSTs the job id to `FLOWSTARTER_BUILD_WORKER_URL` as a
nudge. Until 2026-09-15 that variable was unset on this box and no worker ran
here, so every `FULL_SITE_BUILD`, `CHANGE_REQUEST_BUILD` and
`OPERATOR_EDIT_BUILD` queued on staging sat unclaimed and paid builds only ever
ran from a developer's Mac.

```
flowstarter-main (app slot, network_mode: host)   127.0.0.1:3000
  │  POST /jobs/full-site  (bearer, 8s timeout)
  ▼
build-worker (network_mode: host)                 127.0.0.1:8787
  │  claims the ledger row, leases it, heartbeats every 30s
  │  materialises the job's manifest into a git worktree
  │  docker run  ──►  one DISPOSABLE container per validate command
  │                   read-only root, --network=none after the install,
  │                   --cap-drop=ALL, non-root, no socket
  │  runs every output gate over the exported build
  │  packages a tarball, serves it on its own port
  ▼
flowstarter-main  POST /api/internal/build/deploy  (same bearer)
  │  deploySite → deployments row → site_versions → DNS
  ▼
deploy-agent (sites)                              127.0.0.1:8443
     fetches the tarball back over loopback, extracts to /var/www/sites/<slug>
```

### The Docker socket, stated plainly

The worker container is handed `/var/run/docker.sock`, which is root on this
box. That is deliberate and it is the only such mount on the host:

- **The worker never runs a client's generated code.** Validation —
  `pnpm install && pnpm run build` over an Astro site a coding agent wrote — is
  the one step that executes untrusted code, and it runs in a _separate,
  disposable_ container per command (`apps/build-worker/src/validator.ts`):
  read-only root filesystem, one bind mount (`/site`), `--network=none` for
  everything after the install,
  `--cap-drop=ALL --security-opt=no-new-privileges`, a memory cap, a pids cap, a
  non-root `--user`, and **no socket**. That child is the boundary; the socket
  is what lets the worker ask for it.
- **In staging and production this is mandatory, not opt-in.**
  `apps/build-worker/src/isolation.ts` refuses to start with
  `FLOWSTARTER_BUILD_ISOLATION=native` once `FLOWSTARTER_ENV` resolves to
  staging or production, and `resolveValidationFencing` additionally refuses
  unless the validation image already has pnpm baked in and the build step runs
  with `--network=none`. A host that cannot run the isolated validator fails
  loudly instead of quietly building a client's generated Astro config next to
  every other client's worktree.
- **So the rule for anyone editing this:** everything that runs _inside_ the
  worker container is code from this repository. Anything that would run
  somebody else's code — a shell tool, an operator-supplied command — belongs
  one container further out, where there is no socket.

### The worktrees bind mount, and the trap it avoids

`docker run --mount=type=bind,source=<path>` is resolved by the **daemon**, on
the **host** — not inside the process that asked for it. The worker passes the
site workspace's own absolute path as that source. A worktrees root that existed
only inside the worker container would therefore make the daemon mount a host
path that does not exist, and every build would fail on a missing `package.json`
for a site whose files are plainly there. That is the hardest failure in this
deployment to read backwards, so the compose file mounts
`/srv/flowstarter/build-worker` at the identical absolute path on both sides and
`worker-stack.sh check` asserts it resolves on both.

### `/etc/flowstarter/build-worker-staging.env`

Mode 600, root-owned, written by hand. Copy it from
`build-worker/build-worker.env.example`, which documents every key. The ones
that are not obvious:

| Key                                | Why                                                                                                                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLOWSTARTER_ENV=staging`          | The only thing that can name staging at all: every containerised slot runs `NODE_ENV=production`. It is what forces docker isolation and refuses `FLOWSTARTER_BUILD_SKIP_VALIDATION`.                                                   |
| `FLOWSTARTER_BUILD_WORKER_SECRET`  | Must be **byte-identical** to the one in `staging.env`. Both directions are signed with it: the app's dispatch in, the worker's deploy callback and policy scan back.                                                                   |
| `FLOWSTARTER_BUILD_WORKER_HOST`    | `127.0.0.1`. With `network_mode: host` this is the firewall. A `0.0.0.0` bind publishes `POST /jobs/full-site` **and** the unauthenticated `/artifacts/<token>.tar.gz` route that serves clients' unreleased sites.                     |
| `FLOWSTARTER_BUILD_MODE=local`     | `github` publishes by opening a draft PR — a review gate, not a deploy: nothing reaches the client's host and no `site_versions` row is published. Staging exists to rehearse the chain that ends with a client seeing their site.      |
| `FLOWSTARTER_MAIN_URL`             | `http://127.0.0.1:3000`, the deploy callback and the acceptable-use scan. No default, on purpose: a silent fallback to port 3000 killed two builds against a port nothing was listening on.                                             |
| `FLOWSTARTER_PUBLIC_APP_ORIGIN`    | `FLOWSTARTER_MAIN_URL` is loopback, which is right for the callback and wrong for anything baked _into_ a client's site. This is what the contact-form endpoint and the site's CSP are derived from.                                    |
| `CAL_BASE_URL`                     | Silent when wrong. Unset, the booking-host allow list falls back to `cal.com` only, the booking page is dropped from the build, and the client ships without the calendar they were emailed a link to. Must equal the app slot's value. |
| `FLOWSTARTER_POLICY_SCAN_REQUIRED` | `true`. `local` mode defaults it to false (a laptop with no app running). This worker publishes sites a client will see, so "the gate passed" and "the gate never ran" must not look the same.                                          |

And in `staging.env`, on the app's side:
`FLOWSTARTER_BUILD_WORKER_URL=http://127.0.0.1:8787` plus the same
`FLOWSTARTER_BUILD_WORKER_SECRET`. `dispatchAgentJob` refuses any endpoint that
is neither HTTPS nor loopback.

### Installing and driving it

`scripts/worker-stack.sh` is the only thing that should run `docker compose`
against the build worker's compose file. It installs itself through the ordinary
CI sync (`sync-supabase.sh` picks up any new `scripts/*.sh`), and CI also keeps
`/opt/flowstarter/build-worker/docker-compose.yml` current. What is needed once,
by hand, on a new box:

```bash
sudo mkdir -p /opt/flowstarter/build-worker /srv/flowstarter/build-worker
sudo cp deploy/hetzner-staging/build-worker/docker-compose.yml /opt/flowstarter/build-worker/
sudo cp apps/build-worker/docker/validation-runtime.Dockerfile /opt/flowstarter/build-worker/
sudo cp deploy/hetzner-staging/scripts/worker-stack.sh /opt/flowstarter/staging/
sudo chmod +x /opt/flowstarter/staging/worker-stack.sh
sudo install -m 600 /dev/null /etc/flowstarter/build-worker-staging.env
# Fill it in from build-worker/build-worker.env.example, then build the
# disposable image a generated site is actually compiled inside:
sudo /opt/flowstarter/staging/worker-stack.sh image
sudo /opt/flowstarter/staging/worker-stack.sh up
sudo /opt/flowstarter/staging/worker-stack.sh check    # must pass before going further
sudo /opt/flowstarter/staging/worker-stack.sh health
```

| Subcommand         | What it does                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `up [image]`       | Pulls, `compose up -d`, waits (bounded, `BUILD_WORKER_HEALTH_TIMEOUT`, default 180s) for healthy, then runs `check`. With no image argument it reuses the image the container is already on, so a hand-run deploy never rolls the worker back to whatever `:main` points at.                                                                           |
| `recreate [image]` | `docker rm -f` then `up`. This is what applies an env-file change: `docker restart` does **not** re-read `--env-file`.                                                                                                                                                                                                                                 |
| `down`             | `compose down`.                                                                                                                                                                                                                                                                                                                                        |
| `status`           | Container name, health, and the image tag actually running.                                                                                                                                                                                                                                                                                            |
| `check`            | Fails unless the listener is loopback (configured **and** observed), the shared secret is at least 32 characters, isolation is `docker`, the validation image is present, the worktrees root resolves identically on host and in container, and the worker can reach the host daemon.                                                                  |
| `health`           | The worker answers `/health` on loopback, **and** dispatch 401s an unsigned POST.                                                                                                                                                                                                                                                                      |
| `image`            | Builds `flowstarter/build-validation:node22-pnpm10` on this host from `apps/build-worker/docker/validation-runtime.Dockerfile`. Built locally, never pulled: the worker invokes the Docker CLI with no registry credentials, so the image has to be on the host already, and one built from this repo is the only version of it we can say we control. |

The worker's own image is built and pushed by `staging-deploy.yml`
(`ghcr.io/dmpresearch/flowstarter-build-worker:<sha>`) and deployed **after** the
app slot. That order matters: the worker's publish step calls back into
flowstarter-main, so deploying it first would give it a window in which it can
claim a job, build it, and then fail at publish against an app mid-restart.

### What production will need

Nothing in the worker image is environment-specific — it takes no
`NEXT_PUBLIC_*` build args — so the same image serves both. What `prod` needs is
its own slot beside this one:

- `/etc/flowstarter/build-worker-prod.env` with `FLOWSTARTER_ENV=production`,
  the hosted Supabase project's URL and service-role key, and
  `FLOWSTARTER_MAIN_URL=http://127.0.0.1:3100` (the `prod` slot's port).
- `FLOWSTARTER_BUILD_WORKER_URL` + the matching secret in `prod.env`, and a
  second container on its own port (`FLOWSTARTER_BUILD_WORKER_PORT=8788`) with
  its own `BUILD_WORKER_STATE_ROOT`. Two workers against one ledger is already
  safe — the claim is an atomic compare-and-set and leases are fenced — but two
  workers against **one worktrees root** is not, so the state roots must differ.
- **The artifact URL.** In production `assertUsableArtifactUrl` requires HTTPS,
  so a production worker cannot serve its own tarball off loopback the way this
  one does. Either that rule is widened for a same-box worker the way it already
  is for staging, or the worker gains a publisher that uploads to Supabase
  Storage and hands out a signed URL — which is what the artifact store's own
  comment says production was always meant to do.

## Known gaps

- **Signed Storage URLs.** Tenant asset URLs are signed against
  `http://127.0.0.1:54321` and handed to the browser. They will not load on
  staging, because a visitor's browser cannot reach the Hetzner host's
  loopback address. This is a known limitation of running the stack on
  loopback, not a bug to chase. Fixing it would mean exposing the stack
  beyond loopback, which is the one thing this setup exists to avoid.
- **Clerk and Stripe webhooks.** They need their own endpoints pointed at
  `staging.flowstarter.dev`, independent of this database change.
- **Restoring the Cal dump.** `backup.sh` dumps `flowstarter-cal-db` nightly,
  but `restore.sh --database <name>` still resolves a container as
  `supabase_db_<name>` and restores as `postgres`/`postgres`. Restoring Cal
  today therefore means `docker exec -i flowstarter-cal-db pg_restore -U calcom
-d calcom --clean --if-exists < db-flowstarter-cal-db.dump` by hand, after
  verifying the dump against `manifest.sha256` yourself.
- **The editor web app hardcoded `/api/...` paths in a few places that did
  not respect `VITE_BASE_PATH`.** Found and fixed in two passes. 2026-09-15
  (#182) fixed the ones that block every session outright
  (`CLERK_ME_PATH`/`CLERK_AUTO_PAIR_PATH` in
  `apps/flowstarter-editor/web/src/lib/clerkSession.ts`, and the
  `window-origin` fallback in
  `apps/flowstarter-editor/web/src/environments/primary/target.ts`, which
  feeds `/api/auth/session`, `/api/auth/bootstrap`, `/api/auth/ws-token` and
  the WebSocket RPC socket URL — the last one needs its trailing slash kept,
  since a bare `/editor` without one hits Caddy's `redir /editor/ permanent`
  and a WebSocket handshake cannot follow a redirect). Same day, a follow-up
  sweep fixed the secondary ones #182 left open (`HeaderChromeControls.tsx`'s
  `/api/auth/sign-out` and post-sign-out redirect, `publishSite.ts`'s
  `/api/site/publish`, `ConnectionsSettings.tsx`'s shareable `/pair` link,
  `approveMockup.ts`'s `/api/clerk/workspace/approve-mockup`) and
  consolidated every base-path computation behind one helper,
  `apps/flowstarter-editor/web/src/lib/basePath.ts`
  (`withBasePath()`/`EDITOR_BASE_PATH`), which `router.ts`, `clerkSession.ts`
  and `target.ts` now import instead of each re-deriving
  `import.meta.env.BASE_URL` locally. A source-tree rule test,
  `apps/flowstarter-editor/web/src/basePathLiterals.test.ts`, scans for new
  hardcoded `/api/...`, `/ws`, or `/pair` literals in `fetch()`, `new
  WebSocket()`, `new URL()`, and `.pathname =` and fails the suite on any
  that isn't routed through the helper or listed as a reasoned exception
  (currently one: `ConnectionsSettings.tsx`'s desktop-bridge pairing URL,
  which targets a separate always-root-mounted LAN backend, not this SPA's
  own sub-path deploy).

## One-time box setup

This manual `cp` of `scripts/*.sh` is only needed once, to get
`sync-supabase.sh` itself onto the box — after that, every `staging-deploy`
run installs the current `main` version of every script under
`deploy/hetzner-staging/scripts/` automatically, including updates to
`sync-supabase.sh` itself. See "What CI is allowed to run as root" below.
Skipping this step is not an option for a brand-new box: CI has nothing to
SSH into that can run `sync-supabase.sh` in the first place, so the very
first copy has to be seeded by hand.

```bash
sudo mkdir -p /opt/flowstarter/staging /etc/flowstarter /etc/caddy/platform
sudo cp deploy/hetzner-staging/docker-compose.yml /opt/flowstarter/staging/
sudo cp deploy/hetzner-staging/scripts/*.sh /opt/flowstarter/staging/
sudo chmod +x /opt/flowstarter/staging/*.sh
sudo install -m 600 /dev/null /etc/flowstarter/staging.env
# Edit staging.env with Clerk/etc. for the staging Clerk application, plus
# the discovery-funnel preview vars (see "The production env file" above for
# what they are; staging and production each point at the same previews
# deploy-agent on this box):
#   FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL=http://127.0.0.1:8444
#   FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET=<previews deploy-agent's shared secret>
# Supabase keys are written by supabase-stack.sh write-env below, not by hand.

# Production slot only: its own env file, with the hosted project's values.
# See "The production env file" above for the fields it needs.
sudo install -m 600 /dev/null /etc/flowstarter/prod.env

# Loopback-only Docker publishing (mandatory, see "Database" above).
echo '{ "ip": "127.0.0.1" }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker

# Attach a Hetzner Cloud Firewall allowing inbound 22/80/443 only, then:
sudo REPO_DIR=/opt/flowstarter/staging/repo /opt/flowstarter/staging/supabase-stack.sh ensure
sudo REPO_DIR=/opt/flowstarter/staging/repo /opt/flowstarter/staging/supabase-stack.sh migrate
sudo /opt/flowstarter/staging/supabase-stack.sh write-env
sudo /opt/flowstarter/staging/supabase-stack.sh check

# Optional: override prune-images.sh's/deploy-slot.sh's retention and
# disk-floor defaults (FLOWSTARTER_IMAGE_KEEP_COUNT, FLOWSTARTER_DISK_FLOOR_MB,
# etc. — see "Disk" above) without touching CI. Nothing requires this file to
# exist; skip it to keep the built-in defaults.
sudo install -m 600 /dev/null /etc/flowstarter/staging-ops.env

# Nightly backups (backup.sh/restore.sh above are already copied by the *.sh
# glob a few lines up). See docs/operations/backups.md for what is backed up,
# how retention and encryption are chosen, and the restore drill.
sudo install -m 600 /dev/null /etc/flowstarter/backup.env
# Edit backup.env: at minimum an age recipient (BACKUP_AGE_RECIPIENT_FILE or
# BACKUP_AGE_RECIPIENT) if `age` is installed, or a mode-600
# BACKUP_GPG_PASSPHRASE_FILE if it is not; BACKUP_S3_* only if an
# S3-compatible bucket for off-box copies exists yet (it does not by
# default, see docs/operations/backups.md, "What still needs Darius").
sudo apt-get install -y age || true  # falls back to gpg (already on the box) if this package is unavailable
sudo cp deploy/hetzner-staging/systemd/flowstarter-backup.service /etc/systemd/system/
sudo cp deploy/hetzner-staging/systemd/flowstarter-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now flowstarter-backup.timer
```

`REPO_DIR` needs `supabase/config.toml` in it before `ensure`/`migrate` can
run; CI's sync step (`staging-deploy.yml`, via `sync-supabase.sh`) populates
`/opt/flowstarter/staging/repo` on every deploy of slot `main`, but the very
first run needs that directory seeded by hand (e.g. `git clone` or `rsync`
the repo's `supabase/` directory there) or by triggering one `staging-deploy`
run first.

### What CI is allowed to run as root

CI SSHes in as a `deploy` user, restricted by `/etc/sudoers.d/flowstarter-deploy`
on the host (hand-maintained there, not tracked in this repo) to exactly the
scripts under `/opt/flowstarter/staging/`:

```
Cmnd_Alias FLOWSTARTER_SLOTS = /opt/flowstarter/staging/*.sh
deploy ALL=(root) NOPASSWD: FLOWSTARTER_SLOTS
```

sudoers matches literal commands, not shell logic handed to `ssh` as an
argument -- an inline `mkdir`/`tar`/`mv` sequence run that way is not
something this grant can name, and fails outright ("sudo: a password is
required") the moment a workflow tries it. Anything a workflow needs to do as
root on this box has to live in a script under `scripts/`, get copied in by
the `cp .../scripts/*.sh` line above, and be invoked by path
(`sudo /opt/flowstarter/staging/<script>.sh`) so this one `Cmnd_Alias`
already covers it. `sync-supabase.sh` is why the `supabase/` sync step in
`staging-deploy.yml` needs nothing extra granted: it used to have its own
`Cmnd_Alias FLOWSTARTER_SYNC` for a fixed `mkdir`+`tar` pair, which is no
longer referenced by any workflow and can be dropped from the box's sudoers
file.

**Installing the scripts themselves is the same trick, one level up.** The
`FLOWSTARTER_SLOTS` glob already covers every `.sh` file under
`/opt/flowstarter/staging/`, whatever it's named, so nothing about *adding a
new script* needs a sudoers change either. `staging-deploy.yml`'s sync step
tars `deploy/hetzner-staging/scripts/` alongside `supabase/` on every push to
`main` and pipes both to `sync-supabase.sh`, which -- still running as the
one process sudoers already trusts -- installs any `*.sh` whose content
changed into `/opt/flowstarter/staging/`: written to a temp file in that same
directory first, `chmod 755`, then `mv -f` over the target, so a script
already mid-run (including `sync-supabase.sh` replacing its own installed
copy) keeps reading its old inode to completion rather than a half-written
mix of old and new bytes. Identical content is left untouched, and a script
name that has never existed on the box before is just the "content changed"
case with nothing to compare against, so it installs the same way -- no
separate bootstrap step needed for it. A "Verify installed scripts match the
repo" step right after the sync compares every script's sha256 between the
checkout and the host and fails the deploy loudly on any mismatch, rather
than letting a silent install failure leave the box running stale code. This
is what closes the gap that let the box run `deploy-slot.sh` from a days-old
commit (missing #175's image retention) and fill the staging disk on
2026-09-15 -- see `docs/operations/deploy-disk.md` and `sync-supabase.sh`'s
own header comment for the incident.

## CI

- `.depot/workflows/staging-deploy.yml`: push to `main` deploys slot `main`
  (syncs `supabase/` and `scripts/` to the host via `sync-supabase.sh`,
  verifies the installed scripts' sha256 against the repo, runs migrations,
  refreshes staging.env)
- `.depot/workflows/staging-pr-deploy.yml`: PR deploys slot `pr-<n>`; closed destroys it
- `.depot/workflows/release.yml`: a release tag builds the production image and
  deploys slot `prod`. It is the only lane that touches production, and it
  fails rather than skips when a credential is missing. See
  `docs/release-process.md`.

Secrets: see `docs/ci/secrets.md` (`STAGING_SSH_*`, `STAGING_SUPABASE_ANON_KEY`,
`PROD_NEXT_PUBLIC_*`, `GHCR_TOKEN`).

**Health identifies its own commit.** A deploy takes minutes end to end
(build, push, SSH, `docker compose up`), and the PREVIOUS container keeps
answering `"ok":true` and `"target":"local"` at `/api/health` for the whole
time the new one is rolling out underneath it. A lane that waited only on
those two fields (`.github/scripts/wait-for-staging-slot.sh`, used by
`e2e-smoke.yml`, `visual-check.yml`, `opencode-review.yml` and
`release.yml`'s `staging-journey`) could therefore pass against stale code
the instant the old container was found healthy. `/api/health` now also
reports `"commit"`, set from `FLOWSTARTER_BUILD_COMMIT`: baked in at image
build time (a build arg in `Dockerfile`, passed by every CI lane that builds
this image as the git SHA it tags with), and independently re-derived by
`deploy-slot.sh` from the image tag it is given at deploy time (so it takes
effect even for an image built before this field existed, no rebuild
required). `wait-for-staging-slot.sh` accepts `EXPECTED_COMMIT` and, when
set, will not call a slot ready until its reported commit matches.

## Redeploying or rolling back production by hand

```bash
ssh <user>@<hetzner-host>
sudo /opt/flowstarter/staging/deploy-slot.sh prod \
  ghcr.io/dmpresearch/flowstarter-main:release-2026-09-07 3100
```

Name a release tag, never `:prod`: that tag is a moving pointer at whatever the
release lane pushed last, so it cannot roll anything back. A deploy that fails
its health gate leaves the running container's Caddy snippet untouched.
