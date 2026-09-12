# `@flowstarter/deploy-agent`

Tiny Bun HTTP service that runs on each Hetzner Caddy host. Receives deploys from `flowstarter-main` (or, eventually, the Hetzner operator service), extracts the artifact into `/var/www/sites/{slug}/`, writes the per-site Caddyfile snippet, and reloads Caddy.

Bootstrap is handled by the cloud-init script in `apps/flowstarter-main/src/lib/hosting/cloud-init.ts` — when `deployAgentArtifactUrl` is provided to that generator, Hetzner downloads this binary on first boot and starts the systemd unit.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness and configuration; authenticated |
| `POST` | `/sites/:slug/deploy` | Fetch artifact, extract, write snippet, reload Caddy |
| `DELETE` | `/sites/:slug` | Remove site dir + snippet, reload Caddy |
| `GET` | `/tls-ask?domain=…` | Previews mode only; no auth. 200 if this agent serves that preview hostname |

Every endpoint except `/tls-ask` requires `Authorization: Bearer <DEPLOY_AGENT_SHARED_SECRET>`, `/health` included: reaching it is how a connecting host proves the two sides hold the same secret, so an endpoint that answered everybody would prove nothing. `/tls-ask` stays open because Caddy's on-demand TLS ask cannot send a bearer token; it is loopback-only and reveals nothing but whether a preview hostname is being served.

`GET /health` answers:

```json
{ "ok": true, "version": "0.3.0", "mode": "sites", "siteRuntime": "docker" }
```

`siteRuntime` is part of the contract with `flowstarter-main`: `lib/hosting/connect-existing-server.ts` refuses a host that does not report `ok: true` with `siteRuntime: "docker"`.

Requests that mutate one slug are serialized per slug. Two deploys of the same site, or a deploy racing a delete, would otherwise both pick the same free container slot and fight over one Caddy snippet. Different slugs never wait on each other.

### `POST /sites/:slug/deploy` body

```json
{
  "artifact_url": "https://artifacts.flowstarter.app/builds/abc.tar.gz",
  "artifact_sha256": "...optional sha256 hex...",
  "primary_domain": "acme.com",
  "additional_domains": ["www.acme.com"]
}
```

The agent fetches the URL, verifies the sha256 if provided, extracts into a staging dir, then atomically renames into `/var/www/sites/{slug}/`. The previous version is moved to a `.backup-<ts>` dir and removed best-effort. Caddy snippet is written to `/etc/caddy/sites/{slug}.caddy` and Caddy is reloaded via `systemctl reload caddy`.

The tarball can also be POSTed directly as `application/octet-stream`, with the domains in `x-site-primary-domain` / `x-site-additional-domains` and the digest in `x-artifact-sha256`.

### Archive format

`src/tar-safety.ts` parses the archive itself rather than shelling out to `tar`, because a generated site's file names were chosen by a language model. It accepts gzipped ustar, pax and GNU tar, which covers both `packSiteTarball` (`packages/agentic-codegen/src/flowstarter/site-tarball.ts`) and an operator's `tar -czf site.tar.gz -C dist .`:

- pax extended headers (`x`) and GNU longname headers (`L`) name and size the entry that follows; pax global headers (`g`) are skipped. Without this, `tar -czf` on macOS — which writes a pax header before every entry — was rejected outright.
- `./`-prefixed names, trailing slashes and doubled separators are normalized away. The `./` entry for the archive root is not a file.
- Symlinks, hardlinks, device nodes and fifos are still refused, and a path that escapes the destination still fails whether it came from the ustar name field or a pax `path` record. Validation runs over the whole archive before a single byte is written.

## Environment

Required:
- `DEPLOY_AGENT_SHARED_SECRET` — Bearer token expected on every request.

Optional:
- `DEPLOY_AGENT_PORT` (default `8443`)
- `DEPLOY_AGENT_BIND_ADDRESS` (default `0.0.0.0`) — set to `127.0.0.1` for a host whose agent is private, reached only through an SSH tunnel. Binding to loopback makes that a property of the socket rather than of a firewall rule somebody has to remember to write.
- `DEPLOY_AGENT_SITES_ROOT` (default `/var/www/sites`)
- `DEPLOY_AGENT_CADDY_SITES_DIR` (default `/etc/caddy/sites`)
- `DEPLOY_AGENT_CADDY_RELOAD_CMD` (default `systemctl reload caddy`)
- `DEPLOY_AGENT_TEMP_ROOT` (default `/tmp/flowstarter-deploys`)
- `DEPLOY_AGENT_PREVIEW_DOMAIN_TEMPLATE` — e.g. `{slug}.preview.flowstarter.app` to auto-add the preview host to the snippet.

## Site runtime

`DEPLOY_AGENT_SITE_RUNTIME` picks how a deployed site is served. Default is
`filesystem` (unchanged: extract into `SITES_ROOT/{slug}`, Caddy serves that
directory). Set it to `docker` to instead run each site in its own
container:

- The artifact is extracted (with the same `tar-safety` validation either
  way — no symlinks, no device files, no path escaping the destination)
  into a throwaway build context alongside a Caddyfile and a Dockerfile
  this package owns (`docker/site-runtime.Dockerfile`); no tenant-supplied
  Dockerfile or npm script ever runs. The image is a pinned, non-root
  `caddy:2.11.4-alpine` (same hardening as `examples/dmpresearch/Dockerfile`).
- The container runs `--read-only --cap-drop ALL --security-opt
  no-new-privileges:true`, with `--pids-limit`/`--memory` caps, and
  publishes its port on loopback only (`-p 127.0.0.1::8080`, Docker-assigned).
  Every container and image carries `flowstarter.deploy-agent`,
  `flowstarter.mode` and `flowstarter.slug` labels; `DELETE /sites/:slug`
  removes only resources carrying this site's labels.
- Containers run with `--restart unless-stopped`, so a host reboot or a
  Docker daemon restart brings every site back without anybody logging in.
- Deploys are blue/green per slug (two name slots). The new container must
  answer `200` on `/` locally before the Caddy snippet is rewritten to
  `reverse_proxy` it — a 404 is not ready, which is exactly what a build
  that produced no `index.html` returns. If it never becomes healthy, or
  the Caddy write or reload fails or throws, the new container is torn
  down, the previous snippet is restored, and the previous container is
  left serving, unchanged.
- Nothing destructive runs on a name alone. Before removing a container
  the agent inspects its labels; a name collision with a container it does
  not own fails the deploy rather than deleting a stranger's container.
  Images are removed with plain `docker rmi`, never `rmi -f`, so the
  daemon refuses to untag an image a running container still references.

Extra env in docker mode:
- `DEPLOY_AGENT_DOCKER_BIN` (default `docker`)
- `DEPLOY_AGENT_DOCKER_READY_TIMEOUT_MS` (default `10000`)
- `DEPLOY_AGENT_DOCKER_READY_INTERVAL_MS` (default `250`)
- `DEPLOY_AGENT_DOCKER_TEMPLATE_DIR` — read `site-runtime.Dockerfile` and
  `site-runtime.Caddyfile` from this operator-owned directory instead of
  the copies compiled into the binary. For patching the base image without
  waiting for a new agent build. A directory that is set but unreadable
  stops the agent at startup rather than silently falling back.

## Previews mode

A host runs **two** instances of this binary. The second one serves anonymous
funnel previews and shares nothing writable with the first.

Set `DEPLOY_AGENT_MODE=previews` and the instance:

- writes site directories under `DEPLOY_AGENT_SITES_ROOT` (`/var/www/previews`)
  and Caddy snippets under `DEPLOY_AGENT_CADDY_SITES_DIR`
  (`/etc/caddy/previews/sites`) — a different Caddy **process**
  (`caddy-previews.service`) loads that directory, so a snippet that fails to
  parse cannot take down the Caddy serving paying customers;
- emits a different snippet: `http://{host}:{DEPLOY_AGENT_SITE_PORT}` with
  `header X-Robots-Tag "noindex, nofollow, noarchive"`, a static file server,
  and **no** editor reverse-proxy;
- exposes `GET /tls-ask?domain=…` (unauthenticated, loopback-only) so the front
  Caddy's `on_demand_tls` only issues certificates for preview hostnames this
  agent is actually serving.

Extra env in previews mode:

- `DEPLOY_AGENT_MODE=previews`
- `DEPLOY_AGENT_SITE_PORT` (default `9080`) — the previews Caddy's HTTP port
- `DEPLOY_AGENT_PREVIEW_HOST_SUFFIX`: defaults to `preview.${resolvePlatformDomain()}`
  from `@flowstarter/platform-config`: `preview.flowstarter.dev` unless this
  process's `FLOWSTARTER_ENV` (or `NODE_ENV`) says `production`, in which case
  `preview.flowstarter.net`.

Everything else — port, secret, roots, reload command — comes from the second
env file (`/etc/flowstarter/preview-deploy-agent.env`), written by
`buildCloudInit({ previewsDeployAgentSharedSecret })`. The previews secret is
distinct from the paid-site one on purpose: leaking it costs previews, not
customer sites.

## Building the host binary

The agent ships as one self-contained executable; a host needs no Bun, no
`node_modules` and no checkout.

```bash
bun install
bun run build:linux        # dist/deploy-agent-linux-x64
bun run build:linux-arm64  # dist/deploy-agent-linux-arm64, for Hetzner ARM
```

The Dockerfile and Caddyfile under `docker/` are compiled into the binary
as embedded assets (`import … with { type: 'file' }`), not read from a
path next to it. They used to be loaded from `import.meta.dir/../docker`,
which resolves to a virtual `/$bunfs/root` path in a compiled binary — so
Docker mode would have failed its first deploy with `ENOENT` on every host
that ran the shipped artifact rather than a checkout.

Cross-compiling from macOS works; Bun downloads the target runtime.

## Local dev

```bash
bun install
DEPLOY_AGENT_SHARED_SECRET=dev-secret \
DEPLOY_AGENT_SITES_ROOT=/tmp/sites \
DEPLOY_AGENT_CADDY_SITES_DIR=/tmp/caddy-sites \
DEPLOY_AGENT_CADDY_RELOAD_CMD='echo reloaded' \
bun run dev
```

Then from another shell:
```bash
curl -H 'Authorization: Bearer dev-secret' \
  -H 'Content-Type: application/json' \
  -X POST http://localhost:8443/sites/acme/deploy \
  -d '{"artifact_url":"https://example.com/site.tar.gz"}'
```
