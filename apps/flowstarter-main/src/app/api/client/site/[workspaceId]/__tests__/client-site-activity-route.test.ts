// @vitest-environment node
/**
 * The client's build timeline, through the REAL route handler.
 *
 * Four things are defended here:
 *
 *  1. TENANCY. The handler queries with the service role, which bypasses RLS,
 *     so `requireWorkspaceAccess` running first is the entire boundary. The
 *     cross-tenant case asserts the 404 *and* that no job or event row was
 *     read: a 404 that still listed another tenant's build would be a green
 *     test and a live leak. Both queries are also asserted to carry a
 *     `workspace_id` filter of their own, the discipline the worker's static
 *     guard enforces on the other side of the same tables.
 *  2. WHAT REACHES A CLIENT. `detail` carries file paths and raw gate
 *     verdicts. It is stripped on the way out, and the assertion is on the
 *     serialized body rather than on an object, because the body is what
 *     actually travels.
 *  3. WHAT IS NOT INVENTED. A row whose payload is missing, malformed or
 *     wearing a subject the closed set does not know is dropped, never
 *     repaired -- a repaired event is an invented step.
 *  4. NO NEWS IS NOT AN ERROR. A workspace with no job at all answers 200 with
 *     an empty finished timeline, because the dashboard polls this every five
 *     seconds and a 404 would read as a broken page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Static import: vi.mock is hoisted above it, and the app's tsconfig does not
// allow top-level await in tests.
import { GET } from '../activity/route';
import {
  createFakeSupabase,
  type Row,
} from '@/lib/flowstarter/__tests__/fake-supabase';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';

// ── Clerk ──────────────────────────────────────────────────────────────────
// Mirrors src/lib/__tests__/workspace-access.test.ts.
const authState: { userId: string | null; role: string | undefined } = {
  userId: 'user_client_a',
  role: undefined,
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

const db = createFakeSupabase();

/**
 * The same fake, with every `.eq()` written down. Behaviour alone can show
 * that another tenant's rows did not come back; only the filter list can show
 * *why* -- that the statement asked the database, rather than the route
 * filtering in memory after reading the lot.
 */
interface QueryRecord {
  table: string;
  filters: Array<[unknown, unknown]>;
}
const queries: QueryRecord[] = [];

function recording(table: string): unknown {
  const entry: QueryRecord = { table, filters: [] };
  queries.push(entry);
  const builder = db.client.from(table) as Record<string, unknown>;
  const wrapper: unknown = new Proxy(builder, {
    get(target, property) {
      const value = (target as Record<string | symbol, unknown>)[property];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (property === 'eq') entry.filters.push([args[0], args[1]]);
        const result = (value as (...a: unknown[]) => unknown).apply(
          target,
          args
        );
        // The fake returns its own `self` for every chainable call; hand back
        // the proxy instead so the recording survives the whole chain.
        return result === target ? wrapper : result;
      };
    },
  });
  return wrapper;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: recording }),
}));

const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_A_OLD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function request(workspaceId: string) {
  return new Request(
    `http://localhost/api/client/site/${workspaceId}/activity`
  );
}

function params(workspaceId: string) {
  return { params: Promise.resolve({ workspaceId }) };
}

function job(
  id: string,
  workspaceId: string,
  status: string,
  createdAt: string
): Row {
  return {
    id,
    workspace_id: workspaceId,
    kind: 'FULL_SITE_BUILD',
    status,
    created_at: createdAt,
  };
}

function activityRow(
  jobId: string,
  workspaceId: string,
  createdAt: string,
  activity: unknown
): Row {
  return {
    id: `${jobId}-${createdAt}`,
    job_id: jobId,
    workspace_id: workspaceId,
    kind: 'activity',
    actor: 'system',
    body: 'build',
    payload: { activity },
    created_at: createdAt,
  };
}

/** A well-formed event, with the operator-only `detail` filled in. */
function event(overrides: Record<string, unknown> = {}) {
  return {
    at: '2026-09-14T10:00:00.000Z',
    phase: 'build',
    kind: 'editing',
    subject: 'section.services',
    detail: 'src/components/Services.astro',
    ...overrides,
  };
}

function filtersFor(table: string): Array<[unknown, unknown]> {
  return queries
    .filter((entry) => entry.table === table)
    .flatMap((entry) => entry.filters);
}

beforeEach(() => {
  db.reset();
  queries.length = 0;
  authState.userId = 'user_client_a';
  authState.role = undefined;
  db.seed('workspace_memberships', [
    { workspace_id: WORKSPACE_A, clerk_user_id: 'user_client_a' },
    { workspace_id: WORKSPACE_B, clerk_user_id: 'user_client_b' },
  ]);
});

describe('GET /api/client/site/[workspaceId]/activity', () => {
  it('refuses a signed-out caller and reads nothing', async () => {
    authState.userId = null;

    const res = await GET(request(WORKSPACE_A), params(WORKSPACE_A));

    expect(res.status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it('refuses a malformed workspace id before any query runs', async () => {
    const res = await GET(request('not-a-uuid'), params('not-a-uuid'));

    expect(res.status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it("404s another tenant's workspace without reading its build", async () => {
    db.seed('flowstarter_agent_jobs', [
      job(JOB_B, WORKSPACE_B, 'running', '2026-09-14T09:00:00.000Z'),
    ]);
    db.seed('flowstarter_agent_job_events', [
      activityRow(JOB_B, WORKSPACE_B, '2026-09-14T09:01:00.000Z', event()),
    ]);

    const res = await GET(request(WORKSPACE_B), params(WORKSPACE_B));

    expect(res.status).toBe(404);
    // The membership lookup is the only statement allowed to have run.
    expect(queries.map((entry) => entry.table)).toEqual([
      'workspace_memberships',
    ]);
  });

  it('returns the newest job of THIS workspace, oldest step first', async () => {
    db.seed('flowstarter_agent_jobs', [
      job(JOB_A_OLD, WORKSPACE_A, 'succeeded', '2026-09-13T09:00:00.000Z'),
      job(JOB_A, WORKSPACE_A, 'running', '2026-09-14T09:00:00.000Z'),
      job(JOB_B, WORKSPACE_B, 'running', '2026-09-14T23:00:00.000Z'),
    ]);
    db.seed('flowstarter_agent_job_events', [
      activityRow(
        JOB_A,
        WORKSPACE_A,
        '2026-09-14T09:02:00.000Z',
        event({ kind: 'checking', subject: 'gate.links', detail: undefined })
      ),
      activityRow(
        JOB_A,
        WORKSPACE_A,
        '2026-09-14T09:01:00.000Z',
        event({ subject: 'page.home' })
      ),
      // The previous build of the same workspace, and another tenant's build.
      // Neither belongs on this timeline.
      activityRow(
        JOB_A_OLD,
        WORKSPACE_A,
        '2026-09-13T09:01:00.000Z',
        event({ subject: 'page.about' })
      ),
      activityRow(
        JOB_B,
        WORKSPACE_B,
        '2026-09-14T23:01:00.000Z',
        event({ subject: 'page.pricing' })
      ),
    ]);

    const res = await GET(request(WORKSPACE_A), params(WORKSPACE_A));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(body.status).toBe('running');
    expect(body.events.map((e: { subject: string }) => e.subject)).toEqual([
      'page.home',
      'gate.links',
    ]);
  });

  it('filters both statements by workspace_id', async () => {
    db.seed('flowstarter_agent_jobs', [
      job(JOB_A, WORKSPACE_A, 'running', '2026-09-14T09:00:00.000Z'),
    ]);
    db.seed('flowstarter_agent_job_events', [
      activityRow(JOB_A, WORKSPACE_A, '2026-09-14T09:01:00.000Z', event()),
    ]);

    await GET(request(WORKSPACE_A), params(WORKSPACE_A));

    expect(filtersFor('flowstarter_agent_jobs')).toContainEqual([
      'workspace_id',
      WORKSPACE_A,
    ]);
    const eventFilters = filtersFor('flowstarter_agent_job_events');
    expect(eventFilters).toContainEqual(['workspace_id', WORKSPACE_A]);
    expect(eventFilters).toContainEqual(['job_id', JOB_A]);
    expect(eventFilters).toContainEqual(['kind', 'activity']);
  });

  it('never lets `detail` reach the client', async () => {
    db.seed('flowstarter_agent_jobs', [
      job(JOB_A, WORKSPACE_A, 'running', '2026-09-14T09:00:00.000Z'),
    ]);
    db.seed('flowstarter_agent_job_events', [
      activityRow(JOB_A, WORKSPACE_A, '2026-09-14T09:01:00.000Z', event()),
    ]);

    const res = await GET(request(WORKSPACE_A), params(WORKSPACE_A));
    const text = await res.text();

    // The wire, not an object: a `detail` that survived serialization is the
    // one that would reach a browser.
    expect(text).not.toContain('Services.astro');
    expect(text).not.toContain('detail');
    expect(JSON.parse(text).events[0]).toEqual({
      at: '2026-09-14T10:00:00.000Z',
      phase: 'build',
      kind: 'editing',
      subject: 'section.services',
    });
  });

  it('drops a malformed row instead of repairing it', async () => {
    db.seed('flowstarter_agent_jobs', [
      job(JOB_A, WORKSPACE_A, 'running', '2026-09-14T09:00:00.000Z'),
    ]);
    db.seed('flowstarter_agent_job_events', [
      // No payload at all.
      {
        id: 'empty',
        job_id: JOB_A,
        workspace_id: WORKSPACE_A,
        kind: 'activity',
        payload: null,
        created_at: '2026-09-14T09:00:10.000Z',
      },
      // A payload with no `activity` key.
      activityRow(JOB_A, WORKSPACE_A, '2026-09-14T09:00:20.000Z', undefined),
      // A kind the closed set does not know.
      activityRow(
        JOB_A,
        WORKSPACE_A,
        '2026-09-14T09:00:30.000Z',
        event({ kind: 'pondering' })
      ),
      // A subject the closed set does not know.
      activityRow(
        JOB_A,
        WORKSPACE_A,
        '2026-09-14T09:00:40.000Z',
        event({ subject: 'src/pages/index.astro' })
      ),
      // A string where an object belongs.
      activityRow(
        JOB_A,
        WORKSPACE_A,
        '2026-09-14T09:00:50.000Z',
        'editing the hero'
      ),
      // The one good row.
      activityRow(
        JOB_A,
        WORKSPACE_A,
        '2026-09-14T09:01:00.000Z',
        event({ subject: 'page.home' })
      ),
    ]);

    const res = await GET(request(WORKSPACE_A), params(WORKSPACE_A));
    const body = await res.json();

    expect(body.events).toHaveLength(1);
    expect(body.events[0].subject).toBe('page.home');
  });

  it('answers 200 with an empty finished timeline when there is no job', async () => {
    const res = await GET(request(WORKSPACE_A), params(WORKSPACE_A));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'done', events: [] });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    // The event query is pointless without a job and must not have run.
    expect(filtersFor('flowstarter_agent_job_events')).toEqual([]);
  });

  it.each([
    ['succeeded', 'done'],
    ['failed', 'failed'],
    ['canceled', 'failed'],
    ['queued', 'running'],
    ['running', 'running'],
  ])('reports a %s job as %s', async (jobStatus, expected) => {
    db.seed('flowstarter_agent_jobs', [
      job(JOB_A, WORKSPACE_A, jobStatus, '2026-09-14T09:00:00.000Z'),
    ]);
    db.seed('flowstarter_agent_job_events', [
      activityRow(
        JOB_A,
        WORKSPACE_A,
        '2026-09-14T09:01:00.000Z',
        event({ subject: 'page.home' })
      ),
    ]);

    const res = await GET(request(WORKSPACE_A), params(WORKSPACE_A));

    expect((await res.json()).status).toBe(expected);
  });

  it('reads a gate refusal from the steps before the ledger catches up', async () => {
    db.seed('flowstarter_agent_jobs', [
      job(JOB_A, WORKSPACE_A, 'running', '2026-09-14T09:00:00.000Z'),
    ]);
    db.seed('flowstarter_agent_job_events', [
      activityRow(
        JOB_A,
        WORKSPACE_A,
        '2026-09-14T09:01:00.000Z',
        event({ kind: 'failed', subject: 'gate.links', detail: undefined })
      ),
    ]);

    const res = await GET(request(WORKSPACE_A), params(WORKSPACE_A));

    expect((await res.json()).status).toBe('failed');
  });

  it('caps the timeline so one runaway build cannot flood a poll', async () => {
    db.seed('flowstarter_agent_jobs', [
      job(JOB_A, WORKSPACE_A, 'running', '2026-09-14T09:00:00.000Z'),
    ]);
    db.seed(
      'flowstarter_agent_job_events',
      Array.from({ length: 620 }, (_, index) =>
        activityRow(
          JOB_A,
          WORKSPACE_A,
          `2026-09-14T09:${String(index).padStart(4, '0')}`,
          event({ subject: 'page.home' })
        )
      )
    );

    const res = await GET(request(WORKSPACE_A), params(WORKSPACE_A));

    expect((await res.json()).events).toHaveLength(500);
  });

  it('lets a team member read a client workspace', async () => {
    authState.userId = 'user_operator';
    authState.role = 'team';
    db.seed('flowstarter_agent_jobs', [
      job(JOB_A, WORKSPACE_A, 'running', '2026-09-14T09:00:00.000Z'),
    ]);

    const res = await GET(request(WORKSPACE_A), params(WORKSPACE_A));

    expect(res.status).toBe(200);
    // No membership row exists for this user, so the role is what let them in.
    expect(filtersFor('workspace_memberships')).toEqual([]);
  });

  it.each(['flowstarter_agent_jobs', 'flowstarter_agent_job_events'])(
    'turns a %s read failure into a 500 without leaking it',
    async (table) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      db.seed('flowstarter_agent_jobs', [
        job(JOB_A, WORKSPACE_A, 'running', '2026-09-14T09:00:00.000Z'),
      ]);
      db.failing.add(table);

      const res = await GET(request(WORKSPACE_A), params(WORKSPACE_A));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body).toEqual({
        error: 'Something went wrong on our side.',
        code: 'INTERNAL',
      });
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    }
  );
});
