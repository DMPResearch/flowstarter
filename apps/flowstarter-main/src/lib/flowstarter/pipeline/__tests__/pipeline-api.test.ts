/**
 * The operator pipeline API.
 *
 * These endpoints let a human move money-bearing state and restart builds, so
 * the cases that matter are the ones where they must refuse: a signed-in
 * client who is not an operator, a state jump that would skip a deposit, and a
 * re-dispatch of a build that is already running — which must never produce a
 * second FULL_SITE_BUILD, because the unique index that makes the Stripe
 * deposit path idempotent depends on there being exactly one.
 *
 * Clerk and the service-role client are mocked; every handler runs for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';

vi.mock('server-only', () => ({}));

// ─── Clerk ──────────────────────────────────────────────────────────────────
const authState: { userId: string | null; role: string | undefined } = {
  userId: 'user_operator',
  role: 'team',
};

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: { metadata: { role: authState.role } },
    getToken: async () => 'test-token',
  }),
  clerkClient: async () => ({
    users: {
      getUser: async () => ({
        publicMetadata: { role: authState.role },
        emailAddresses: [],
        primaryEmailAddressId: null,
      }),
    },
  }),
  currentUser: async () => null,
}));

// ─── An in-memory stand-in for the service-role client ──────────────────────
// Small enough to read, faithful enough to exercise the filters the handlers
// depend on — including the compare-and-set `.in('status', ...)` guards.
type Row = Record<string, unknown>;

const tables: Record<string, Row[]> = {
  workspaces: [],
  flowstarter_agent_jobs: [],
  flowstarter_agent_job_events: [],
  project_events: [],
};

let idCounter = 0;

/**
 * Tables — or `table:op` pairs — whose next query comes back as a Postgrest
 * error. Every handler here has an `if (error)` arm that decides between a
 * 500 and carrying on with less; that decision is the thing worth pinning.
 */
const failing = new Set<string>();

type Result = { data: Row[] | null; error: unknown };

class FakeBuilder implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' = 'select';
  private predicates: Array<(row: Row) => boolean> = [];
  private values: Row = {};
  private orderKey: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(private readonly table: string) {}

  select() {
    return this;
  }
  insert(values: Row) {
    this.op = 'insert';
    this.values = values;
    return this;
  }
  update(values: Row) {
    this.op = 'update';
    this.values = values;
    return this;
  }
  eq(column: string, value: unknown) {
    this.predicates.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.predicates.push((row) => values.includes(row[column]));
    return this;
  }
  gt(column: string, value: unknown) {
    this.predicates.push((row) => String(row[column]) > String(value));
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.orderKey = column;
    this.orderAsc = options?.ascending !== false;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private run(): Row[] {
    const rows = tables[this.table] ?? [];
    if (this.op === 'insert') {
      const inserted = {
        id: `generated-${++idCounter}`,
        created_at: `2026-09-08T10:00:${String(idCounter).padStart(
          2,
          '0'
        )}.000Z`,
        ...this.values,
      };
      rows.push(inserted);
      return [inserted];
    }
    let matched = rows.filter((row) => this.predicates.every((p) => p(row)));
    if (this.op === 'update') {
      for (const row of matched) Object.assign(row, this.values);
      return matched;
    }
    if (this.orderKey) {
      const key = this.orderKey;
      matched = [...matched].sort((a, b) =>
        this.orderAsc
          ? String(a[key]).localeCompare(String(b[key]))
          : String(b[key]).localeCompare(String(a[key]))
      );
    }
    return this.limitN === null ? matched : matched.slice(0, this.limitN);
  }

  private failure(): Result | null {
    if (failing.has(this.table) || failing.has(`${this.table}:${this.op}`)) {
      return { data: null, error: { message: `fake: ${this.table} is down` } };
    }
    return null;
  }

  async maybeSingle() {
    return this.failure() ?? { data: this.run()[0] ?? null, error: null };
  }
  async single() {
    const failed = this.failure();
    if (failed) return failed;
    const rows = this.run();
    return rows.length === 1
      ? { data: rows[0], error: null }
      : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
  }
  then<T1, T2 = never>(
    onFulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(
      this.failure() ?? { data: this.run(), error: null }
    ).then(onFulfilled, onRejected);
  }
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => new FakeBuilder(table),
  }),
}));

// Static imports: vi.mock is hoisted, and this tsconfig forbids top-level await.
import {
  cancelJobHandler,
  jobEventsHandler,
  jobNoteHandler,
  overrideStateHandler,
  pipelineBoardHandler,
  pipelineDetailHandler,
  redispatchBuildHandler,
} from '../api';
import { jobLogHandler } from '../job-log-api';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const OTHER_WORKSPACE_ID = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';
const JOB_ID = '2b6f1d4a-9c3e-4b21-8f77-5a1c2d3e4f61';

function ctx(id = WORKSPACE_ID) {
  return { params: Promise.resolve({ id }) };
}

function jobCtx(jobId = JOB_ID, id = WORKSPACE_ID) {
  return { params: Promise.resolve({ id, jobId }) };
}

function get(url = 'http://test.local/x'): NextRequest {
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

function seedJobEvent(overrides: Row = {}) {
  const row: Row = {
    id: `evt-${++idCounter}`,
    job_id: JOB_ID,
    workspace_id: WORKSPACE_ID,
    kind: 'phase',
    actor: 'system',
    body: 'Checking the build',
    payload: {},
    created_at: `2026-09-08T09:00:${String(idCounter).padStart(2, '0')}.000Z`,
    ...overrides,
  };
  tables.flowstarter_agent_job_events.push(row);
  return row;
}

function post(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function seedWorkspace(overrides: Row = {}) {
  const row: Row = {
    id: WORKSPACE_ID,
    name: 'Acme site',
    slug: 'acme',
    client_business_name: 'Acme Ltd',
    client_name: null,
    client_email: 'owner@acme.test',
    project_state: ProjectState.DEPOSIT_PAID,
    deposit_status: 'paid',
    deposit_paid_at: '2026-08-30T10:00:00.000Z',
    final_value_minor: 199_900,
    setup_fee: null,
    billing_currency: 'eur',
    created_at: '2026-08-29T10:00:00.000Z',
    updated_at: '2026-08-30T10:00:00.000Z',
    ...overrides,
  };
  tables.workspaces.push(row);
  return row;
}

function seedJob(overrides: Row = {}) {
  const row: Row = {
    id: JOB_ID,
    workspace_id: WORKSPACE_ID,
    kind: 'FULL_SITE_BUILD',
    status: 'queued',
    attempt_count: 0,
    max_attempts: 3,
    run_after: '2026-08-30T10:00:00.000Z',
    created_at: '2026-08-30T10:00:00.000Z',
    started_at: null,
    finished_at: null,
    error_code: null,
    error_detail: null,
    ...overrides,
  };
  tables.flowstarter_agent_jobs.push(row);
  return row;
}

beforeEach(() => {
  authState.userId = 'user_operator';
  authState.role = 'team';
  tables.workspaces = [];
  tables.flowstarter_agent_jobs = [];
  tables.flowstarter_agent_job_events = [];
  tables.project_events = [];
  failing.clear();
  idCounter = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // Nothing in these tests should reach the network; a build worker that is
  // not configured is also the realistic local case.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 }))
  );
});

describe('operator-only access', () => {
  const calls: Array<[string, () => Promise<Response>]> = [
    ['GET board', () => pipelineBoardHandler()],
    ['GET detail', () => pipelineDetailHandler(post({}), ctx())],
    ['POST redispatch', () => redispatchBuildHandler(post({}), ctx())],
    [
      'POST state',
      () =>
        overrideStateHandler(
          post({ toState: ProjectState.AGENTS_WORKING, reason: 'because' }),
          ctx()
        ),
    ],
    [
      'POST cancel-job',
      () => cancelJobHandler(post({ jobId: JOB_ID, reason: 'because' }), ctx()),
    ],
  ];

  it.each(calls)(
    '%s refuses a signed-in client who is not an operator',
    async (_name, call) => {
      seedWorkspace();
      seedJob();
      authState.userId = 'user_plain_client';
      authState.role = undefined;

      const res = await call();
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
    }
  );

  it.each(calls)('%s refuses an anonymous caller', async (_name, call) => {
    seedWorkspace();
    seedJob();
    authState.userId = null;
    authState.role = undefined;

    const res = await call();
    expect(res.status).toBe(401);
  });

  it('lets an admin through', async () => {
    seedWorkspace();
    authState.role = 'admin';
    const res = await pipelineBoardHandler();
    expect(res.status).toBe(200);
  });

  it('never writes an audit row for a refused caller', async () => {
    seedWorkspace();
    authState.role = undefined;
    await overrideStateHandler(
      post({ toState: ProjectState.AGENTS_WORKING, reason: 'sneaking in' }),
      ctx()
    );
    expect(tables.project_events).toHaveLength(0);
    expect(tables.workspaces[0].project_state).toBe(ProjectState.DEPOSIT_PAID);
  });
});

describe('the board', () => {
  it('groups workspaces by state', async () => {
    seedWorkspace({
      id: WORKSPACE_ID,
      project_state: ProjectState.DEPOSIT_PAID,
    });
    seedWorkspace({
      id: OTHER_WORKSPACE_ID,
      project_state: ProjectState.INTAKE,
      created_at: '2026-08-28T10:00:00.000Z',
    });

    const res = await pipelineBoardHandler();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(2);
    const byState = Object.fromEntries(
      body.columns.map(
        (c: { state: string; cards: Array<{ workspaceId: string }> }) => [
          c.state,
          c.cards.map((card) => card.workspaceId),
        ]
      )
    );
    expect(byState[ProjectState.DEPOSIT_PAID]).toEqual([WORKSPACE_ID]);
    expect(byState[ProjectState.INTAKE]).toEqual([OTHER_WORKSPACE_ID]);
    expect(byState[ProjectState.HUMAN_QA]).toEqual([]);
  });
});

describe('state overrides', () => {
  it('rejects an illegal transition server-side, and says what is allowed', async () => {
    seedWorkspace({ project_state: ProjectState.INTAKE });

    const res = await overrideStateHandler(
      post({
        toState: ProjectState.LIVE_SUBSCRIPTION,
        reason: 'client is in a hurry',
      }),
      ctx()
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('ILLEGAL_TRANSITION');
    expect(body.allowedTransitions).toEqual([ProjectState.PREVIEW_READY]);
    // The refusal must be total: no state change, no audit row.
    expect(tables.workspaces[0].project_state).toBe(ProjectState.INTAKE);
    expect(tables.project_events).toHaveLength(0);
  });

  it('rejects a state that is not in the enum at all', async () => {
    seedWorkspace();
    const res = await overrideStateHandler(
      post({ toState: 'DEFINITELY_LIVE', reason: 'nope' }),
      ctx()
    );
    expect(res.status).toBe(400);
    expect(tables.workspaces[0].project_state).toBe(ProjectState.DEPOSIT_PAID);
  });

  it('requires a reason', async () => {
    seedWorkspace();
    const res = await overrideStateHandler(
      post({ toState: ProjectState.AGENTS_WORKING }),
      ctx()
    );
    expect(res.status).toBe(400);
    expect(tables.project_events).toHaveLength(0);
  });

  it('applies a legal move and records who made it and why', async () => {
    seedWorkspace({ project_state: ProjectState.DEPOSIT_PAID });

    const res = await overrideStateHandler(
      post({
        toState: ProjectState.AGENTS_WORKING,
        reason: 'Build worker was restarted by hand',
      }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(tables.workspaces[0].project_state).toBe(
      ProjectState.AGENTS_WORKING
    );
    expect(tables.project_events).toHaveLength(1);
    expect(tables.project_events[0]).toMatchObject({
      workspace_id: WORKSPACE_ID,
      kind: 'state_overridden',
      actor: 'user_operator',
      payload: {
        from: ProjectState.DEPOSIT_PAID,
        to: ProjectState.AGENTS_WORKING,
        reason: 'Build worker was restarted by hand',
      },
    });
  });

  it('allows a one-step correction backwards', async () => {
    seedWorkspace({ project_state: ProjectState.HUMAN_QA });
    const res = await overrideStateHandler(
      post({
        toState: ProjectState.AGENTS_WORKING,
        reason: 'QA found a rebuild is needed',
      }),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(tables.workspaces[0].project_state).toBe(
      ProjectState.AGENTS_WORKING
    );
  });

  it('404s for a workspace that does not exist', async () => {
    const res = await overrideStateHandler(
      post({ toState: ProjectState.AGENTS_WORKING, reason: 'ghost' }),
      ctx()
    );
    expect(res.status).toBe(404);
  });
});

describe('re-dispatching a build', () => {
  it('re-queues a job the worker never picked up, without creating a second one', async () => {
    seedWorkspace();
    seedJob({ status: 'queued' });

    const res = await redispatchBuildHandler(post({}), ctx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      job: { id: JOB_ID, status: 'queued' },
      duplicate: false,
    });
    // The single FULL_SITE_BUILD row is reused, so the unique index on
    // (workspace_id, kind) still holds.
    expect(tables.flowstarter_agent_jobs).toHaveLength(1);
    expect(tables.flowstarter_agent_jobs[0].id).toBe(JOB_ID);
  });

  it('refuses to touch a build that is already running, and creates nothing', async () => {
    seedWorkspace();
    seedJob({ status: 'running', started_at: '2026-08-30T11:00:00.000Z' });

    const res = await redispatchBuildHandler(post({}), ctx());

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('JOB_ALREADY_RUNNING');
    expect(body.duplicate).toBe(true);
    expect(tables.flowstarter_agent_jobs).toHaveLength(1);
    expect(tables.flowstarter_agent_jobs[0].status).toBe('running');
    expect(tables.project_events).toHaveLength(0);
  });

  it('refuses when the build already succeeded', async () => {
    seedWorkspace();
    seedJob({ status: 'succeeded', finished_at: '2026-08-30T11:00:00.000Z' });

    const res = await redispatchBuildHandler(post({}), ctx());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: 'JOB_NOT_REDISPATCHABLE',
    });
    expect(tables.flowstarter_agent_jobs).toHaveLength(1);
  });

  it('grants a failed job one more attempt rather than resetting its history', async () => {
    seedWorkspace();
    seedJob({
      status: 'failed',
      attempt_count: 3,
      max_attempts: 3,
      error_code: 'worker_timeout',
      error_detail: 'timed out',
    });

    const res = await redispatchBuildHandler(
      post({ reason: 'worker was down' }),
      ctx()
    );

    expect(res.status).toBe(200);
    const job = tables.flowstarter_agent_jobs[0];
    expect(job.status).toBe('queued');
    expect(job.attempt_count).toBe(3);
    expect(job.max_attempts).toBe(4);
    expect(job.error_code).toBeNull();
    expect(tables.project_events[0]).toMatchObject({
      kind: 'build_redispatched',
      actor: 'user_operator',
      payload: { previousStatus: 'failed', jobId: JOB_ID },
    });
  });

  it('reports a queued-but-undispatched job instead of failing the request', async () => {
    seedWorkspace();
    seedJob({ status: 'queued' });
    // No worker configured — exactly the case deposit-workflow logs and moves
    // past. The row must still end up queued.
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_URL', '');
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_SECRET', '');

    const res = await redispatchBuildHandler(post({}), ctx());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dispatched).toBe(false);
    expect(body.dispatchError).toMatch(/not configured/);
    expect(tables.flowstarter_agent_jobs[0].status).toBe('queued');
  });

  it('hands the job id to the build worker when one is configured', async () => {
    seedWorkspace();
    seedJob({ status: 'queued' });
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_URL', 'http://localhost:4310');
    vi.stubEnv('FLOWSTARTER_BUILD_WORKER_SECRET', 'x'.repeat(40));

    const res = await redispatchBuildHandler(post({}), ctx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ dispatched: true });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://localhost:4310/jobs/full-site');
    expect(init.body).toBe(JSON.stringify({ jobId: JOB_ID }));
  });

  it('409s when there is no build job to re-dispatch', async () => {
    seedWorkspace();
    const res = await redispatchBuildHandler(post({}), ctx());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'NO_BUILD_JOB' });
    expect(tables.flowstarter_agent_jobs).toHaveLength(0);
  });
});

describe('cancelling a stuck job', () => {
  it('records the reason on the job row and in the audit trail', async () => {
    seedWorkspace();
    seedJob({ status: 'running', started_at: '2026-08-30T09:00:00.000Z' });

    const res = await cancelJobHandler(
      post({ jobId: JOB_ID, reason: 'Worker died mid-build' }),
      ctx()
    );

    expect(res.status).toBe(200);
    const job = tables.flowstarter_agent_jobs[0];
    expect(job.status).toBe('canceled');
    expect(job.error_code).toBe('operator_canceled');
    expect(job.error_detail).toBe('Worker died mid-build');
    expect(job.finished_at).not.toBeNull();
    expect(tables.project_events[0]).toMatchObject({
      kind: 'job_canceled',
      actor: 'user_operator',
      payload: {
        jobId: JOB_ID,
        previousStatus: 'running',
        reason: 'Worker died mid-build',
      },
    });
  });

  it('requires a reason', async () => {
    seedWorkspace();
    seedJob({ status: 'running' });
    const res = await cancelJobHandler(post({ jobId: JOB_ID }), ctx());
    expect(res.status).toBe(400);
    expect(tables.flowstarter_agent_jobs[0].status).toBe('running');
  });

  it('refuses to cancel a job that already finished', async () => {
    seedWorkspace();
    seedJob({ status: 'succeeded' });
    const res = await cancelJobHandler(
      post({ jobId: JOB_ID, reason: 'too late' }),
      ctx()
    );
    expect(res.status).toBe(409);
    expect(tables.flowstarter_agent_jobs[0].status).toBe('succeeded');
  });

  it('will not cancel a job belonging to another workspace', async () => {
    seedWorkspace();
    seedWorkspace({ id: OTHER_WORKSPACE_ID });
    seedJob({ workspace_id: OTHER_WORKSPACE_ID, status: 'running' });

    const res = await cancelJobHandler(
      post({ jobId: JOB_ID, reason: 'wrong project' }),
      ctx(WORKSPACE_ID)
    );

    expect(res.status).toBe(404);
    expect(tables.flowstarter_agent_jobs[0].status).toBe('running');
  });
});

describe('the project timeline', () => {
  it('returns jobs, events and the moves allowed from here', async () => {
    seedWorkspace({ project_state: ProjectState.DEPOSIT_PAID });
    seedJob({ status: 'queued' });
    tables.project_events.push({
      id: 'evt-1',
      workspace_id: WORKSPACE_ID,
      kind: 'state_overridden',
      actor: 'user_operator',
      payload: {
        from: ProjectState.PREVIEW_READY,
        to: ProjectState.DEPOSIT_PAID,
      },
      created_at: '2026-08-30T10:00:00.000Z',
    });

    const res = await pipelineDetailHandler(post({}), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.project.projectState).toBe(ProjectState.DEPOSIT_PAID);
    expect(body.project.quoteMinor).toBe(199_900);
    expect(body.allowedTransitions).toEqual([
      ProjectState.AGENTS_WORKING,
      ProjectState.PREVIEW_READY,
    ]);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      id: JOB_ID,
      canRedispatch: true,
      canCancel: true,
    });
    expect(body.events).toHaveLength(1);
  });

  it("carries each job the phase it is on and the agents' last line", async () => {
    seedWorkspace();
    seedJob({ status: 'running' });
    seedJobEvent({ body: 'Preparing a clean worktree' });
    seedJobEvent({
      kind: 'reply',
      body: '  Built five pages and a contact form.  ',
    });
    seedJobEvent({ body: 'Checking the build' });
    // Another workspace's job must not leak into this one's cards.
    seedJobEvent({
      job_id: '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      workspace_id: OTHER_WORKSPACE_ID,
      body: 'Publishing',
    });

    const res = await pipelineDetailHandler(post({}), ctx());
    const body = await res.json();
    expect(body.jobs[0]).toMatchObject({
      id: JOB_ID,
      latestPhase: 'Checking the build',
      lastReply: 'Built five pages and a contact form.',
    });
  });

  it('leaves the phase null for a job that has said nothing', async () => {
    seedWorkspace();
    seedJob({ status: 'queued' });

    const res = await pipelineDetailHandler(post({}), ctx());
    const body = await res.json();
    expect(body.jobs[0].latestPhase).toBeNull();
    expect(body.jobs[0].lastReply).toBeNull();
  });

  it('offers a re-dispatch on a stuck site rebuild, which the same worker runs', async () => {
    seedWorkspace({ project_state: ProjectState.LIVE_SUBSCRIPTION });
    seedJob({ kind: 'SITE_REBUILD', status: 'failed' });

    const res = await pipelineDetailHandler(post({}), ctx());
    const body = await res.json();
    expect(body.jobs[0]).toMatchObject({
      kind: 'SITE_REBUILD',
      canRedispatch: true,
    });
  });

  it('offers no re-dispatch on a kind this worker does not run', async () => {
    seedWorkspace();
    seedJob({ kind: 'ASSET_INGEST', status: 'failed' });

    const res = await pipelineDetailHandler(post({}), ctx());
    const body = await res.json();
    expect(body.jobs[0].canRedispatch).toBe(false);
  });

  it('rejects a workspace id that is not a uuid before touching the database', async () => {
    const res = await pipelineDetailHandler(post({}), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });
});

describe('the build conversation', () => {
  it('returns what was said about a build, oldest first, with where it is now', async () => {
    seedWorkspace();
    seedJob({ status: 'running' });
    seedJobEvent({ body: 'Agents expanding the site' });
    seedJobEvent({ kind: 'reply', body: 'Done: built five pages.' });
    seedJobEvent({ body: 'Checking the build' });

    const res = await jobEventsHandler(get(), jobCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.map((e: { body: string }) => e.body)).toEqual([
      'Agents expanding the site',
      'Done: built five pages.',
      'Checking the build',
    ]);
    expect(body.job.latestPhase).toBe('Checking the build');
    expect(body.job.acceptsNotes).toBe(true);
  });

  it('only returns lines newer than the cursor a live panel hands back', async () => {
    seedWorkspace();
    seedJob({ status: 'running' });
    const first = seedJobEvent({ body: 'Preparing a clean worktree' });
    seedJobEvent({ body: 'Checking the build' });

    const res = await jobEventsHandler(
      get(`http://test.local/x?after=${first.created_at}`),
      jobCtx()
    );
    const body = await res.json();
    expect(body.events.map((e: { body: string }) => e.body)).toEqual([
      'Checking the build',
    ]);
  });

  it('will not show a job that belongs to another workspace', async () => {
    seedWorkspace();
    seedWorkspace({ id: OTHER_WORKSPACE_ID });
    seedJob({ workspace_id: OTHER_WORKSPACE_ID });

    const res = await jobEventsHandler(get(), jobCtx());
    expect(res.status).toBe(404);
  });

  it('records a note for the agents, says when it lands, and leaves an audit row', async () => {
    seedWorkspace();
    seedJob({ status: 'running' });

    const res = await jobNoteHandler(
      post({ message: 'Use the client logo in every header.' }),
      jobCtx()
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.delivery).toBe('next_pass');
    expect(body.event.kind).toBe('note');
    expect(body.event.actor).toBe('user_operator');

    expect(tables.flowstarter_agent_job_events).toHaveLength(1);
    expect(tables.flowstarter_agent_job_events[0]).toMatchObject({
      job_id: JOB_ID,
      workspace_id: WORKSPACE_ID,
      kind: 'note',
      actor: 'user_operator',
      body: 'Use the client logo in every header.',
    });
    expect(tables.project_events).toHaveLength(1);
    expect(tables.project_events[0]).toMatchObject({
      kind: 'build_note_sent',
      actor: 'user_operator',
    });
  });

  it("tells a queued job's note it lands at build start, and a failed job's on the next attempt", async () => {
    seedWorkspace();
    seedJob({ status: 'queued' });
    const queued = await (
      await jobNoteHandler(post({ message: 'Keep the palette.' }), jobCtx())
    ).json();
    expect(queued.delivery).toBe('build_start');

    tables.flowstarter_agent_jobs[0].status = 'failed';
    const failed = await (
      await jobNoteHandler(
        post({ message: 'Try again with fewer pages.' }),
        jobCtx()
      )
    ).json();
    expect(failed.delivery).toBe('next_attempt');
  });

  it('refuses a note to a build that has finished, and writes nothing', async () => {
    seedWorkspace();
    seedJob({ status: 'succeeded' });

    const res = await jobNoteHandler(post({ message: 'Too late?' }), jobCtx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('JOB_FINISHED');
    expect(tables.flowstarter_agent_job_events).toHaveLength(0);
    expect(tables.project_events).toHaveLength(0);
  });

  it('requires a real message', async () => {
    seedWorkspace();
    seedJob({ status: 'running' });
    const res = await jobNoteHandler(post({ message: 'ok' }), jobCtx());
    expect(res.status).toBe(400);
  });

  it('is operator-only like everything else here', async () => {
    authState.role = undefined;
    seedWorkspace();
    seedJob({ status: 'running' });
    const res = await jobNoteHandler(
      post({ message: 'Hello agents' }),
      jobCtx()
    );
    expect(res.status).toBe(403);
    expect(tables.flowstarter_agent_job_events).toHaveLength(0);
  });
});

describe('the /admin and /team mirrors', () => {
  it('are the same handler, so they cannot drift apart', async () => {
    const [
      adminBoard,
      teamBoard,
      adminDetail,
      teamDetail,
      adminRedispatch,
      teamRedispatch,
      adminState,
      teamState,
      adminCancel,
      teamCancel,
      adminEvents,
      teamEvents,
      adminNotes,
      teamNotes,
      adminLog,
      teamLog,
    ] = await Promise.all([
      import('@/app/api/admin/projects/pipeline/route'),
      import('@/app/api/team/projects/pipeline/route'),
      import('@/app/api/admin/projects/[id]/pipeline/route'),
      import('@/app/api/team/projects/[id]/pipeline/route'),
      import('@/app/api/admin/projects/[id]/pipeline/redispatch/route'),
      import('@/app/api/team/projects/[id]/pipeline/redispatch/route'),
      import('@/app/api/admin/projects/[id]/pipeline/state/route'),
      import('@/app/api/team/projects/[id]/pipeline/state/route'),
      import('@/app/api/admin/projects/[id]/pipeline/cancel-job/route'),
      import('@/app/api/team/projects/[id]/pipeline/cancel-job/route'),
      import(
        '@/app/api/admin/projects/[id]/pipeline/jobs/[jobId]/events/route'
      ),
      import('@/app/api/team/projects/[id]/pipeline/jobs/[jobId]/events/route'),
      import('@/app/api/admin/projects/[id]/pipeline/jobs/[jobId]/notes/route'),
      import('@/app/api/team/projects/[id]/pipeline/jobs/[jobId]/notes/route'),
      import('@/app/api/admin/projects/[id]/pipeline/jobs/[jobId]/log/route'),
      import('@/app/api/team/projects/[id]/pipeline/jobs/[jobId]/log/route'),
    ]);

    expect(adminBoard.GET).toBe(teamBoard.GET);
    expect(adminBoard.GET).toBe(pipelineBoardHandler);
    expect(adminDetail.GET).toBe(teamDetail.GET);
    expect(adminDetail.GET).toBe(pipelineDetailHandler);
    expect(adminRedispatch.POST).toBe(teamRedispatch.POST);
    expect(adminRedispatch.POST).toBe(redispatchBuildHandler);
    expect(adminState.POST).toBe(teamState.POST);
    expect(adminState.POST).toBe(overrideStateHandler);
    expect(adminCancel.POST).toBe(teamCancel.POST);
    expect(adminCancel.POST).toBe(cancelJobHandler);
    expect(adminEvents.GET).toBe(teamEvents.GET);
    expect(adminEvents.GET).toBe(jobEventsHandler);
    expect(adminNotes.POST).toBe(teamNotes.POST);
    expect(adminNotes.POST).toBe(jobNoteHandler);
    expect(adminLog.GET).toBe(teamLog.GET);
    expect(adminLog.GET).toBe(jobLogHandler);
  });
});

// ─── The full build log ─────────────────────────────────────────────────────
// The chat feed above is the readable summary of a build. This is everything
// underneath it: the agents' narration, their tool calls, and the machine's
// own output, written by the worker in batches and read back as lines.

describe('the full build log', () => {
  function seedStreamLog(
    source: 'agent' | 'machine' | 'tool',
    body: string,
    overrides: Row = {}
  ) {
    return seedJobEvent({
      kind: 'log',
      body,
      payload: { source, lines: body.split('\n').length, stream: true },
      ...overrides,
    });
  }

  it('keeps the stream out of the chat feed unless it is asked for', async () => {
    seedWorkspace();
    seedJob({ status: 'running' });
    seedJobEvent({ kind: 'phase', body: 'Agents expanding the site' });
    seedStreamLog('agent', 'Reading the approved preview.');
    seedStreamLog('tool', 'write_file src/pages/index.astro');
    seedJobEvent({ kind: 'reply', body: 'Built the site.' });

    const feed = await jobEventsHandler(get(), jobCtx());
    const feedBody = await feed.json();
    expect(feedBody.events.map((e: { kind: string }) => e.kind)).toEqual([
      'phase',
      'reply',
    ]);

    // An explicit kinds filter opts back in, and can narrow further.
    const withLogs = await jobEventsHandler(
      get('http://test.local/x?kinds=log'),
      jobCtx()
    );
    const logBody = await withLogs.json();
    expect(logBody.events.map((e: { body: string }) => e.body)).toEqual([
      'Reading the approved preview.',
      'write_file src/pages/index.astro',
    ]);
  });

  it('flattens the batches into lines, oldest first, carrying the source', async () => {
    seedWorkspace();
    seedJob({ status: 'succeeded' });
    seedJobEvent({ kind: 'phase', body: 'Checking the build' });
    seedStreamLog('machine', 'Running pnpm run build\n\nbuilt in 4.2s');
    seedStreamLog('tool', 'write_file src/pages/index.astro');

    const res = await jobLogHandler(get(), jobCtx());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.job).toEqual({
      id: JOB_ID,
      kind: 'FULL_SITE_BUILD',
      status: 'succeeded',
    });
    expect(
      body.lines.map((line: { source: string; text: string }) => [
        line.source,
        line.text,
      ])
    ).toEqual([
      ['phase', 'Checking the build'],
      ['machine', 'Running pnpm run build'],
      ['machine', 'built in 4.2s'],
      ['tool', 'write_file src/pages/index.astro'],
    ]);
    expect(body.lines[0].at).toBeTruthy();
  });

  it('serves a downloadable text file on ?format=text', async () => {
    seedWorkspace();
    seedJob();
    seedStreamLog('machine', 'Running pnpm run build', {
      created_at: '2026-09-08T09:14:07.000Z',
    });

    const res = await jobLogHandler(
      get('http://test.local/x?format=text'),
      jobCtx()
    );
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(res.headers.get('Content-Disposition')).toContain(
      `build-${JOB_ID}.log`
    );
    expect(await res.text()).toBe(
      '09:14:07 [machine] Running pnpm run build\n'
    );
  });

  it('refuses a job that belongs to another workspace', async () => {
    seedWorkspace();
    seedWorkspace({ id: OTHER_WORKSPACE_ID, slug: 'other' });
    seedJob({ workspace_id: OTHER_WORKSPACE_ID });
    seedStreamLog('machine', 'not yours', { workspace_id: OTHER_WORKSPACE_ID });

    const res = await jobLogHandler(get(), jobCtx(JOB_ID, WORKSPACE_ID));
    expect(res.status).toBe(404);
  });

  it('refuses a client who is not an operator', async () => {
    authState.role = 'client';
    seedWorkspace();
    seedJob();

    const res = await jobLogHandler(get(), jobCtx());
    expect(res.status).toBe(403);
  });
});

// ── When the database is having a bad day ──────────────────────────────────
//
// Each handler decides for itself whether a failed query is fatal. Losing the
// jobs behind the board costs stall detection; losing the workspaces costs the
// page. Losing the audit row costs neither, and must never cost the operator
// the action they came to perform.

describe('a query that fails', () => {
  const silence = () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  };

  it('takes the board down only when the projects themselves cannot be read', async () => {
    silence();
    seedWorkspace();
    failing.add('workspaces');

    const res = await pipelineBoardHandler();
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('DB_ERROR');
  });

  it('still renders the board without its jobs and events', async () => {
    silence();
    seedWorkspace();
    seedJob();
    failing.add('flowstarter_agent_jobs');
    failing.add('project_events');

    const res = await pipelineBoardHandler();
    expect(res.status).toBe(200);
    const board = await res.json();
    expect(board.total).toBe(1);
    // No job means no job-shaped stall reason, which is the price paid.
    const card = board.columns
      .flatMap((c: { cards: unknown[] }) => c.cards)
      .at(0) as { latestJob: unknown };
    expect(card.latestJob).toBeNull();
  });

  it('refuses the project pipeline rather than showing a half-read one', async () => {
    silence();
    seedWorkspace();

    failing.add('workspaces');
    const noWorkspace = await pipelineDetailHandler(post({}), ctx());
    expect(noWorkspace.status).toBe(500);
    expect((await noWorkspace.json()).error).toMatch(/load the workspace/);

    failing.clear();
    failing.add('flowstarter_agent_jobs');
    const noJobs = await pipelineDetailHandler(post({}), ctx());
    expect(noJobs.status).toBe(500);
    expect((await noJobs.json()).error).toMatch(/project pipeline/);
  });

  it('refuses to re-dispatch a build it could not read or could not re-queue', async () => {
    silence();
    seedWorkspace();
    seedJob();

    failing.add('flowstarter_agent_jobs:select');
    const unread = await redispatchBuildHandler(post({}), ctx());
    expect(unread.status).toBe(500);
    expect((await unread.json()).error).toMatch(/load the job/);

    failing.clear();
    failing.add('flowstarter_agent_jobs:update');
    const unqueued = await redispatchBuildHandler(post({}), ctx());
    expect(unqueued.status).toBe(500);
    expect((await unqueued.json()).error).toMatch(/re-queue the job/);
    // The attempt counter was not spent on a write that did not happen.
    expect(tables.flowstarter_agent_jobs[0]!.attempt_count).toBe(0);
  });

  it('refuses a state override it could not write', async () => {
    silence();
    seedWorkspace({ project_state: ProjectState.PREVIEW_READY });
    failing.add('workspaces:update');

    const res = await overrideStateHandler(
      post({ toState: ProjectState.DEPOSIT_PAID, reason: 'Paid by transfer' }),
      ctx()
    );

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/update the project state/);
    expect(tables.project_events).toHaveLength(0);
  });

  it('refuses a cancellation it could not read or could not write', async () => {
    silence();
    seedWorkspace();
    seedJob({ status: 'running' });

    failing.add('flowstarter_agent_jobs:select');
    const unread = await cancelJobHandler(
      post({ jobId: JOB_ID, reason: 'Stuck for two hours' }),
      ctx()
    );
    expect(unread.status).toBe(500);
    expect((await unread.json()).error).toMatch(/load the job/);

    failing.clear();
    failing.add('flowstarter_agent_jobs:update');
    const unwritten = await cancelJobHandler(
      post({ jobId: JOB_ID, reason: 'Stuck for two hours' }),
      ctx()
    );
    expect(unwritten.status).toBe(500);
    expect((await unwritten.json()).error).toMatch(/cancel the job/);
    expect(tables.flowstarter_agent_jobs[0]!.status).toBe('running');
  });

  it('refuses a note it could not read a job for, or could not store', async () => {
    silence();
    seedWorkspace();
    seedJob({ status: 'running' });

    failing.add('flowstarter_agent_jobs:select');
    const unread = await jobNoteHandler(
      post({ message: 'Use the second logo' }),
      jobCtx()
    );
    expect(unread.status).toBe(500);
    expect((await unread.json()).error).toMatch(/load the job/);

    failing.clear();
    failing.add('flowstarter_agent_job_events:insert');
    const unstored = await jobNoteHandler(
      post({ message: 'Use the second logo' }),
      jobCtx()
    );
    expect(unstored.status).toBe(500);
    expect((await unstored.json()).error).toMatch(/record the note/);
  });

  it('still delivers the note when only the audit row fails', async () => {
    // The audit trail is best effort by design: the agents get the note.
    silence();
    seedWorkspace();
    seedJob({ status: 'running' });
    failing.add('project_events:insert');

    const res = await jobNoteHandler(
      post({ message: 'Use the second logo' }),
      jobCtx()
    );

    expect(res.status).toBe(201);
    expect(tables.flowstarter_agent_job_events).toHaveLength(1);
    expect(tables.project_events).toHaveLength(0);
  });

  it('refuses the build conversation rather than showing an empty one', async () => {
    silence();
    seedWorkspace();
    seedJob();
    failing.add('flowstarter_agent_job_events:select');

    const res = await jobEventsHandler(get(), jobCtx());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/build conversation/);
  });

  it('refuses the build log at every step it could fail', async () => {
    silence();
    seedWorkspace();
    seedJob();

    failing.add('workspaces');
    const noWorkspace = await jobLogHandler(get(), jobCtx());
    expect(noWorkspace.status).toBe(500);
    expect((await noWorkspace.json()).error).toMatch(/load the workspace/);

    failing.clear();
    failing.add('flowstarter_agent_jobs');
    const noJob = await jobLogHandler(get(), jobCtx());
    expect(noJob.status).toBe(500);
    expect((await noJob.json()).error).toMatch(/load the job/);

    failing.clear();
    failing.add('flowstarter_agent_job_events');
    const noLog = await jobLogHandler(get(), jobCtx());
    expect(noLog.status).toBe(500);
    expect((await noLog.json()).error).toMatch(/load the build log/);
  });
});

describe('the build log, before any query runs', () => {
  it('rejects ids that are not uuids', async () => {
    const badWorkspace = await jobLogHandler(get(), jobCtx(JOB_ID, 'nope'));
    expect(badWorkspace.status).toBe(400);
    expect((await badWorkspace.json()).error).toBe('Invalid workspace id');

    const badJob = await jobLogHandler(get(), jobCtx('nope'));
    expect(badJob.status).toBe(400);
    expect((await badJob.json()).error).toBe('Invalid job id');
  });

  it('404s a workspace that does not exist', async () => {
    const res = await jobLogHandler(get(), jobCtx());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });

  it('stops flattening at the cap rather than streaming a whole build to a browser', async () => {
    seedWorkspace();
    seedJob();
    seedJobEvent({
      kind: 'log',
      payload: { source: 'machine', stream: true },
      body: Array.from({ length: 20_050 }, (_, i) => `line ${i}`).join('\n'),
    });

    const res = await jobLogHandler(get(), jobCtx());
    const body = await res.json();
    expect(body.lines).toHaveLength(20_000);
  });
});

describe('a request body that is not JSON at all', () => {
  it('is refused as an invalid body, not as a crash', async () => {
    seedWorkspace();
    const broken = {
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as NextRequest;

    const res = await overrideStateHandler(broken, ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_BODY');
  });
});
