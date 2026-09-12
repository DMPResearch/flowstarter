# Hetzner platform slots (flowstarter-main)

Runs the Next.js app in Docker on the **same Hetzner Caddy host** as client
sites, but **isolated** from deploy-agent. Three kinds of slot share one
compose file and one pair of scripts: `main` and `pr-N` for staging, and `prod`
for production at `flowstarter.net`.

| Path                          | Owner                                        |
| ----------------------------- | -------------------------------------------- |
| `/var/www/sites/*`            | Client static sites (deploy-agent)           |
| `/opt/flowstarter/staging`    | Platform compose + scripts (all slots)       |
| `/etc/caddy/platform/*.caddy` | Platform vhosts (`main`, `pr-*`, `prod`)     |
| `/etc/flowstarter/staging.env`| Staging secrets, mode 600                    |
| `/etc/flowstarter/prod.env`   | Production secrets, mode 600                 |
| `/etc/flowstarter/tls/`       | Optional Cloudflare Origin CA cert for prod  |
| `/etc/flowstarter/backup.env` | Backup config (retention, encryption, S3), mode 600 |
| `/var/backups/flowstarter/`   | Nightly backups, see `docs/operations/backups.md`   |

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
the site down.

### What is different about `prod`

- It runs **none** of the Supabase CLI stack steps: no `ensure`, no `check`, no
  `migrate`, no `write-env`. It talks to the hosted Supabase project. Schema
  changes are applied to that project deliberately, by hand.
- Its health gate asserts `"env":"production"` from `/api/health` instead of
  `"target":"local"`. A staging image landed on port 3100 by mistake reports
  `"env":"staging"` and never gets a Caddy snippet.
- Its Caddy snippet serves two hostnames and 301-redirects `www` to the apex.

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
   root, so Cloudflare SSL/TLS must then be **Full**, *not* Full (strict). The
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
```

The `NEXT_PUBLIC_*` values also exist as Depot secrets (`PROD_NEXT_PUBLIC_*`),
because those are inlined into the client bundle at **build** time while the
file above is read at **run** time. Keep the two in step; a mismatch shows up
as a browser talking to one project and the server to another.

`PLATFORM_DOMAIN` matters because `@flowstarter/platform-config` resolves the
platform domain from the request hostname first and falls back to
`flowstarter.dev`. That fallback is right for staging and wrong for production,
so production names its domain explicitly. Staging needs no such line.

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

**What CI does on every staging deploy** (`scripts/deploy-slot.sh`, see below):
runs `ensure` before starting the container; for slot `main` only, also runs
`migrate` and `write-env`, since PR slots share the schema slot `main` last
applied. The Caddy snippet that makes a slot reachable is written only after
the container is healthy and its own `/api/health` reports it is talking to
the local stack (`"target":"local"`), never a remote one.

**Slot `prod` runs none of this.** It talks to the hosted Supabase project, so
`ensure`, `check`, `migrate` and `write-env` are all skipped and its health
gate asserts `"env":"production"` instead. Nothing on this box migrates the
production database.

**RAM.** The trimmed stack keeps gotrue, kong, postgrest, storage-api,
postgres-meta, and postgres, and excludes studio, edge-runtime, logflare,
vector, supavisor, imgproxy, mailpit, and realtime. It runs at roughly 1 GB.
A cx22 fits `main` plus a couple of PR slots; if PR slots pile up, prefer a
cx32.

## Known gaps

- **Signed Storage URLs.** Tenant asset URLs are signed against
  `http://127.0.0.1:54321` and handed to the browser. They will not load on
  staging, because a visitor's browser cannot reach the Hetzner host's
  loopback address. This is a known limitation of running the stack on
  loopback, not a bug to chase. Fixing it would mean exposing the stack
  beyond loopback, which is the one thing this setup exists to avoid.
- **Clerk and Stripe webhooks.** They need their own endpoints pointed at
  `staging.flowstarter.dev`, independent of this database change.

## One-time box setup

```bash
sudo mkdir -p /opt/flowstarter/staging /etc/flowstarter /etc/caddy/platform
sudo cp deploy/hetzner-staging/docker-compose.yml /opt/flowstarter/staging/
sudo cp deploy/hetzner-staging/scripts/*.sh /opt/flowstarter/staging/
sudo chmod +x /opt/flowstarter/staging/*.sh
sudo install -m 600 /dev/null /etc/flowstarter/staging.env
# Edit staging.env with Clerk/etc. for the staging Clerk application.
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
run; CI's sync step (`staging-deploy.yml`) populates
`/opt/flowstarter/staging/repo` on every deploy of slot `main`, but the very
first run needs that directory seeded by hand (e.g. `git clone` or `rsync`
the repo's `supabase/` directory there) or by triggering one `staging-deploy`
run first.

## CI

- `.depot/workflows/staging-deploy.yml`: push to `main` deploys slot `main`
  (syncs `supabase/` to the host, runs migrations, refreshes staging.env)
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
