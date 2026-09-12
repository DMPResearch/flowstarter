// @vitest-environment node
/**
 * The operator override, through the real handler.
 *
 * This route is the only way a site is built from an incomplete brief, which
 * makes it the one place where the gate the build worker enforces can be
 * waived. Two things therefore have to be true of it and are asserted below:
 * a caller who is not an operator cannot reach it at all, not even for a
 * workspace that is not yours to operate and especially not for one that is;
 * and an override that does land is attributable, with a reason, an actor and
 * a row on the audit trail.
 *
 * The refusals reuse the shared operator cases, so this route cannot drift
 * from the rest of the `/api/admin/projects/[id]` tree, and they assert the
 * negative that matters: not one table is touched on the way to the refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as OVERRIDE_BRIEF } from '../route';
import {
  expectRejectsForeignWorkspace,
  expectRejectsSignedOut,
  type RouteCase,
} from '../../../../../../__tests__/operator-route-cases';

vi.mock('server-only', () => ({}));

/**
 * The build the override exists to start.
 *
 * An override that only writes a timestamp is the psql UPDATE this endpoint
 * was built to replace: `override_at` is one of the two conditions the
 * worker's claim reads, so the moment it is written the parked job may run,
 * and something has to say so. The state machine itself is pinned in
 * `lib/flowstarter/__tests__/brief-build-dispatch.test.ts`; what is defended
 * here is that this route calls it, after the write and never instead of it.
 */
const enqueueOnReady = vi.hoisted(() =>
  vi.fn(async () => ({
    outcome: 'resumed' as const,
    jobId: 'job-1',
    reason: '',
  }))
);
vi.mock('@/lib/flowstarter/deposit-workflow', () => ({
  enqueueBuildOnBriefReady: enqueueOnReady,
}));

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const OPERATOR = 'user_team_1';

const authState: { userId: string | null; role: string | undefined } = {
  userId: OPERATOR,
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

// ───────────────────────────────────────────────────────────────────────────
// The double
// ───────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * Records every table a handler touched, like `recording-supabase.ts`, and
 * additionally keeps what was written: the refusal cases need the first, the
 * happy path needs the second, and one double for both keeps the mock of
 * `@/supabase-clients/server` singular, which `vi.mock` hoisting requires.
 */
function createDb() {
  const tables: string[] = [];
  const writes: Array<{ table: string; op: string; values: unknown }> = [];
  const rows: Record<string, Row[]> = {};
  const failing = new Set<string>();

  function builder(table: string) {
    tables.push(table);
    let op = 'select';
    let values: unknown = null;

    const result = () =>
      failing.has(table)
        ? { data: null, error: { message: `fake: ${table} unavailable` } }
        : { data: rows[table] ?? [], error: null };

    const self: Record<string, unknown> = {
      select: () => self,
      eq: () => self,
      in: () => self,
      is: () => self,
      not: () => self,
      order: () => self,
      limit: () => self,
      insert(next: unknown) {
        op = 'insert';
        values = next;
        writes.push({ table, op, values });
        return self;
      },
      update(next: unknown) {
        op = 'update';
        values = next;
        writes.push({ table, op, values });
        return self;
      },
      upsert(next: unknown) {
        op = 'upsert';
        values = next;
        writes.push({ table, op, values });
        return self;
      },
      maybeSingle: async () => {
        const { data, error } = result();
        return { data: (data as Row[])?.[0] ?? null, error };
      },
      single: async () => {
        const { data, error } = result();
        return { data: (data as Row[])?.[0] ?? null, error };
      },
      then(
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) {
        return Promise.resolve(result()).then(onFulfilled, onRejected);
      },
    };
    return self;
  }

  return {
    tables,
    writes,
    rows,
    failing,
    seed(table: string, seedRows: Row[]) {
      rows[table] = seedRows;
    },
    reset() {
      tables.length = 0;
      writes.length = 0;
      failing.clear();
      for (const key of Object.keys(rows)) delete rows[key];
    },
    client: {
      from: builder,
      storage: {
        from: () => ({
          async createSignedUrl(path: string) {
            return {
              data: { signedUrl: `https://signed.test/${path}` },
              error: null,
            };
          },
        }),
      },
    } as unknown as never,
  };
}

const db = createDb();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
  createSupabaseServerClient: () => db.client,
}));

function post(body?: unknown, id: string = WORKSPACE): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/projects/${id}/brief/override`,
    {
      method: 'POST',
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
          }),
    }
  );
}

const ctx = (id: string = WORKSPACE) => ({ params: Promise.resolve({ id }) });

function call(body?: unknown, id?: string): Promise<Response> {
  return OVERRIDE_BRIEF(
    post(body, id),
    ctx(id)
  ) as unknown as Promise<Response>;
}

const cases: RouteCase[] = [
  [
    'POST brief override',
    () => call({ reason: 'Client sent everything by email' }),
  ],
];

beforeEach(() => {
  db.reset();
  enqueueOnReady.mockClear();
  authState.userId = OPERATOR;
  authState.role = 'team';
  db.seed('workspaces', [{ id: WORKSPACE, project_state: 'DEPOSIT_PAID' }]);
});

describe('a workspace that is not yours to operate', () => {
  it('refuses a signed-out caller, without reading a row', async () => {
    await expectRejectsSignedOut(cases, db, authState);
  });

  it('refuses a signed-in client who is a member of the workspace', async () => {
    // Membership opens the client's editor. It must not open the surface that
    // waives the gate on their own build.
    await expectRejectsForeignWorkspace(cases, db, authState);
  });
});

describe('POST /api/admin/projects/[id]/brief/override', () => {
  it('refuses a workspace id that is not a uuid, before any query', async () => {
    const response = await call({ reason: 'Anything' }, 'not-a-uuid');
    expect(response.status).toBe(400);
    expect(db.tables).toEqual([]);
  });

  it('refuses an override with no reason', async () => {
    // The reason is the entire difference between this endpoint and somebody
    // editing a timestamp by hand.
    const response = await call({});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_BODY' });
    expect(db.tables).toEqual([]);
  });

  it('refuses a reason that is not a sentence', async () => {
    expect((await call({ reason: 'ok' })).status).toBe(400);
  });

  it('refuses a body that is not json at all', async () => {
    const request = new NextRequest(
      `http://localhost/api/admin/projects/${WORKSPACE}/brief/override`,
      {
        method: 'POST',
        body: 'not json',
        headers: { 'Content-Type': 'application/json' },
      }
    );
    const response = (await OVERRIDE_BRIEF(
      request,
      ctx()
    )) as unknown as Response;
    expect(response.status).toBe(400);
  });

  it('404s for a workspace that does not exist', async () => {
    db.seed('workspaces', []);
    const response = await call({ reason: 'Client sent everything by email' });
    expect(response.status).toBe(404);
    expect(db.writes).toEqual([]);
  });

  it('writes the override and the audit event, and answers with the readiness it waived', async () => {
    const response = await call({
      reason: 'Client sent the offer and two projects by email on 11 Sep',
    });
    expect(response.status).toBe(200);

    const brief = db.writes.find((write) => write.table === 'workspace_briefs');
    expect(brief?.op).toBe('upsert');
    expect(brief?.values).toMatchObject({
      // withTenant pins the tenant on the row itself, so the upsert cannot
      // land on another workspace's brief.
      workspace_id: WORKSPACE,
      override_by: OPERATOR,
    });
    expect(typeof (brief?.values as { override_at: string }).override_at).toBe(
      'string'
    );

    const event = db.writes.find((write) => write.table === 'project_events');
    expect(event?.op).toBe('insert');
    expect(event?.values).toMatchObject({
      workspace_id: WORKSPACE,
      kind: 'brief_override',
      actor: OPERATOR,
    });
    expect(
      (event?.values as { payload: { reason: string } }).payload.reason
    ).toBe('Client sent the offer and two projects by email on 11 Sep');

    const body = (await response.json()) as {
      override: { at: string; by: string; reason: string };
      readiness: { ready: boolean; missing: Array<{ code: string }> };
    };
    expect(body.override.by).toBe(OPERATOR);
    // The brief really is incomplete: the answer says exactly what was waived,
    // which is the point of returning it rather than an empty 204.
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.missing.map((entry) => entry.code)).toContain(
      'brief_offer_missing'
    );
  });

  it('starts the parked build, and says which job it let out', async () => {
    const response = await call({
      reason: 'Client sent the offer and two projects by email on 11 Sep',
    });
    expect(response.status).toBe(200);
    expect(enqueueOnReady).toHaveBeenCalledTimes(1);
    expect(enqueueOnReady).toHaveBeenCalledWith({ workspaceId: WORKSPACE });

    const body = (await response.json()) as {
      build: { outcome: string; jobId: string | null };
    };
    expect(body.build).toEqual({
      outcome: 'resumed',
      jobId: 'job-1',
      reason: '',
    });
  });

  it('refuses before it starts anything when the workspace does not exist', async () => {
    db.seed('workspaces', []);
    const response = await call({ reason: 'Client sent everything by email' });
    expect(response.status).toBe(404);
    expect(enqueueOnReady).not.toHaveBeenCalled();
  });

  it('still overrides when the audit event cannot be written', async () => {
    // The override has already landed by then. Reporting a failure would send
    // an operator back to psql, which is the outcome this route exists to
    // prevent.
    db.failing.add('project_events');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await call({ reason: 'Client is on holiday, build it' });
    expect(response.status).toBe(200);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('reports a database failure as a 500 rather than a silent success', async () => {
    db.failing.add('workspace_briefs');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await call({ reason: 'Client sent everything by email' });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'DB_ERROR' });
    errors.mockRestore();
  });
});
