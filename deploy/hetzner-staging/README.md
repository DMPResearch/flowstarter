# Hetzner platform staging (flowstarter-main)

Runs the Next.js app in Docker on the **same Hetzner Caddy host** as client
sites, but **isolated** from deploy-agent:

| Path | Owner |
|------|--------|
| `/var/www/sites/*` | Client static sites (deploy-agent) |
| `/opt/flowstarter/staging` | Platform staging compose + scripts |
| `/etc/caddy/platform/*.caddy` | Platform vhosts (`staging` + `pr-*`) |

## Hostnames

| Slot | URL | DNS |
|------|-----|-----|
| `main` | `https://staging.flowstarter.dev` | A/AAAA (or CNAME) → **Hetzner box IP** |
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

## One-time box setup

```bash
sudo mkdir -p /opt/flowstarter/staging /etc/flowstarter /etc/caddy/platform
sudo cp deploy/hetzner-staging/docker-compose.yml /opt/flowstarter/staging/
sudo cp deploy/hetzner-staging/scripts/*.sh /opt/flowstarter/staging/
sudo chmod +x /opt/flowstarter/staging/*.sh
sudo install -m 600 /dev/null /etc/flowstarter/staging.env
# Edit staging.env with Clerk/Supabase/etc. for the staging Clerk application.
```

## CI

- `.depot/workflows/staging-deploy.yml` — push to `main` → slot `main`
- `.depot/workflows/staging-pr-deploy.yml` — PR → slot `pr-<n>`; closed → destroy

Secrets: see `docs/ci/secrets.md` (STAGING_SSH_*, GHCR via GITHUB_TOKEN).
