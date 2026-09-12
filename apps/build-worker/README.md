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
  -> claim the ledger row (unleased queued|failed|waiting_brief, or running
     with a dead lease -> running + this worker's lease, compare-and-set)
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

| Variable                                                              | Default                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `FLOWSTARTER_BUILD_WORKER_PORT`                                       | `8787`                                                                              |
| `FLOWSTARTER_BUILD_WORKER_HOST`                                       | `0.0.0.0`                                                                           |
| `PI_PROVIDER` / `PI_MODEL`                                            | `openrouter` / `z-ai/glm-5.2`                                                       |
| `PI_THINKING_LEVEL` / `PI_TIMEOUT_MS`                                 | `medium` / `1800000`                                                                |
| `FLOWSTARTER_SITES_BASE_REF` / `FLOWSTARTER_SITES_REMOTE`             | `main` / `origin`                                                                   |
| `FLOWSTARTER_STAGING_URL_TEMPLATE`                                    | `https://{projectId}.staging.flowstarter.net`                                       |
| `FLOWSTARTER_BUILD_VALIDATE_COMMANDS`                                 | `[["pnpm","install","--ignore-scripts","--prefer-offline"],["pnpm","run","build"]]` |
| `FLOWSTARTER_BUILD_ISOLATION`                                         | `docker` in staging/production, `native` in development — see below                 |
| `FLOWSTARTER_BUILD_VALIDATE_ISOLATION`                                | the name that setting shipped under; still honoured, and must not disagree          |
| `FLOWSTARTER_BUILD_TIMEOUT_MS`                                        | `900000` (per command)                                                              |
| `FLOWSTARTER_BUILD_MAX_ATTEMPTS`                                      | `3`                                                                                 |
| `FLOWSTARTER_BUILD_CONCURRENCY` / `FLOWSTARTER_BUILD_QUEUE_LIMIT`     | `1` / `32`                                                                          |
| `FLOWSTARTER_BUILD_POLL_INTERVAL_MS` / `FLOWSTARTER_BUILD_POLL_LIMIT` | `60000` / `25` — how often the ledger is swept, and how many rows one sweep takes   |
| `FLOWSTARTER_BUILD_LEASE_TTL_MS`                                      | `120000` — how long a claim is good for without a heartbeat                         |
| `FLOWSTARTER_BUILD_LEASE_HEARTBEAT_MS`                                | `30000` — at most half the TTL, or the service refuses to start                     |
| `FLOWSTARTER_BUILD_RETRY_BACKOFF_MS`                                  | `30000` — the first retry's wait; doubles per attempt                               |
| `FLOWSTARTER_BUILD_RETRY_BACKOFF_MAX_MS`                              | `900000` — the cap on that doubling                                                 |
| `CAL_BASE_URL`                                                    | unset — the platform's own Cal.com, e.g. `https://cal.flowstarter.dev`              |

`CAL_BASE_URL` is optional but load-bearing once the platform provisions
booking pages itself (see `docs/operations/cal.md`). The host in it is what
tells `normalizeCalTarget` that a `workspaces.cal_com_url` on the platform's
own Cal.com is a real booking link. **Leave it unset and every self-hosted
booking link is silently dropped from the build** — the host allow list falls
back to `cal.com` only, `parseCalComUrl` returns null, the page set drops the
booking page, and the client's site ships without the calendar they were
emailed a link to. It must be set to the same value the app slot carries.

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

## Durable queue

The in-process queue is an array of promises and dies with this process. It is
not the _record_ of what work exists: the ledger is, and one sweep every
`FLOWSTARTER_BUILD_POLL_INTERVAL_MS` reads it back.

```
claim        one compare-and-set writes running + leased_by + lease_expires_at
heartbeat    every 30s while the build runs, expiry moves out by 120s
sweep        recover every dead lease, then enqueue everything runnable
fail         status failed, lease dropped, run_after = now + 30s x 2^(attempt-1)
```

A sweep asks the database two questions in that order.

**What has a dead worker abandoned?** A `running` row whose lease has stopped
being renewed is a build whose worker is gone. Before leases existed nothing
ever looked at such a row again — the claim rule excluded `running` outright and
the operator board refused to re-dispatch it — so a paid build sat there until a
client asked where their site was. Recovery does one of three things with it,
and says which on the console:

- **complete** — the build had already pushed its commit and opened its PR, and
  only the ledger was behind. It is finished from its own payload and nothing is
  rebuilt or re-published. Not applied to `CHANGE_REQUEST_BUILD`, whose last
  step also stamps a site version and moves the request `paid -> done`; those
  are rebuilt, which their own compare-and-set makes safe.
- **requeue** — nothing shipped and attempts remain. Due immediately: the wait
  already happened, as a build that ran and died.
- **abandon** — the retry budget is spent, so the row reads `failed` and appears
  on the operator board instead of looping.

**What is runnable now?** Everything `queued` and due, every `failed` retry
whose backoff has elapsed, and every `waiting_brief` job whose client has since
finished their brief (promoted to `queued` here, guarded on the status that was
read). Recovery runs first so a build it just re-queued is picked up by the same
sweep rather than waiting out another interval.

`waiting_brief` is never treated as abandoned. Nobody is holding it and nothing
is wrong with it; the thing that ends its wait is a client filling in a form.

`POST /api/admin/projects/[id]/pipeline/redispatch` may re-queue a `running` job
whose lease has expired, guarded on the exact dead holder. A job whose worker is
still checking in is still refused.

Migration: `supabase/migrations/20260912170000_agent_job_leases.sql`.

## Validation isolation

Validation is the one step that executes generated code for real: an Astro build
runs the site's own config, its integrations and whatever the install resolved.
In `native` mode all of that runs as this service's user, with this service's
filesystem — so a generated `astro.config.mjs` can read a neighbouring client's
worktree, `/etc/flowstarter/*`, or this worker's own `.env`. Scrubbing the child
environment removes the credentials from the _process_; it does nothing about
the ones on _disk_.

So `FLOWSTARTER_BUILD_ISOLATION` is a rule of the environment, not a preference:

| Resolved `FLOWSTARTER_ENV` | Default  | `native` allowed?                     |
| -------------------------- | -------- | ------------------------------------- |
| `development`, `test`      | `native` | yes — a laptop may have no daemon     |
| `staging`, `production`    | `docker` | **no** — the service refuses to start |

There is no fallback. A staging or production host that cannot run the isolated
validator must fail loudly rather than quietly build a client's generated code
next to every other client's worktree. The rule is a pure module,
`src/isolation.ts`, and is unit-tested there.

Each command gets its own disposable container, and the container is given:

- **one** bind mount, the site workspace, at `/site` — no host home directory,
  no Docker socket, no path outside the workspace;
- a `--read-only` root filesystem: `/site` and the `/tmp` tmpfs are the only
  writable paths, and the tmpfs dies with the container;
- `--network=none` for every command except the install step, which is the one
  that legitimately needs a registry (see below);
- a non-root `--user`, this service's own uid:gid by default so build output in
  the mount stays readable. Running the build as root is refused, not accepted:
  set `FLOWSTARTER_BUILD_VALIDATE_DOCKER_USER` if this service runs as root;
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

| Variable                                          | Default                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_BIN`           | `docker` (bare executable name)                                                                                  |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE`         | `node:22-bookworm-slim`                                                                                          |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_NETWORK`       | `bridge` — the **install** step's egress; a named network routes it through a registry proxy. `host` is refused. |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_BUILD_NETWORK` | `none` when pnpm is baked into the image, otherwise the install network                                          |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_PNPM_BAKED`    | `false` — `true` when the image already has the pinned pnpm prepared                                             |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_USER`          | this service's own `uid:gid`. May not be uid 0.                                                                  |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_MEMORY`        | `4g`                                                                                                             |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_TMPFS_SIZE`    | `2g` (holds `HOME` and the pnpm store)                                                                           |
| `FLOWSTARTER_BUILD_VALIDATE_DOCKER_PIDS_LIMIT`    | `1024`                                                                                                           |
| `FLOWSTARTER_BUILD_VALIDATE_PNPM_VERSION`         | `10.29.2`                                                                                                        |

### Network, per command

Only the install step may reach a registry. Everything after it —
`pnpm run build` above all — gets `--network=none`, because a generated site has
no business calling out from its own build.

That is only possible if the image can supply pnpm by itself: corepack downloads
the pinned version on first use, into a corepack home that lives on the
container's tmpfs and dies with it, so a stock image needs a registry for
_every_ command. `docker/validation-runtime.Dockerfile` bakes it in — build that
image, point `FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE` at it, and set
`FLOWSTARTER_BUILD_VALIDATE_DOCKER_PNPM_BAKED=true`; the file's own header has
the exact command.

Without it the worker grants the build step the same egress as the install and
names that in the boot log — an honest default rather than a broken one. Asking
for `FLOWSTARTER_BUILD_VALIDATE_DOCKER_BUILD_NETWORK=none` on an image with no
baked pnpm is refused at boot, with that command in the message.

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
  `(status, attempt_count, leased_by)`.
- Two workers cannot write one worktree: a lease is refused while its holder is
  still checking in, and recovery guards on the exact dead holder it read.

## Tests

```bash
pnpm --dir apps/build-worker test
pnpm --dir apps/build-worker typecheck
```

Nothing in the suite touches the network, Supabase, GitHub or a real Pi model —
every one of those is an injected seam.

One test is opt-in, because it needs a live Docker daemon: an adversarial
"build" that tries to read a neighbouring workspace's secret,
`/etc/flowstarter/*`, this worker's `.env` and `/var/run/docker.sock`, run for
real under the isolated validator and asserted to be refused all four — and run
natively and asserted to reach all four, which is the defect stated as a passing
test. Build the validation image, then set `FLOWSTARTER_BUILD_DOCKER_PROOF=1`
and run `test/docker-isolation-proof.test.ts`. The same four targets are
asserted against the container's argument vector in `test/validator.test.ts`,
which runs everywhere.
