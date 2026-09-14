// @vitest-environment node
/**
 * The acceptable-use gate on the brief route.
 *
 * The four quick questions before the preview describe a business in a
 * sentence; the brief is where the client writes what they actually sell,
 * and it is the only place a clean intake can turn into a prohibited offer.
 * By the time a brief is saved a deposit has already changed hands, so this
 * surface passes `refusalBecomesReview: true` to the gate: a refuse verdict
 * is reported to the client as the REVIEW notice, never the refusal one, and
 * the build is held for a person rather than slammed shut on paid work.
 *
 * The brief itself is always saved -- losing the client's own writing would
 * be a second injury. What stops is the build: `enqueueBuildOnBriefReady`
 * must not be called, and the workspace is parked at
 * `concierge_stage: 'internal_review'` so an operator finds it on the board
 * they already look at.
 *
 * The classifier is mocked (there is no matcher, only a model behind
 * classifyAcceptableUse); the rule layer is real. The Clerk and in-memory
 * Supabase preamble is copied from the sibling `brief-route.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PUT } from '../route';

vi.mock('server-only', () => ({}));

const enqueueOnReady = vi.hoisted(() =>
  vi.fn(async () => ({
    outcome: 'enqueued' as const,
    jobId: 'job-1',
    reason: '',
  }))
);
vi.mock('@/lib/flowstarter/deposit-workflow', () => ({
  enqueueBuildOnBriefReady: enqueueOnReady,
}));

// ── The acceptable-use gate ──────────────────────────────────────────────
// Mocked at the classifier, not at a matcher: there is no matcher, only a
// model behind classifyAcceptableUse. The rule layer is real.
const classify = vi.hoisted(() => vi.fn());
vi.mock('@/lib/policy/classifier', () => ({
  classifyAcceptableUse: classify,
  clearAcceptableUseCache: vi.fn(),
  evidenceHashOf: (t: string) => 'hash-' + t.length,
}));

vi.mock('@/lib/policy/review', () => ({
  recordPolicyOutcome: vi.fn(async () => ({
    reviewId: 'rev-1',
    recorded: true,
  })),
}));

function classification(
  overrides: Partial<Parameters<typeof classify>[0]> = {}
) {
  return {
    categoryId: 'none',
    confidence: 0.95,
    evidence: 'Nothing notable.',
    needsHuman: false,
    tier: 'llm' as const,
    evidenceHash: 'abc123',
    promptVersion: 'test',
    costEstimateUsd: null,
    model: null,
    cached: false,
    ...overrides,
  };
}

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

/** Long enough to clear MIN_OFFER_CHARS with room to spare. */
const GOOD_OFFER =
  'We fit and service gas boilers for homes across the county, and we take on ' +
  'the emergency call-outs nobody else will.';

// ── Clerk ──────────────────────────────────────────────────────────────────
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

// ── The database ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface QueryFailure {
  table: string;
  mode?: 'select' | 'insert' | 'update' | 'upsert';
  error?: unknown;
  throws?: unknown;
  skip?: number;
}

const tables: Record<string, Row[]> = {};
const failures: QueryFailure[] = [];
const signed: string[] = [];
let signFailure = false;

function rows(table: string): Row[] {
  return (tables[table] ??= []);
}

function takeFailure(
  table: string,
  mode: 'select' | 'insert' | 'update' | 'upsert'
): QueryFailure | undefined {
  const index = failures.findIndex(
    (failure) =>
      failure.table === table && (!failure.mode || failure.mode === mode)
  );
  if (index < 0) return undefined;
  const failure = failures[index] as QueryFailure;
  if (failure.skip && failure.skip > 0) {
    failure.skip -= 1;
    return undefined;
  }
  failures.splice(index, 1);
  return failure;
}

function builder(table: string) {
  let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select';
  const filters: Array<[string, unknown]> = [];
  const inFilters: Array<[string, unknown[]]> = [];
  let payload: Row[] = [];
  let orderColumn: string | undefined;
  let ascending = true;
  let limit: number | undefined;

  function matches(row: Row): boolean {
    return (
      filters.every(([column, value]) => row[column] === value) &&
      inFilters.every(([column, values]) => values.includes(row[column]))
    );
  }

  function selected(): Row[] {
    let out = rows(table).filter(matches);
    if (orderColumn) {
      const column = orderColumn;
      out = [...out].sort((a, b) => {
        const left = String(a[column] ?? '');
        const right = String(b[column] ?? '');
        return (
          (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1)
        );
      });
    }
    if (limit !== undefined) out = out.slice(0, limit);
    return out;
  }

  function resolve(): { data: Row[] | null; error: unknown } {
    const failure = takeFailure(table, mode);
    if (failure) {
      if ('throws' in failure) throw failure.throws;
      return { data: null, error: failure.error ?? null };
    }
    if (mode === 'insert') {
      const inserted = payload.map((values, index) => ({
        id: `${table}-${rows(table).length + index}`,
        created_at: new Date(1_700_000_000_000).toISOString(),
        ...values,
      }));
      rows(table).push(...inserted);
      return { data: inserted, error: null };
    }
    if (mode === 'upsert') {
      for (const values of payload) {
        const existing = rows(table).find(
          (row) => row.workspace_id === values.workspace_id
        );
        if (existing) Object.assign(existing, values);
        else rows(table).push({ ...values });
      }
      return { data: payload, error: null };
    }
    if (mode === 'update') {
      const target = rows(table).filter(matches);
      for (const row of target) Object.assign(row, payload[0]);
      return { data: target, error: null };
    }
    return { data: selected(), error: null };
  }

  const self = {
    select() {
      return self;
    },
    insert(values: Row | Row[]) {
      mode = 'insert';
      payload = Array.isArray(values) ? values : [values];
      return self;
    },
    upsert(values: Row | Row[]) {
      mode = 'upsert';
      payload = Array.isArray(values) ? values : [values];
      return self;
    },
    update(values: Row) {
      mode = 'update';
      payload = [values];
      return self;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return self;
    },
    in(column: string, values: unknown[]) {
      inFilters.push([column, values]);
      return self;
    },
    order(column: string, options?: { ascending?: boolean }) {
      orderColumn = column;
      ascending = options?.ascending !== false;
      return self;
    },
    limit(count: number) {
      limit = count;
      return self;
    },
    maybeSingle() {
      const { data, error } = resolve();
      return Promise.resolve({ data: data?.[0] ?? null, error });
    },
    then(
      onFulfilled: (value: { data: Row[] | null; error: unknown }) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };
  return self;
}

const storage = {
  from(bucket: string) {
    return {
      async createSignedUrl(path: string, ttl: number) {
        signed.push(path);
        if (signFailure) return { data: null, error: { message: 'no' } };
        return {
          data: {
            signedUrl: `https://storage.test/${bucket}/${path}?t=${ttl}`,
          },
          error: null,
        };
      },
    };
  },
};

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builder, storage }),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

function body(overrides: Record<string, unknown> = {}) {
  return {
    offer: GOOD_OFFER,
    projects: [],
    noProjects: true,
    designReferenceAssetIds: [],
    photoAssetIds: [],
    ...overrides,
  };
}

function putRequest(payload: unknown): NextRequest {
  return new NextRequest('https://app.test/api/client/brief/x', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function callPut(workspaceId: string, payload: unknown) {
  return PUT(putRequest(payload), {
    params: Promise.resolve({ workspaceId }),
  });
}

function savedBrief(): Row | undefined {
  return rows('workspace_briefs').find(
    (row) => row.workspace_id === WORKSPACE_A
  );
}

function workspaceRow(): Row | undefined {
  return rows('workspaces').find((row) => row.id === WORKSPACE_A);
}

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  failures.length = 0;
  signed.length = 0;
  signFailure = false;
  authState.userId = 'user_client_a';
  authState.role = undefined;
  rows('workspace_memberships').push({
    workspace_id: WORKSPACE_A,
    clerk_user_id: 'user_client_a',
  });
  rows('workspaces').push({ id: WORKSPACE_A, concierge_stage: 'active' });
  classify.mockReset();
  enqueueOnReady.mockClear();
});

describe('PUT /api/client/brief/[workspaceId] — acceptable-use gate', () => {
  it('saves the brief, reports the review notice (not a refusal), and does not dispatch the build', async () => {
    // Post-deposit surface: refusalBecomesReview is true here, so even a
    // confident prohibited match is reported as a review, never a refusal.
    classify.mockResolvedValue(
      classification({ categoryId: 'illegal_drugs', confidence: 0.95 })
    );

    const response = await callPut(WORKSPACE_A, body());
    const payload = await response.json();

    expect(response.status).toBe(200);
    // The client's own words are saved either way -- losing them would be a
    // second injury.
    expect(savedBrief()?.offer).toBe(GOOD_OFFER);
    expect(payload.policy).toBeTruthy();
    expect(payload.policy.decision).toBe('review');
    // The property under test: money and writing are kept, the build is not.
    expect(enqueueOnReady).not.toHaveBeenCalled();
    expect(payload.build).toBeUndefined();
  });

  it('parks the workspace for an operator to look at', async () => {
    classify.mockResolvedValue(
      classification({ categoryId: 'illegal_drugs', confidence: 0.95 })
    );

    await callPut(WORKSPACE_A, body());

    expect(workspaceRow()?.concierge_stage).toBe('internal_review');
  });

  it('dispatches the build for a clean, ready brief', async () => {
    classify.mockResolvedValue(
      classification({ categoryId: 'none', confidence: 0.95 })
    );

    const response = await callPut(WORKSPACE_A, body());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.policy).toBeUndefined();
    expect(enqueueOnReady).toHaveBeenCalledTimes(1);
    expect(enqueueOnReady).toHaveBeenCalledWith({ workspaceId: WORKSPACE_A });
    expect(payload.build).toEqual({ outcome: 'enqueued', jobId: 'job-1' });
    expect(workspaceRow()?.concierge_stage).toBe('active');
  });
});
