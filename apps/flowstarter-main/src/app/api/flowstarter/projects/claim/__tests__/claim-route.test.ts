/**
 * The conversion from anonymous preview to owned project, through the REAL
 * POST /api/flowstarter/projects/claim handler.
 *
 * This route is the only thing that connects the two halves of the product,
 * so the cases below are the ones that would silently break it:
 *
 *  - signed out → 401, because a workspace nobody owns is worse than none;
 *  - the happy path writes all four rows the downstream flow checks for —
 *    workspace, artifacts, membership, event — and lands in PREVIEW_READY;
 *  - claiming the same preview twice returns the SAME workspace and does not
 *    insert a second one (a double click must not create two projects);
 *  - a membership failure is reported, not swallowed, and does not lose the
 *    workspace the client just paid attention to.
 *
 * Static imports throughout: vi.mock is hoisted above them, and the app's
 * tsconfig does not allow top-level await.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  clearClaimablePreviews,
  rememberClaimablePreview,
} from '@/lib/flowstarter/claim';
import { CURRENT_RIGHTS_STATEMENT_VERSION } from '@/components/flowstarter/rights-statement';
import { confirmFetchedPictureRights } from '@/lib/flowstarter/funnel-assets';
import { ensureClientMembership } from '@/lib/flowstarter/membership';
import { savePreviewArtifacts } from '@/lib/flowstarter/preview-artifacts';
import { POST } from '../route';

vi.mock('server-only', () => ({}));

const PREVIEW_ID = 'a1b2c3d4-1111-4111-8111-111111111111';
const OTHER_PREVIEW_ID = 'a1b2c3d4-2222-4222-8222-222222222222';

// ── Clerk ─────────────────────────────────────────────────────────────────
// Same style as src/lib/__tests__/workspace-access.test.ts.

const authState: { userId: string | null } = { userId: 'user_visitor' };

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: {},
    // requireAuth binds getToken off the session, so the mock needs one.
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
// A minimal chainable, thenable Postgrest-style builder over three in-memory
// tables. `workspaces.claimed_preview_id` carries a partial unique index in
// the database; the same rule is enforced here so the 23505 branch under test
// is the one production actually takes.

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
// Both are covered by their own suites; here they are stubbed so the claim's
// orchestration (order, error handling, what it passes on) is what is tested.

// The funnel-asset half of the claim. Stubbed so the route's own decision —
// whether to confirm rights over a picture we fetched — is what is under test,
// rather than Supabase Storage. `confirmFetchedPictureRights` has its own
// suite in lib/flowstarter/__tests__/funnel-assets-rights.test.ts.
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
    // Mirrors the real function: it advances the workspace to PREVIEW_READY.
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
const confirmPictureMock = vi.mocked(confirmFetchedPictureRights);
const artifactsMock = vi.mocked(savePreviewArtifacts);

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
  confirmPictureMock.mockClear();
});

describe('POST /api/flowstarter/projects/claim', () => {
  it('refuses a signed-out visitor', async () => {
    authState.userId = null;
    stashPreview();

    const response = await POST(claimRequest(VALID_BODY));

    expect(response.status).toBe(401);
    expect(db.workspaces).toHaveLength(0);
    expect(membershipMock).not.toHaveBeenCalled();
  });

  it('rejects a body without a preview id', async () => {
    const response = await POST(claimRequest({ tier: 'pro' }));
    expect(response.status).toBe(400);
    expect(db.workspaces).toHaveLength(0);
  });

  it('creates the workspace, artifacts, membership and event', async () => {
    stashPreview();

    const response = await POST(claimRequest(VALID_BODY));
    const body = (await response.json()) as {
      workspaceId: string;
      unlockUrl: string;
      previewReady: boolean;
      quoteMinor: number | null;
    };

    expect(response.status).toBe(201);
    expect(db.workspaces).toHaveLength(1);

    const workspace = db.workspaces[0];
    expect(workspace.claimed_preview_id).toBe(PREVIEW_ID);
    expect(workspace.client_email).toBe('owner@example.com');
    expect(workspace.client_business_name).toBe('Acme Bakery');
    // €1,199 for the pro tier — the server's figure, not the browser's.
    expect(workspace.final_value_minor).toBe(119_900);
    expect(workspace.project_state).toBe(ProjectState.PREVIEW_READY);

    // The manifest is re-pointed at its new home: the build worker fails the
    // job when intake.projectId and the workspace disagree.
    expect(artifactsMock).toHaveBeenCalledTimes(1);
    const artifactArgs = artifactsMock.mock.calls[0][0];
    expect(artifactArgs.workspaceId).toBe(body.workspaceId);
    expect(artifactArgs.intake.projectId).toBe(body.workspaceId);
    expect(artifactArgs.advanceToPreviewReady).toBe(true);

    expect(membershipMock).toHaveBeenCalledWith({
      workspaceId: body.workspaceId,
      clerkUserId: 'user_visitor',
    });

    expect(db.project_events).toHaveLength(1);
    expect(db.project_events[0]).toMatchObject({
      kind: 'preview_claimed',
      actor: 'user_visitor',
      workspace_id: body.workspaceId,
    });

    // Routing is recomputed here, not taken from the browser: the wizard's
    // /api/discovery/recommend copy is ignored on purpose.
    expect(db.intake_submissions).toHaveLength(1);
    expect(db.intake_submissions[0]).toMatchObject({
      workspace_id: body.workspaceId,
      decided_by: 'rules',
      routing_decision: 'standard',
    });
    expect(db.intake_submissions[0].rules_fired).toContain(
      'bookingOrPortfolioGoal'
    );

    expect(body.previewReady).toBe(true);
    expect(body.quoteMinor).toBe(119_900);
    expect(body.unlockUrl).toContain(`/unlock/${body.workspaceId}`);
  });

  it('recomputes the routing verdict server-side', async () => {
    stashPreview();

    // ASAP (4) + starter tier (4) clears the custom threshold of 5, whatever
    // the browser might have claimed.
    await POST(
      claimRequest({
        ...VALID_BODY,
        tier: 'starter',
        timeline: 'asap',
        routing: {
          decision: 'standard',
          score: 0,
          rulesFired: [],
          reasons: [],
        },
      })
    );

    expect(db.intake_submissions).toHaveLength(1);
    expect(db.intake_submissions[0]).toMatchObject({
      decided_by: 'rules',
      routing_decision: 'custom',
    });
    expect(db.intake_submissions[0].score).toBeGreaterThanOrEqual(5);
  });

  it('leaves the quote unset when the wizard sent no tier', async () => {
    stashPreview();

    const { tier: _tier, ...withoutTier } = VALID_BODY;
    const response = await POST(claimRequest(withoutTier));
    const body = (await response.json()) as { quoteMinor: number | null };

    expect(response.status).toBe(201);
    expect(body.quoteMinor).toBeNull();
    expect(db.workspaces[0].final_value_minor).toBeUndefined();
  });

  it('returns the same workspace when the same preview is claimed twice', async () => {
    stashPreview();

    const first = await POST(claimRequest(VALID_BODY));
    const firstBody = (await first.json()) as { workspaceId: string };
    const second = await POST(claimRequest(VALID_BODY));
    const secondBody = (await second.json()) as {
      workspaceId: string;
      alreadyClaimed: boolean;
    };

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondBody.workspaceId).toBe(firstBody.workspaceId);
    expect(secondBody.alreadyClaimed).toBe(true);
    // The whole point: one preview, one project.
    expect(db.workspaces).toHaveLength(1);
    expect(artifactsMock).toHaveBeenCalledTimes(1);
    expect(db.project_events).toHaveLength(1);
  });

  it('does not hand another account the workspace behind a claimed preview', async () => {
    stashPreview();
    await POST(claimRequest(VALID_BODY));
    db.workspace_memberships.push({
      workspace_id: db.workspaces[0].id,
      clerk_user_id: 'user_visitor',
      role: 'client',
    });

    authState.userId = 'user_stranger';
    const response = await POST(claimRequest(VALID_BODY));

    expect(response.status).toBe(409);
    expect(db.workspaces).toHaveLength(1);
  });

  it('keeps the workspace and reports the failure when membership cannot be written', async () => {
    stashPreview();
    membershipMock.mockRejectedValueOnce(new Error('memberships unavailable'));

    const response = await POST(claimRequest(VALID_BODY));
    const body = (await response.json()) as {
      workspaceId: string;
      membershipError?: string;
    };

    expect(response.status).toBe(201);
    expect(db.workspaces).toHaveLength(1);
    expect(body.workspaceId).toBe(db.workspaces[0].id);
    expect(body.membershipError).toBe('memberships unavailable');
    // The failure is recorded, not swallowed: an unopenable workspace has to
    // be findable afterwards.
    expect(db.project_events.map((event) => event.kind)).toEqual([
      'preview_claim_membership_failed',
      'preview_claimed',
    ]);
  });

  it('creates an owned workspace but no artifacts when the preview is gone', async () => {
    // The stash is process-local: a preview generated in another instance, or
    // one that has aged out, must still convert into something the visitor
    // owns — it just cannot claim to be ready to build.
    stashPreview(OTHER_PREVIEW_ID);

    const response = await POST(claimRequest(VALID_BODY));
    const body = (await response.json()) as { previewReady: boolean };

    expect(response.status).toBe(201);
    expect(body.previewReady).toBe(false);
    expect(artifactsMock).not.toHaveBeenCalled();
    expect(db.workspaces[0].project_state).toBe(ProjectState.INTAKE);
    expect(membershipMock).toHaveBeenCalledTimes(1);
  });
});

describe('the profile picture the claim page asks about', () => {
  /**
   * The whole safety property, stated once: a picture we read off somebody's
   * public page is filed with no rights confirmation, so it is invisible to
   * `loadUsableAssets` and unpublishable on a paid site. The claim page's one
   * checkbox is the only thing that changes that, and these are the three ways
   * that can go.
   */
  it('confirms the rights when the visitor left the box ticked', async () => {
    stashPreview();

    const response = await POST(
      claimRequest({ ...VALID_BODY, useProfilePicture: true })
    );

    expect(response.status).toBe(201);
    expect(confirmPictureMock).toHaveBeenCalledTimes(1);
    expect(confirmPictureMock).toHaveBeenCalledWith(
      expect.objectContaining({ previewId: PREVIEW_ID })
    );
  });

  it('confirms nothing when the visitor unticked it', async () => {
    stashPreview();

    const response = await POST(
      claimRequest({ ...VALID_BODY, useProfilePicture: false })
    );

    expect(response.status).toBe(201);
    expect(confirmPictureMock).not.toHaveBeenCalled();
  });

  it('confirms nothing when the field is absent altogether', async () => {
    // The field is only sent when there is a fetched picture to ask about, so
    // its absence must never be read as consent. The schema defaults it to
    // false for exactly this reason: a caller that forgets the key publishes
    // nothing rather than publishing somebody's photograph.
    stashPreview();

    const response = await POST(claimRequest(VALID_BODY));

    expect(response.status).toBe(201);
    expect(confirmPictureMock).not.toHaveBeenCalled();
  });

  it('records the statement version and where the answer came from', async () => {
    // A confirmation with no version, address or agent on it is a boolean, not
    // evidence, and the question it answers is a legal one.
    stashPreview();

    await POST(claimRequest({ ...VALID_BODY, useProfilePicture: true }));

    const call = confirmPictureMock.mock.calls[0]?.[0];
    expect(call?.statementVersion).toBe(CURRENT_RIGHTS_STATEMENT_VERSION);
    expect(call).toHaveProperty('ip');
    expect(call).toHaveProperty('userAgent');
  });

  it('still creates the workspace when the visitor says no', async () => {
    // Declining is an answer about a picture, not about the purchase.
    stashPreview();

    const response = await POST(
      claimRequest({ ...VALID_BODY, useProfilePicture: false })
    );
    const body = (await response.json()) as { workspaceId: string };

    expect(response.status).toBe(201);
    expect(body.workspaceId).toBeTruthy();
    expect(db.workspaces).toHaveLength(1);
  });

  it('refuses a non-boolean answer rather than guessing what it meant', async () => {
    stashPreview();

    const response = await POST(
      claimRequest({ ...VALID_BODY, useProfilePicture: 'yes please' })
    );

    expect(response.status).toBe(400);
    expect(confirmPictureMock).not.toHaveBeenCalled();
  });
});
