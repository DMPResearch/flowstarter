/**
 * The operator pipeline API, once.
 *
 * `/api/admin/*` and `/api/team/*` are the same surface under two names, and
 * every existing pair in this tree was copy-pasted — which is how the two
 * halves of an endpoint drift until only one of them has the fix. These
 * handlers live here and both route trees are one-line re-exports of them, so
 * there is exactly one implementation and one place to audit.
 *
 * Every handler is operator-only via `requireTeamAuth`. Nothing here takes a
 * workspace id on trust from the client beyond what that check already allows:
 * team and admin are cross-tenant by design, and these are the dashboards that
 * design exists for.
 */
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { requireTeamAuth } from '@/lib/api-auth';
import type { Json } from '@/lib/database.types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  buildPipelineBoard,
  latestJobByWorkspace,
  stateChangedAtByWorkspace,
  summarizeJob,
  toPipelineCard,
  type PipelineEventRow,
  type PipelineJobRow,
  type PipelineWorkspaceRow,
} from './board';
import { DispatchError, dispatchAgentJob } from './dispatch';
import {
  allowedNextStates,
  asProjectState,
  describeRejectedTransition,
  isAllowedTransition,
} from './state-transitions';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WORKSPACE_COLUMNS =
  'id, name, slug, client_business_name, client_name, client_email, project_state, ' +
  'deposit_status, deposit_paid_at, final_value_minor, setup_fee, billing_currency, ' +
  'created_at, updated_at';

const JOB_COLUMNS =
  'id, workspace_id, kind, status, attempt_count, max_attempts, run_after, ' +
  'created_at, started_at, finished_at, error_code, error_detail';

const EVENT_COLUMNS = 'id, workspace_id, kind, actor, payload, created_at';

/** Board queries are unbounded by nature; cap them so one bad row cannot OOM. */
const BOARD_WORKSPACE_LIMIT = 500;
const BOARD_JOB_LIMIT = 2_000;
const BOARD_EVENT_LIMIT = 2_000;
const TIMELINE_EVENT_LIMIT = 200;

/** Statuses a re-dispatch may legally reset. `running` is deliberately absent. */
const REDISPATCHABLE_STATUSES = ['queued', 'failed', 'canceled'] as const;
// `waiting_brief` is cancellable: a project an operator is abandoning must not
// leave a build parked on a brief nobody will ever finish.
const CANCELLABLE_STATUSES = ['queued', 'running', 'waiting_brief'] as const;

/**
 * Kinds the build worker runs, and therefore the only kinds a re-dispatch can
 * mean anything for. Both go to the same worker endpoint.
 */
const REDISPATCHABLE_KINDS = ['FULL_SITE_BUILD', 'SITE_REBUILD'] as const;

type Ctx = { params: Promise<{ id: string }> };
type JobCtx = { params: Promise<{ id: string; jobId: string }> };

/** Job statuses an operator note can still reach: the worker reads notes at pass boundaries, and a failed job is re-read on its next attempt. */
const NOTEABLE_STATUSES = [
  'queued',
  'running',
  'failed',
  'waiting_brief',
] as const;
const JOB_EVENT_COLUMNS = 'id, job_id, kind, actor, body, payload, created_at';
const JOB_EVENT_LIMIT = 2_000;

/**
 * The conversation is phases, replies and notes. The agents' running work and
 * the machine's output are written to the same table as batched `log` events
 * marked `payload.stream`, and there are hundreds of them per build: they are
 * the log view's material, not the chat feed's. `?kinds=` opts back in.
 */
function isStreamLog(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { stream?: unknown }).stream === true
  );
}

/**
 * How far back the detail view scans job events to find each job's current
 * phase and last agent line. One bounded query for the whole workspace beats
 * one query per job, and 500 newest lines covers every build a workspace has
 * had many times over.
 */
const JOB_HEADLINE_SCAN_LIMIT = 500;

/** An agent's line is a headline on a card, not the whole reply. */
const LAST_REPLY_MAX_CHARS = 200;

function badRequest(message: string, code = 'BAD_REQUEST', status = 400) {
  return NextResponse.json({ error: message, code }, { status });
}

async function readJson(req: NextRequest): Promise<unknown> {
  return req.json().catch(() => null);
}

function zodMessage(error: z.ZodError): string {
  const first = error.issues[0];
  return first
    ? `${first.path.join('.') || 'body'}: ${first.message}`
    : 'Invalid body';
}

/**
 * Common preamble: operator auth, a syntactically valid workspace id, and the
 * workspace row itself. Returns a response to hand straight back on failure so
 * every handler fails the same way.
 */
async function resolveWorkspace(ctx: Ctx): Promise<
  | {
      ok: true;
      userId: string;
      workspace: PipelineWorkspaceRow;
      db: ReturnType<typeof createSupabaseServiceRoleClient>;
    }
  | { ok: false; response: NextResponse }
> {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return { ok: false, response: auth.response };

  const { id } = await ctx.params;
  if (!UUID.test(id)) {
    return { ok: false, response: badRequest('Invalid workspace id') };
  }

  const db = createSupabaseServiceRoleClient();
  const { data, error } = await db
    .from('workspaces')
    .select(WORKSPACE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('[pipeline] workspace lookup failed:', error);
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Could not load the workspace', code: 'DB_ERROR' },
        { status: 500 }
      ),
    };
  }
  if (!data) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Workspace not found', code: 'NOT_FOUND' },
        { status: 404 }
      ),
    };
  }

  return {
    ok: true,
    userId: auth.userId,
    workspace: data as unknown as PipelineWorkspaceRow,
    db,
  };
}

/**
 * Appends to the audit trail. Never throws into the caller: the action it
 * describes has already happened, and losing the note is not a reason to tell
 * the operator their intervention failed. It is loud in the logs instead.
 */
async function recordEvent(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  row: { workspaceId: string; kind: string; actor: string; payload: Json }
): Promise<void> {
  const { error } = await db.from('project_events').insert({
    workspace_id: row.workspaceId,
    kind: row.kind,
    actor: row.actor,
    payload: row.payload,
  });
  if (error) {
    console.error(
      `[pipeline] could not write ${row.kind} event for ${row.workspaceId}:`,
      error
    );
  }
}

// ─── GET /projects/pipeline — the board ─────────────────────────────────────

export async function pipelineBoardHandler(): Promise<NextResponse> {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const db = createSupabaseServiceRoleClient();
  const [workspacesRes, jobsRes, eventsRes] = await Promise.all([
    db
      .from('workspaces')
      .select(WORKSPACE_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(BOARD_WORKSPACE_LIMIT),
    db
      .from('flowstarter_agent_jobs')
      .select(JOB_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(BOARD_JOB_LIMIT),
    db
      .from('project_events')
      .select(EVENT_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(BOARD_EVENT_LIMIT),
  ]);

  if (workspacesRes.error) {
    console.error(
      '[pipeline] board workspaces query failed:',
      workspacesRes.error
    );
    return NextResponse.json(
      { error: 'Could not load the pipeline', code: 'DB_ERROR' },
      { status: 500 }
    );
  }

  // Jobs and events only decorate the board. Losing them costs stall detection
  // fidelity, not the page — an operator with a partial board beats a 500.
  if (jobsRes.error)
    console.warn('[pipeline] jobs query failed:', jobsRes.error);
  if (eventsRes.error)
    console.warn('[pipeline] events query failed:', eventsRes.error);

  const board = buildPipelineBoard({
    workspaces: (workspacesRes.data ?? []) as unknown as PipelineWorkspaceRow[],
    jobs: (jobsRes.data ?? []) as unknown as PipelineJobRow[],
    events: (eventsRes.data ?? []) as unknown as PipelineEventRow[],
  });

  return NextResponse.json(board, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

// ─── GET /projects/[id]/pipeline — timeline + jobs ──────────────────────────

/**
 * The two lines a job card shows from its conversation: where the worker is
 * now, and the last thing the agents said. Rows must arrive newest first, so
 * the first of each kind seen for a job is the one to keep.
 */
function jobHeadlines(
  rows: readonly JobEventRow[]
): Map<string, { latestPhase: string | null; lastReply: string | null }> {
  const byJob = new Map<
    string,
    { latestPhase: string | null; lastReply: string | null }
  >();
  for (const row of rows) {
    let entry = byJob.get(row.job_id);
    if (!entry) {
      entry = { latestPhase: null, lastReply: null };
      byJob.set(row.job_id, entry);
    }
    if (row.kind === 'phase' && entry.latestPhase === null) {
      entry.latestPhase = row.body;
    } else if (row.kind === 'reply' && entry.lastReply === null) {
      entry.lastReply = row.body.trim().slice(0, LAST_REPLY_MAX_CHARS);
    }
  }
  return byJob;
}

export async function pipelineDetailHandler(
  _req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const resolved = await resolveWorkspace(ctx);
  if (!resolved.ok) return resolved.response;
  const { db, workspace } = resolved;

  const [jobsRes, eventsRes, headlinesRes] = await Promise.all([
    db
      .from('flowstarter_agent_jobs')
      .select(JOB_COLUMNS)
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false }),
    db
      .from('project_events')
      .select(EVENT_COLUMNS)
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .limit(TIMELINE_EVENT_LIMIT),
    // Newest first, so the first row seen for a job is that job's latest.
    db
      .from('flowstarter_agent_job_events')
      .select(JOB_EVENT_COLUMNS)
      .eq('workspace_id', workspace.id)
      .in('kind', ['phase', 'reply'])
      .order('created_at', { ascending: false })
      .limit(JOB_HEADLINE_SCAN_LIMIT),
  ]);

  if (jobsRes.error || eventsRes.error) {
    console.error(
      '[pipeline] detail query failed:',
      jobsRes.error ?? eventsRes.error
    );
    return NextResponse.json(
      { error: 'Could not load the project pipeline', code: 'DB_ERROR' },
      { status: 500 }
    );
  }

  // The headline lines only decorate the cards. Losing them costs a card its
  // "what is it doing now" line, not the page.
  if (headlinesRes.error) {
    console.warn('[pipeline] job headline query failed:', headlinesRes.error);
  }

  const now = Date.now();
  const jobs = (jobsRes.data ?? []) as unknown as PipelineJobRow[];
  const events = (eventsRes.data ?? []) as unknown as PipelineEventRow[];
  const headlines = jobHeadlines(
    (headlinesRes.data ?? []) as unknown as JobEventRow[]
  );
  const state = asProjectState(workspace.project_state) ?? ProjectState.INTAKE;
  const stateSince =
    stateChangedAtByWorkspace(events).get(workspace.id) ??
    workspace.updated_at ??
    workspace.created_at;

  const card = toPipelineCard({
    workspace,
    job: latestJobByWorkspace(jobs).get(workspace.id) ?? null,
    stateSince,
    now,
  });

  return NextResponse.json(
    {
      project: card,
      allowedTransitions: allowedNextStates(state),
      jobs: jobs.map((job) => ({
        ...summarizeJob(job, now),
        errorDetail: job.error_detail,
        runAfter: job.run_after,
        latestPhase: headlines.get(job.id)?.latestPhase ?? null,
        lastReply: headlines.get(job.id)?.lastReply ?? null,
        canRedispatch:
          (REDISPATCHABLE_KINDS as readonly string[]).includes(job.kind) &&
          (REDISPATCHABLE_STATUSES as readonly string[]).includes(job.status),
        canCancel: (CANCELLABLE_STATUSES as readonly string[]).includes(
          job.status
        ),
      })),
      events: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        actor: event.actor,
        payload: event.payload,
        createdAt: event.created_at,
      })),
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
}

// ─── POST /projects/[id]/pipeline/redispatch ────────────────────────────────

const redispatchSchema = z.object({
  /** Omit to act on the workspace's single FULL_SITE_BUILD. */
  jobId: z.string().uuid().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

/**
 * Re-nudges a build the worker never picked up.
 *
 * This never inserts a job. `flowstarter_agent_jobs` carries a unique index on
 * (workspace_id, kind) for FULL_SITE_BUILD precisely so a redelivered Stripe
 * webhook converges on one build, and an operator button that inserted would
 * either violate that index or quietly start a second build. So the row is
 * found and reset in place: same id, same idempotency key, attempt history
 * intact. A build that is already `running` is reported back as a conflict
 * rather than disturbed.
 */
export async function redispatchBuildHandler(
  req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const resolved = await resolveWorkspace(ctx);
  if (!resolved.ok) return resolved.response;
  const { db, workspace, userId } = resolved;

  const parsed = redispatchSchema.safeParse((await readJson(req)) ?? {});
  if (!parsed.success)
    return badRequest(zodMessage(parsed.error), 'INVALID_BODY');

  let query = db
    .from('flowstarter_agent_jobs')
    .select(JOB_COLUMNS)
    .eq('workspace_id', workspace.id);
  query = parsed.data.jobId
    ? query.eq('id', parsed.data.jobId)
    : query.eq('kind', 'FULL_SITE_BUILD');

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[pipeline] redispatch lookup failed:', error);
    return NextResponse.json(
      { error: 'Could not load the job', code: 'DB_ERROR' },
      { status: 500 }
    );
  }

  const job = data as unknown as PipelineJobRow | null;
  if (!job) {
    return NextResponse.json(
      {
        error:
          'This workspace has no build job to re-dispatch. A build is only ' +
          'enqueued when a deposit is recorded.',
        code: 'NO_BUILD_JOB',
      },
      { status: 409 }
    );
  }

  if (!(REDISPATCHABLE_STATUSES as readonly string[]).includes(job.status)) {
    return NextResponse.json(
      {
        error:
          job.status === 'running'
            ? 'That build is already running. Cancel it first if it is stuck.'
            : `A ${job.status} build cannot be re-dispatched.`,
        code:
          job.status === 'running'
            ? 'JOB_ALREADY_RUNNING'
            : 'JOB_NOT_REDISPATCHABLE',
        job: { id: job.id, status: job.status },
        /** Explicit, so the caller can assert nothing new was enqueued. */
        duplicate: true,
      },
      { status: 409 }
    );
  }

  // Captured before the write: the response and the audit row both describe
  // what the job *was*, and reading it back off `job` afterwards would depend
  // on the client having handed us a detached copy.
  const previousStatus = job.status;
  const now = new Date().toISOString();
  const update = await db
    .from('flowstarter_agent_jobs')
    .update({
      status: 'queued',
      run_after: now,
      started_at: null,
      finished_at: null,
      error_code: null,
      error_detail: null,
      // A job that burned through its retries would be re-queued and instantly
      // re-abandoned. Grant exactly one more attempt, never reset the count —
      // the history of how many times this has failed is the useful part.
      max_attempts: Math.max(job.max_attempts, job.attempt_count + 1),
      updated_at: now,
    })
    .eq('id', job.id)
    // A worker that claimed the job between the read and the write wins; we
    // must not yank a running build back into the queue.
    .in('status', REDISPATCHABLE_STATUSES as unknown as string[])
    .select('id, status')
    .maybeSingle();

  if (update.error) {
    console.error('[pipeline] redispatch update failed:', update.error);
    return NextResponse.json(
      { error: 'Could not re-queue the job', code: 'DB_ERROR' },
      { status: 500 }
    );
  }
  if (!update.data) {
    return NextResponse.json(
      {
        error:
          'That build was claimed by a worker while you were looking at it.',
        code: 'JOB_ALREADY_RUNNING',
        job: { id: job.id, status: 'running' },
        duplicate: true,
      },
      { status: 409 }
    );
  }

  // The row is queued either way; the nudge is best-effort, exactly as it is
  // on the deposit path. Report which happened instead of hiding it.
  let dispatched = true;
  let dispatchError: string | null = null;
  try {
    await dispatchAgentJob(job.id);
  } catch (e) {
    dispatched = false;
    dispatchError =
      e instanceof DispatchError || e instanceof Error
        ? e.message
        : 'Dispatch failed';
    console.error(
      `[pipeline] job ${job.id} re-queued but not dispatched:`,
      dispatchError
    );
  }

  await recordEvent(db, {
    workspaceId: workspace.id,
    kind: 'build_redispatched',
    actor: userId,
    payload: {
      jobId: job.id,
      jobKind: job.kind,
      previousStatus,
      attemptCount: job.attempt_count,
      dispatched,
      dispatchError,
      reason: parsed.data.reason ?? null,
    },
  });

  return NextResponse.json({
    job: { id: job.id, kind: job.kind, status: 'queued', previousStatus },
    /** False when the row was reset but the worker could not be reached. */
    dispatched,
    dispatchError,
    duplicate: false,
  });
}

// ─── POST /projects/[id]/pipeline/state ─────────────────────────────────────

const stateSchema = z.object({
  toState: z.nativeEnum(ProjectState),
  reason: z.string().trim().min(3).max(500),
});

/**
 * Moves a project to a neighbouring lifecycle state, on the record.
 *
 * The transition map is the guard, not the dropdown: a hand-rolled POST gets
 * the same 422 the UI would have prevented. The reason is mandatory because
 * an override without one is indistinguishable from a mistake six weeks later.
 */
export async function overrideStateHandler(
  req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const resolved = await resolveWorkspace(ctx);
  if (!resolved.ok) return resolved.response;
  const { db, workspace, userId } = resolved;

  const parsed = stateSchema.safeParse(await readJson(req));
  if (!parsed.success)
    return badRequest(zodMessage(parsed.error), 'INVALID_BODY');

  const from = asProjectState(workspace.project_state);
  if (!from) {
    return badRequest(
      `Workspace is in an unrecognised state "${workspace.project_state}"`,
      'UNKNOWN_STATE',
      409
    );
  }

  const to = parsed.data.toState;
  if (!isAllowedTransition(from, to)) {
    return NextResponse.json(
      {
        error: describeRejectedTransition(from, to),
        code: 'ILLEGAL_TRANSITION',
        from,
        to,
        allowedTransitions: allowedNextStates(from),
      },
      { status: 422 }
    );
  }

  const now = new Date().toISOString();
  const update = await db
    .from('workspaces')
    .update({ project_state: to, updated_at: now })
    .eq('id', workspace.id)
    // Compare-and-set: if the real pipeline moved the project while the
    // operator was deciding, their override applied to a state that no longer
    // exists and must not land.
    .eq('project_state', from)
    .select('id, project_state')
    .maybeSingle();

  if (update.error) {
    console.error('[pipeline] state override failed:', update.error);
    return NextResponse.json(
      { error: 'Could not update the project state', code: 'DB_ERROR' },
      { status: 500 }
    );
  }
  if (!update.data) {
    return NextResponse.json(
      {
        error:
          'The project moved on its own while you were deciding. Reload and retry.',
        code: 'STATE_CHANGED',
        from,
      },
      { status: 409 }
    );
  }

  await recordEvent(db, {
    workspaceId: workspace.id,
    kind: 'state_overridden',
    actor: userId,
    payload: { from, to, reason: parsed.data.reason },
  });

  return NextResponse.json({
    project: { id: workspace.id, projectState: to, previousState: from },
    allowedTransitions: allowedNextStates(to),
  });
}

// ─── POST /projects/[id]/pipeline/cancel-job ────────────────────────────────

const cancelSchema = z.object({
  jobId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

/**
 * Stops a job that is never going to finish. The reason is recorded twice on
 * purpose: on the job row as `error_detail`, where whoever reads the ledger
 * will see it, and in project_events, where the audit trail lives.
 */
export async function cancelJobHandler(
  req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const resolved = await resolveWorkspace(ctx);
  if (!resolved.ok) return resolved.response;
  const { db, workspace, userId } = resolved;

  const parsed = cancelSchema.safeParse(await readJson(req));
  if (!parsed.success)
    return badRequest(zodMessage(parsed.error), 'INVALID_BODY');

  const { data, error } = await db
    .from('flowstarter_agent_jobs')
    .select(JOB_COLUMNS)
    // Scoped to the workspace in the URL so a job id from another tenant
    // cannot be cancelled through this project's endpoint.
    .eq('workspace_id', workspace.id)
    .eq('id', parsed.data.jobId)
    .maybeSingle();
  if (error) {
    console.error('[pipeline] cancel lookup failed:', error);
    return NextResponse.json(
      { error: 'Could not load the job', code: 'DB_ERROR' },
      { status: 500 }
    );
  }

  const job = data as unknown as PipelineJobRow | null;
  if (!job) {
    return NextResponse.json(
      { error: 'Job not found for this project', code: 'NOT_FOUND' },
      { status: 404 }
    );
  }
  if (!(CANCELLABLE_STATUSES as readonly string[]).includes(job.status)) {
    return NextResponse.json(
      {
        error: `A ${job.status} job cannot be cancelled.`,
        code: 'JOB_NOT_CANCELLABLE',
        job: { id: job.id, status: job.status },
      },
      { status: 409 }
    );
  }

  const previousStatus = job.status;
  const now = new Date().toISOString();
  const update = await db
    .from('flowstarter_agent_jobs')
    .update({
      status: 'canceled',
      finished_at: now,
      error_code: 'operator_canceled',
      error_detail: parsed.data.reason,
      updated_at: now,
    })
    .eq('id', job.id)
    .in('status', CANCELLABLE_STATUSES as unknown as string[])
    .select('id, status')
    .maybeSingle();

  if (update.error) {
    console.error('[pipeline] cancel update failed:', update.error);
    return NextResponse.json(
      { error: 'Could not cancel the job', code: 'DB_ERROR' },
      { status: 500 }
    );
  }
  if (!update.data) {
    return NextResponse.json(
      {
        error: 'That job finished before it could be cancelled.',
        code: 'JOB_NOT_CANCELLABLE',
        job: { id: job.id, status: previousStatus },
      },
      { status: 409 }
    );
  }

  await recordEvent(db, {
    workspaceId: workspace.id,
    kind: 'job_canceled',
    actor: userId,
    payload: {
      jobId: job.id,
      jobKind: job.kind,
      previousStatus,
      reason: parsed.data.reason,
    },
  });

  return NextResponse.json({
    job: {
      id: job.id,
      kind: job.kind,
      status: 'canceled',
      previousStatus,
      reason: parsed.data.reason,
    },
  });
}

// ─── GET /projects/[id]/pipeline/jobs/[jobId]/events — the build conversation ─

interface JobEventRow {
  id: string;
  job_id: string;
  kind: string;
  actor: string;
  body: string;
  payload: unknown;
  created_at: string;
}

async function resolveJob(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  workspaceId: string,
  jobId: string
): Promise<
  { ok: true; job: PipelineJobRow } | { ok: false; response: NextResponse }
> {
  if (!UUID.test(jobId)) {
    return { ok: false, response: badRequest('Invalid job id') };
  }
  const { data, error } = await db
    .from('flowstarter_agent_jobs')
    .select(JOB_COLUMNS)
    .eq('id', jobId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) {
    console.error('[pipeline] job lookup failed:', error);
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Could not load the job', code: 'DB_ERROR' },
        { status: 500 }
      ),
    };
  }
  if (!data) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Job not found', code: 'NOT_FOUND' },
        { status: 404 }
      ),
    };
  }
  return { ok: true, job: data as unknown as PipelineJobRow };
}

/**
 * Everything said about one build, oldest first: the worker's phases and
 * logs, the agents' replies, the operators' notes. `?after=<iso>` returns
 * only what is newer, so a live panel can poll cheaply.
 */
export async function jobEventsHandler(
  req: NextRequest,
  ctx: JobCtx
): Promise<NextResponse> {
  const resolved = await resolveWorkspace(ctx);
  if (!resolved.ok) return resolved.response;
  const { db, workspace } = resolved;
  const { jobId } = await ctx.params;
  const found = await resolveJob(db, workspace.id, jobId);
  if (!found.ok) return found.response;

  const after = req.nextUrl?.searchParams.get('after') ?? null;
  if (after && Number.isNaN(Date.parse(after))) {
    return badRequest('after must be an ISO timestamp');
  }
  const kinds = (req.nextUrl?.searchParams.get('kinds') ?? '')
    .split(',')
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);

  let query = db
    .from('flowstarter_agent_job_events')
    .select(JOB_EVENT_COLUMNS)
    .eq('job_id', found.job.id);
  if (after) query = query.gt('created_at', after);
  const { data, error } = await query
    .order('created_at', { ascending: true })
    .limit(JOB_EVENT_LIMIT);
  if (error) {
    console.error('[pipeline] job events query failed:', error);
    return NextResponse.json(
      { error: 'Could not load the build conversation', code: 'DB_ERROR' },
      { status: 500 }
    );
  }

  // Filtered here rather than in the query: the feed is capped either way,
  // and the fact a log row is a stream batch lives in its jsonb payload.
  const events = ((data ?? []) as unknown as JobEventRow[]).filter((event) =>
    kinds.length > 0 ? kinds.includes(event.kind) : !isStreamLog(event.payload)
  );
  const latestPhase = [...events]
    .reverse()
    .find((event) => event.kind === 'phase');
  return NextResponse.json(
    {
      job: {
        ...summarizeJob(found.job, Date.now()),
        errorDetail: found.job.error_detail,
        latestPhase: latestPhase?.body ?? null,
        acceptsNotes: (NOTEABLE_STATUSES as readonly string[]).includes(
          found.job.status
        ),
      },
      events: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        actor: event.actor,
        body: event.body,
        payload: event.payload,
        createdAt: event.created_at,
      })),
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
}

// ─── POST /projects/[id]/pipeline/jobs/[jobId]/notes — talk to the agents ───

const noteSchema = z.object({
  message: z.string().trim().min(3).max(2_000),
});

/**
 * Leaves a note for the agents building this site. The worker folds notes
 * into its next pass: before the build starts, after the first pass has been
 * checked, or on the next attempt of a failed job. A finished build has no
 * next pass, so it refuses rather than pretending.
 */
export async function jobNoteHandler(
  req: NextRequest,
  ctx: JobCtx
): Promise<NextResponse> {
  const resolved = await resolveWorkspace(ctx);
  if (!resolved.ok) return resolved.response;
  const { db, workspace, userId } = resolved;
  const { jobId } = await ctx.params;
  const found = await resolveJob(db, workspace.id, jobId);
  if (!found.ok) return found.response;

  const parsed = noteSchema.safeParse((await readJson(req)) ?? {});
  if (!parsed.success)
    return badRequest(zodMessage(parsed.error), 'INVALID_BODY');

  if (!(NOTEABLE_STATUSES as readonly string[]).includes(found.job.status)) {
    return NextResponse.json(
      {
        error:
          'This build has finished. Notes reach the agents only while a ' +
          'build is queued, running, or waiting for another attempt.',
        code: 'JOB_FINISHED',
        job: { id: found.job.id, status: found.job.status },
      },
      { status: 409 }
    );
  }

  const { data, error } = await db
    .from('flowstarter_agent_job_events')
    .insert({
      job_id: found.job.id,
      workspace_id: workspace.id,
      kind: 'note',
      actor: userId,
      body: parsed.data.message,
      payload: {},
    })
    .select(JOB_EVENT_COLUMNS)
    .single();
  if (error) {
    console.error('[pipeline] note insert failed:', error);
    return NextResponse.json(
      { error: 'Could not record the note', code: 'DB_ERROR' },
      { status: 500 }
    );
  }

  await recordEvent(db, {
    workspaceId: workspace.id,
    kind: 'build_note_sent',
    actor: userId,
    payload: { jobId: found.job.id, chars: parsed.data.message.length },
  });

  const row = data as unknown as JobEventRow;
  return NextResponse.json(
    {
      event: {
        id: row.id,
        kind: row.kind,
        actor: row.actor,
        body: row.body,
        payload: row.payload,
        createdAt: row.created_at,
      },
      // Honest about the delivery model: the agents see this at their next
      // pass boundary, not the instant it is sent.
      delivery:
        found.job.status === 'running'
          ? 'next_pass'
          : found.job.status === 'failed'
          ? 'next_attempt'
          : 'build_start',
    },
    { status: 201 }
  );
}
