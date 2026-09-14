/**
 * The acceptable-use gate at the two change-request enforcement points.
 *
 * A change request is the surface where a site that already passed intake
 * can be asked to become something else: "add a page where people can book
 * an escort", or a clean ask an operator then quotes. Both places call
 * `screenAcceptableUse` and both are post-deposit, so `refusalBecomesReview`
 * is set: a refusal never slams the door on paid work, it holds it for a
 * person and answers 409 with the review notice, never 451.
 *
 * The classifier is mocked at its module boundary. This design has no phrase
 * matcher anywhere, so there is nothing to seed a fixture string against; the
 * only thing under test is that a route reads the verdict correctly and
 * refuses (or proceeds) before the expensive, stateful step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  CLEAN_CATEGORY_ID,
  PROHIBITED_CATEGORIES,
} from '@/lib/policy/acceptable-use';
import { createFakeSupabase } from './fake-supabase';

vi.mock('server-only', () => ({}));

// The classifier is the one seam this design has. Mocking it here, rather
// than a phrase list, is the point: nothing downstream may know what a
// prohibited category "sounds like", only what the classifier answered.
const classify = vi.hoisted(() => vi.fn());
vi.mock('@/lib/policy/classifier', () => ({
  classifyAcceptableUse: classify,
  clearAcceptableUseCache: vi.fn(),
  evidenceHashOf: (t: string) => 'hash-' + t.length,
}));

// The audit row is a side effect this suite does not assert on; keeping the
// rest of the module real (the notices, the thresholds) is what makes the
// status codes and bodies below mean anything.
vi.mock('@/lib/policy/review', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordPolicyOutcome: vi.fn(async () => ({
    reviewId: 'rev-1',
    recorded: true,
  })),
}));

// ── Clerk, for the operator quote handler ──────────────────────────────────
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

const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

// ── The client filing route's two side effects, spied so the test can prove
// a prohibited classification never reaches them. Everything else in each
// module (the real transitions, the real body formatting) stays real.
const createChangeRequest = vi.fn(async () => ({ id: 'cr-new' }));
vi.mock('@/lib/flowstarter/change-requests', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createChangeRequest: (...args: unknown[]) =>
    createChangeRequest(...(args as [])),
}));

const recordChangeRequest = vi.fn(async () => ({ messageId: 'msg-1' }));
vi.mock('@/lib/flowstarter/messaging', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordChangeRequest: (...args: unknown[]) =>
    recordChangeRequest(...(args as [])),
}));

// The workspace-access, subscription and tenancy plumbing is a different
// suite's job (client-site-routes.test.ts exercises it end to end). Here the
// context is handed over directly so this file is only about the gate.
const openSiteEditorContext = vi.fn();
vi.mock(
  '@/app/api/client/site/site-editor-context',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    openSiteEditorContext: (...args: unknown[]) =>
      openSiteEditorContext(...(args as [])),
  })
);

import { POST as escalatePOST } from '@/app/api/client/site/[workspaceId]/escalate/route';
import { quoteChangeRequestHandler } from '../change-requests-api';
import type { ChangeRequestRow } from '../change-requests';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const CHANGE_ID = '2b6f1d4a-9c3e-4b21-8f77-5a1c2d3e4f61';
const TABLE = 'flowstarter_change_requests';

const PROHIBITED_CATEGORY_ID = PROHIBITED_CATEGORIES[0]!.id;

/** The classifier's shape, defaulted clean and overridable per test. */
function classification(overrides: {
  categoryId: string;
  confidence: number;
  needsHuman?: boolean;
}) {
  return {
    categoryId: overrides.categoryId,
    confidence: overrides.confidence,
    evidence: 'what the classifier says it saw',
    needsHuman: overrides.needsHuman ?? false,
    tier: 'llm' as const,
    evidenceHash: 'abc123',
    promptVersion: 'test',
    costEstimateUsd: null,
    model: null,
    cached: false,
  };
}

// Confidently prohibited. Above `refuseConfidence` (0.75 by default), so the
// rule layer's verdict is `refuse`, then flipped to `review` by the route's
// own `refusalBecomesReview: true`.
const PROHIBITED = classification({
  categoryId: PROHIBITED_CATEGORY_ID,
  confidence: 0.95,
});

// Confidently clean. Above `cleanConfidence` (0.5 by default), so nothing
// stops the request.
const CLEAN = classification({
  categoryId: CLEAN_CATEGORY_ID,
  confidence: 0.9,
});

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

// ─── (a) The client filing a change request ─────────────────────────────────

describe('filing a change request: the client-facing gate', () => {
  function ctx(id = WORKSPACE_ID) {
    return { params: Promise.resolve({ workspaceId: id }) };
  }

  beforeEach(() => {
    classify.mockReset();
    createChangeRequest.mockClear();
    recordChangeRequest.mockClear();
    openSiteEditorContext.mockReset().mockResolvedValue({
      ok: true,
      context: {
        workspaceId: WORKSPACE_ID,
        access: {
          actorId: 'user_client',
          role: 'client',
          subscriptionStatus: 'active',
        },
        site: {},
      },
    });
  });

  it('refuses a prohibited request before a ticket ever exists', async () => {
    classify.mockResolvedValue(PROHIBITED);

    const res = await escalatePOST(
      req({ request: 'Add a page where people can buy MDMA in bulk' }),
      ctx()
    );
    const body = await res.json();

    // Post-deposit surface: a refusal is held for a person, not slammed shut.
    // The status and the notice both say "review", never the refusal's 451.
    expect(res.status).toBe(409);
    expect(body.code).toBe('ACCEPTABLE_USE');
    expect(body.policy.decision).toBe('review');

    // The gate runs before either side effect of actually filing the ticket.
    expect(createChangeRequest).not.toHaveBeenCalled();
    expect(recordChangeRequest).not.toHaveBeenCalled();
  });

  it('still files a clean structural request', async () => {
    classify.mockResolvedValue(CLEAN);

    const res = await escalatePOST(
      req({
        request: 'Add a page for group workshops with its own booking calendar',
      }),
      ctx()
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.escalated).toBe(true);
    expect(createChangeRequest).toHaveBeenCalledTimes(1);
    expect(recordChangeRequest).toHaveBeenCalledTimes(1);
  });
});

// ─── (b) The operator pricing one ───────────────────────────────────────────

describe('quoting a change request: the operator-facing gate', () => {
  function changeCtx(changeId = CHANGE_ID, id = WORKSPACE_ID) {
    return { params: Promise.resolve({ id, changeId }) };
  }

  function seed(overrides: Partial<ChangeRequestRow> = {}) {
    const row = {
      id: CHANGE_ID,
      workspace_id: WORKSPACE_ID,
      message_id: 'msg-1',
      request: 'Add a page for group workshops with its own booking calendar',
      classification: 'structural',
      matched_rules: ['structural:new-thing'],
      status: 'requested',
      quote_minor: null,
      currency: 'eur',
      quote_note: null,
      quoted_by: null,
      quoted_at: null,
      responded_at: null,
      stripe_checkout_session_id: null,
      stripe_payment_intent_id: null,
      paid_at: null,
      completed_at: null,
      build_job_id: null,
      built_version: null,
      completed_via: null,
      completion_note: null,
      created_by: 'user_client',
      created_at: '2026-09-08T09:00:00.000Z',
      updated_at: '2026-09-08T09:00:00.000Z',
      ...overrides,
    };
    db.seed(TABLE, [row]);
    return row;
  }

  beforeEach(() => {
    db.reset();
    classify.mockReset();
    authState.userId = 'user_operator';
    authState.role = 'team';
  });

  it('refuses to price a request the gate now calls prohibited', async () => {
    seed();
    classify.mockResolvedValue(PROHIBITED);

    const res = await quoteChangeRequestHandler(
      req({ amountMinor: 24_000 }),
      changeCtx()
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('ACCEPTABLE_USE');

    // The row never moved off `requested`, and nothing was quoted.
    expect(db.rows(TABLE)[0]!.status).toBe('requested');
    expect(db.rows(TABLE)[0]!.quote_minor).toBeNull();
    expect(
      db
        .rows('project_events')
        .some((row) => row.kind === 'change_request_quoted')
    ).toBe(false);
  });

  it('still quotes a request the gate calls clean', async () => {
    seed();
    classify.mockResolvedValue(CLEAN);

    const res = await quoteChangeRequestHandler(
      req({ amountMinor: 24_000, note: 'Two days of work' }),
      changeCtx()
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.request.status).toBe('quoted');
    expect(db.rows(TABLE)[0]!.quote_minor).toBe(24_000);
    expect(
      db
        .rows('project_events')
        .some((row) => row.kind === 'change_request_quoted')
    ).toBe(true);
  });
});
