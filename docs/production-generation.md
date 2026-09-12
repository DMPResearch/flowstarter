# Preview generation in production

Where `POST /api/discovery/preview/live` (the free, live-sandbox preview the
intake wizard kicks off) can actually run, and why it could not on Netlify.

> **Outcome, 2026-09.** Shape A won. Production left Netlify Functions and now
> runs as a long-lived Node container on the Hetzner box, the `prod` slot at
> `flowstarter.net` (`docs/release-process.md`,
> `deploy/hetzner-staging/README.md`). The execution-model objection below is
> therefore settled: the route no longer runs under a function timeout. What
> remains is the prerequisites half of the argument. The pipeline stays off
> until `FLOWSTARTER_MCP_URL`, `FLOWSTARTER_MCP_INTERNAL_TOKEN`, the model key
> and `DAYTONA_API_KEY` are present in `/etc/flowstarter/prod.env`;
> `missingGenerationPrerequisites()` still tells the visitor the truth up front
> while they are not. The analysis below is kept as the record of the decision.

## Can it run on Netlify Functions at all

No, for two independent reasons.

**1. The prerequisites are not there.** The route needs four things from the
environment: a Pi/OpenRouter model key, the MCP template library
(`FLOWSTARTER_MCP_URL` + `FLOWSTARTER_MCP_INTERNAL_TOKEN`), and
`DAYTONA_API_KEY` for the sandbox. Netlify's environment for this app has
`OPENROUTER_API_KEY` and none of the rest (see
`apps/flowstarter-main/src/lib/discovery/generation-availability.ts`, added by
this change to name exactly which ones). Before this fix that check lived
only inside the detached worker
(`apps/flowstarter-main/src/app/api/discovery/preview/live/route.ts:537-544`
prior to this change), so it ran after the job already existed and the
visitor had already been told a build was starting.

**2. Even fully configured, the run pattern does not fit a Function.** The
route answers the POST immediately and keeps working in a detached,
un-awaited `async` closure (`void (async () => { ... })()` at
`.../live/route.ts:~476`) that runs the Pi pipeline over several model turns
(minutes), then publishes to a Daytona sandbox, all after the HTTP response
has already gone out. That relies on the Node process staying alive past the
response, which a persistent server gives you and a request-scoped Lambda
does not: a standard Netlify Function (the shape `@netlify/plugin-nextjs`
deploys this app as) is free to freeze or reclaim its execution environment
once the response is sent. `maxDuration = 300` bounds a single invocation; it
does not promise the detached work survives after that invocation's response
went out. So this is not only a missing-secret problem: the current
fire-and-forget shape needs a long-lived process regardless.

The local `astro dev` fallback (`publishLocalPreview`, same file) makes the
second point sharper: it spawns a child process and polls it over HTTP for up
to 60 seconds from the same handler. That is a server behavior, not a
function behavior.

## What `preview-failure.ts` does with this

`isTransientPipelineFailure` (`apps/flowstarter-main/src/lib/discovery/preview-failure.ts`)
decides whether a failure that happens _while a run is already in progress_
is worth one restart. The missing-prerequisites case never reaches it: the
route fails the job directly, before calling the pipeline, with `error: 'Pi
preview infrastructure is not configured'`, and that message deliberately
does not match `TRANSIENT_PREVIEW_FAILURE` (there is a test for exactly this
in `preview-failure.test.ts`). Restarting a run that cannot start would only
fail again at the same cost; classifying it as fatal-not-transient was
already correct. What this change adds is upstream of that: not attempting
the run at all when the prerequisites are absent, and telling the visitor
the honest thing instead of the sequence "Getting your build started" →
"The build stopped".

## Two viable shapes

**A. The app on a persistent host, the worker beside it.** Move
`apps/flowstarter-main` off Netlify Functions onto a long-running Node
process (a container, or the Hetzner host referenced in
`docs/preview-environment.md` for the staging build worker). The current
code needs no change: the detached closure, the in-memory `live-jobs.ts`
store, and the SSE stream all assume one process stays up for the life of a
job, which becomes true again. Cost: the whole app leaves Netlify's managed
deploys, previews and rollbacks for a self-run server, for the sake of one
feature that is a small fraction of the app's routes.

**B. Generation moves to the worker, the app enqueues and polls.**
`apps/flowstarter-main` stays on Netlify. `POST /api/discovery/preview/live`
becomes a thin enqueue: validate the spec and budget as today, write a job
row (a new `preview_jobs` table, or an extension of `funnel_previews`) with
status `queued`, and return the `demoId`. A persistent worker (an addition
to `apps/build-worker`, which already runs on a Hetzner host and already
knows how to drive `packages/agentic-codegen`, or a sibling process next to
it) claims queued jobs, runs the existing `PreviewGenerationPipeline` and
`previewInSandbox` (`@flowstarter/daytona-utils`) unchanged, and writes
phase/status/previewUrl back to the row. `GET
/api/discovery/preview/live` and the SSE stream read that row instead of the
in-memory map. Cost: `live-jobs.ts` stops being in-memory and becomes a real
table, and the SSE route needs a source that is not a same-process
`EventEmitter` (a poll of the row, or Supabase Realtime).

## Recommendation

Shape B. `apps/build-worker` already proves this pattern for the paid,
post-deposit build: a queue, a persistent worker, status written back for
the app to read. Extending it to the free preview reuses that precedent and
its Hetzner host instead of opening a second one, and it leaves the rest of
the app, which works fine on Netlify today, exactly where it is. Shape A
fixes this one feature by moving everything, which is a much larger and
riskier change for a smaller gain.

Concretely, in a follow-up (not this change): add the job table and RLS for
it (anonymous funnel traffic, so no `workspace_id` yet, same as
`funnel_previews` today); teach the worker to claim and run preview jobs
the same way it claims paid builds; switch `live-jobs.ts`'s callers to the
table instead of the in-memory map; and change the SSE route's transport
from an in-process emitter to a poll or Realtime subscription on the row.
Local development can keep the current in-process path behind an env flag,
so a laptop without the worker running still works.

## The paid build worker: leases, and where generated code runs

Two rules the worker in `apps/build-worker` now enforces, both closing findings
from `docs/quality/codex-review-2026-09-12.md`. They are recorded here because
the shape above ("a persistent worker claims queued jobs") is only safe if a
worker that dies gives its job back, and only safe to run at all if what it
builds cannot read the host.

### The lease model (risk 4: a restart could strand paid work)

The queue in `queue.ts` is still an array of promises, and it still dies with
the process. What changed is that it is no longer the record of what work
exists. The ledger is.

A claim writes two new columns on `flowstarter_agent_jobs`
(`supabase/migrations/20260912170000_agent_job_leases.sql`):

| Column             | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `leased_by`        | the worker process holding the job, `host:pid:nonce` |
| `lease_expires_at` | when that hold runs out unless it is renewed         |

- **Claim.** One compare-and-set on `(id, status, attempt_count, leased_by)`
  writes `running` _and_ the lease together, so no row ever reads `running`
  with nobody named on it.
- **Heartbeat.** Every `FLOWSTARTER_BUILD_LEASE_HEARTBEAT_MS` (30s) while the
  build runs, the expiry moves forward by
  `FLOWSTARTER_BUILD_LEASE_TTL_MS` (2 minutes). The beat must fit twice inside
  the TTL or the worker refuses to start. A renewal that matches no row means
  another worker took the job; this one stops renewing and lets its own
  compare-and-set refuse the finish.
- **Claimability.** `running` is no longer excluded outright — it is excluded
  _while its lease holds_. That one change is what lets a restarted worker pick
  up the build its predecessor died inside. A `running` row with no lease
  (claimed by a worker from before this migration) is dated from `started_at`
  instead; a row with neither is left for an operator rather than guessed at.
- **Recovery, on every sweep.** `BuildReconciler` (`reconcile.ts`, the poller
  the brief work added) now does two things in order, starting with the first
  sweep at boot. First it takes every `running` row whose lease has died and
  logs what it did with each one — three outcomes, decided by
  `apps/build-worker/src/leases.ts`: _complete_ (the build had already
  published — see below), _requeue_ (attempts remain), _abandon_ (budget spent,
  so it reads `failed` and appears on the operator board rather than looping).
  A `waiting_brief` job is never one of these: nobody holds it, nothing is
  wrong with it, and the thing that ends its wait is a client filling in a form.
- **Then the queue.** Every `FLOWSTARTER_BUILD_POLL_INTERVAL_MS` (60s) the
  worker re-reads the ledger for everything runnable: `queued` and due, a
  `failed` retry whose backoff has elapsed, a `waiting_brief` job whose brief is
  now ready, and a `running` job whose lease has expired. A dispatch that never
  arrived — an unreachable worker, a dropped webhook, a scheduled retry —
  reaches a build without anybody re-posting anything. Recovery running first is
  what lets a build it just re-queued start in the same sweep.
- **Backoff.** A failed attempt writes `run_after = now + 30s · 2^(attempt-1)`,
  capped at 15 minutes, onto the row. On the row, not in a timer: a worker that
  restarts between attempts still honours it, and an operator can see when the
  next try is due.
- **Idempotent publication.** Publication happens before the statement that
  marks the job succeeded. A worker killed between them leaves a row saying
  `running` and a payload saying the site shipped. Recovery reads the payload
  first: if it carries a commit _and_ a PR url, the job is completed from that
  payload and nothing is rebuilt or re-published. A `CHANGE_REQUEST_BUILD` is
  deliberately excluded from that shortcut — its final step also stamps a site
  version and moves the request `paid -> done`, and guessing at those from a
  payload is how a client gets told a change shipped that did not.
- **The operator board.** `POST .../pipeline/redispatch` may now re-queue a
  `running` job whose lease has expired, guarded on the exact dead holder it
  read. A job whose worker is still checking in is still refused.

### The isolation rule (risk 3: generated builds ran with host filesystem access)

Validation is the one step that executes code an agent wrote: `pnpm run build`
runs the site's own Astro config, its integrations, and whatever the install
resolved. Native mode runs all of that as the worker's user, so a generated
config can read neighbouring client worktrees, `/etc/flowstarter`, and the
worker's own `.env`. Scrubbing the child environment removes credentials from
the _process_; it does nothing about the ones on _disk_.

`FLOWSTARTER_BUILD_ISOLATION` is therefore a rule of the environment
(`apps/build-worker/src/isolation.ts`), not an operator preference:

| Resolved `FLOWSTARTER_ENV` | Default  | `native` allowed?                    |
| -------------------------- | -------- | ------------------------------------ |
| `development`, `test`      | `native` | yes                                  |
| `staging`, `production`    | `docker` | **no** — the worker refuses to start |

There is no fallback. A staging or production host that cannot run the isolated
validator must fail loudly rather than quietly build a client's generated code
next to every other client's worktree.

Each command runs in its own disposable container:

- exactly **one** bind mount, the job's worktree, at `/site`;
- `--read-only` root, with `/tmp` the only writable tmpfs (it holds `HOME` and
  every cache and dies with the container);
- `--network=none` for the build step; the install step alone may reach a
  registry, through `bridge` or a named proxy network. `none` for the build
  requires an image with the pinned pnpm already prepared
  (`apps/build-worker/docker/validation-runtime.Dockerfile`), because corepack
  would otherwise have to fetch it on every command; on the stock
  `node:22-bookworm-slim` the worker grants the build step the same egress as
  the install and says so;
- `--cap-drop=ALL --security-opt=no-new-privileges`, memory and PID caps,
  `--init` so a timeout actually stops the build;
- a non-root `--user`; running as root is refused rather than accepted;
- no Docker socket, no host home, no inherited environment, and a proxy URL
  (which can embed basic-auth) reaching only the command that has a registry to
  talk to.

The adversarial fixture in `apps/build-worker/test/docker-isolation-proof.test.ts`
runs a "build" that tries to read another workspace's secret, `/etc/flowstarter`,
the worker's `.env` and `/var/run/docker.sock`, and asserts it is refused all
four under isolation and reaches all four natively. It is opt-in
(`FLOWSTARTER_BUILD_DOCKER_PROOF=1`) because it needs a live daemon; the same
four targets are asserted against the container's argument vector in
`validator.test.ts`, which runs everywhere.
