/**
 * The operator review board: `listPolicyReviewsHandler` and
 * `resolvePolicyReviewHandler` from `@/lib/policy/review-api`.
 *
 * A `review` verdict is a hold, not a rejection, and this is the only place a
 * human lifts one. What matters here is not the classifier (mocked out of
 * every other suite in this policy package) but the board itself: only an
 * operator may read or resolve one, an approval needs a real note, and
 * approving a brief's hold is the step that starts the build the save never
 * did (see the block comment at the top of `review-api.ts` about the four
 * paid builds PR #119 lost).
 *
 * The Supabase client is a small chainable, thenable in-memory double, in the
 * same style as `claim-route.test.ts`'s `builderFor`, extended with
 * `order`/`limit`/`update` because the board's list and resolve queries use
 * both.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));

// ── requireTeamAuth: mocked directly, so this suite is about the board, not
// about Clerk. Every case sets `authState` before calling a handler.
const authState: {
  result:
    | { authorized: true; userId: string }
    | { authorized: false; response: NextResponse };
} = { result: { authorized: true, userId: 'user_operator' } };

vi.mock('@/lib/api-auth', () => ({
  requireTeamAuth: async () => authState.result,
}));

// ── The build nudge an approval on a `brief` hold fires. Its own behaviour
// has its own suite (deposit-workflow.test.ts); here only the fact that it
// was, or was not, called is under test.
const enqueueBuildOnBriefReady = vi.fn(async () => ({
  outcome: 'queued' as const,
  jobId: 'job-1',
}));
vi.mock('@/lib/flowstarter/deposit-workflow', () => ({
  enqueueBuildOnBriefReady: (...args: unknown[]) =>
    enqueueBuildOnBriefReady(...(args as [])),
}));

// ── A small chainable, thenable Postgrest-style double over three in-memory
// tables: `policy_reviews`, `project_events`, `workspaces`. Tables are
// created lazily so a test never has to declare one it does not touch.

interface Row {
  [column: string]: unknown;
}

const db: Record<string, Row[]> = {};
const failing = new Set<string>();
let seq = 0;

function rows(table: string): Row[] {
  return (db[table] ??= []);
}

function resetDb(): void {
  for (const key of Object.keys(db)) delete db[key];
  failing.clear();
  seq = 0;
}

function builderFor(table: string) {
  const filters: Array<[string, unknown]> = [];
  let mode: 'select' | 'insert' | 'update' = 'select';
  let payload: Row | null = null;
  let orderColumn: string | undefined;
  let ascending = true;
  let limitCount: number | undefined;

  function matches(row: Row): boolean {
    return filters.every(([column, value]) => row[column] === value);
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
    if (limitCount !== undefined) out = out.slice(0, limitCount);
    return out;
  }

  function resolve(): {
    data: Row[] | null;
    error: { code?: string; message: string } | null;
  } {
    if (failing.has(table)) {
      return { data: null, error: { message: `fake: ${table} unavailable` } };
    }
    if (mode === 'insert' && payload) {
      seq += 1;
      const row: Row = {
        id: `row-${seq}`,
        created_at: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
        ...payload,
      };
      rows(table).push(row);
      return { data: [row], error: null };
    }
    if (mode === 'update' && payload) {
      const target = selected();
      for (const row of target) Object.assign(row, payload);
      return { data: target, error: null };
    }
    return { data: selected(), error: null };
  }

  const builder = {
    select() {
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }) {
      orderColumn = column;
      ascending = options?.ascending !== false;
      return builder;
    },
    limit(count: number) {
      limitCount = count;
      return builder;
    },
    insert(values: Row) {
      mode = 'insert';
      payload = values;
      return builder;
    },
    update(values: Row) {
      mode = 'update';
      payload = values;
      return builder;
    },
    async maybeSingle() {
      const result = resolve();
      if (result.error) return { data: null, error: result.error };
      return { data: result.data?.[0] ?? null, error: null };
    },
    then<T>(
      onFulfilled: (value: ReturnType<typeof resolve>) => T,
      onRejected?: (reason: unknown) => T
    ) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builderFor }),
}));

import {
  listPolicyReviewsHandler,
  resolvePolicyReviewHandler,
} from '../review-api';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const REVIEW_ID = '2b6f1d4a-9c3e-4b21-8f77-5a1c2d3e4f61';
const REAL_NOTE = 'Checked the pharmacy licence number on the register.';

function ctx(id = WORKSPACE_ID) {
  return { params: Promise.resolve({ id }) };
}
function post(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}
const getReq = {} as NextRequest;

function seedReview(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: REVIEW_ID,
    workspace_id: WORKSPACE_ID,
    surface: 'brief',
    decision: 'review',
    category_id: 'licensed_pharmacy',
    confidence: 0.62,
    rule: 'sensitive_lawful',
    tier: 'llm',
    prompt_version: 'test',
    evidence_hash: 'hash-abc',
    evidence: 'mentions a pharmacy licence',
    status: 'open',
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    created_at: '2026-09-10T09:00:00.000Z',
    ...overrides,
  };
  rows('policy_reviews').push(row);
  return row;
}

beforeEach(() => {
  resetDb();
  authState.result = { authorized: true, userId: 'user_operator' };
  enqueueBuildOnBriefReady.mockClear();
  enqueueBuildOnBriefReady.mockResolvedValue({
    outcome: 'queued',
    jobId: 'job-1',
  });
});

describe('who may read or resolve the board', () => {
  it('refuses a caller requireTeamAuth does not authorize', async () => {
    authState.result = {
      authorized: false,
      response: NextResponse.json(
        { error: 'Not a team member' },
        { status: 403 }
      ),
    };
    seedReview();

    const listRes = await listPolicyReviewsHandler(getReq, ctx());
    expect(listRes.status).toBe(403);

    const resolveRes = await resolvePolicyReviewHandler(
      post({ reviewId: REVIEW_ID, decision: 'approve', note: REAL_NOTE }),
      ctx()
    );
    expect(resolveRes.status).toBe(403);

    // Nothing moved for an operator who was never let in.
    expect(rows('policy_reviews')[0]!.status).toBe('open');
  });
});

describe('reading the board', () => {
  it('fills the policy words in from the policy module, and counts what is open', async () => {
    seedReview({ status: 'open' });
    seedReview({
      id: 'row-2',
      status: 'approved',
      resolved_by: 'user_operator',
      resolved_at: '2026-09-10T10:00:00.000Z',
      resolution_note: REAL_NOTE,
    });

    const res = await listPolicyReviewsHandler(getReq, ctx());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.reviews).toHaveLength(2);
    expect(body.openCount).toBe(1);

    const open = body.reviews.find((r: { id: string }) => r.id === REVIEW_ID);
    // The operator reads the policy's own words, not a bare category id.
    expect(open.categoryLabel).toBe('Licensed pharmacy or medicine retail');
    expect(open.categoryReason).toMatch(/licence/);
    expect(open.disposition).toBe('review');
  });
});

describe('resolving one', () => {
  it('refuses an approval with a note shorter than 10 characters', async () => {
    seedReview();

    const res = await resolvePolicyReviewHandler(
      post({ reviewId: REVIEW_ID, decision: 'approve', note: 'ok' }),
      ctx()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NOTE_REQUIRED');
    // Still open: a short note is not a decision.
    expect(rows('policy_reviews')[0]!.status).toBe('open');
  });

  it('approves with a real note, writes the event, and starts the brief’s build', async () => {
    seedReview({ surface: 'brief' });

    const res = await resolvePolicyReviewHandler(
      post({ reviewId: REVIEW_ID, decision: 'approve', note: REAL_NOTE }),
      ctx()
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.review.status).toBe('approved');
    expect(rows('policy_reviews')[0]!.resolution_note).toBe(REAL_NOTE);
    expect(rows('policy_reviews')[0]!.resolved_by).toBe('user_operator');

    expect(
      rows('project_events').some(
        (row) => row.kind === 'policy_review_approved'
      )
    ).toBe(true);

    // The hold on a paid brief does not just flip a status; it is what was
    // supposed to start the build the save never did.
    expect(enqueueBuildOnBriefReady).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
    });
    expect(body.build).toEqual({ outcome: 'queued', jobId: 'job-1' });
  });

  it('does not nudge a build for a hold on a surface other than the brief', async () => {
    seedReview({ surface: 'change_request' });

    const res = await resolvePolicyReviewHandler(
      post({ reviewId: REVIEW_ID, decision: 'approve', note: REAL_NOTE }),
      ctx()
    );
    expect(res.status).toBe(200);
    expect(enqueueBuildOnBriefReady).not.toHaveBeenCalled();
  });

  it('refuses, and writes the refusal event', async () => {
    seedReview();

    const res = await resolvePolicyReviewHandler(
      post({ reviewId: REVIEW_ID, decision: 'refuse' }),
      ctx()
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.review.status).toBe('refused');
    expect(rows('policy_reviews')[0]!.status).toBe('refused');
    expect(
      rows('project_events').some((row) => row.kind === 'policy_review_refused')
    ).toBe(true);
    // A refusal never starts a build.
    expect(enqueueBuildOnBriefReady).not.toHaveBeenCalled();
  });

  it('answers 409 on a review that is not open any more', async () => {
    seedReview({ status: 'approved' });

    const res = await resolvePolicyReviewHandler(
      post({ reviewId: REVIEW_ID, decision: 'approve', note: REAL_NOTE }),
      ctx()
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('POLICY_REVIEW_STALE');
  });
});
