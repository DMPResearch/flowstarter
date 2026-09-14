/**
 * The acceptable-use gate on the claim route.
 *
 * A claim is the step where a stranger becomes a workspace with a price
 * attached, so a refused category must never get one: everything downstream
 * of this route (the deposit Checkout, the build, the host) reads the
 * workspace as a customer. The claim is screened on its own answers, not on
 * the preview gate's cached verdict, because a visitor can type a clean
 * intake and then a dirty claim.
 *
 * The classifier is mocked (there is no matcher, only a model behind
 * classifyAcceptableUse); the rule layer that turns a classification into
 * refuse/review/allow is real, so the 451/409 split below is exercised for
 * real against these inputs.
 *
 * The Clerk and in-memory Supabase preamble is copied from the sibling
 * `claim-route.test.ts` in this directory, verbatim, so this suite exercises
 * the same fake persistence the rest of the route's tests do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  clearClaimablePreviews,
  rememberClaimablePreview,
} from '@/lib/flowstarter/claim';
import { ensureClientMembership } from '@/lib/flowstarter/membership';
import { savePreviewArtifacts } from '@/lib/flowstarter/preview-artifacts';
import { POST } from '../route';

vi.mock('server-only', () => ({}));

const PREVIEW_ID = 'a1b2c3d4-1111-4111-8111-111111111111';

// ── Clerk ─────────────────────────────────────────────────────────────────

const authState: { userId: string | null } = { userId: 'user_visitor' };

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: {},
    getToken: async () => 'test-token',
  }),
  clerkClient: async () => ({
    users: { getUser: async () => ({ publicMetadata: {} }) },
  }),
  currentUser: async () => ({
    primaryEmailAddressId: 'idn_1',
    emailAddresses: [{ id: 'idn_1', emailAddress: 'owner@example.com' }],
  }),
}));

// ── Supabase (service role) ───────────────────────────────────────────────

interface Row {
  [column: string]: unknown;
}

const db: Record<string, Row[]> = {
  workspaces: [],
  workspace_memberships: [],
  project_events: [],
  intake_submissions: [],
};

let workspaceSeq = 0;
function nextWorkspaceId(): string {
  workspaceSeq += 1;
  return `0f4e1088-8d8f-4f18-83b1-406cc292b2${String(workspaceSeq).padStart(
    2,
    '0'
  )}`;
}

function builderFor(table: string) {
  const filters: Record<string, unknown> = {};
  let inserted: Row | null = null;
  let insertError: { code: string; message: string } | null = null;
  let isInsert = false;

  const matching = () =>
    (db[table] ?? []).filter((row) =>
      Object.entries(filters).every(([column, value]) => row[column] === value)
    );

  const settle = () =>
    isInsert
      ? { data: inserted ? [inserted] : null, error: insertError }
      : { data: matching(), error: null };

  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    },
    insert: (values: Row) => {
      isInsert = true;
      const previewId = values.claimed_preview_id;
      if (
        table === 'workspaces' &&
        typeof previewId === 'string' &&
        db.workspaces.some((row) => row.claimed_preview_id === previewId)
      ) {
        insertError = {
          code: '23505',
          message: 'duplicate key value violates unique constraint',
        };
        return builder;
      }
      inserted = {
        id:
          table === 'workspaces' ? nextWorkspaceId() : `${table}-${Date.now()}`,
        ...values,
      };
      db[table].push(inserted);
      return builder;
    },
    maybeSingle: async () => {
      const result = settle();
      if (result.error) return { data: null, error: result.error };
      return { data: result.data?.[0] ?? null, error: null };
    },
    single: async () => builder.maybeSingle(),
    then: <T>(
      onFulfilled: (value: ReturnType<typeof settle>) => T,
      onRejected?: (reason: unknown) => T
    ) => Promise.resolve(settle()).then(onFulfilled, onRejected),
  };
  return builder;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builderFor }),
}));

// ── The two collaborators that own their own persistence ─────────────────

vi.mock('@/lib/flowstarter/funnel-assets', () => ({
  claimFunnelAssets: vi.fn(async () => ({
    moved: 0,
    alreadyClaimed: 0,
    failed: [],
  })),
  confirmFetchedPictureRights: vi.fn(async () => ({ confirmed: 1 })),
}));

vi.mock('@/lib/flowstarter/membership', () => ({
  ensureClientMembership: vi.fn(async () => ({
    workspaceId: 'ws',
    clerkUserId: 'user_visitor',
    created: true,
  })),
}));

vi.mock('@/lib/flowstarter/preview-artifacts', () => ({
  savePreviewArtifacts: vi.fn(async (input: { workspaceId: string }) => {
    const workspace = db.workspaces.find((row) => row.id === input.workspaceId);
    if (workspace) workspace.project_state = ProjectState.PREVIEW_READY;
    return {
      workspaceId: input.workspaceId,
      fileCount: 1,
      templateSlug: 'astro-service',
      advanced: true,
    };
  }),
  PreviewArtifactError: class extends Error {},
}));

const membershipMock = vi.mocked(ensureClientMembership);
const artifactsMock = vi.mocked(savePreviewArtifacts);

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

// ── Fixtures ──────────────────────────────────────────────────────────────

function stashPreview(previewId = PREVIEW_ID) {
  rememberClaimablePreview({
    previewId,
    intake: {
      projectId: previewId,
      business: {
        name: 'Acme Bakery',
        niche: 'Bakery',
        location: 'Dublin',
        description: 'Sourdough, daily.',
      },
      socialMedia: [],
      locale: 'en',
      submittedAt: new Date().toISOString(),
      consent: { publicProfileAnalysis: false, acceptedAt: '' },
    } as never,
    brandConfig: { schemaVersion: '1.0' } as never,
    template: {
      slug: 'astro-service',
      reason: 'best fit',
      matchedSignals: [],
      confidence: 0.9,
    },
    files: [{ path: 'package.json', content: '{}', type: 'file' }],
    previewArtifactUrl: 'daytona://sandbox-1',
    previewUrl: 'https://preview.example.com',
  });
}

function claimRequest(body: Record<string, unknown>) {
  return new NextRequest(
    'http://localhost:3000/api/flowstarter/projects/claim',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

const VALID_BODY = {
  previewId: PREVIEW_ID,
  tier: 'pro' as const,
  businessName: 'Acme Bakery',
  fullName: 'Ada Baker',
  description: 'Sourdough, daily.',
  industry: 'Bakery',
  targetAudience: 'Local families',
  goal: 'bookings',
  brandTone: 'warm',
};

beforeEach(() => {
  authState.userId = 'user_visitor';
  for (const table of Object.keys(db)) db[table] = [];
  workspaceSeq = 0;
  clearClaimablePreviews();
  membershipMock.mockClear();
  membershipMock.mockResolvedValue({
    workspaceId: 'ws',
    clerkUserId: 'user_visitor',
    created: true,
  });
  artifactsMock.mockClear();
  classify.mockReset();
});

describe('POST /api/flowstarter/projects/claim — acceptable-use gate', () => {
  it('refuses a prohibited category with 451 and never reaches claimPreview', async () => {
    classify.mockResolvedValue(
      classification({ categoryId: 'illegal_drugs', confidence: 0.95 })
    );
    stashPreview();

    const response = await POST(claimRequest(VALID_BODY));
    const body = (await response.json()) as {
      code?: string;
      policy?: { decision?: string };
    };

    expect(response.status).toBe(451);
    expect(body.code).toBe('ACCEPTABLE_USE');
    // claimPreview never ran: no workspace row was created, no membership
    // written. A refused category must not become a priced project.
    expect(db.workspaces).toHaveLength(0);
    expect(membershipMock).not.toHaveBeenCalled();
    expect(artifactsMock).not.toHaveBeenCalled();
  });

  it('answers 409 for a review verdict', async () => {
    // A lawful-but-sensitive category below the refuse bar but at or above the
    // review bar is a hold, not a refusal: 409, the same status the route
    // already uses for "your request conflicts with this workspace's state".
    classify.mockResolvedValue(
      classification({ categoryId: 'licensed_pharmacy', confidence: 0.6 })
    );
    stashPreview();

    const response = await POST(claimRequest(VALID_BODY));

    expect(response.status).toBe(409);
    expect(db.workspaces).toHaveLength(0);
  });

  it('still claims for a clean classification', async () => {
    classify.mockResolvedValue(
      classification({ categoryId: 'none', confidence: 0.95 })
    );
    stashPreview();

    const response = await POST(claimRequest(VALID_BODY));
    const body = (await response.json()) as { workspaceId: string };

    expect(response.status).toBe(201);
    expect(db.workspaces).toHaveLength(1);
    expect(body.workspaceId).toBe(db.workspaces[0].id);
    expect(membershipMock).toHaveBeenCalledTimes(1);
    expect(artifactsMock).toHaveBeenCalledTimes(1);
  });
});
