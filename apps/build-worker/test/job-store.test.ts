import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ProjectState } from '@flowstarter/agentic-codegen';
import {
  buildJobFromRows,
  changeRequestFor,
  isClaimable,
  JobArtifactError,
  parseApprovedPreviewFiles,
  parseRequiredIntegrations,
  SupabaseFullSiteBuildJobStore,
  type JobLedgerRow,
} from '../src/job-store';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

function ledgerRow(overrides: Partial<JobLedgerRow> = {}): JobLedgerRow {
  return {
    id: '4f9d5bf2-1c4a-4a2f-9d4a-4c0f0a7c2f11',
    workspace_id: WORKSPACE_ID,
    kind: 'FULL_SITE_BUILD',
    status: 'queued',
    attempt_count: 0,
    payload: {},
    ...overrides,
  };
}

/**
 * A brief the client has finished. `claim()` reads this before it will start a
 * FULL_SITE_BUILD, so it is the ordinary precondition of every claim below
 * rather than a special case: a build whose client has not sent their offer,
 * their projects and their pictures has nothing true to build from.
 */
function readyBrief(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      ready_at: '2026-09-12T09:00:00.000Z',
      override_at: null,
      ...overrides,
    },
  };
}

function artifacts(overrides: Record<string, unknown> = {}) {
  return {
    intake_payload: {
      projectId: WORKSPACE_ID,
      business: { name: 'Calm Path' },
    },
    brand_config: { schemaVersion: '1.0' },
    preview_manifest: {
      files: [{ path: 'src/content/site.md', content: 'Approved preview' }],
    },
    ...overrides,
  };
}

describe('claim eligibility', () => {
  it('claims a freshly queued full-site build', () => {
    expect(isClaimable(ledgerRow(), 3)).toBe(true);
  });

  it('will not double-start a job another worker is already running', () => {
    expect(isClaimable(ledgerRow({ status: 'running' }), 3)).toBe(false);
  });

  it('will not rebuild a job that already succeeded or was canceled', () => {
    expect(isClaimable(ledgerRow({ status: 'succeeded' }), 3)).toBe(false);
    expect(isClaimable(ledgerRow({ status: 'canceled' }), 3)).toBe(false);
  });

  it('retries a failed job until the attempt budget is spent', () => {
    expect(
      isClaimable(ledgerRow({ status: 'failed', attempt_count: 2 }), 3),
    ).toBe(true);
    expect(
      isClaimable(ledgerRow({ status: 'failed', attempt_count: 3 }), 3),
    ).toBe(false);
  });

  it('ignores an inline-edit job dispatched to the full-site endpoint', () => {
    expect(isClaimable(ledgerRow({ kind: 'INLINE_EDIT' }), 3)).toBe(false);
  });

  it('claims a site rebuild, which rides the same endpoint as a full build', () => {
    expect(isClaimable(ledgerRow({ kind: 'SITE_REBUILD' }), 3)).toBe(true);
    expect(
      isClaimable(ledgerRow({ kind: 'SITE_REBUILD', status: 'running' }), 3),
    ).toBe(false);
  });
});

describe('artifact parsing', () => {
  it('maps ledger and artifact rows onto a FullSiteBuildJob', () => {
    const job = buildJobFromRows({
      job: ledgerRow({ payload: { requiredIntegrations: ['cal.com'] } }),
      projectState: ProjectState.DEPOSIT_PAID,
      artifacts: artifacts(),
    });

    expect(job.projectId).toBe(WORKSPACE_ID);
    expect(job.projectState).toBe(ProjectState.DEPOSIT_PAID);
    expect(job.requiredIntegrations).toEqual(['cal.com']);
    expect(job.approvedPreviewFiles).toEqual([
      {
        path: 'src/content/site.md',
        content: 'Approved preview',
        type: 'file',
      },
    ]);
  });

  it('carries the kind through, so the worker knows which half to run', () => {
    expect(
      buildJobFromRows({
        job: ledgerRow(),
        projectState: ProjectState.DEPOSIT_PAID,
        artifacts: artifacts(),
      }).kind,
    ).toBe('FULL_SITE_BUILD');
  });

  it('builds a rebuild job from a live project, with no deposit gate', () => {
    // The deposit gate belongs to the full build. A client publishing an edit
    // does so months later, from LIVE_SUBSCRIPTION, and mapping the rows must
    // not quietly require the state that build already passed through.
    const job = buildJobFromRows({
      job: ledgerRow({
        kind: 'SITE_REBUILD',
        payload: { trigger: 'client_publish', version: 4 },
      }),
      projectState: ProjectState.LIVE_SUBSCRIPTION,
      artifacts: artifacts({
        preview_manifest: {
          files: [{ path: 'src/content/site.md', content: 'The edit' }],
        },
      }),
    });

    expect(job.kind).toBe('SITE_REBUILD');
    expect(job.projectState).toBe(ProjectState.LIVE_SUBSCRIPTION);
    expect(job.approvedPreviewFiles).toEqual([
      { path: 'src/content/site.md', content: 'The edit', type: 'file' },
    ]);
  });

  it('keeps a real Cal.com link and adds the integration the build needs', () => {
    const job = buildJobFromRows({
      job: ledgerRow(),
      projectState: ProjectState.DEPOSIT_PAID,
      artifacts: artifacts(),
      calComUrl: '  https://cal.com/calm-path/intro  ',
    });

    expect(job.calComUrl).toBe('https://cal.com/calm-path/intro');
    expect(job.requiredIntegrations).toEqual(['cal.com']);
  });

  it('drops a booking link on a host that only looks like Cal.com', () => {
    // The workspace row is client-supplied and its value is written into the
    // built site. A substring or prefix test on "cal.com" would accept every
    // one of these, so the host itself is what gets checked.
    for (const lookalike of [
      'https://cal.com.attacker.example/book',
      'https://notcal.com/book',
      'https://cal.com@attacker.example/book',
      'https://evil.example/cal.com/book',
    ]) {
      const job = buildJobFromRows({
        job: ledgerRow(),
        projectState: ProjectState.DEPOSIT_PAID,
        artifacts: artifacts(),
        calComUrl: lookalike,
      });

      expect(job.calComUrl).toBeUndefined();
      expect(job.requiredIntegrations).toEqual([]);
    }
  });

  it('refuses an intake whose projectId does not match the paid workspace', () => {
    expect(() =>
      buildJobFromRows({
        job: ledgerRow(),
        projectState: ProjectState.DEPOSIT_PAID,
        artifacts: artifacts({
          intake_payload: { projectId: '11111111-1111-4111-8111-111111111111' },
        }),
      }),
    ).toThrow(JobArtifactError);
  });

  it('refuses to build from an empty or missing preview manifest', () => {
    expect(() => parseApprovedPreviewFiles({})).toThrow(JobArtifactError);
    expect(() => parseApprovedPreviewFiles({ files: [] })).toThrow(
      JobArtifactError,
    );
    expect(() => parseApprovedPreviewFiles(null)).toThrow(JobArtifactError);
  });

  it('refuses a manifest entry without a usable path or content', () => {
    expect(() =>
      parseApprovedPreviewFiles({ files: [{ content: 'x' }] }),
    ).toThrow(JobArtifactError);
    expect(() =>
      parseApprovedPreviewFiles({ files: [{ path: 'a.md', content: 3 }] }),
    ).toThrow(JobArtifactError);
  });

  it('skips the tooling state an older manifest still carries', () => {
    // `flowstarter_project_artifacts.preview_manifest` for the workspace that
    // failed on 2026-09-12 holds seven `.astro/` scratch paths. Materializing
    // a dev server's process id into a build worktree is how a paid build
    // ends up being checked against one, so they are skipped here rather than
    // rejected: an old row must still build.
    expect(
      parseApprovedPreviewFiles({
        files: [
          { path: '.astro/dev.json', content: '{"pid": 97132}' },
          { path: 'node_modules/astro/index.js', content: 'x' },
          { path: 'pnpm-lock.yaml', content: 'lockfileVersion: 9' },
          { path: 'dist/index.html', content: '<h1>stale</h1>' },
          { path: 'src/content/site.md', content: 'Approved preview' },
        ],
      }),
    ).toEqual([
      {
        path: 'src/content/site.md',
        content: 'Approved preview',
        type: 'file',
      },
    ]);
  });

  it('refuses a manifest that is nothing but tooling state', () => {
    expect(() =>
      parseApprovedPreviewFiles({
        files: [{ path: '.astro/dev.json', content: '{"pid": 97132}' }],
      }),
    ).toThrow(JobArtifactError);
  });

  it('falls back to the preview manifest when the payload carries no integrations', () => {
    expect(
      parseRequiredIntegrations({}, { requiredIntegrations: ['newsletter'] }),
    ).toEqual(['newsletter']);
    expect(parseRequiredIntegrations({}, {})).toEqual([]);
  });

  it('rejects an integration name that is not a plain slug', () => {
    expect(() =>
      parseRequiredIntegrations(
        { requiredIntegrations: ['../etc/passwd'] },
        {},
      ),
    ).toThrow(JobArtifactError);
  });
});

/**
 * `SupabaseFullSiteBuildJobStore` behaviour, driven against a hand-rolled
 * scripted mock of the Supabase query builder (same recording style as
 * `tenancy.test.ts`). Each test enqueues exactly the `{ data, error }`
 * responses the code path under test will pull off, one per `.from(table)`
 * call, in call order -- so a test that supplies too few responses for a
 * path is itself a signal the path changed shape.
 *
 * This worker bypasses RLS (module doc on `../src/job-store.ts`), so several
 * assertions below exist purely to prove the tenant boundary rather than
 * assume it: every `workspaces` access is keyed by that row's own `id`
 * (which *is* the workspace id -- see the allow-list in
 * `worker-tenant-filter.test.ts`), and every `flowstarter_project_artifacts`
 * access carries an explicit `workspace_id` filter via `withTenant`.
 */
type Scripted = { data?: unknown; error?: unknown };

interface RecordedQuery {
  table: string;
  op: 'select' | 'update' | 'insert' | 'delete';
  values?: unknown;
  eqCalls: Array<[string, unknown]>;
  gtCalls: Array<[string, unknown]>;
}

function makeScriptedClient(script: Record<string, Scripted[]>) {
  const calls: RecordedQuery[] = [];
  const remaining: Record<string, Scripted[]> = Object.fromEntries(
    Object.entries(script).map(([table, responses]) => [table, [...responses]]),
  );

  const client = {
    from(table: string) {
      const queue = remaining[table];
      const response: Scripted = queue?.length
        ? (queue.shift() as Scripted)
        : { data: null, error: null };
      const record: RecordedQuery = {
        table,
        op: 'select',
        eqCalls: [],
        gtCalls: [],
      };
      calls.push(record);
      // `update(...)`/`insert(...)`/`delete()` lock the recorded op. A
      // `.select('id')` chained after `.update(...)` (asking for the
      // updated row back) must not relabel the call as a plain read.
      let opLocked = false;

      const builder: Record<string, unknown> = {
        select(_columns?: string) {
          if (!opLocked) record.op = 'select';
          return builder;
        },
        update(values: unknown) {
          record.op = 'update';
          opLocked = true;
          record.values = values;
          return builder;
        },
        insert(values: unknown) {
          record.op = 'insert';
          opLocked = true;
          record.values = values;
          return builder;
        },
        delete() {
          record.op = 'delete';
          opLocked = true;
          return builder;
        },
        eq(column: string, value: unknown) {
          record.eqCalls.push([column, value]);
          return builder;
        },
        gt(column: string, value: unknown) {
          record.gtCalls.push([column, value]);
          return builder;
        },
        not(column: string, operator: string, value: unknown) {
          record.eqCalls.push([
            `not:${column}`,
            `${operator}:${String(value)}`,
          ]);
          return builder;
        },
        in(column: string, values: unknown) {
          record.eqCalls.push([column, values]);
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(response);
        },
        single() {
          return Promise.resolve(response);
        },
        // Several call sites `await` the builder itself (an insert or an
        // update with no trailing `.select()`), the same way the real
        // supabase-js builder is thenable.
        then(
          onFulfilled: (value: Scripted) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve(response).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

const dbError = (message: string) => ({ name: 'PostgrestError', message });

function worktree() {
  return { branch: 'client/flowstarter-test', path: '/tmp/worktree' };
}

describe('SupabaseFullSiteBuildJobStore', () => {
  describe('appendEvent (and the workspaceFor lookup it shares)', () => {
    it('looks up the job workspace once and stamps it onto the event', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        flowstarter_agent_job_events: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.appendEvent('job-1', { kind: 'log', body: 'building' });

      const insertCall = calls.find(
        (c) => c.table === 'flowstarter_agent_job_events',
      );
      expect(insertCall?.op).toBe('insert');
      expect(insertCall?.values).toMatchObject({
        job_id: 'job-1',
        workspace_id: WORKSPACE_ID,
        kind: 'log',
        actor: 'system',
        body: 'building',
        payload: {},
      });
    });

    it('truncates an event body to 4000 characters', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        flowstarter_agent_job_events: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.appendEvent('job-1', {
        kind: 'log',
        body: 'x'.repeat(5_000),
      });

      const insertCall = calls.find(
        (c) => c.table === 'flowstarter_agent_job_events',
      );
      expect((insertCall?.values as { body: string }).body).toHaveLength(4_000);
    });

    it('caches the workspace id, so a second event does not re-read the ledger', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        flowstarter_agent_job_events: [{ error: null }, { error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.appendEvent('job-1', { kind: 'log', body: 'first' });
      await store.appendEvent('job-1', { kind: 'log', body: 'second' });

      expect(
        calls.filter((c) => c.table === 'flowstarter_agent_jobs'),
      ).toHaveLength(1);
      expect(
        calls.filter((c) => c.table === 'flowstarter_agent_job_events'),
      ).toHaveLength(2);
    });

    it('refuses to post an event against a job that does not exist', async () => {
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: null, error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(
        store.appendEvent('missing-job', { kind: 'log', body: 'x' }),
      ).rejects.toThrow(JobArtifactError);
    });

    it('propagates a Supabase error from the workspace lookup', async () => {
      const error = dbError('connection reset');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: null, error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(
        store.appendEvent('job-1', { kind: 'log', body: 'x' }),
      ).rejects.toBe(error);
    });

    it('propagates a Supabase error from the insert itself', async () => {
      const error = dbError('insert failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        flowstarter_agent_job_events: [{ error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(
        store.appendEvent('job-1', { kind: 'log', body: 'x' }),
      ).rejects.toBe(error);
    });
  });

  describe('readOperatorNotes', () => {
    it('maps rows into operator notes, coercing every field to a string', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_job_events: [
          {
            data: [
              {
                id: 7,
                body: 'looks good',
                actor: 'operator',
                created_at: '2026-01-01T00:00:00Z',
              },
            ],
          },
        ],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      const notes = await store.readOperatorNotes('job-1', null);

      expect(notes).toEqual([
        {
          id: '7',
          body: 'looks good',
          actor: 'operator',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]);
      const call = calls[0];
      expect(call?.eqCalls).toContainEqual(['job_id', 'job-1']);
      expect(call?.eqCalls).toContainEqual(['kind', 'note']);
      expect(call?.gtCalls).toHaveLength(0);
    });

    it('applies the after cursor as a gt filter when one is given', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_job_events: [{ data: [] }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.readOperatorNotes('job-1', '2026-01-01T00:00:00Z');

      expect(calls[0]?.gtCalls).toContainEqual([
        'created_at',
        '2026-01-01T00:00:00Z',
      ]);
    });

    it('returns an empty list rather than null when there are no notes yet', async () => {
      const { client } = makeScriptedClient({
        flowstarter_agent_job_events: [{ data: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.readOperatorNotes('job-1', null)).resolves.toEqual([]);
    });

    it('propagates a Supabase error', async () => {
      const error = dbError('read failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_job_events: [{ data: null, error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.readOperatorNotes('job-1', null)).rejects.toBe(error);
    });
  });

  describe('claim', () => {
    it('claims a queued job and materializes it from the workspace and artifact rows', async () => {
      const row = ledgerRow();
      const { client, calls } = makeScriptedClient({
        // The brief gate runs before the compare-and-set, so every claim that
        // is expected to proceed has to have a ready brief behind it.
        workspace_briefs: [readyBrief()],
        flowstarter_agent_jobs: [{ data: row }, { data: { id: row.id } }],
        workspaces: [
          {
            data: {
              id: WORKSPACE_ID,
              project_state: ProjectState.DEPOSIT_PAID,
              cal_com_url: null,
            },
          },
        ],
        flowstarter_project_artifacts: [{ data: artifacts() }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      const job = await store.claim(row.id);

      expect(job?.projectId).toBe(WORKSPACE_ID);
      expect(job?.projectState).toBe(ProjectState.DEPOSIT_PAID);

      // Tenant boundary, asserted rather than assumed: `workspaces` is keyed
      // by its own id (the allow-list's reasoning), and the artifacts read
      // carries an explicit workspace_id filter via withTenant.
      const workspaceCall = calls.find((c) => c.table === 'workspaces');
      expect(workspaceCall?.eqCalls).toContainEqual(['id', WORKSPACE_ID]);
      const artifactCall = calls.find(
        (c) => c.table === 'flowstarter_project_artifacts',
      );
      expect(artifactCall?.eqCalls).toContainEqual([
        'workspace_id',
        WORKSPACE_ID,
      ]);
    });

    it('returns null for a job id that does not exist, without claiming anything', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: null, error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.claim('missing')).resolves.toBeNull();
      expect(calls).toHaveLength(1);
    });

    it('returns null for a job already running elsewhere, without issuing the CAS update', async () => {
      const row = ledgerRow({ status: 'running' });
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: row }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.claim(row.id)).resolves.toBeNull();
      expect(
        calls.filter((c) => c.table === 'flowstarter_agent_jobs'),
      ).toHaveLength(1);
    });

    it('returns null when a concurrent dispatch wins the compare-and-set race', async () => {
      const row = ledgerRow();
      const { client, calls } = makeScriptedClient({
        // The brief gate runs before the compare-and-set, so every claim that
        // is expected to proceed has to have a ready brief behind it.
        workspace_briefs: [readyBrief()],
        // Read succeeds, but the CAS update matches zero rows -- another
        // worker already advanced (status, attempt_count) first.
        flowstarter_agent_jobs: [{ data: row }, { data: null, error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.claim(row.id)).resolves.toBeNull();
      expect(calls.filter((c) => c.table === 'workspaces')).toHaveLength(0);
      expect(
        calls.filter((c) => c.table === 'flowstarter_project_artifacts'),
      ).toHaveLength(0);
    });

    it('propagates a Supabase error from the initial read, before any CAS attempt', async () => {
      const error = dbError('read failed');
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: null, error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.claim('job-1')).rejects.toBe(error);
      expect(calls).toHaveLength(1);
    });

    it('propagates a Supabase error from the compare-and-set update', async () => {
      const row = ledgerRow();
      const error = dbError('cas failed');
      const { client } = makeScriptedClient({
        // The brief gate runs before the compare-and-set, so every claim that
        // is expected to proceed has to have a ready brief behind it.
        workspace_briefs: [readyBrief()],
        flowstarter_agent_jobs: [{ data: row }, { data: null, error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.claim(row.id)).rejects.toBe(error);
    });

    it('marks the job failed and rethrows when the workspace row is missing', async () => {
      const row = ledgerRow();
      const { client, calls } = makeScriptedClient({
        // The brief gate runs before the compare-and-set, so every claim that
        // is expected to proceed has to have a ready brief behind it.
        workspace_briefs: [readyBrief()],
        flowstarter_agent_jobs: [
          { data: row },
          { data: { id: row.id } },
          // markFailed()'s own update+select, triggered from the catch block.
          { data: { workspace_id: WORKSPACE_ID } },
        ],
        workspaces: [{ data: null, error: null }, { error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.claim(row.id)).rejects.toThrow(
        /Build workspace does not exist/,
      );

      const jobUpdates = calls.filter(
        (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
      );
      // [0] is claim()'s own compare-and-set; [1] is markFailed()'s cleanup.
      expect(jobUpdates).toHaveLength(2);
      const failedUpdate = jobUpdates[1];
      expect(failedUpdate?.values).toMatchObject({
        status: 'failed',
        error_code: 'BUILD_JOB_UNCLAIMABLE',
      });
    });

    it('marks the job failed and rethrows when the artifacts row is missing', async () => {
      const row = ledgerRow();
      const { client } = makeScriptedClient({
        // The brief gate runs before the compare-and-set, so every claim that
        // is expected to proceed has to have a ready brief behind it.
        workspace_briefs: [readyBrief()],
        flowstarter_agent_jobs: [
          { data: row },
          { data: { id: row.id } },
          { data: { workspace_id: WORKSPACE_ID } },
        ],
        workspaces: [
          {
            data: {
              id: WORKSPACE_ID,
              project_state: ProjectState.DEPOSIT_PAID,
              cal_com_url: null,
            },
          },
          { error: null },
        ],
        flowstarter_project_artifacts: [{ data: null, error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.claim(row.id)).rejects.toThrow(
        /no approved preview artifacts/,
      );
    });

    it('still surfaces the original claim failure even when markFailed cleanup itself errors', async () => {
      const row = ledgerRow();
      const cleanupError = dbError('cleanup update failed');
      const { client } = makeScriptedClient({
        // The brief gate runs before the compare-and-set, so every claim that
        // is expected to proceed has to have a ready brief behind it.
        workspace_briefs: [readyBrief()],
        flowstarter_agent_jobs: [
          { data: row },
          { data: { id: row.id } },
          // markFailed's own update+select fails outright.
          { data: null, error: cleanupError },
        ],
        workspaces: [{ data: null, error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      // The original cause -- workspace missing -- not the cleanup failure.
      await expect(store.claim(row.id)).rejects.toThrow(
        /Build workspace does not exist/,
      );
    });

    it('propagates a Supabase error from the artifacts read, after marking the job failed', async () => {
      const row = ledgerRow();
      const artifactError = dbError('artifacts read failed');
      const { client } = makeScriptedClient({
        // The brief gate runs before the compare-and-set, so every claim that
        // is expected to proceed has to have a ready brief behind it.
        workspace_briefs: [readyBrief()],
        flowstarter_agent_jobs: [
          { data: row },
          { data: { id: row.id } },
          { data: { workspace_id: WORKSPACE_ID } },
        ],
        workspaces: [
          {
            data: {
              id: WORKSPACE_ID,
              project_state: ProjectState.DEPOSIT_PAID,
              cal_com_url: null,
            },
          },
          { error: null },
        ],
        flowstarter_project_artifacts: [{ data: null, error: artifactError }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.claim(row.id)).rejects.toBe(artifactError);
    });

    it('ignores a job whose attempt budget is already spent', async () => {
      const row = ledgerRow({ status: 'failed', attempt_count: 3 });
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: row }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.claim(row.id)).resolves.toBeNull();
      expect(calls).toHaveLength(1);
    });

    /**
     * The wait, which is the whole point of the gate.
     *
     * The in-depth brief is filled in on the client's dashboard after the
     * deposit, so between paying and finishing that form there is a real
     * window in which a FULL_SITE_BUILD is queued and there is nothing honest
     * to build from. Starting anyway does not produce a worse site, it
     * produces an invented one: a case study the client never had, an offer
     * nobody wrote. So the job waits, and the tests below pin the three things
     * that makes it safe to leave running unattended for days -- the row is
     * not touched, the rebuild path is not caught by it, and the operator
     * board is told once rather than once per poll.
     */
    describe('waiting on the client brief', () => {
      it('does not claim a full build whose client has no brief row yet, and leaves the row queued', async () => {
        const row = ledgerRow();
        const { client, calls } = makeScriptedClient({
          flowstarter_agent_jobs: [{ data: row }],
          // No row at all: the client has not opened the brief page. Not an
          // error, and specifically not a reason to fail the job.
          workspace_briefs: [{ data: null, error: null }],
        });
        const store = new SupabaseFullSiteBuildJobStore(client, {
          maxAttempts: 3,
        });

        await expect(store.claim(row.id)).resolves.toBeNull();

        // The row is untouched: no compare-and-set, so `status` is still
        // `queued` and `attempt_count` is still whatever it was. A gate that
        // spent an attempt per poll would exhaust the budget of a build that
        // has nothing wrong with it.
        expect(
          calls.filter(
            (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
          ),
        ).toHaveLength(0);
        expect(calls.filter((c) => c.table === 'workspaces')).toHaveLength(0);
        expect(
          calls.filter((c) => c.table === 'flowstarter_project_artifacts'),
        ).toHaveLength(0);

        // And the brief read is tenant scoped, like every other read here.
        const briefCall = calls.find((c) => c.table === 'workspace_briefs');
        expect(briefCall?.eqCalls).toContainEqual([
          'workspace_id',
          WORKSPACE_ID,
        ]);
      });

      it('says once, on the ledger, that the job is waiting on the client', async () => {
        const row = ledgerRow();
        const { client, calls } = makeScriptedClient({
          flowstarter_agent_jobs: [{ data: row }],
          workspace_briefs: [{ data: null, error: null }],
          // [0] the "what was said last" read, [1] the insert.
          flowstarter_agent_job_events: [
            { data: null, error: null },
            { error: null },
          ],
        });
        const store = new SupabaseFullSiteBuildJobStore(client, {
          maxAttempts: 3,
        });

        await store.claim(row.id);

        const inserts = calls.filter(
          (c) =>
            c.table === 'flowstarter_agent_job_events' && c.op === 'insert',
        );
        expect(inserts).toHaveLength(1);
        expect(inserts[0]?.values).toMatchObject({
          job_id: row.id,
          workspace_id: WORKSPACE_ID,
          kind: 'phase',
          payload: { waitingOn: 'brief' },
        });
        expect(String((inserts[0]?.values as { body: string }).body)).toContain(
          'Waiting on the client brief',
        );
      });

      it('does not repeat itself on the next poll', async () => {
        const row = ledgerRow();
        const { client, calls } = makeScriptedClient({
          flowstarter_agent_jobs: [{ data: row }],
          workspace_briefs: [{ data: null, error: null }],
          // The last event on this job is already the waiting one, which is
          // what a second poll a few seconds later sees.
          flowstarter_agent_job_events: [
            { data: { payload: { waitingOn: 'brief' } }, error: null },
          ],
        });
        const store = new SupabaseFullSiteBuildJobStore(client, {
          maxAttempts: 3,
        });

        await expect(store.claim(row.id)).resolves.toBeNull();
        expect(
          calls.filter(
            (c) =>
              c.table === 'flowstarter_agent_job_events' && c.op === 'insert',
          ),
        ).toHaveLength(0);
      });

      it('keeps waiting rather than failing when the ledger line cannot be written', async () => {
        const row = ledgerRow();
        const { client } = makeScriptedClient({
          flowstarter_agent_jobs: [{ data: row }],
          workspace_briefs: [{ data: null, error: null }],
          flowstarter_agent_job_events: [
            { data: null, error: dbError('events unavailable') },
          ],
        });
        const store = new SupabaseFullSiteBuildJobStore(client, {
          maxAttempts: 3,
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Commentary failing is not the job failing.
        await expect(store.claim(row.id)).resolves.toBeNull();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
      });

      it('claims the build once the brief is ready', async () => {
        const row = ledgerRow();
        const { client } = makeScriptedClient({
          flowstarter_agent_jobs: [{ data: row }, { data: { id: row.id } }],
          workspace_briefs: [readyBrief()],
          workspaces: [
            {
              data: {
                id: WORKSPACE_ID,
                project_state: ProjectState.DEPOSIT_PAID,
                cal_com_url: null,
              },
            },
          ],
          flowstarter_project_artifacts: [{ data: artifacts() }],
        });
        const store = new SupabaseFullSiteBuildJobStore(client, {
          maxAttempts: 3,
        });

        await expect(store.claim(row.id)).resolves.toMatchObject({
          id: row.id,
          projectId: WORKSPACE_ID,
        });
      });

      it('claims the build on an operator override alone, with the brief still incomplete', async () => {
        const row = ledgerRow();
        const { client } = makeScriptedClient({
          flowstarter_agent_jobs: [{ data: row }, { data: { id: row.id } }],
          // The only way a build starts on an incomplete brief: a person said
          // so, on the record, through the override route.
          workspace_briefs: [
            readyBrief({
              ready_at: null,
              override_at: '2026-09-12T10:00:00.000Z',
            }),
          ],
          workspaces: [
            {
              data: {
                id: WORKSPACE_ID,
                project_state: ProjectState.DEPOSIT_PAID,
                cal_com_url: null,
              },
            },
          ],
          flowstarter_project_artifacts: [{ data: artifacts() }],
        });
        const store = new SupabaseFullSiteBuildJobStore(client, {
          maxAttempts: 3,
        });

        await expect(store.claim(row.id)).resolves.toMatchObject({
          id: row.id,
        });
      });

      it('never gates a rebuild, which is a change to a site that already exists', async () => {
        const row = ledgerRow({ kind: 'SITE_REBUILD' });
        const { client, calls } = makeScriptedClient({
          flowstarter_agent_jobs: [{ data: row }, { data: { id: row.id } }],
          workspaces: [
            {
              data: {
                id: WORKSPACE_ID,
                project_state: ProjectState.LIVE_SUBSCRIPTION,
                cal_com_url: null,
              },
            },
          ],
          flowstarter_project_artifacts: [{ data: artifacts() }],
        });
        const store = new SupabaseFullSiteBuildJobStore(client, {
          maxAttempts: 3,
        });

        await expect(store.claim(row.id)).resolves.toMatchObject({
          kind: 'SITE_REBUILD',
        });
        // The brief is not even read: a client publishing an edit months later
        // must not be held behind a form they finished at the start.
        expect(
          calls.filter((c) => c.table === 'workspace_briefs'),
        ).toHaveLength(0);
      });

      it('refuses to guess when the brief cannot be read at all', async () => {
        const row = ledgerRow();
        const error = dbError('workspace_briefs unavailable');
        const { client, calls } = makeScriptedClient({
          flowstarter_agent_jobs: [{ data: row }],
          workspace_briefs: [{ data: null, error }],
        });
        const store = new SupabaseFullSiteBuildJobStore(client, {
          maxAttempts: 3,
        });

        // A database that cannot be read is not a client who has not
        // answered, and must never be treated as one: the failure is loud and
        // the row is left alone.
        await expect(store.claim(row.id)).rejects.toBe(error);
        expect(
          calls.filter(
            (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
          ),
        ).toHaveLength(0);
      });
    });
  });

  describe('markAgentWorking', () => {
    it('records the worktree and advances the workspace from DEPOSIT_PAID to AGENTS_WORKING', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        workspaces: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.markAgentWorking('job-1', worktree());

      const jobUpdate = calls.find((c) => c.table === 'flowstarter_agent_jobs');
      expect(jobUpdate?.values).toMatchObject({
        worktree_branch: 'client/flowstarter-test',
        worktree_path: '/tmp/worktree',
      });
      expect(jobUpdate?.eqCalls).toContainEqual(['id', 'job-1']);

      const workspaceUpdate = calls.find((c) => c.table === 'workspaces');
      expect(workspaceUpdate?.values).toEqual({
        project_state: ProjectState.AGENTS_WORKING,
      });
      expect(workspaceUpdate?.eqCalls).toContainEqual(['id', WORKSPACE_ID]);
      expect(workspaceUpdate?.eqCalls).toContainEqual([
        'project_state',
        ProjectState.DEPOSIT_PAID,
      ]);
    });

    it('propagates a Supabase error from the job update', async () => {
      const error = dbError('update failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: null, error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.markAgentWorking('job-1', worktree())).rejects.toBe(
        error,
      );
    });

    it('propagates a Supabase error from the workspace state transition', async () => {
      const error = dbError('state update failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        workspaces: [{ error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.markAgentWorking('job-1', worktree())).rejects.toBe(
        error,
      );
    });
  });

  describe('markHumanQa', () => {
    const result = {
      commitSha: 'abc123',
      pullRequestUrl: 'https://github.com/example/site/pull/1',
      stagingUrl: 'https://project.staging.flowstarter.net',
    };

    it('merges the result onto the existing payload and moves the workspace to HUMAN_QA', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: { payload: { trigger: 'deposit_paid' } } },
          { data: { workspace_id: WORKSPACE_ID } },
        ],
        workspaces: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.markHumanQa('job-1', result);

      const update = calls.find(
        (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
      );
      expect(update?.values).toMatchObject({
        status: 'succeeded',
        pull_request_url: result.pullRequestUrl,
        payload: {
          trigger: 'deposit_paid',
          commitSha: result.commitSha,
          stagingUrl: result.stagingUrl,
          pullRequestUrl: result.pullRequestUrl,
        },
      });

      const workspaceUpdate = calls.find((c) => c.table === 'workspaces');
      expect(workspaceUpdate?.values).toEqual({
        project_state: ProjectState.HUMAN_QA,
      });
      expect(workspaceUpdate?.eqCalls).toContainEqual(['id', WORKSPACE_ID]);
      expect(workspaceUpdate?.eqCalls).toContainEqual([
        'project_state',
        ProjectState.AGENTS_WORKING,
      ]);
    });

    it('falls back to an empty payload when the ledger payload is missing or not an object', async () => {
      for (const existingPayload of [null, undefined, ['not', 'a', 'record']]) {
        const { client, calls } = makeScriptedClient({
          flowstarter_agent_jobs: [
            { data: { payload: existingPayload } },
            { data: { workspace_id: WORKSPACE_ID } },
          ],
          workspaces: [{ error: null }],
        });
        const store = new SupabaseFullSiteBuildJobStore(client, {
          maxAttempts: 3,
        });

        await store.markHumanQa('job-1', result);

        const update = calls.find(
          (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
        );
        expect(update?.values).toMatchObject({
          payload: {
            commitSha: result.commitSha,
            stagingUrl: result.stagingUrl,
            pullRequestUrl: result.pullRequestUrl,
          },
        });
      }
    });

    it('propagates a Supabase error from the payload read', async () => {
      const error = dbError('payload read failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: null, error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.markHumanQa('job-1', result)).rejects.toBe(error);
    });

    it('propagates a Supabase error from the job update', async () => {
      const error = dbError('update failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: { payload: {} } },
          { data: null, error },
        ],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.markHumanQa('job-1', result)).rejects.toBe(error);
    });

    it('propagates a Supabase error from the workspace state transition', async () => {
      const error = dbError('state update failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: { payload: {} } },
          { data: { workspace_id: WORKSPACE_ID } },
        ],
        workspaces: [{ error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.markHumanQa('job-1', result)).rejects.toBe(error);
    });
  });

  describe('markRebuildStarted', () => {
    it('records the worktree without touching the workspace state', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.markRebuildStarted('job-1', worktree());

      const update = calls.find((c) => c.table === 'flowstarter_agent_jobs');
      expect(update?.values).toMatchObject({
        worktree_branch: 'client/flowstarter-test',
        worktree_path: '/tmp/worktree',
      });
      expect(update?.eqCalls).toContainEqual(['id', 'job-1']);
      // A client publishing an edit does not change where the engagement
      // stands; a rebuild must not perturb project_state.
      expect(calls.filter((c) => c.table === 'workspaces')).toHaveLength(0);
    });

    it('propagates a Supabase error', async () => {
      const error = dbError('update failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.markRebuildStarted('job-1', worktree())).rejects.toBe(
        error,
      );
    });
  });

  describe('markRebuilt', () => {
    const result = {
      commitSha: 'def456',
      pullRequestUrl: 'https://github.com/example/site/pull/2',
      stagingUrl: 'https://project.staging.flowstarter.net',
    };

    it('merges the result onto the existing payload without moving project_state', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: { payload: { trigger: 'client_publish' } } },
          { error: null },
        ],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.markRebuilt('job-1', result);

      const update = calls.find(
        (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
      );
      expect(update?.values).toMatchObject({
        status: 'succeeded',
        pull_request_url: result.pullRequestUrl,
        payload: {
          trigger: 'client_publish',
          commitSha: result.commitSha,
          stagingUrl: result.stagingUrl,
          pullRequestUrl: result.pullRequestUrl,
        },
      });
      expect(calls.filter((c) => c.table === 'workspaces')).toHaveLength(0);
    });

    it('propagates a Supabase error from the payload read', async () => {
      const error = dbError('payload read failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: null, error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.markRebuilt('job-1', result)).rejects.toBe(error);
    });

    it('propagates a Supabase error from the job update', async () => {
      const error = dbError('update failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { payload: {} } }, { error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(store.markRebuilt('job-1', result)).rejects.toBe(error);
    });
  });

  describe('markFailed', () => {
    it('records the failure and rolls the workspace back to DEPOSIT_PAID for a retry', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        workspaces: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.markFailed('job-1', {
        code: 'BUILD_TIMEOUT',
        detail: 'timed out',
      });

      const jobUpdate = calls.find((c) => c.table === 'flowstarter_agent_jobs');
      expect(jobUpdate?.values).toMatchObject({
        status: 'failed',
        error_code: 'BUILD_TIMEOUT',
        error_detail: 'timed out',
      });
      expect(jobUpdate?.eqCalls).toContainEqual(['id', 'job-1']);

      const workspaceUpdate = calls.find((c) => c.table === 'workspaces');
      expect(workspaceUpdate?.values).toEqual({
        project_state: ProjectState.DEPOSIT_PAID,
      });
      expect(workspaceUpdate?.eqCalls).toContainEqual(['id', WORKSPACE_ID]);
      expect(workspaceUpdate?.eqCalls).toContainEqual([
        'project_state',
        ProjectState.AGENTS_WORKING,
      ]);
    });

    it('truncates the error detail to 2000 characters', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        workspaces: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.markFailed('job-1', { code: 'X', detail: 'y'.repeat(3_000) });

      const jobUpdate = calls.find((c) => c.table === 'flowstarter_agent_jobs');
      expect(
        (jobUpdate?.values as { error_detail: string }).error_detail,
      ).toHaveLength(2_000);
    });

    it('propagates a Supabase error from the job update', async () => {
      const error = dbError('update failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: null, error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(
        store.markFailed('job-1', { code: 'X', detail: 'y' }),
      ).rejects.toBe(error);
    });

    it('propagates a Supabase error from the workspace rollback', async () => {
      const error = dbError('rollback failed');
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        workspaces: [{ error }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(
        store.markFailed('job-1', { code: 'X', detail: 'y' }),
      ).rejects.toBe(error);
    });
  });

  describe('the change-request build, on the ledger', () => {
    const CHANGE_ID = '72fe7f79-0e83-4cf6-9b4a-2502842b9a54';

    it('records the worktree and moves no project state', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.markChangeRequestBuildStarted('job-1', worktree());

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        table: 'flowstarter_agent_jobs',
        op: 'update',
      });
      // A client who has paid for one more section has not gone back into the
      // build pipeline, so nothing touches `workspaces`.
      expect(calls.some((call) => call.table === 'workspaces')).toBe(false);
    });

    it('surfaces a failure to record the worktree', async () => {
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ error: dbError('no such job') }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(
        store.markChangeRequestBuildStarted('job-1', worktree()),
      ).rejects.toMatchObject({ message: 'no such job' });
    });

    it('saves the finished manifest as the next version, unpublished', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        site_versions: [{ data: { version: 4 } }, { error: null }],
        flowstarter_project_artifacts: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      const saved = await store.saveChangeRequestVersion('job-1', {
        changeRequestId: CHANGE_ID,
        files: [
          { path: 'src/content/site.md', content: 'the change', type: 'file' },
        ],
      });

      expect(saved).toEqual({ version: 5 });
      const insert = calls.find(
        (call) => call.table === 'site_versions' && call.op === 'insert',
      );
      expect(insert?.values).toMatchObject({
        workspace_id: WORKSPACE_ID,
        version: 5,
        summary: `Paid change request ${CHANGE_ID}`,
      });
      // Nothing is marked published here: that happens only once the deploy
      // has actually succeeded.
      expect(
        (insert?.values as { published_at?: unknown }).published_at,
      ).toBeUndefined();
      // The worker and the deploy path both read the artifact row, so the
      // change is not real until this mirrors the new version.
      const mirror = calls.find(
        (call) => call.table === 'flowstarter_project_artifacts',
      );
      expect(mirror?.op).toBe('update');
      expect(mirror?.eqCalls).toContainEqual(['workspace_id', WORKSPACE_ID]);
    });

    it('starts at version 1 for a site that was never edited', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        site_versions: [{ data: null }, { error: null }],
        flowstarter_project_artifacts: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      expect(
        await store.saveChangeRequestVersion('job-1', {
          changeRequestId: CHANGE_ID,
          files: [],
        }),
      ).toEqual({ version: 1 });
      const insert = calls.find(
        (call) => call.table === 'site_versions' && call.op === 'insert',
      );
      expect((insert?.values as { version: number }).version).toBe(1);
    });

    it('re-reads the number when a client publish takes it first', async () => {
      // The unique index on (workspace_id, version) is what decides; the read
      // is only there so the common case does not spend an insert to learn it.
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        site_versions: [
          { data: { version: 4 } },
          { error: { code: '23505', message: 'duplicate key' } },
          { data: { version: 5 } },
          { error: null },
        ],
        flowstarter_project_artifacts: [{ error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      expect(
        await store.saveChangeRequestVersion('job-1', {
          changeRequestId: CHANGE_ID,
          files: [],
        }),
      ).toEqual({ version: 6 });
      expect(
        calls.filter(
          (call) => call.table === 'site_versions' && call.op === 'insert',
        ),
      ).toHaveLength(2);
    });

    it('gives up rather than looping when the number never settles', async () => {
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        site_versions: Array.from({ length: 8 }, (_, index) =>
          index % 2 === 0
            ? { data: { version: 4 } }
            : { error: { code: '23505', message: 'duplicate key' } },
        ),
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(
        store.saveChangeRequestVersion('job-1', {
          changeRequestId: CHANGE_ID,
          files: [],
        }),
      ).rejects.toThrow(JobArtifactError);
    });

    it('surfaces an insert failure that is not a version collision', async () => {
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        site_versions: [
          { data: { version: 4 } },
          { error: dbError('manifest too large') },
        ],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(
        store.saveChangeRequestVersion('job-1', {
          changeRequestId: CHANGE_ID,
          files: [],
        }),
      ).rejects.toMatchObject({ message: 'manifest too large' });
    });

    it('publishes the version, finishes the job and moves paid to done', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: { workspace_id: WORKSPACE_ID } },
          { data: { payload: { trigger: 'operator_build' } } },
          { error: null },
        ],
        site_versions: [{ error: null }, { error: null }],
        flowstarter_change_requests: [{ data: [{ id: CHANGE_ID }] }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await store.markChangeRequestBuilt('job-1', {
        commitSha: 'cha09e5',
        pullRequestUrl: 'https://example.test/deploy/12',
        stagingUrl: 'https://acme.flowstarter.net',
        changeRequestId: CHANGE_ID,
        version: 5,
      });

      // The enqueue payload is merged into, never replaced: it is the only
      // provenance linking a shipped change back to the request that bought it.
      const finish = calls.find(
        (call) =>
          call.table === 'flowstarter_agent_jobs' && call.op === 'update',
      );
      expect(finish?.values).toMatchObject({
        status: 'succeeded',
        pull_request_url: 'https://example.test/deploy/12',
      });
      expect(
        (finish?.values as { payload: Record<string, unknown> }).payload,
      ).toMatchObject({
        trigger: 'operator_build',
        commitSha: 'cha09e5',
        builtVersion: 5,
      });

      const done = calls.find(
        (call) => call.table === 'flowstarter_change_requests',
      );
      expect(done?.op).toBe('update');
      expect(done?.values).toMatchObject({
        status: 'done',
        completed_via: 'build',
        built_version: 5,
        build_job_id: 'job-1',
      });
      // Compare-and-set on `paid`: a request already moved by hand, or by a
      // previous attempt, is not completed a second time.
      expect(done?.eqCalls).toContainEqual(['status', 'paid']);
      expect(done?.eqCalls).toContainEqual(['workspace_id', WORKSPACE_ID]);
    });

    it('says so loudly when the request was not at paid to be completed', async () => {
      // The site is live and the ledger disagrees, which is exactly the state
      // an operator has to be able to see.
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: { workspace_id: WORKSPACE_ID } },
          { data: { payload: {} } },
          { error: null },
        ],
        site_versions: [{ error: null }, { error: null }],
        flowstarter_change_requests: [{ data: [] }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(
        store.markChangeRequestBuilt('job-1', {
          commitSha: 'cha09e5',
          pullRequestUrl: 'u',
          stagingUrl: 's',
          changeRequestId: CHANGE_ID,
          version: 5,
        }),
      ).rejects.toThrow(/was not at paid when its build finished/);
    });

    it('surfaces a failure to stamp the version published', async () => {
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        site_versions: [{ error: dbError('site_versions unavailable') }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, {
        maxAttempts: 3,
      });

      await expect(
        store.markChangeRequestBuilt('job-1', {
          commitSha: 'c',
          pullRequestUrl: 'u',
          stagingUrl: 's',
          changeRequestId: CHANGE_ID,
          version: 5,
        }),
      ).rejects.toMatchObject({ message: 'site_versions unavailable' });
    });
  });
});

describe('CHANGE_REQUEST_BUILD on the ledger', () => {
  const CHANGE_ID = '72fe7f79-0e83-4cf6-9b4a-2502842b9a54';
  const ASSET_ID = 'b104b1e0-6d4c-4a3e-9230-13cc17b426a0';

  function changePayload(overrides: Record<string, unknown> = {}) {
    return {
      trigger: 'operator_build',
      changeRequest: {
        changeRequestId: CHANGE_ID,
        request: 'Add a gallery to the Flowstarter case study page',
        operatorNote: 'Three across on desktop',
        seedVersion: 4,
        assets: [
          {
            assetId: ASSET_ID,
            publicPath: '/flowstarter-media/cr-b104b1e0.jpg',
            caption: 'The client dashboard',
            mime: 'image/jpeg',
            width: 1200,
            height: 750,
          },
        ],
        ...overrides,
      },
    };
  }

  it('is a kind this worker will claim', () => {
    expect(isClaimable(ledgerRow({ kind: 'CHANGE_REQUEST_BUILD' }), 3)).toBe(
      true,
    );
  });

  it('carries the request and the pictures onto the job', () => {
    const job = buildJobFromRows({
      job: ledgerRow({
        kind: 'CHANGE_REQUEST_BUILD',
        payload: changePayload(),
      }),
      projectState: ProjectState.LIVE_SUBSCRIPTION,
      artifacts: artifacts(),
      changeRequestAssetFiles: [
        {
          path: 'public/flowstarter-media/cr-b104b1e0.jpg',
          content: 'AAAA',
          encoding: 'base64',
          type: 'file',
        },
      ],
    });

    expect(job.kind).toBe('CHANGE_REQUEST_BUILD');
    expect(job.changeRequest?.changeRequestId).toBe(CHANGE_ID);
    expect(job.changeRequest?.operatorNote).toBe('Three across on desktop');
    expect(job.changeRequest?.seedVersion).toBe(4);
    // The seed is the client's own manifest with their pictures folded in, so
    // the paths the prompt names are files the agent can really open.
    expect(job.approvedPreviewFiles.map((file) => file.path)).toEqual([
      'src/content/site.md',
      'public/flowstarter-media/cr-b104b1e0.jpg',
    ]);
  });

  it('leaves the other two kinds carrying no change request', () => {
    for (const kind of ['FULL_SITE_BUILD', 'SITE_REBUILD']) {
      const job = buildJobFromRows({
        // Even with a change request on the payload: the kind decides.
        job: ledgerRow({ kind, payload: changePayload() }),
        projectState: ProjectState.HUMAN_QA,
        artifacts: artifacts(),
      });
      expect(job.changeRequest).toBeUndefined();
    }
  });

  it('carries no change request when the payload holds nothing readable', () => {
    const job = buildJobFromRows({
      job: ledgerRow({
        kind: 'CHANGE_REQUEST_BUILD',
        payload: { trigger: 'operator_build' },
      }),
      projectState: ProjectState.HUMAN_QA,
      artifacts: artifacts(),
    });
    // The worker fails the job loudly on this rather than guessing, and the
    // request stays at paid.
    expect(job.changeRequest).toBeUndefined();
  });

  it('reads the change request straight off a ledger row', () => {
    expect(
      changeRequestFor(
        ledgerRow({ kind: 'CHANGE_REQUEST_BUILD', payload: changePayload() }),
      )?.changeRequestId,
    ).toBe(CHANGE_ID);
    expect(
      changeRequestFor(
        ledgerRow({ kind: 'SITE_REBUILD', payload: changePayload() }),
      ),
    ).toBeNull();
  });
});
