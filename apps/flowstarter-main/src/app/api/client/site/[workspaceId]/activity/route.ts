import 'server-only';
/**
 * GET /api/client/site/[workspaceId]/activity — what the agent is doing on
 * this workspace's newest build, in the client's copy of the timeline.
 *
 * Its siblings under this folder open with `openSiteEditorContext`, and this
 * one deliberately does not. That helper's second step is `loadWorkspaceSite`,
 * which throws a 404 when a workspace has neither a published version nor a
 * preview manifest — which is exactly the state a project sits in while its
 * first build is running. Gating this route on it would hide the timeline from
 * the only readers it exists for. So the gate here is `requireWorkspaceAccess`
 * alone: the same membership check `openSiteEditorContext` starts with, and
 * the entire tenant boundary, without the "is there a site to edit yet"
 * question that has nothing to do with reading progress.
 *
 * Everything below that check runs with the service role, which bypasses RLS,
 * so both queries filter by `workspace_id` by hand — the discipline
 * `apps/build-worker/test/worker-tenant-filter.test.ts` enforces statically in
 * the worker, applied here because the reason for it is the same.
 *
 * `detail` never leaves this file. Every row goes through `isAgentActivityEvent`
 * and then `projectForClient`, which drops the field that carries file paths
 * and raw gate verdicts. A client is told the services section was edited, not
 * which `.astro` file it lives in.
 */
import { NextResponse } from 'next/server';
// Deep path, not the package root: the root re-exports the Pi SDK and the
// whole generation graph, none of which a route that reads four columns needs.
import {
  activityStatus,
  isAgentActivityEvent,
  projectForClient,
  type AgentActivityEvent,
} from '@flowstarter/agentic-codegen/src/flowstarter/activity';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A long build emits a few hundred steps. The ceiling is here so one runaway
 * job cannot turn a dashboard poll into a megabyte of JSON every five seconds.
 */
const MAX_ACTIVITY_ROWS = 500;

export interface ClientBuildActivityResponse {
  status: 'running' | 'done' | 'failed';
  events: AgentActivityEvent[];
}

/**
 * The job's own verdict outranks the events for a job that has stopped: a
 * build killed by a crash or a cancellation has no `failed` step to read,
 * because the thing that would have written one is what died. While the job is
 * still queued or running the events are the better answer, since a gate that
 * has just refused shows up in them before the ledger catches up.
 */
function resolveStatus(
  jobStatus: string,
  events: readonly AgentActivityEvent[]
): ClientBuildActivityResponse['status'] {
  if (jobStatus === 'failed' || jobStatus === 'canceled') return 'failed';
  if (jobStatus === 'succeeded') return 'done';
  return activityStatus(events);
}

/** Never cached: it is one tenant's live build, re-read every few seconds. */
function respond(body: ClientBuildActivityResponse): NextResponse {
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  const supabase = createSupabaseServiceRoleClient();

  try {
    const { data: job, error: jobError } = await supabase
      .from('flowstarter_agent_jobs')
      .select('id, status')
      .eq('workspace_id', access.workspaceId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (jobError) throw jobError;

    // No job yet, or none left after a workspace was reset. Nothing is
    // running, so the honest answer is an empty finished timeline rather than
    // a 404 the poller would have to read as an error every five seconds.
    if (!job) return respond({ status: 'done', events: [] });

    const { data: rows, error: rowsError } = await supabase
      .from('flowstarter_agent_job_events')
      .select('payload')
      .eq('workspace_id', access.workspaceId)
      .eq('job_id', job.id)
      .eq('kind', 'activity')
      .order('created_at', { ascending: true })
      .limit(MAX_ACTIVITY_ROWS);
    if (rowsError) throw rowsError;

    const events: AgentActivityEvent[] = [];
    for (const row of rows ?? []) {
      const candidate = (row.payload as { activity?: unknown } | null)
        ?.activity;
      // A malformed row is dropped, never repaired: a repaired event is an
      // invented step, and an invented step is a lie about a build.
      if (isAgentActivityEvent(candidate)) {
        events.push(projectForClient(candidate));
      }
    }

    return respond({
      status: resolveStatus(String(job.status ?? ''), events),
      events,
    });
  } catch (error) {
    console.error('[api/client/site/activity] request failed', error);
    return NextResponse.json(
      { error: 'Something went wrong on our side.', code: 'INTERNAL' },
      { status: 500 }
    );
  }
}
