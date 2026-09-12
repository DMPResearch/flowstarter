# @flowstarter/build-worker

The private Pi build worker from `docs/FLOWSTARTER_AGENT_ARCHITECTURE.md`. It
closes the `DEPOSIT_PAID -> AGENTS_WORKING -> HUMAN_QA` leg of the lifecycle.

Before this service existed, `enqueueFullBuildFromDeposit` wrote a
`FULL_SITE_BUILD` row to the ledger and POSTed to
`FLOWSTARTER_BUILD_WORKER_URL/jobs/full-site` — and nothing was listening. This
is the listener.

## What it does

```
POST /jobs/full-site  { "jobId": "<uuid>" }
  -> claim the ledger row (queued|failed -> running, atomic compare-and-set)
  -> refuse unless the workspace is DEPOSIT_PAID
  -> git worktree  client/flowstarter-<uuid>  off the sites repo
  -> materialize the approved preview files into generated-sites/<uuid>/
  -> Pi full-site coding session, bounded to that directory
  -> trusted validation (install + build + dist/ must exist) — runs outside Pi
  -> atomic commit
  -> push branch, open a draft PR, record the staging URL
  -> ledger succeeded, workspace -> HUMAN_QA
```

Any failure records `FULL_SITE_BUILD_FAILED` on the ledger and rolls the
workspace back to `DEPOSIT_PAID` so the job can be re-dispatched (up to
`FLOWSTARTER_BUILD_MAX_ATTEMPTS`).

## Endpoints

| Method | Path              | Auth   | Response                                                                 |
| ------ | ----------------- | ------ | ------------------------------------------------------------------------ |
| `POST` | `/jobs/full-site` | Bearer | `202` accepted (build runs detached), `400` bad job id, `503` queue full |
| `GET`  | `/health`         | none   | `200 { ok, version, active, waiting }`                                   |

The caller times out after 8s, so `/jobs/full-site` always answers immediately
and the build runs on the in-process queue behind it.

## Where it runs

The Hetzner compute host, never Netlify — builds take minutes and need a real
filesystem, git and a package manager. Run it under systemd next to the
deploy-agent, or via `pnpm --dir apps/build-worker start`.

## Configuration

Required:

| Variable                                 | Purpose                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `FLOWSTARTER_BUILD_WORKER_SECRET`        | Shared bearer secret; must match flowstarter-main. Minimum 32 chars.                  |
| `NEXT_PUBLIC_SUPABASE_URL`               | Supabase project URL.                                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`              | Service role — the ledger and artifact tables have no other grant.                    |
| `PI_API_KEY` _(or `OPENROUTER_API_KEY`)_ | Model credentials for the Pi session.                                                 |
| `FLOWSTARTER_REPOSITORY_ROOT`            | Absolute path to the client-sites git checkout.                                       |
| `FLOWSTARTER_WORKTREES_ROOT`             | Absolute path where per-client worktrees are created. Must differ from the repo root. |
| `FLOWSTARTER_SITES_REPO`                 | `owner/repo` for the PR.                                                              |
| `FLOWSTARTER_SITES_GITHUB_TOKEN`         | Token with `contents:write` + `pull_requests:write` on that repo.                     |

Optional:

| Variable                                                          | Default                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `FLOWSTARTER_BUILD_WORKER_PORT`                                   | `8787`                                                                              |
| `FLOWSTARTER_BUILD_WORKER_HOST`                                   | `0.0.0.0`                                                                           |
| `PI_PROVIDER` / `PI_MODEL`                                        | `openrouter` / `z-ai/glm-5.2`                                                       |
| `PI_THINKING_LEVEL` / `PI_TIMEOUT_MS`                             | `medium` / `1800000`                                                                |
| `FLOWSTARTER_SITES_BASE_REF` / `FLOWSTARTER_SITES_REMOTE`         | `main` / `origin`                                                                   |
| `FLOWSTARTER_STAGING_URL_TEMPLATE`                                | `https://{projectId}.staging.flowstarter.net`                                       |
| `FLOWSTARTER_BUILD_VALIDATE_COMMANDS`                             | `[["pnpm","install","--ignore-scripts","--prefer-offline"],["pnpm","run","build"]]` |
| `FLOWSTARTER_BUILD_VALIDATE_ISOLATION`                            | `native` — see below                                                                |
| `FLOWSTARTER_BUILD_TIMEOUT_MS`                                    | `900000` (per command)                                                              |
| `FLOWSTARTER_BUILD_MAX_ATTEMPTS`                                  | `3`                                                                                 |
| `FLOWSTARTER_BUILD_CONCURRENCY` / `FLOWSTARTER_BUILD_QUEUE_LIMIT` | `1` / `32`                                                                          |

The service refuses to start if any required value is missing or malformed.

### Local publish mode (`pnpm run dev:local`)

`FLOWSTARTER_BUILD_MODE=local` swaps the GitHub-PR publish path for a worker
that writes straight to a local artifacts directory and posts its deploy
callback to a running `flowstarter-main` — no GitHub token, no provisioned
host, nothing else provisioned. It is what `pnpm run dev:local` sets.

| Variable                                                     | Required?                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FLOWSTARTER_MAIN_URL`                                       | **Yes**, whenever `FLOWSTARTER_BUILD_MODE=local` | Where the worker posts its deploy callback. **No default.** It used to default silently to `http://127.0.0.1:3000`, which killed two separate builds (2026-09-11 and 2026-09-12) because nothing was listening there — see `docs/quality/mvp-readiness-2026-09-12.md`, "Build and delivery". Set it to wherever `flowstarter-main`'s dev server is actually running, e.g. `http://127.0.0.1:3067`. The process refuses to boot without it (outside the unit-test suite).                                                                                                             |
| `FLOWSTARTER_BUILD_STUB_AGENT`                               | No — **opt-in only**                             | `true` swaps the real Pi coding session for a deterministic stub that copies a fixture site instead of generating one. It is never implied by `dev:local` itself — the script does not set it, so a plain `pnpm run dev:local` exercises the real agent. Set it yourself (shell or `.env.local`) when you want the fast, model-free loop. It never touches validation: `pnpm install && pnpm run build` still runs for real regardless of this flag. Only `FLOWSTARTER_BUILD_SKIP_VALIDATION` (unit-test-only, refused outside development) can swap that out — see `src/config.ts`. |
| `FLOWSTARTER_BUILD_ARTIFACTS_ROOT`                           | No                                               | `/tmp/flowstarter-build-artifacts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `FLOWSTARTER_BUILD_ARTIFACT_BASE_URL`                        | No                                               | `http://127.0.0.1:<port>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `FLOWSTARTER_BUILD_OUTPUT_DIR`                               | No                                               | `dist`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `FLOWSTARTER_REPOSITORY_ROOT` / `FLOWSTARTER_WORKTREES_ROOT` | No, in local mode                                | `/tmp/flowstarter-local/repository` / `/tmp/flowstarter-local/worktrees`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Validation isolation

Validation is the one step that executes generated code for real: an Astro build
runs the site's own config, its integrations and whatever the install resolved.
`FLOWSTARTER_BUILD_VALIDATE_ISOLATION` decides where that happens.

`native` (default) runs the commands on the build host as this service's user —
the historical behaviour, and the only option on a host with no Docker daemon.

`docker` runs each command inside a disposable container. It is opt-in per host
rather than automatic: it needs a working daemon, and a half-configured one must
fail loudly instead of silently falling back to building next to the
service-role key. Each command gets its own container, and the container is
given:

- **one** bind mount, the site workspace, at `/site` — no host home directory,
  no Docker socket, no path outside the workspace;
- `--cap-drop=ALL --security-opt=no-new-privileges`, a memory cap and a pids
  cap, `--init` so a timeout actually stops the build, `--rm` plus a
  `docker rm --force` by name for the one case `--rm` cannot cover (a killed
  client leaving the daemon holding a live container);
- an environment built from scratch: `HOME` and every cache point into the
  container's own tmpfs, so nothing is inherited from this process;
- `corepack pnpm@10.29.2` as the package manager. An operator-configured `pnpm`
  command is rewritten to that pinned wrapper; the toolchain comes from the
  image, never from the host and never from the generated site's manifest.

Only `corepack`, `node`, `npm`, `npx` and `pnpm` can be named in
`FLOWSTARTER_BUILD_VALIDATE_COMMANDS` under `docker`, and the service refuses to
start if something else is. The image must be public or already pulled: the
Docker CLI is invoked with `PATH`, `HOME`, `DOCKER_HOST` and `DOCKER_CONTEXT`
and no registry credentials.

| Variable                                       | Default                                         |
| ---------------------------------------------- | ----------------------------------------------- |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_BIN`        | `docker` (bare executable name)                 |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE`      | `node:22-bookworm-slim`                         |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_NETWORK`    | `bridge` (`none` for a pre-populated workspace) |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_MEMORY`     | `4g`                                            |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_TMPFS_SIZE` | `2g` (holds `HOME` and the pnpm store)          |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_PIDS_LIMIT` | `1024`                                          |
| `FLOWSTARTER_BUILD_VALIDATE_PNPM_VERSION`      | `10.29.2`                                       |

Build output is logged the same way in both modes, and the `dist/` gate is still
checked on the host — the bind mount is where the container wrote it.

## Boundaries

- The Pi session gets Flowstarter-owned `read_file`/`write_file`/`edit_file`
  rooted at `generated-sites/<uuid>/` — no shell, no general filesystem.
- Validation commands are operator-defined and run **outside** Pi. Their names
  must be bare executables, and they run through `execFile` (no shell).
- A validation command never inherits this process's environment, in either
  isolation mode. The child gets an allowlist — `PATH`, `HOME`, locale, cache and
  proxy variables — so the service-role key, the Pi key and the GitHub token
  cannot reach a generated build. An allowlist, not a denylist: the rule has to
  stay correct when the next secret is added to the worker's environment.
- The GitHub token reaches git through `GIT_CONFIG_*` env vars, not `git -c` or
  a credential-bearing remote URL, so it never appears in process argv or the
  repo config. Git and GitHub error text is redacted before it is logged or
  stored on the ledger.
- Duplicate dispatch is safe twice over: the queue collapses an in-flight job
  id, and the ledger claim is an atomic compare-and-set on
  `(status, attempt_count)`.

## Tests

```bash
pnpm --dir apps/build-worker test
pnpm --dir apps/build-worker typecheck
```

Nothing in the suite touches the network, Supabase, GitHub or a real Pi model —
every one of those is an injected seam.
