import { resolveBuildCommit } from '@/lib/build-commit';
import { probeBuildWorkerHealth } from '@/lib/flowstarter/pipeline/dispatch';
import { probeDatabase } from '@/lib/health/database-probe';
import { probeMcpHealth } from '@/lib/discovery/generation-availability';
import { getSigmaHealth } from '@/lib/sigma/warm';
import { describeSupabaseTarget } from '@/lib/supabase-target';
import { NextResponse } from 'next/server';

/**
 * Liveness probe for Hetzner staging / Docker HEALTHCHECK, and the endpoint
 * the deploy scripts, the watchers and every operator check actually trust.
 *
 * This used to echo `describeSupabaseTarget()` — the *configuration* — and
 * report `ok: true` unconditionally, without ever testing a connection.
 * `/api/health/database` ran a real probe and correctly reported an outage,
 * but nothing that matters read that endpoint: they all read this one. A
 * real Hetzner incident had the database down, `/api/health/database`
 * saying so, and `/api/health` cheerfully answering `"ok":true` the whole
 * time. `database`, `templateLibrary` and `buildWorker` below are now real,
 * bounded probes (run in parallel, each with its own short timeout), and
 * `ok` is their conjunction — never a value independent of what was actually
 * checked.
 *
 * `database` always runs: every deploy needs a working database. It reuses
 * `probeDatabase` (lib/health/database-probe.ts), the exact same probe
 * `/api/health/database` runs, so the two endpoints cannot disagree again.
 *
 * `templateLibrary` and `buildWorker` are each only "required" (able to fail
 * `ok`) when their URL is configured — most environments run neither the MCP
 * template library nor a standalone build worker, and reporting
 * `not-configured` (not `error`) keeps this endpoint honest about the
 * difference between "not wired up here" and "wired up and not answering".
 * `templateLibrary` reuses `probeMcpHealth`, the same bounded `GET /health`
 * probe #142 added to `generationPrerequisites`; `buildWorker` mirrors it
 * against the build worker's own unauthenticated `/health` route.
 *
 * `supabase` is still included so the staging deploy script can assert
 * `target === 'local'` before trusting this host: a staging box wired to a
 * hosted Supabase project is misconfigured even if the process is up. That
 * field describes *configuration*, same as before — `database` is what now
 * answers "is it actually reachable".
 *
 * `commit`, when known, is what lets a caller waiting on this endpoint (see
 * .github/scripts/wait-for-staging-slot.sh) tell a slot that finished
 * rolling out to the expected commit apart from one still serving the
 * previous build while the new one deploys underneath it -- health alone
 * cannot make that distinction. Omitted rather than faked when unknown: see
 * resolveBuildCommit.
 *
 * `sigma` reports whether `src/instrumentation.ts`'s startup warm-up of the
 * sigma classifier (`@flowstarter/sigma-flowstarter`) actually found its
 * model cache and loaded it — `'missing'` means every acceptable-use/scope
 * check is silently failing open to human review, which is a deploy defect
 * (see deploy/hetzner-staging/README.md, "Shipping the sigma model"), not a
 * reason to fail this probe: it never joins the `ok` conjunction, the same
 * way a remote Supabase target on a staging slot is reported, not refused,
 * here.
 *
 * The HTTP status stays 200 regardless of `ok`: every consumer of this
 * route (deploy-slot.sh, wait-for-staging-slot.sh, the docker-compose
 * HEALTHCHECK) reads the JSON body, and `curl -f` / a non-2xx status would
 * make a real failure indistinguishable from the server being unreachable,
 * throwing away the detail this fix exists to surface.
 */
export async function GET() {
  const commit = resolveBuildCommit();
  const env = process.env;
  const mcpUrl = env.FLOWSTARTER_MCP_URL?.trim() ?? '';
  const buildWorkerUrl = env.FLOWSTARTER_BUILD_WORKER_URL?.trim() ?? '';

  const [database, templateLibrary, buildWorker] = await Promise.all([
    probeDatabase(env),
    mcpUrl
      ? probeMcpHealth(mcpUrl, env).then((healthy): 'ok' | 'error' =>
          healthy ? 'ok' : 'error'
        )
      : Promise.resolve<'not-configured'>('not-configured'),
    buildWorkerUrl
      ? probeBuildWorkerHealth(buildWorkerUrl, env).then(
          (healthy): 'ok' | 'error' => (healthy ? 'ok' : 'error')
        )
      : Promise.resolve<'not-configured'>('not-configured'),
  ]);

  const ok =
    database.ok && templateLibrary !== 'error' && buildWorker !== 'error';

  return NextResponse.json(
    {
      ok,
      supabase: describeSupabaseTarget(),
      sigma: getSigmaHealth(),
      database: database.ok ? 'ok' : 'error',
      templateLibrary,
      buildWorker,
      ...(commit ? { commit } : {}),
    },
    { status: 200 }
  );
}
