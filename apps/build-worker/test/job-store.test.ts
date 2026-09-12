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

function makeScriptedClient(
  script: Record<string, Scripted[]>,
  /**
   * Bytes the storage bucket answers with, per object path. Only the brief and
   * change-request asset paths reach it; anything else answers "not found",
   * which is the case a build has to survive rather than fail on.
   */
  objects: Record<string, Buffer> = {},
) {
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
        // `is(column, null)` is how the lease guards express "nobody holds
        // this", and `lte` is the queue sweep's run_after window.
        is(column: string, value: unknown) {
          record.eqCalls.push([`is:${column}`, value]);
          return builder;
        },
        lte(column: string, value: unknown) {
          record.eqCalls.push([`lte:${column}`, value]);
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

  const withStorage = {
    ...client,
    storage: {
      from: () => ({
        download: async (path: string) => {
          const bytes = objects[path];
          if (!bytes) return { data: null, error: { message: 'not found' } };
          return {
            data: {
              arrayBuffer: async () =>
                bytes.buffer.slice(
                  bytes.byteOffset,
                  bytes.byteOffset + bytes.byteLength,
                ),
            },
            error: null,
          };
        },
      }),
    },
  };

  return { client: withStorage as unknown as SupabaseClient, calls };
}

/**
 * A real PNG at 400x400, so `assertSafeUploadedImage` reads honest bytes and
 * clears the minimum edge it demands. Same fixture as
 * `change-request-assets.test.ts`.
 */
function pngBytes(): Buffer {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  png.writeUInt32BE(400, 16);
  png.writeUInt32BE(400, 20);
  return png;
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
      it('parks a full build whose client has no brief row yet, without spending an attempt', async () => {
        const row = ledgerRow();
        const { client, calls } = makeScriptedClient({
          flowstarter_agent_jobs: [{ data: row }, { error: null }],
          // No row at all: the client has not opened the brief page. Not an
          // error, and specifically not a reason to fail the job.
          workspace_briefs: [{ data: null, error: null }],
        });
        const store = new SupabaseFullSiteBuildJobStore(client, {
          maxAttempts: 3,
        });

        await expect(store.claim(row.id)).resolves.toBeNull();

        // Exactly one write, and it is the status: `waiting_brief`, which is
        // what makes this visible on the board and findable by the sweep.
        // `attempt_count` is deliberately absent from it -- a gate that spent
        // an attempt per poll would exhaust the budget of a build that has
        // nothing wrong with it -- and the update is guarded on the status
        // that was read, so a job somebody else claimed is left alone.
        const parked = calls.filter(
          (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
        );
        expect(parked).toHaveLength(1);
        expect(parked[0]?.values).toMatchObject({ status: 'waiting_brief' });
        expect(parked[0]?.values).not.toHaveProperty('attempt_count');
        expect(parked[0]?.eqCalls).toContainEqual(['id', row.id]);
        expect(parked[0]?.eqCalls).toContainEqual(['status', 'queued']);
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

/**
 * The brief on its way into the build, and the sweep that finds a job nobody
 * dispatched.
 *
 * Both halves of the 2026-09-12 defect live here. The payload carried nothing
 * the client wrote after paying, so `intake.projects` was always absent and
 * the invented-project gate never ran; and the end of a `waiting_brief` wait
 * reached nobody, because the only thing that ever asked this worker to look
 * at a job was a dispatch at deposit time that had already been refused.
 */
describe('the client brief on a claimed build', () => {
  const PORTRAIT_ID = 'b104b1e0-6d4c-4a3e-9230-13cc17b426a0';
  const SHOT_ID = 'c2f0f3a1-9b2e-4a7c-8d1f-6b5a4c3d2e10';
  const PORTRAIT_PATH = 'public/flowstarter-media/brief-b104b1e0.jpg';
  const SHOT_PATH = 'public/flowstarter-media/brief-c2f0f3a1.png';

  function briefPayload() {
    return {
      trigger: 'deposit_paid',
      briefInput: {
        version: 1,
        composedAt: '2026-09-12T09:30:00.000Z',
        reason: 'brief_ready',
        offer: 'Calm, plain-language bookkeeping for founders.',
        projects: [
          {
            name: 'Ereno',
            line: 'A calm inbox for freelance invoices.',
            link: 'https://ereno.example',
            screenshotAssetIds: [SHOT_ID],
            screenshots: [
              {
                assetId: SHOT_ID,
                publicPath: '/flowstarter-media/brief-c2f0f3a1.png',
                manifestPath: SHOT_PATH,
                caption: 'The Ereno inbox',
                mime: 'image/png',
                width: 1600,
                height: 1000,
              },
            ],
          },
        ],
        noProjects: false,
        designReferences: [],
        photos: [],
        portrait: {
          assetId: PORTRAIT_ID,
          publicPath: '/flowstarter-media/brief-b104b1e0.jpg',
          manifestPath: PORTRAIT_PATH,
          caption: 'Ana at her desk',
          mime: 'image/jpeg',
          width: 1600,
          height: 1600,
        },
      },
    };
  }

  function assetRows(rights: { portrait: boolean; shot: boolean }) {
    return [
      {
        id: PORTRAIT_ID,
        storage_path: `tenant/${WORKSPACE_ID}/assets/portrait.jpg`,
        rights_confirmed_at: rights.portrait
          ? '2026-09-12T09:00:00.000Z'
          : null,
      },
      {
        id: SHOT_ID,
        storage_path: `tenant/${WORKSPACE_ID}/assets/shot.png`,
        rights_confirmed_at: rights.shot ? '2026-09-12T09:00:00.000Z' : null,
      },
    ];
  }

  function scriptFor(rows: Array<Record<string, unknown>>) {
    return {
      flowstarter_agent_jobs: [
        { data: ledgerRow({ payload: briefPayload() }) },
        { data: { id: 'job-1' } },
      ],
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
      assets: [{ data: rows }],
      flowstarter_agent_job_events: [
        { data: { workspace_id: WORKSPACE_ID } },
        { error: null },
      ],
    };
  }

  it('merges the brief into the intake and puts the files on disk', async () => {
    const { client } = makeScriptedClient(
      scriptFor(assetRows({ portrait: true, shot: true })),
      {
        [`tenant/${WORKSPACE_ID}/assets/portrait.jpg`]: pngBytes(),
        [`tenant/${WORKSPACE_ID}/assets/shot.png`]: pngBytes(),
      },
    );
    const store = new SupabaseFullSiteBuildJobStore(client, { maxAttempts: 3 });

    const job = await store.claim('4f9d5bf2-1c4a-4a2f-9d4a-4c0f0a7c2f11');

    // The whole point: the rules downstream read these off the intake.
    expect(job?.intake.offer).toContain('plain-language bookkeeping');
    expect(job?.intake.projects?.map((project) => project.name)).toEqual([
      'Ereno',
    ]);
    expect(job?.intake.photos?.[0]?.kind).toBe('portrait');
    // And the bytes are seeded beside the approved preview, at the exact paths
    // the prompt will name.
    const paths = job?.approvedPreviewFiles.map((file) => file.path) ?? [];
    expect(paths).toContain('src/content/site.md');
    expect(paths).toContain(PORTRAIT_PATH);
    expect(paths).toContain(SHOT_PATH);
    const portrait = job?.approvedPreviewFiles.find(
      (file) => file.path === PORTRAIT_PATH,
    );
    expect(portrait?.encoding).toBe('base64');
    expect(job?.briefInput?.projects[0]?.screenshots).toHaveLength(1);
  });

  it('never publishes a file whose rights are no longer confirmed, and stops naming its path', async () => {
    const { client, calls } = makeScriptedClient(
      // The client withdrew the portrait's rights after the payload was
      // composed. Rights are a statement somebody can take back, and this is
      // the last moment before those bytes are on a public website.
      scriptFor(assetRows({ portrait: false, shot: true })),
      {
        [`tenant/${WORKSPACE_ID}/assets/portrait.jpg`]: pngBytes(),
        [`tenant/${WORKSPACE_ID}/assets/shot.png`]: pngBytes(),
      },
    );
    const store = new SupabaseFullSiteBuildJobStore(client, { maxAttempts: 3 });

    const job = await store.claim('4f9d5bf2-1c4a-4a2f-9d4a-4c0f0a7c2f11');

    const paths = job?.approvedPreviewFiles.map((file) => file.path) ?? [];
    expect(paths).not.toContain(PORTRAIT_PATH);
    expect(paths).toContain(SHOT_PATH);
    // And the brief the prompt is written from no longer mentions it, so the
    // agent is never told to place a picture that is not there.
    expect(job?.briefInput?.portrait).toBeNull();
    // The client is owed an answer for the missing photograph, on the job's
    // own timeline, before the build starts.
    const note = calls.find(
      (c) => c.table === 'flowstarter_agent_job_events' && c.op === 'insert',
    );
    expect(String((note?.values as { body?: string })?.body)).toContain(
      'could not be used',
    );
    // The asset read is tenant scoped, like every other read here.
    const assetRead = calls.find((c) => c.table === 'assets');
    expect(assetRead?.eqCalls).toContainEqual(['workspace_id', WORKSPACE_ID]);
  });

  it('leaves the intake untouched for a workspace with no brief on its payload', async () => {
    const { client } = makeScriptedClient({
      flowstarter_agent_jobs: [
        { data: ledgerRow() },
        { data: { id: 'job-1' } },
      ],
      workspace_briefs: [readyBrief({ ready_at: null, override_at: 'now' })],
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
    const store = new SupabaseFullSiteBuildJobStore(client, { maxAttempts: 3 });

    const job = await store.claim('4f9d5bf2-1c4a-4a2f-9d4a-4c0f0a7c2f11');

    // An operator-created project, or any workspace that predates the brief
    // page: `projects` stays absent, which is what keeps the gate silent and
    // the build behaving exactly as it did.
    expect(job?.intake.projects).toBeUndefined();
    expect(job?.briefInput).toBeUndefined();
    expect(job?.approvedPreviewFiles.map((file) => file.path)).toEqual([
      'src/content/site.md',
    ]);
  });
});

describe('readyForClaim: the jobs nobody dispatched', () => {
  const JOB_A = '4f9d5bf2-1c4a-4a2f-9d4a-4c0f0a7c2f11';
  const JOB_B = '5a8e6cf3-2d5b-4b30-8e5b-5d1f1b8d3f22';

  function sweepRow(overrides: Record<string, unknown> = {}) {
    return {
      id: JOB_A,
      workspace_id: WORKSPACE_ID,
      kind: 'FULL_SITE_BUILD',
      status: 'queued',
      attempt_count: 0,
      run_after: '2020-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('returns a queued job that is due', async () => {
    const { client } = makeScriptedClient({
      flowstarter_agent_jobs: [{ data: [sweepRow()] }],
    });
    const store = new SupabaseFullSiteBuildJobStore(client, { maxAttempts: 3 });
    await expect(store.readyForClaim(25)).resolves.toEqual([JOB_A]);
  });

  it('leaves a queued job alone until its backoff window has passed', async () => {
    const { client } = makeScriptedClient({
      flowstarter_agent_jobs: [
        { data: [sweepRow({ run_after: '2999-01-01T00:00:00.000Z' })] },
      ],
    });
    const store = new SupabaseFullSiteBuildJobStore(client, { maxAttempts: 3 });
    await expect(store.readyForClaim(25)).resolves.toEqual([]);
  });

  it('leaves a job that has spent its attempt budget', async () => {
    const { client } = makeScriptedClient({
      flowstarter_agent_jobs: [{ data: [sweepRow({ attempt_count: 3 })] }],
    });
    const store = new SupabaseFullSiteBuildJobStore(client, { maxAttempts: 3 });
    await expect(store.readyForClaim(25)).resolves.toEqual([]);
  });

  it('promotes a parked job whose client finished their brief while nothing was listening', async () => {
    const { client, calls } = makeScriptedClient({
      flowstarter_agent_jobs: [
        { data: [sweepRow({ status: 'waiting_brief' })] },
        { data: { id: JOB_A } },
      ],
      workspace_briefs: [readyBrief()],
    });
    const store = new SupabaseFullSiteBuildJobStore(client, { maxAttempts: 3 });

    await expect(store.readyForClaim(25)).resolves.toEqual([JOB_A]);

    // Promotion is a compare-and-set on the status that was read, so of two
    // workers sweeping at once exactly one takes the job.
    const promote = calls.find(
      (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
    );
    expect(promote?.values).toMatchObject({ status: 'queued' });
    expect(promote?.eqCalls).toContainEqual(['status', 'waiting_brief']);
    // And the brief read is tenant scoped.
    const briefRead = calls.find((c) => c.table === 'workspace_briefs');
    expect(briefRead?.eqCalls).toContainEqual(['workspace_id', WORKSPACE_ID]);
  });

  it('leaves a parked job parked while the brief is still unfinished', async () => {
    const { client, calls } = makeScriptedClient({
      flowstarter_agent_jobs: [
        { data: [sweepRow({ status: 'waiting_brief' })] },
      ],
      workspace_briefs: [{ data: null, error: null }],
    });
    const store = new SupabaseFullSiteBuildJobStore(client, { maxAttempts: 3 });

    await expect(store.readyForClaim(25)).resolves.toEqual([]);
    expect(
      calls.filter(
        (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
      ),
    ).toHaveLength(0);
  });

  it('does not hand back a job another worker promoted first', async () => {
    const { client } = makeScriptedClient({
      flowstarter_agent_jobs: [
        { data: [sweepRow({ id: JOB_B, status: 'waiting_brief' })] },
        // The guarded update matched nothing: somebody else got there.
        { data: null },
      ],
      workspace_briefs: [readyBrief()],
    });
    const store = new SupabaseFullSiteBuildJobStore(client, { maxAttempts: 3 });
    await expect(store.readyForClaim(25)).resolves.toEqual([]);
  });
});

/**
 * Leases on the ledger: the durable half of the queue.
 *
 * The defect these cover is one a client feels. A worker claimed a paid build,
 * wrote `running`, and died. Nothing looked at that row again — a restarted
 * worker walked past it, and the operator board refused to re-dispatch it — so
 * the site was never built and nobody found out until the client asked.
 */
describe('SupabaseFullSiteBuildJobStore leases', () => {
  const NOW = Date.parse('2026-09-12T12:00:00.000Z');
  const OWNER = 'build-1:42:abcd';
  const options = {
    maxAttempts: 3,
    leaseTtlMs: 120_000,
    owner: OWNER,
    backoff: { baseMs: 30_000, maxMs: 900_000 },
    now: () => NOW,
  };
  const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

  function leasedRow(overrides: Partial<JobLedgerRow> = {}): JobLedgerRow {
    return ledgerRow({
      status: 'running',
      attempt_count: 1,
      leased_by: 'build-0:9:dead',
      lease_expires_at: iso(-1_000),
      ...overrides,
    });
  }

  describe('claim', () => {
    it('writes who holds the job and until when, in the same statement', async () => {
      const row = ledgerRow();
      const { client, calls } = makeScriptedClient({
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
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await store.claim(row.id);

      const cas = calls.filter(
        (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
      )[0];
      expect(cas?.values).toMatchObject({
        status: 'running',
        leased_by: OWNER,
        lease_expires_at: iso(120_000),
      });
      // There is no window where the row reads `running` with nobody on it.
      expect(cas?.eqCalls).toContainEqual(['is:leased_by', null]);
    });

    it('takes over a build whose worker stopped checking in', async () => {
      const row = leasedRow();
      const { client, calls } = makeScriptedClient({
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
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.claim(row.id)).resolves.not.toBeNull();

      const cas = calls.filter(
        (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
      )[0];
      // Guarded on the dead holder, so two workers recovering the same
      // abandoned build cannot both take it.
      expect(cas?.eqCalls).toContainEqual(['leased_by', 'build-0:9:dead']);
      expect(cas?.values).toMatchObject({ leased_by: OWNER });
    });

    it('leaves a build alone while its worker is still checking in', async () => {
      const row = leasedRow({ lease_expires_at: iso(60_000) });
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: row }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.claim(row.id)).resolves.toBeNull();
      expect(
        calls.filter((c) => c.table === 'flowstarter_agent_jobs'),
      ).toHaveLength(1);
    });

    it('finishes a crashed build that had already published, without rebuilding it', async () => {
      // Idempotent publication. The commit is pushed and the PR is open; all
      // that is missing is the row that says so. Building again would open a
      // second PR for work that already shipped.
      const row = leasedRow({
        payload: {
          commitSha: 'abc123',
          pullRequestUrl: 'https://github.com/o/r/pull/7',
          stagingUrl: 'https://x.staging.flowstarter.dev',
        },
      });
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: row },
          { data: { payload: row.payload } },
          { data: { workspace_id: WORKSPACE_ID } },
        ],
        workspaces: [{ data: null, error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.claim(row.id)).resolves.toBeNull();

      const update = calls.find(
        (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
      );
      expect(update?.values).toMatchObject({
        status: 'succeeded',
        pull_request_url: 'https://github.com/o/r/pull/7',
        leased_by: null,
        lease_expires_at: null,
      });
      // Nothing was re-claimed: no attempt was spent and no build started.
      expect(
        calls.some(
          (c) =>
            c.op === 'update' &&
            (c.values as Record<string, unknown>)?.status === 'running',
        ),
      ).toBe(false);
    });
  });

  describe('heartbeat', () => {
    it('pushes the expiry forward, guarded on this worker owning the row', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { id: 'job-1' } }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.heartbeat('job-1')).resolves.toBe(true);

      const beat = calls[0];
      expect(beat?.values).toMatchObject({
        leased_by: OWNER,
        lease_expires_at: iso(120_000),
      });
      expect(beat?.eqCalls).toContainEqual(['status', 'running']);
      expect(beat?.eqCalls).toContainEqual(['leased_by', OWNER]);
    });

    it('reports the lease lost when somebody else now holds the job', async () => {
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: null, error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.heartbeat('job-1')).resolves.toBe(false);
    });
  });

  describe('reconcileStaleLeases', () => {
    it('re-queues a build abandoned by a worker that stopped', async () => {
      const row = leasedRow();
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: [row] }, { data: { id: row.id } }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.reconcileStaleLeases()).resolves.toEqual({
        requeued: [row.id],
        completed: [],
        abandoned: [],
      });

      const requeue = calls.find((c) => c.op === 'update');
      expect(requeue?.values).toMatchObject({
        status: 'queued',
        started_at: null,
        leased_by: null,
        lease_expires_at: null,
        error_code: 'BUILD_LEASE_EXPIRED',
        // Due now: the wait already happened, as a build that ran and died.
        run_after: iso(0),
      });
      expect(requeue?.eqCalls).toContainEqual(['leased_by', 'build-0:9:dead']);
    });

    it('completes a build that published before it crashed', async () => {
      const row = leasedRow({
        payload: {
          commitSha: 'abc123',
          pullRequestUrl: 'https://github.com/o/r/pull/7',
          stagingUrl: 'https://x.staging.flowstarter.dev',
        },
      });
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: [row] },
          { data: { payload: row.payload } },
          { data: { workspace_id: WORKSPACE_ID } },
        ],
        workspaces: [{ data: null, error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.reconcileStaleLeases()).resolves.toEqual({
        requeued: [],
        completed: [row.id],
        abandoned: [],
      });
    });

    it('fails a build with no attempts left rather than looping on it', async () => {
      const row = leasedRow({ attempt_count: 3 });
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: [row] },
          { data: { workspace_id: WORKSPACE_ID } },
        ],
        workspaces: [{ data: null, error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.reconcileStaleLeases()).resolves.toEqual({
        requeued: [],
        completed: [],
        abandoned: [row.id],
      });
      const failure = calls.find((c) => c.op === 'update');
      expect(failure?.values).toMatchObject({
        status: 'failed',
        error_code: 'BUILD_LEASE_EXPIRED',
      });
    });

    it('leaves a build whose worker is still checking in', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: [leasedRow({ lease_expires_at: iso(60_000) })] },
        ],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.reconcileStaleLeases()).resolves.toEqual({
        requeued: [],
        completed: [],
        abandoned: [],
      });
      expect(calls.filter((c) => c.op === 'update')).toHaveLength(0);
    });
  });

  describe('readyForClaim, with leases', () => {
    it('hands back an abandoned build alongside the ordinary queue', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [
          {
            data: [
              ledgerRow({ id: 'queued-1' }),
              // Somebody else is genuinely running this one.
              leasedRow({ id: 'held-1', lease_expires_at: iso(60_000) }),
              // Nobody is running this one any more.
              leasedRow({ id: 'abandoned-1' }),
              // A retry whose backoff has elapsed, and one whose has not.
              ledgerRow({
                id: 'retry-1',
                status: 'failed',
                attempt_count: 1,
                run_after: iso(-1),
              }),
              ledgerRow({
                id: 'backing-off-1',
                status: 'failed',
                attempt_count: 1,
                run_after: iso(60_000),
              }),
              // Not ours to run.
              ledgerRow({ id: 'inline-1', kind: 'INLINE_EDIT' }),
              // Out of attempts.
              ledgerRow({ id: 'spent-1', status: 'failed', attempt_count: 3 }),
            ],
          },
        ],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.readyForClaim(50)).resolves.toEqual([
        'queued-1',
        'abandoned-1',
        'retry-1',
      ]);
      // The sweep asks for the four statuses a worker may take something from;
      // which of them it actually may is `claimVerdict`'s answer, not a second
      // copy of the rule written into the query.
      expect(calls[0]?.eqCalls).toContainEqual([
        'status',
        ['queued', 'failed', 'running', 'waiting_brief'],
      ]);
      // A recovered row is handed over as it is. Promoting it to `queued` here
      // would throw away the lease that lets claim() tell a dead holder from a
      // live one, and the payload check that stops a second publish.
      expect(calls.filter((c) => c.op === 'update')).toHaveLength(0);
    });

    it('leaves a build parked on its brief to the brief gate, not to the lease rule', async () => {
      const { client } = makeScriptedClient({
        flowstarter_agent_jobs: [
          { data: [ledgerRow({ id: 'parked-1', status: 'waiting_brief' })] },
        ],
        // The client has still not finished it.
        workspace_briefs: [{ data: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await expect(store.readyForClaim(50)).resolves.toEqual([]);
    });
  });

  describe('markFailed', () => {
    it('records the backoff on the row and drops the lease', async () => {
      const { client, calls } = makeScriptedClient({
        flowstarter_agent_jobs: [{ data: { workspace_id: WORKSPACE_ID } }],
        workspaces: [{ data: null, error: null }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await store.markFailed('job-1', { code: 'BUILD_FAILED', detail: 'boom' });

      expect(calls[0]?.values).toMatchObject({
        status: 'failed',
        leased_by: null,
        lease_expires_at: null,
        // First attempt: one base interval, written where a restart can read it.
        run_after: iso(30_000),
      });
    });

    it('backs off further on a later attempt', async () => {
      const row = ledgerRow({ status: 'failed', attempt_count: 1 });
      const { client, calls } = makeScriptedClient({
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
          { data: null, error: null },
        ],
        flowstarter_project_artifacts: [{ data: artifacts() }],
      });
      const store = new SupabaseFullSiteBuildJobStore(client, options);

      await store.claim(row.id);
      await store.markFailed(row.id, { code: 'BUILD_FAILED', detail: 'boom' });

      const failure = calls
        .filter(
          (c) => c.table === 'flowstarter_agent_jobs' && c.op === 'update',
        )
        .at(-1);
      // Second attempt: two base intervals.
      expect(failure?.values).toMatchObject({ run_after: iso(60_000) });
    });
  });
});
