# Hetzner platform staging (flowstarter-main)

Runs the Next.js app in Docker on the **same Hetzner Caddy host** as client
sites, but **isolated** from deploy-agent:

| Path                          | Owner                                |
| ----------------------------- | ------------------------------------ |
| `/var/www/sites/*`            | Client static sites (deploy-agent)   |
| `/opt/flowstarter/staging`    | Platform staging compose + scripts   |
| `/etc/caddy/platform/*.caddy` | Platform vhosts (`staging` + `pr-*`) |

## Hostnames

| Slot   | URL                                    | DNS                                                  |
| ------ | -------------------------------------- | ---------------------------------------------------- |
| `main` | `https://staging.flowstarter.dev`      | A/AAAA (or CNAME) → **Hetzner box IP**               |
| `pr-N` | `https://pr-N.staging.flowstarter.dev` | covered by `*.staging.flowstarter.dev` → **Hetzner** |

Do **not** CNAME these to the local Cloudflare tunnel (`flowstarter-dev`). That tunnel
still owns `www`, `workflows`, apex, `admin`, and the generic `*.flowstarter.dev`
catch-all for laptop demos — see `scripts/cloudflared-flowstarter-workflows.yml`.

Cloudflare DNS (example, dns-only so Caddy can terminate TLS):

```
staging.flowstarter.dev      A      <HETZNER_IP>
*.staging.flowstarter.dev    A      <HETZNER_IP>
```

Leave `www.flowstarter.dev` / `workflows.flowstarter.dev` as CNAMEs to the tunnel.

Caddy base file must include:

```caddy
import /etc/caddy/platform/*.caddy
```

Do **not** put these snippets under `/etc/caddy/sites/` (deploy-agent owns that).

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

**What CI does on every deploy** (`scripts/deploy-slot.sh`, see below): runs
`ensure` before starting the container; for slot `main` only, also runs
`migrate` and `write-env`, since PR slots share the schema slot `main` last
applied. The Caddy snippet that makes a slot reachable is written only after
the container is healthy and its own `/api/health` reports it is talking to
the local stack (`"target":"local"`), never a remote one.

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

# Loopback-only Docker publishing (mandatory, see "Database" above).
echo '{ "ip": "127.0.0.1" }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker

# Attach a Hetzner Cloud Firewall allowing inbound 22/80/443 only, then:
sudo REPO_DIR=/opt/flowstarter/staging/repo /opt/flowstarter/staging/supabase-stack.sh ensure
sudo REPO_DIR=/opt/flowstarter/staging/repo /opt/flowstarter/staging/supabase-stack.sh migrate
sudo /opt/flowstarter/staging/supabase-stack.sh write-env
sudo /opt/flowstarter/staging/supabase-stack.sh check
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

Secrets: see `docs/ci/secrets.md` (`STAGING_SSH_*`, `STAGING_SUPABASE_ANON_KEY`,
GHCR via `GITHUB_TOKEN`).
