/**
 * The half of the deposit-to-build flow that did not exist.
 *
 * The deposit enqueues a FULL_SITE_BUILD before the client has written a word
 * of their brief; the worker refuses to claim it until the brief is ready; and
 * until `enqueueBuildOnBriefReady` nothing anywhere turned "the brief is now
 * ready" back into "so run it". A client could pay, fill in everything that
 * was asked of them, and wait forever -- which is exactly what the 2026-09-12
 * review found.
 *
 * These tests pin the state machine: parked to queued, exactly once, only for
 * a settled deposit, and never dragging a build a worker has already claimed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import type { BriefInput } from '@flowstarter/agentic-codegen/src/flowstarter/brief-input';
import { enqueueBuildOnBriefReady } from '../deposit-workflow';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const JOB_ID = '4f9d5bf2-1c4a-4a2f-9d4a-4c0f0a7c2f11';

function briefInput(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    version: 1,
    composedAt: '2026-09-12T10:00:00.000Z',
    reason: 'brief_ready',
    offer: 'Calm, plain-language bookkeeping for founders.',
    projects: [
      {
        name: 'Ereno',
        line: 'A calm inbox for freelance invoices.',
        link: 'https://ereno.example',
        screenshotAssetIds: [],
        screenshots: [],
      },
    ],
    noProjects: false,
    designReferences: [],
    photos: [],
    portrait: null,
    ...overrides,
  };
}

interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'update';
  values?: Record<string, unknown>;
  eqCalls: Array<[string, unknown]>;
  inCalls: Array<[string, unknown]>;
}

const state: {
  workspace: Record<string, unknown> | null;
  existingJob: { id: string; status: string } | null;
  /** Set when the insert should collide with the one-build-per-workspace index. */
  insertConflicts: boolean;
  calls: RecordedCall[];
} = {
  workspace: null,
  existingJob: null,
  insertConflicts: false,
  calls: [],
};

function builderFor(table: string) {
  const record: RecordedCall = {
    table,
    op: 'select',
    eqCalls: [],
    inCalls: [],
  };
  state.calls.push(record);
  const builder: Record<string, unknown> = {
    select() {
      return builder;
    },
    insert(values: Record<string, unknown>) {
      record.op = 'insert';
      record.values = values;
      return builder;
    },
    update(values: Record<string, unknown>) {
      record.op = 'update';
      record.values = values;
      return builder;
    },
    eq(column: string, value: unknown) {
      record.eqCalls.push([column, value]);
      return builder;
    },
    in(column: string, value: unknown) {
      record.inCalls.push([column, value]);
      return builder;
    },
    maybeSingle() {
      if (table === 'workspaces') {
        return Promise.resolve({ data: state.workspace, error: null });
      }
      return Promise.resolve({ data: state.existingJob, error: null });
    },
    single() {
      if (table === 'workspaces') {
        return Promise.resolve({ data: { id: WORKSPACE_ID }, error: null });
      }
      if (record.op === 'insert') {
        return state.insertConflicts
          ? Promise.resolve({ data: null, error: { code: '23505' } })
          : Promise.resolve({
              data: { id: JOB_ID, status: 'queued' },
              error: null,
            });
      }
      return Promise.resolve({ data: state.existingJob, error: null });
    },
    then(
      resolve: (value: unknown) => unknown,
      reject?: (e: unknown) => unknown
    ) {
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builderFor }),
}));

const composed: { briefInput: BriefInput | null; reason: string } = {
  briefInput: null,
  reason: 'brief is not ready',
};
vi.mock('../brief-build-input', () => ({
  loadBriefBuildInput: async () => composed,
}));

vi.mock('@/lib/hosting/funnel-previews', () => ({
  loadFunnelPreview: async () => null,
}));

const dispatched: string[] = [];
vi.mock('../pipeline/dispatch', () => ({
  DispatchError: class DispatchError extends Error {},
  dispatchAgentJob: async (jobId: string) => {
    dispatched.push(jobId);
  },
}));

function paidWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKSPACE_ID,
    project_state: ProjectState.DEPOSIT_PAID,
    deposit_status: 'paid',
    ...overrides,
  };
}

function jobWrites() {
  return state.calls.filter(
    (call) => call.table === 'flowstarter_agent_jobs' && call.op !== 'select'
  );
}

describe('enqueueBuildOnBriefReady', () => {
  beforeEach(() => {
    state.workspace = paidWorkspace();
    state.existingJob = null;
    state.insertConflicts = false;
    state.calls = [];
    dispatched.length = 0;
    composed.briefInput = briefInput();
    composed.reason = '';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('lets a parked build out of the waiting room, with the brief on its payload', async () => {
    // The ordinary case: the deposit enqueued this job days ago and the worker
    // parked it. The unique index means the insert collides, which is how the
    // existing job is found without a race.
    state.existingJob = { id: JOB_ID, status: 'waiting_brief' };
    state.insertConflicts = true;

    const result = await enqueueBuildOnBriefReady({
      workspaceId: WORKSPACE_ID,
    });

    expect(result).toMatchObject({ outcome: 'resumed', jobId: JOB_ID });
    const writes = jobWrites();
    // One payload refresh, then one guarded promotion.
    const payloadWrite = writes.find(
      (call) => call.op === 'update' && 'payload' in (call.values ?? {})
    );
    expect(
      (payloadWrite?.values?.['payload'] as { briefInput?: BriefInput })
        ?.briefInput?.projects?.[0]?.name
    ).toBe('Ereno');
    const promotion = writes.find(
      (call) => call.op === 'update' && call.values?.['status'] === 'queued'
    );
    expect(promotion?.eqCalls).toContainEqual(['status', 'waiting_brief']);
    expect(promotion?.eqCalls).toContainEqual(['id', JOB_ID]);
    // And the worker is nudged, so the client does not wait for the sweep.
    expect(dispatched).toEqual([JOB_ID]);
  });

  it('enqueues exactly once, however many times a complete brief is saved', async () => {
    state.existingJob = { id: JOB_ID, status: 'waiting_brief' };
    state.insertConflicts = true;

    await enqueueBuildOnBriefReady({ workspaceId: WORKSPACE_ID });
    const insertsFirst = jobWrites().filter((call) => call.op === 'insert');
    await enqueueBuildOnBriefReady({ workspaceId: WORKSPACE_ID });

    const inserts = jobWrites().filter((call) => call.op === 'insert');
    // Two attempted inserts, both refused by the unique index, and therefore
    // one job. The index is the idempotency key, not a read-then-write.
    expect(insertsFirst).toHaveLength(1);
    expect(inserts).toHaveLength(2);
    expect(
      inserts.every((call) => call.values?.['kind'] === 'FULL_SITE_BUILD')
    ).toBe(true);
  });

  it('enqueues a queued build directly when the brief was already complete', async () => {
    const result = await enqueueBuildOnBriefReady({
      workspaceId: WORKSPACE_ID,
    });

    expect(result).toMatchObject({ outcome: 'enqueued', jobId: JOB_ID });
    const insert = jobWrites().find((call) => call.op === 'insert');
    expect(insert?.values).toMatchObject({
      workspace_id: WORKSPACE_ID,
      kind: 'FULL_SITE_BUILD',
      status: 'queued',
    });
  });

  it('does not move the lifecycle or rewrite the deposit timestamps', async () => {
    await enqueueBuildOnBriefReady({ workspaceId: WORKSPACE_ID });
    // `deposit_paid_at` belongs to the moment the money landed. A brief
    // finished on Thursday must not make Monday's deposit look like today's.
    expect(
      state.calls.filter(
        (call) => call.table === 'workspaces' && call.op === 'update'
      )
    ).toHaveLength(0);
  });

  it('refuses to start a build for a deposit that never settled', async () => {
    state.workspace = paidWorkspace({ deposit_status: 'unpaid' });
    const result = await enqueueBuildOnBriefReady({
      workspaceId: WORKSPACE_ID,
    });
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(result.reason).toContain('deposit');
    expect(jobWrites()).toHaveLength(0);
  });

  it('does nothing at all while the brief is still unfinished', async () => {
    composed.briefInput = null;
    composed.reason = 'brief is not ready';
    const result = await enqueueBuildOnBriefReady({
      workspaceId: WORKSPACE_ID,
    });
    expect(result).toEqual({
      outcome: 'skipped',
      jobId: null,
      reason: 'brief is not ready',
    });
    expect(jobWrites()).toHaveLength(0);
  });

  it('leaves a build that is already running alone, but still refreshes its payload', async () => {
    state.existingJob = { id: JOB_ID, status: 'running' };
    state.insertConflicts = true;

    const result = await enqueueBuildOnBriefReady({
      workspaceId: WORKSPACE_ID,
    });

    expect(result).toMatchObject({
      outcome: 'already_building',
      jobId: JOB_ID,
    });
    const promotion = jobWrites().find(
      (call) => call.op === 'update' && call.values?.['status'] === 'queued'
    );
    // The guard is on the status: a running job matches nothing and is never
    // dragged back into the queue behind the worker that holds it.
    expect(promotion?.eqCalls).toContainEqual(['status', 'waiting_brief']);
  });

  it('will not start a build for a project that is past DEPOSIT_PAID', async () => {
    state.workspace = paidWorkspace({
      project_state: ProjectState.HUMAN_QA,
    });
    const result = await enqueueBuildOnBriefReady({
      workspaceId: WORKSPACE_ID,
    });
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('HUMAN_QA');
    expect(jobWrites()).toHaveLength(0);
  });

  it('refuses a workspace id that is not a canonical UUID without touching the database', async () => {
    const result = await enqueueBuildOnBriefReady({ workspaceId: 'nope' });
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(state.calls).toHaveLength(0);
  });

  it('never throws, so a save the client watched succeed cannot fail on a nudge', async () => {
    state.workspace = null;
    await expect(
      enqueueBuildOnBriefReady({ workspaceId: WORKSPACE_ID })
    ).resolves.toMatchObject({ outcome: 'skipped' });
  });
});
