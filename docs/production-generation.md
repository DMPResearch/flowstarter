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
decides whether a failure that happens *while a run is already in progress*
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
