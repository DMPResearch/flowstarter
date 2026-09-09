// @vitest-environment node
/**
 * The client site editor, through the REAL route handlers.
 *
 * Five things are defended here, and each has already been a real bug in
 * something:
 *
 *  1. TENANCY. Every handler queries with the service role, which bypasses
 *     RLS. `requireWorkspaceAccess` running first is the entire boundary, so
 *     the cross-tenant cases assert not only the 404 but that no query other
 *     than the membership lookup ever ran — a 404 that still read another
 *     tenant's manifest would be a green test and a live leak.
 *  2. POLICY. The panel only offers content blocks, but the panel is not the
 *     authorization. A request naming a component is classified server-side
 *     and refused with the policy's own words, and the agent is never called.
 *  3. CONCURRENCY. An apply carries the original it was shown beside. If the
 *     site moved on, the apply must lose rather than overwrite a version its
 *     author never saw.
 *  4. RIGHTS. An asset without `rights_confirmed_at` cannot reach a site, and
 *     the refusal happens before the object is downloaded.
 *  5. COST. Each proposal spends the tenant's tokens, so the daily cap has to
 *     hold on the N+1th request rather than on the N+1th *successful* one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
// Static imports: vi.mock is hoisted above them, and the app's tsconfig does
// not allow top-level await in tests.
import { GET as GET_STATE } from '../route';
import { POST as EDIT } from '../edit/route';
import { POST as APPLY } from '../apply/route';
import { GET as LIST_IMAGES, POST as SWAP_IMAGE } from '../images/route';
import { POST as REVERT } from '../revert/route';
import { POST as PUBLISH } from '../publish/route';
import { POST as ESCALATE } from '../escalate/route';
import { GET as PREVIEW } from '../preview/[[...path]]/route';
import { GET as LIST_CHANGES } from '../changes/route';
import { POST as RESPOND } from '../changes/[changeId]/respond/route';
import { ChangeRequestError } from '@/lib/flowstarter/change-requests';
import { createFakeSiteSupabase, type Row } from './fake-site-supabase';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';
/**
 * A third workspace of the same client, used only by the burst-limit case.
 * The limiter lives in module scope and keeps counting between tests, so the
 * case that fills a bucket has to fill one nothing else draws from.
 */
const WORKSPACE_BURST = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const ASSET_CONFIRMED = '11111111-1111-4111-8111-111111111111';
const ASSET_UNCONFIRMED = '22222222-2222-4222-8222-222222222222';
const CHANGE_REQUEST = '44444444-4444-4444-8444-444444444444';

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

const db = createFakeSiteSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

// The ledger is not what these cases are about, and the real module reaches
// for a Supabase client of its own.
const llmLedger: Array<Record<string, unknown>> = [];
vi.mock('@/lib/ai/llm', () => ({
  llmActionConfig: () => ({ maxTokens: 30_000, maxOutputTokens: 8_000 }),
  recordLlmUsage: async (usage: Record<string, unknown>) => {
    llmLedger.push(usage);
  },
}));

// The nudge to the build worker is an HTTP call to a process that is not
// running here. The row in the ledger is the commitment and is asserted for
// real; this only records that the nudge was attempted.
const dispatched: string[] = [];
/** Set to make the nudge fail the way an unreachable worker does. */
const dispatchFailure: { error: unknown } = { error: null };
vi.mock('@/lib/flowstarter/pipeline/dispatch', () => ({
  DispatchError: class extends Error {},
  dispatchAgentJob: async (jobId: string) => {
    if (dispatchFailure.error) throw dispatchFailure.error;
    dispatched.push(jobId);
  },
}));

/**
 * The real Pi model is not configured in this environment (no PI_API_KEY that
 * reaches a provider), so the agent is stood in for. What is NOT stubbed is
 * the thing worth testing: the route decides whether the agent may be called
 * at all, and `inlineEdit.calls` is asserted to be empty on every refusal.
 */
interface AgentUsage {
  action: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
}

const inlineEdit = {
  calls: [] as Array<Record<string, unknown>>,
  reply: 'Operations and strategy consultancy',
  /** Thrown instead of answering, the way a provider outage arrives. */
  failure: null as unknown,
  /** Reported to the run's usage sink before it answers, when set. */
  usage: null as AgentUsage | null,
};

vi.mock('@flowstarter/agentic-codegen', () => ({
  PiSdkFlowstarterAgents: class {
    constructor(
      readonly options: { usageSink?: (usage: AgentUsage) => void }
    ) {}
    async editInline(request: Record<string, unknown>) {
      inlineEdit.calls.push(request);
      if (inlineEdit.usage) this.options.usageSink?.(inlineEdit.usage);
      if (inlineEdit.failure) throw inlineEdit.failure;
      return {
        targetId: request['targetId'],
        originalContent: request['originalContent'],
        replacementContent: inlineEdit.reply,
      };
    }
  },
}));

/**
 * Stripe is not reachable from a unit test, and a checkout session is not what
 * these cases are about: the route's job is to decide whether a checkout may
 * be opened at all, and with which origin.
 */
const checkout = {
  calls: [] as Array<Record<string, unknown>>,
  /** Thrown instead of returning a session, when set. */
  failure: null as unknown,
};

vi.mock('@/lib/flowstarter/change-request-checkout', () => ({
  createChangeRequestCheckout: async (input: Record<string, unknown>) => {
    checkout.calls.push(input);
    if (checkout.failure) throw checkout.failure;
    return {
      url: 'https://checkout.stripe.test/session/cs_test_123',
      sessionId: 'cs_test_123',
    };
  },
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

const CONTENT = `---
siteMeta:
  title: "Halden & Roe"
  description: "An independent consultancy."

hero:
  label: "Operations consultancy"
  title: "Decisions that hold"
  text: |
    We are Halden and Roe.

    No deck-and-leave.
  image: "/images/hero.jpg"
  imageAlt: "A meeting room"
  actions:
    - label: "Book a session"
      href: "/book"
---
`;

const LABEL_TARGET = 'src/content/site-labels.md#7';
const IMAGE_SLOT = 'src/content/site-labels.md#13';

function manifest() {
  return {
    files: [
      { path: 'src/content/site-labels.md', content: CONTENT },
      {
        path: 'src/components/Hero.astro',
        content: '<section class="hero"><slot /></section>\n',
      },
      {
        path: 'public/styles/site.css',
        content: ':root { --ink: #101014; }\n',
      },
    ],
  };
}

/**
 * A PNG whose header is real and whose body is not. `assertSafeUploadedImage`
 * (magic bytes) and `probeImageSize` (IHDR) read only the header, so this is a
 * genuine exercise of the validator without a binary in the repo.
 */
function pngBytes(width = 1600, height = 900): Buffer {
  const bytes = Buffer.alloc(64, 0);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function seedWorkspace(subscriptionStatus = 'active'): void {
  db.seed('workspaces', [
    {
      id: WORKSPACE_A,
      name: 'Halden & Roe',
      slug: 'halden-roe',
      subscription_status: subscriptionStatus,
      hosting_server_id: null,
      deploy_status: 'none',
    },
    {
      id: WORKSPACE_BURST,
      name: 'Halden & Roe, second site',
      slug: 'halden-roe-two',
      subscription_status: 'active',
      hosting_server_id: null,
      deploy_status: 'none',
    },
    {
      id: WORKSPACE_B,
      name: 'Someone else',
      slug: 'someone-else',
      subscription_status: 'active',
      hosting_server_id: null,
      deploy_status: 'none',
    },
  ]);
  db.seed('workspace_memberships', [
    { workspace_id: WORKSPACE_A, clerk_user_id: 'user_client_a' },
    { workspace_id: WORKSPACE_BURST, clerk_user_id: 'user_client_a' },
  ]);
  db.seed('flowstarter_project_artifacts', [
    {
      workspace_id: WORKSPACE_BURST,
      preview_manifest: manifest(),
      template_slug: 'professional-services',
      template_version: '1.0.0',
    },
    {
      workspace_id: WORKSPACE_A,
      preview_manifest: manifest(),
      template_slug: 'professional-services',
      template_version: '1.0.0',
    },
    {
      workspace_id: WORKSPACE_B,
      preview_manifest: manifest(),
      template_slug: 'professional-services',
      template_version: '1.0.0',
    },
  ]);
}

function seedAssets(): void {
  const path = `tenant/${WORKSPACE_A}/assets/abc.png`;
  db.objects.set(path, pngBytes());
  db.seed('assets', [
    {
      id: ASSET_CONFIRMED,
      workspace_id: WORKSPACE_A,
      source: 'upload',
      kind: 'section',
      mime: 'image/png',
      width: 1600,
      height: 900,
      usable_for: ['section'],
      selected: true,
      storage_path: path,
      rights_confirmed_at: '2026-08-01T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
    },
    {
      id: ASSET_UNCONFIRMED,
      workspace_id: WORKSPACE_A,
      source: 'upload',
      kind: 'section',
      mime: 'image/png',
      width: 1600,
      height: 900,
      usable_for: ['section'],
      selected: false,
      storage_path: `tenant/${WORKSPACE_A}/assets/def.png`,
      rights_confirmed_at: null,
      created_at: '2026-08-02T00:00:00.000Z',
    },
  ]);
  db.objects.set(`tenant/${WORKSPACE_A}/assets/def.png`, pngBytes());
}

function post(url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }),
  });
}

function get(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

function params(workspaceId: string, path?: string[]) {
  return {
    params: Promise.resolve({ workspaceId, ...(path ? { path } : {}) }),
  };
}

/** The change-request routes carry a second segment in their params. */
function changeParams(workspaceId: string, changeId: string) {
  return { params: Promise.resolve({ workspaceId, changeId }) };
}

/** Everything the handlers read that is not the membership check itself. */
function dataQueries() {
  return db.queries.filter((query) => query.table !== 'workspace_memberships');
}

function manifestOf(workspaceId: string): { files: Array<Row> } {
  const versions = db
    .rows('site_versions')
    .filter((row) => row.workspace_id === workspaceId)
    .sort((a, b) => (a.version as number) - (b.version as number));
  const latest = versions[versions.length - 1];
  if (latest) return latest.manifest as { files: Array<Row> };
  const artifact = db
    .rows('flowstarter_project_artifacts')
    .find((row) => row.workspace_id === workspaceId);
  return artifact?.preview_manifest as { files: Array<Row> };
}

function contentOf(workspaceId: string): string {
  const file = manifestOf(workspaceId).files.find(
    (entry) => entry.path === 'src/content/site-labels.md'
  );
  return String(file?.content ?? '');
}

beforeEach(() => {
  db.reset();
  authState.userId = 'user_client_a';
  authState.role = undefined;
  inlineEdit.calls.length = 0;
  inlineEdit.failure = null;
  inlineEdit.usage = null;
  dispatched.length = 0;
  dispatchFailure.error = null;
  llmLedger.length = 0;
  checkout.calls.length = 0;
  checkout.failure = null;
  inlineEdit.reply = 'Operations and strategy consultancy';
  process.env.PI_API_KEY = 'test-key';
  seedWorkspace();
});

// ── 1. Tenancy ─────────────────────────────────────────────────────────────

describe('a workspace that is not yours', () => {
  it('is 404 on every route, and nothing of it is read', async () => {
    // Thunks, not promises: each call has to start *after* the query log is
    // cleared, or the log would already hold the previous case's queries and
    // the "nothing was read" assertion would be measuring the wrong request.
    const cases: Array<[string, () => Promise<Response>]> = [
      ['state', () => GET_STATE(get('/x'), params(WORKSPACE_B))],
      [
        'edit',
        () =>
          EDIT(
            post('/x', { targetId: LABEL_TARGET, instruction: 'warmer' }),
            params(WORKSPACE_B)
          ),
      ],
      [
        'apply',
        () =>
          APPLY(
            post('/x', {
              targetId: LABEL_TARGET,
              originalContent: 'Operations consultancy',
              replacementContent: 'Anything at all',
            }),
            params(WORKSPACE_B)
          ),
      ],
      ['images:list', () => LIST_IMAGES(get('/x'), params(WORKSPACE_B))],
      [
        'images:swap',
        () =>
          SWAP_IMAGE(
            post('/x', { slotId: IMAGE_SLOT, assetId: ASSET_CONFIRMED }),
            params(WORKSPACE_B)
          ),
      ],
      ['revert', () => REVERT(post('/x', { version: 1 }), params(WORKSPACE_B))],
      ['publish', () => PUBLISH(post('/x'), params(WORKSPACE_B))],
      [
        'preview',
        () => PREVIEW(get('/x'), params(WORKSPACE_B, ['index.html'])),
      ],
      ['changes:list', () => LIST_CHANGES(get('/x'), params(WORKSPACE_B))],
      [
        'changes:respond',
        () =>
          RESPOND(
            post('/x', { decision: 'accept' }),
            changeParams(WORKSPACE_B, CHANGE_REQUEST)
          ),
      ],
    ];

    for (const [name, call] of cases) {
      db.queries.length = 0;
      const response = await call();
      expect(response.status, name).toBe(404);
      expect(dataQueries(), name).toEqual([]);
    }
    expect(inlineEdit.calls).toHaveLength(0);
    expect(db.downloads).toEqual([]);
    expect(db.rows('site_versions')).toEqual([]);
    // The other tenant's change requests were neither read nor answered.
    expect(db.rows('change_requests')).toEqual([]);
    expect(db.rows('project_events')).toEqual([]);
  });

  it('asks a signed-out caller to sign in rather than pretending it is missing', async () => {
    authState.userId = null;
    const response = await GET_STATE(get('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(401);
    expect(dataQueries()).toEqual([]);
  });
});

// ── 2. State ───────────────────────────────────────────────────────────────

describe('GET the editor state', () => {
  it('returns the editable blocks and the policy that governs them', async () => {
    const response = await GET_STATE(get('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.site.templateSlug).toBe('professional-services');
    expect(body.site.rendersBuiltHtml).toBe(false);
    expect(body.policy.content.action).toBe('inline_content_agent');
    expect(body.policy.image.action).toBe('client_media_upload');
    expect(body.allowance).toMatchObject({ used: 0, cap: 25 });

    const ids = body.targets.map((target: { id: string }) => target.id);
    expect(ids).toContain(LABEL_TARGET);
    // The href line and the picture path are not on offer.
    expect(ids).not.toContain('src/content/site-labels.md#17');
    expect(ids).not.toContain(IMAGE_SLOT);
  });
});

// ── 3. Policy ──────────────────────────────────────────────────────────────

describe('policy, decided on the server', () => {
  it('refuses a structural target even though the UI never offered one', async () => {
    const response = await EDIT(
      post('/x', {
        targetId: 'src/components/Hero.astro#1',
        instruction: 'make the hero taller',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.policy.action).toBe('maintenance_request');
    expect(body.error).toMatch(/require Flowstarter review/);
    // The model was never asked, so the tenant was never billed for it.
    expect(inlineEdit.calls).toHaveLength(0);
    expect(db.rows('project_events')).toEqual([]);
  });

  it('refuses a structural target on apply too, not only on propose', async () => {
    const response = await APPLY(
      post('/x', {
        targetId: 'public/styles/site.css#1',
        originalContent: ':root { --ink: #101014; }',
        replacementContent: 'a warmer ink',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(403);
    expect(db.rows('site_versions')).toEqual([]);
  });

  it('stops editing when the subscription has lapsed', async () => {
    db.reset();
    seedWorkspace('past_due');
    const response = await EDIT(
      post('/x', { targetId: LABEL_TARGET, instruction: 'warmer' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.error).toMatch(/active care subscription/);
    expect(inlineEdit.calls).toHaveLength(0);
  });
});

// ── 4. Propose and apply ───────────────────────────────────────────────────

describe('proposing a change', () => {
  it('returns the replacement without touching the site', async () => {
    const response = await EDIT(
      post('/x', {
        targetId: LABEL_TARGET,
        instruction: 'name the strategy work too',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.originalContent).toBe('Operations consultancy');
    expect(body.replacementContent).toBe('Operations and strategy consultancy');
    expect(body.allowance).toMatchObject({ used: 1, cap: 25 });

    // Nothing was written to the site.
    expect(db.rows('site_versions')).toEqual([]);
    expect(contentOf(WORKSPACE_A)).toContain('label: "Operations consultancy"');

    // The audit row carries a hash, never the client's words.
    const event = db.rows('project_events')[0];
    expect(event?.kind).toBe('site_edit_proposed');
    expect(event?.actor).toBe('user_client_a');
    const payload = event?.payload as Record<string, unknown>;
    expect(payload['instructionSha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(payload)).not.toContain('strategy work');
  });

  it('refuses the request after the daily cap, before spending a token', async () => {
    db.seed(
      'project_events',
      Array.from({ length: 25 }, (_, index) => ({
        id: `event-${index}`,
        workspace_id: WORKSPACE_A,
        kind: 'site_edit_proposed',
        actor: 'user_client_a',
        payload: {},
        created_at: new Date().toISOString(),
      }))
    );

    const response = await EDIT(
      post('/x', { targetId: LABEL_TARGET, instruction: 'one more' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.code).toBe('DAILY_CAP');
    expect(inlineEdit.calls).toHaveLength(0);
    // And no 26th proposal row was written.
    expect(
      db
        .rows('project_events')
        .filter((row) => row.kind === 'site_edit_proposed')
    ).toHaveLength(25);
  });

  it('refuses an instruction longer than the cap', async () => {
    const response = await EDIT(
      post('/x', { targetId: LABEL_TARGET, instruction: 'x'.repeat(5_000) }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect(inlineEdit.calls).toHaveLength(0);
  });
});

describe('applying a change', () => {
  it('snapshots the delivered site first, then the change', async () => {
    const response = await APPLY(
      post('/x', {
        targetId: LABEL_TARGET,
        originalContent: 'Operations consultancy',
        replacementContent: 'Operations and strategy consultancy',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);
    expect((await response.json()).version).toBe(2);

    const versions = db
      .rows('site_versions')
      .filter((row) => row.workspace_id === WORKSPACE_A);
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
    expect(versions[0]?.created_by).toBe('system');
    expect(versions[1]?.created_by).toBe('user_client_a');

    // The artifact row — what the worker builds and the deploy path ships —
    // now mirrors the new version.
    expect(contentOf(WORKSPACE_A)).toContain(
      'label: "Operations and strategy consultancy"'
    );

    const audit = db
      .rows('project_events')
      .find((row) => row.kind === 'site_edited');
    expect(audit?.payload).toMatchObject({
      targetId: LABEL_TARGET,
      changedPaths: ['src/content/site-labels.md'],
      version: 2,
    });
  });

  it('refuses when the original no longer matches the site', async () => {
    await APPLY(
      post('/x', {
        targetId: LABEL_TARGET,
        originalContent: 'Operations consultancy',
        replacementContent: 'Operations and strategy consultancy',
      }),
      params(WORKSPACE_A)
    );

    // A second tab still holding the text from before the first apply.
    const response = await APPLY(
      post('/x', {
        targetId: LABEL_TARGET,
        originalContent: 'Operations consultancy',
        replacementContent: 'Something entirely different',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/changed since you started/);
    // The losing write did not land.
    expect(contentOf(WORKSPACE_A)).toContain(
      'label: "Operations and strategy consultancy"'
    );
    expect(db.rows('site_versions')).toHaveLength(2);
  });

  it('refuses markup posted straight at the apply route', async () => {
    const response = await APPLY(
      post('/x', {
        targetId: LABEL_TARGET,
        originalContent: 'Operations consultancy',
        replacementContent: '<img src=x onerror=alert(1)>',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect(db.rows('site_versions')).toEqual([]);
  });
});

// ── 5. Revert ──────────────────────────────────────────────────────────────

describe('reverting', () => {
  it('brings the earlier wording back as a new version', async () => {
    await APPLY(
      post('/x', {
        targetId: LABEL_TARGET,
        originalContent: 'Operations consultancy',
        replacementContent: 'Operations and strategy consultancy',
      }),
      params(WORKSPACE_A)
    );
    expect(contentOf(WORKSPACE_A)).toContain(
      'label: "Operations and strategy consultancy"'
    );

    const response = await REVERT(
      post('/x', { version: 1 }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 3, revertedTo: 1 });

    // Back to exactly what was delivered — and the change is still in the
    // record rather than deleted from it.
    expect(contentOf(WORKSPACE_A)).toBe(CONTENT);
    expect(db.rows('site_versions').map((row) => row.version)).toEqual([
      1, 2, 3,
    ]);
  });

  it('refuses a version that is not this workspace’s', async () => {
    db.seed('site_versions', [
      {
        id: 'foreign',
        workspace_id: WORKSPACE_B,
        version: 9,
        manifest: manifest(),
        created_by: 'user_other',
        created_at: '2026-08-01T00:00:00.000Z',
        published_at: null,
        summary: null,
      },
    ]);
    const response = await REVERT(
      post('/x', { version: 9 }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(404);
  });
});

// ── 6. Images ──────────────────────────────────────────────────────────────

describe('swapping a picture', () => {
  beforeEach(() => {
    seedAssets();
  });

  it('lists the slots and every file, with rights intact', async () => {
    const response = await LIST_IMAGES(get('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.slots.map((slot: { id: string }) => slot.id)).toEqual([
      IMAGE_SLOT,
    ]);
    expect(body.slots[0]).toMatchObject({
      currentPath: '/images/hero.jpg',
      alt: 'A meeting room',
    });
    const usable = body.assets.map((asset: { id: string; usable: boolean }) => [
      asset.id,
      asset.usable,
    ]);
    expect(usable).toContainEqual([ASSET_CONFIRMED, true]);
    expect(usable).toContainEqual([ASSET_UNCONFIRMED, false]);
  });

  it('refuses a file whose rights were never confirmed, before downloading it', async () => {
    db.downloads.length = 0;
    const response = await SWAP_IMAGE(
      post('/x', { slotId: IMAGE_SLOT, assetId: ASSET_UNCONFIRMED }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('RIGHTS_NOT_CONFIRMED');
    expect(db.downloads).toEqual([]);
    expect(db.rows('site_versions')).toEqual([]);
  });

  it('refuses a file belonging to another workspace', async () => {
    db.seed('assets', [
      {
        id: '33333333-3333-4333-8333-333333333333',
        workspace_id: WORKSPACE_B,
        source: 'upload',
        storage_path: `tenant/${WORKSPACE_B}/assets/ghi.png`,
        rights_confirmed_at: '2026-08-01T00:00:00.000Z',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]);
    const response = await SWAP_IMAGE(
      post('/x', {
        slotId: IMAGE_SLOT,
        assetId: '33333333-3333-4333-8333-333333333333',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(404);
    expect(db.downloads).toEqual([]);
  });

  it('puts a confirmed picture into the slot and versions the result', async () => {
    const response = await SWAP_IMAGE(
      post('/x', { slotId: IMAGE_SLOT, assetId: ASSET_CONFIRMED }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.previousPath).toBe('/images/hero.jpg');
    expect(body.publicPath).toBe('/flowstarter-media/hero-13.png');
    expect(body.version).toBe(2);

    expect(contentOf(WORKSPACE_A)).toContain(
      'image: "/flowstarter-media/hero-13.png"'
    );
    const files = manifestOf(WORKSPACE_A).files;
    const media = files.find(
      (file) => file.path === 'public/flowstarter-media/hero-13.png'
    );
    expect(media?.encoding).toBe('base64');
    expect(
      db
        .rows('project_events')
        .some((row) => row.kind === 'site_image_replaced')
    ).toBe(true);
  });
});

// ── 7. Serving the site ────────────────────────────────────────────────────

describe('serving the site into the frame', () => {
  it('refuses to walk out of the manifest', async () => {
    for (const path of [
      ['..', '..', '.env'],
      ['styles', '..', '..', 'src', 'components', 'Hero.astro'],
      ['..'],
    ]) {
      const response = await PREVIEW(get('/x'), params(WORKSPACE_A, path));
      expect(response.status, path.join('/')).toBe(404);
    }
  });

  it('serves a stored asset with the right content type', async () => {
    const response = await PREVIEW(
      get('/x'),
      params(WORKSPACE_A, ['styles', 'site.css'])
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/css; charset=utf-8'
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain('--ink');
  });

  it('renders the content view with a clickable id on every block', async () => {
    const response = await PREVIEW(get('/x'), params(WORKSPACE_A, []));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8'
    );
    // Sandboxed into an opaque origin: the frame cannot touch the dashboard.
    expect(response.headers.get('content-security-policy')).toContain(
      'sandbox allow-scripts'
    );
    const html = await response.text();
    expect(html).toContain(`data-flowstarter-id="${LABEL_TARGET}"`);
    expect(html).toContain('Operations consultancy');
  });

  it('does not serve a file that is not in the manifest', async () => {
    const response = await PREVIEW(
      get('/x'),
      params(WORKSPACE_A, ['not-a-file.txt'])
    );
    expect(response.status).toBe(404);
  });
});

// ── 8. Publish ─────────────────────────────────────────────────────────────

describe('publishing', () => {
  /**
   * A project with a server allocated. Publishing from here is the case the
   * rebuild exists for; the default fixture has no server at all.
   */
  function hostThePublishedSite(): void {
    db.seed('hosting_servers', [
      { id: 'host-1', deploy_agent_url: 'https://agent.test' },
    ]);
    const workspace = db
      .rows('workspaces')
      .find((row) => row.id === WORKSPACE_A);
    if (workspace) workspace['hosting_server_id'] = 'host-1';
  }

  /** The manifest already carries a previous build's output. */
  function withAPreviousBuild(): void {
    const artifact = db
      .rows('flowstarter_project_artifacts')
      .find((row) => row.workspace_id === WORKSPACE_A);
    (artifact?.['preview_manifest'] as { files: Row[] }).files.push({
      path: 'dist/index.html',
      content: '<html></html>',
    });
  }

  it('marks a version and says what still has to happen', async () => {
    const response = await PUBLISH(post('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.version).toBe(1);
    // No server allocated in this fixture, and that is what the client is told.
    expect(body.deploy.mode).toBe('no_host');
    expect(body.deploy.detail).toMatch(/marked to publish/);
    // Nothing to rebuild onto, so nothing is queued and nothing is nudged.
    expect(body.rebuildJobId).toBeNull();
    expect(db.rows('flowstarter_agent_jobs')).toEqual([]);
    expect(dispatched).toEqual([]);

    const published = db.rows('site_versions').find((row) => row.version === 1);
    expect(published?.published_at).toBeTruthy();
    expect(
      db
        .rows('project_events')
        .some((row) => row.kind === 'site_publish_requested')
    ).toBe(true);
  });

  it('queues the rebuild that puts the edit live, and nudges the worker', async () => {
    hostThePublishedSite();

    const response = await PUBLISH(post('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deploy.mode).toBe('rebuild_queued');
    expect(body.deploy.detail).toMatch(/being rebuilt/);

    const jobs = db.rows('flowstarter_agent_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      workspace_id: WORKSPACE_A,
      kind: 'SITE_REBUILD',
      status: 'queued',
    });
    expect(jobs[0]['payload']).toMatchObject({
      trigger: 'client_publish',
      version: body.version,
      publishedBy: 'user_client_a',
    });
    expect(body.rebuildJobId).toBe(jobs[0]['id']);
    expect(dispatched).toEqual([jobs[0]['id']]);
  });

  it('joins the rebuild already in flight rather than starting a second one', async () => {
    hostThePublishedSite();

    const first = await (await PUBLISH(post('/x'), params(WORKSPACE_A))).json();
    dispatched.length = 0;
    const second = await (
      await PUBLISH(post('/x'), params(WORKSPACE_A))
    ).json();

    // Two rebuilds of one workspace would race for the same worktree, and the
    // loser would deploy stale files over the winner.
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(1);
    expect(second.rebuildJobId).toBe(first.rebuildJobId);
    expect(second.deploy.mode).toBe('rebuild_queued');
    // Still nudged: the first nudge may have been the one that was lost.
    expect(dispatched).toEqual([first.rebuildJobId]);
  });

  it('queues a rebuild for a site that is already built and hosted too', async () => {
    // The other branch: a live host with a deploy agent behind it. The
    // previous build is exactly what must not be re-published as-is, so this
    // still queues rather than deploying what is already there.
    hostThePublishedSite();
    withAPreviousBuild();
    process.env.DEPLOY_AGENT_SHARED_SECRET = 'x'.repeat(40);
    try {
      const body = await (
        await PUBLISH(post('/x'), params(WORKSPACE_A))
      ).json();
      expect(body.deploy.mode).toBe('rebuild_queued');
      expect(body.deploy.hasBuild).toBe(true);
      expect(db.rows('flowstarter_agent_jobs')).toHaveLength(1);
    } finally {
      delete process.env.DEPLOY_AGENT_SHARED_SECRET;
    }
  });

  it('queues a fresh rebuild when the only one on the ledger has finished', async () => {
    hostThePublishedSite();
    db.seed('flowstarter_agent_jobs', [
      {
        id: 'done-1',
        workspace_id: WORKSPACE_A,
        kind: 'SITE_REBUILD',
        status: 'succeeded',
        payload: {},
      },
    ]);

    const body = await (await PUBLISH(post('/x'), params(WORKSPACE_A))).json();
    expect(body.rebuildJobId).not.toBe('done-1');
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(2);
  });

  it('queues a second rebuild behind one that is already running, instead of joining it', async () => {
    // The worker freezes the manifest at claim time, so a `running` job is
    // already building the OLD manifest. Joining it would silently drop this
    // publish's edit, so it has to get its own `queued` job that waits behind
    // the running one.
    hostThePublishedSite();
    db.seed('flowstarter_agent_jobs', [
      {
        id: 'running-1',
        workspace_id: WORKSPACE_A,
        kind: 'SITE_REBUILD',
        status: 'running',
        payload: {},
      },
    ]);

    const body = await (await PUBLISH(post('/x'), params(WORKSPACE_A))).json();
    expect(body.deploy.mode).toBe('rebuild_queued');
    expect(body.rebuildJobId).not.toBe('running-1');

    const jobs = db.rows('flowstarter_agent_jobs');
    expect(jobs).toHaveLength(2);
    const queued = jobs.find((row) => row.id === body.rebuildJobId);
    expect(queued).toMatchObject({ status: 'queued', kind: 'SITE_REBUILD' });
    const running = jobs.find((row) => row.id === 'running-1');
    expect(running?.status).toBe('running');
  });

  it('joins a queued rebuild even while a different one is already running', async () => {
    // Confirms the join rule reads status, not just "something in flight":
    // a queued job's manifest is not frozen yet, so it is safe to join even
    // though a running job also exists for the same workspace.
    hostThePublishedSite();
    db.seed('flowstarter_agent_jobs', [
      {
        id: 'running-1',
        workspace_id: WORKSPACE_A,
        kind: 'SITE_REBUILD',
        status: 'running',
        payload: {},
      },
      {
        id: 'queued-1',
        workspace_id: WORKSPACE_A,
        kind: 'SITE_REBUILD',
        status: 'queued',
        payload: {},
      },
    ]);

    const body = await (await PUBLISH(post('/x'), params(WORKSPACE_A))).json();
    expect(body.rebuildJobId).toBe('queued-1');
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(2);
  });
});

// ── 8. Bigger changes: escalation with rule-based classification ───────────

describe('escalating a bigger change', () => {
  it('files a structural request into the thread as a change_request', async () => {
    const response = await ESCALATE(
      post('/x', {
        request: 'Add a page for group workshops with a booking calendar',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.classification).toBe('structural');
    expect(body.escalated).toBe(true);

    const message = db
      .rows('project_messages')
      .find((row) => row.kind === 'change_request');
    expect(message).toBeTruthy();
    expect(message?.direction).toBe('inbound');
    expect(message?.status).toBe('sent');
    expect(String(message?.body)).toContain('group workshops');
  });

  it('points a wording request back at the editor without filing anything', async () => {
    const response = await ESCALATE(
      post('/x', { request: 'Fix the typo in the about paragraph please' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.classification).toBe('content');
    expect(body.escalated).toBe(false);
    expect(
      db.rows('project_messages').some((row) => row.kind === 'change_request')
    ).toBe(false);
  });

  it('files anyway when the client insists', async () => {
    const response = await ESCALATE(
      post('/x', {
        request: 'Fix the typo in the about paragraph please',
        force: true,
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(201);
    expect((await response.json()).escalated).toBe(true);
    expect(
      db.rows('project_messages').some((row) => row.kind === 'change_request')
    ).toBe(true);
  });

  it('is 404 on a workspace that is not yours, and files nothing', async () => {
    const response = await ESCALATE(
      post('/x', { request: 'Add a booking page to this site' }),
      params(WORKSPACE_B)
    );
    expect(response.status).toBe(404);
    expect(db.rows('project_messages')).toHaveLength(0);
  });

  it('refuses when the subscription has lapsed, in the policy’s own words', async () => {
    db.reset();
    seedWorkspace('past_due');
    const response = await ESCALATE(
      post('/x', { request: 'Add a booking page to this site' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.policy?.action).toBe('deny');
    expect(db.rows('project_messages')).toHaveLength(0);
  });
});

// ── 9. The other two ways in ───────────────────────────────────────────────

describe('a team member at a client editor', () => {
  beforeEach(() => {
    // A team account is authorized for the workspace, and is still not a
    // client: the policy routes an operator to the isolated workbench.
    authState.role = 'team';
  });

  it('is refused on every client route, in the policy’s own words', async () => {
    const cases: Array<[string, () => Promise<Response>]> = [
      ['images:list', () => LIST_IMAGES(get('/x'), params(WORKSPACE_A))],
      [
        'images:swap',
        () =>
          SWAP_IMAGE(
            post('/x', { slotId: IMAGE_SLOT, assetId: ASSET_CONFIRMED }),
            params(WORKSPACE_A)
          ),
      ],
      ['revert', () => REVERT(post('/x', { version: 1 }), params(WORKSPACE_A))],
      ['publish', () => PUBLISH(post('/x'), params(WORKSPACE_A))],
      [
        'edit',
        () =>
          EDIT(
            post('/x', { targetId: LABEL_TARGET, instruction: 'warmer' }),
            params(WORKSPACE_A)
          ),
      ],
    ];

    for (const [name, call] of cases) {
      const response = await call();
      expect(response.status, name).toBe(403);
      const body = await response.json();
      expect(body.policy?.action, name).toBe('operator_workbench');
      expect(body.error, name).toMatch(/isolated full editor/);
    }

    // Nothing was written to the client's site on the way past.
    expect(db.rows('site_versions')).toEqual([]);
    expect(inlineEdit.calls).toHaveLength(0);
  });
});

describe('a workspace whose site has not been delivered yet', () => {
  beforeEach(() => {
    db.reset();
    db.seed('workspaces', [
      {
        id: WORKSPACE_A,
        name: 'Halden & Roe',
        slug: 'halden-roe',
        subscription_status: 'active',
        hosting_server_id: null,
        deploy_status: 'none',
      },
    ]);
    db.seed('workspace_memberships', [
      { workspace_id: WORKSPACE_A, clerk_user_id: 'user_client_a' },
    ]);
  });

  it('says there is no site to edit rather than showing an empty one', async () => {
    const response = await LIST_IMAGES(get('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe('NOT_FOUND');
    expect(body.error).toMatch(/no site to edit yet/);
  });

  it('answers the same way on the preview frame', async () => {
    const response = await PREVIEW(get('/x'), params(WORKSPACE_A, []));
    expect(response.status).toBe(404);
  });
});

// ── 10. Images: the refusals under the swap ────────────────────────────────

describe('the picture swap, when it cannot happen', () => {
  beforeEach(() => {
    seedAssets();
  });

  it('reports a failure to read the library rather than an empty one', async () => {
    db.failQuery({
      table: 'assets',
      mode: 'select',
      error: { message: 'statement timeout' },
    });
    const response = await LIST_IMAGES(get('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe('INTERNAL');
    // The database's own words stay in the log.
    expect(JSON.stringify(body)).not.toContain('statement timeout');
  });

  it('asks for a slot and a file when the body names neither', async () => {
    const response = await SWAP_IMAGE(
      post('/x', { slotId: '', assetId: 'not-a-uuid' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID');
    expect(db.downloads).toEqual([]);
  });

  it('refuses a row whose stored path points at another tenant', async () => {
    // The row is this workspace's, the path is not. This is a bug in the data
    // rather than in the request, and it must not be downloaded on the way.
    db.seed('assets', [
      {
        id: '44444444-4444-4444-8444-444444444444',
        workspace_id: WORKSPACE_A,
        source: 'upload',
        storage_path: `tenant/${WORKSPACE_B}/assets/ghi.png`,
        rights_confirmed_at: '2026-08-01T00:00:00.000Z',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]);
    db.downloads.length = 0;

    const response = await SWAP_IMAGE(
      post('/x', {
        slotId: IMAGE_SLOT,
        assetId: '44444444-4444-4444-8444-444444444444',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe('INTERNAL');
    expect(db.downloads).toEqual([]);
    expect(db.rows('site_versions')).toEqual([]);
  });

  it('refuses a row that has no stored copy at all', async () => {
    db.seed('assets', [
      {
        id: '55555555-5555-4555-8555-555555555555',
        workspace_id: WORKSPACE_A,
        source: 'upload',
        storage_path: null,
        rights_confirmed_at: '2026-08-01T00:00:00.000Z',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]);
    const response = await SWAP_IMAGE(
      post('/x', {
        slotId: IMAGE_SLOT,
        assetId: '55555555-5555-4555-8555-555555555555',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('That file has no stored copy');
  });

  it('refuses when the object behind the row cannot be read', async () => {
    db.objects.delete(`tenant/${WORKSPACE_A}/assets/abc.png`);
    const response = await SWAP_IMAGE(
      post('/x', { slotId: IMAGE_SLOT, assetId: ASSET_CONFIRMED }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('That file could not be read');
    expect(db.rows('site_versions')).toEqual([]);
  });

  it('refuses a slot that is not part of this site', async () => {
    const response = await SWAP_IMAGE(
      post('/x', {
        slotId: 'src/content/site-labels.md#999',
        assetId: ASSET_CONFIRMED,
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/image slot is not part/);
    expect(db.rows('site_versions')).toEqual([]);
  });

  it('re-reads the bytes and refuses a picture too small to use', async () => {
    // The row says image/png and the rights are confirmed; the object itself
    // is a 120px thumbnail. A row written before the check existed still
    // cannot put an unusable picture on a client's site.
    db.objects.set(`tenant/${WORKSPACE_A}/assets/abc.png`, pngBytes(120, 80));
    const response = await SWAP_IMAGE(
      post('/x', { slotId: IMAGE_SLOT, assetId: ASSET_CONFIRMED }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('IMAGE_REJECTED');
    expect(body.error).toMatch(/blurry/);
    expect(db.rows('site_versions')).toEqual([]);
  });

  it('keeps the alt text the client sent with the picture', async () => {
    const response = await SWAP_IMAGE(
      post('/x', {
        slotId: IMAGE_SLOT,
        assetId: ASSET_CONFIRMED,
        alt: 'The studio on Carr Lane',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);
    expect(contentOf(WORKSPACE_A)).toContain(
      'imageAlt: "The studio on Carr Lane"'
    );
  });
});

// ── 11. Revert: the refusals ───────────────────────────────────────────────

describe('reverting, when the request does not make sense', () => {
  it('refuses a body that is not JSON at all', async () => {
    const response = await REVERT(
      new NextRequest('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'version three please',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Send a JSON body');
  });

  it('asks for a version number when the body has none', async () => {
    const response = await REVERT(post('/x', {}), params(WORKSPACE_A));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID');
    expect(db.rows('site_versions')).toEqual([]);
  });

  it('refuses to revert to the version already on screen', async () => {
    await APPLY(
      post('/x', {
        targetId: LABEL_TARGET,
        originalContent: 'Operations consultancy',
        replacementContent: 'Operations and strategy consultancy',
      }),
      params(WORKSPACE_A)
    );

    const response = await REVERT(
      post('/x', { version: 2 }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      'That is already the current version.'
    );
    // No fourth version was appended for a change that was not one.
    expect(db.rows('site_versions')).toHaveLength(2);
  });
});

// ── 12. The editor's cost and availability ─────────────────────────────────

describe('what an edit costs and when it cannot run', () => {
  it('puts the run’s tokens on the tenant’s own ledger', async () => {
    inlineEdit.usage = {
      action: 'preview_edit',
      model: 'z-ai/glm-5.2',
      tokensIn: 1200,
      tokensOut: 90,
      cachedTokens: 0,
    };

    const response = await EDIT(
      post('/x', { targetId: LABEL_TARGET, instruction: 'warmer' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);

    // An authenticated editor run belongs to a workspace; billing it to
    // nobody is how a tenant's usage goes missing.
    expect(llmLedger).toHaveLength(1);
    expect(llmLedger[0]).toMatchObject({
      workspaceId: WORKSPACE_A,
      projectId: null,
      action: 'preview_edit',
      tokensIn: 1200,
      tokensOut: 90,
    });
  });

  it('stops the burst before it becomes a bill', async () => {
    const attempts: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await EDIT(
        post('/x', {
          targetId: LABEL_TARGET,
          instruction: `change number ${attempt}`,
        }),
        params(WORKSPACE_BURST)
      );
      attempts.push(response.status);
      if (response.status === 429) {
        const body = await response.json();
        expect(body.code).toBe('RATE_LIMITED');
        expect(body.retryAt).toEqual(expect.any(Number));
        break;
      }
      expect(response.status).toBe(200);
    }

    // The bucket holds six a minute, so the refusal has to arrive well
    // inside eight tries — and the model is not asked for the one refused.
    expect(attempts).toContain(429);
    expect(inlineEdit.calls).toHaveLength(attempts.length - 1);
  });

  it('says the assistant is not configured rather than failing obscurely', async () => {
    delete process.env.PI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const response = await EDIT(
      post('/x', { targetId: LABEL_TARGET, instruction: 'warmer' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe('EDITOR_UNAVAILABLE');
    expect(body.error).toMatch(/not configured/);
    // The proposal was still counted against the day, because the row is
    // what the cap counts and it is written before the model runs.
    expect(
      db
        .rows('project_events')
        .filter((row) => row.kind === 'site_edit_proposed')
    ).toHaveLength(1);
  });

  it('falls back to the OpenRouter key when no Pi key is set', async () => {
    process.env.PI_API_KEY = '   ';
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    try {
      const response = await EDIT(
        post('/x', { targetId: LABEL_TARGET, instruction: 'warmer' }),
        params(WORKSPACE_A)
      );
      expect(response.status).toBe(200);
      expect(inlineEdit.calls).toHaveLength(1);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('does not leak the provider’s error text when a run fails', async () => {
    inlineEdit.failure = new Error(
      'openrouter 401: key sk-or-v1-abcdef is invalid'
    );
    const response = await EDIT(
      post('/x', { targetId: LABEL_TARGET, instruction: 'warmer' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: 'Something went wrong on our side.',
      code: 'INTERNAL',
    });
    expect(JSON.stringify(body)).not.toContain('sk-or-v1');
    expect(db.rows('site_versions')).toEqual([]);
  });
});

// ── 13. Publishing: the answers that are not "it is building" ──────────────

describe('publishing when the build cannot be started', () => {
  function hostThePublishedSite(
    deployAgentUrl: string | null = 'https://agent.test'
  ): void {
    db.seed('hosting_servers', [
      { id: 'host-1', deploy_agent_url: deployAgentUrl },
    ]);
    const workspace = db
      .rows('workspaces')
      .find((row) => row.id === WORKSPACE_A);
    if (workspace) workspace['hosting_server_id'] = 'host-1';
  }

  function withAPreviousBuild(): void {
    const artifact = db
      .rows('flowstarter_project_artifacts')
      .find((row) => row.workspace_id === WORKSPACE_A);
    (artifact?.['preview_manifest'] as { files: Row[] }).files.push({
      path: 'dist/index.html',
      content: '<html></html>',
    });
  }

  it('says it was a dry run when the environment has no deploy agent', async () => {
    // A hosted, already-built site whose new build would have nowhere to go:
    // publishing it must not claim the change is on its way live.
    hostThePublishedSite();
    withAPreviousBuild();
    delete process.env.DEPLOY_AGENT_SHARED_SECRET;

    const response = await PUBLISH(post('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deploy).toMatchObject({
      mode: 'dry_run',
      hasHost: true,
      hasBuild: true,
      agentConfigured: false,
    });
    expect(body.deploy.detail).toMatch(/dry run/);
    expect(body.rebuildJobId).toBeNull();
    expect(db.rows('flowstarter_agent_jobs')).toEqual([]);
  });

  it('treats a host with no deploy agent url the same way', async () => {
    hostThePublishedSite(null);
    withAPreviousBuild();
    process.env.DEPLOY_AGENT_SHARED_SECRET = 'x'.repeat(40);
    try {
      const body = await (
        await PUBLISH(post('/x'), params(WORKSPACE_A))
      ).json();
      expect(body.deploy.mode).toBe('dry_run');
      expect(body.deploy.agentConfigured).toBe(false);
    } finally {
      delete process.env.DEPLOY_AGENT_SHARED_SECRET;
    }
  });

  it('keeps the queued job when the worker cannot be nudged', async () => {
    hostThePublishedSite();
    dispatchFailure.error = new Error('connect ECONNREFUSED worker:4000');

    const response = await PUBLISH(post('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    const body = await response.json();
    // The ledger row is the commitment; the nudge is only a nudge, and an
    // operator can re-dispatch a queued job.
    expect(body.deploy.mode).toBe('rebuild_queued');
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(1);
    expect(dispatched).toEqual([]);

    const event = db
      .rows('project_events')
      .find((row) => row.kind === 'site_publish_requested');
    expect(event?.payload).toMatchObject({ dispatched: false });
  });

  it('records the nudge failure even when it was not an Error', async () => {
    hostThePublishedSite();
    dispatchFailure.error = 'worker refused the connection';
    const response = await PUBLISH(post('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    expect(dispatched).toEqual([]);
  });

  it('publishes the version already on screen rather than snapshotting again', async () => {
    await APPLY(
      post('/x', {
        targetId: LABEL_TARGET,
        originalContent: 'Operations consultancy',
        replacementContent: 'Operations and strategy consultancy',
      }),
      params(WORKSPACE_A)
    );

    const body = await (await PUBLISH(post('/x'), params(WORKSPACE_A))).json();
    // Versions 1 and 2 exist already; publishing marks 2 rather than making 3.
    expect(body.version).toBe(2);
    expect(db.rows('site_versions')).toHaveLength(2);
    const published = db.rows('site_versions').find((row) => row.version === 2);
    expect(published?.published_at).toEqual(expect.any(String));
  });

  it('fails the publish rather than reporting one that did not happen', async () => {
    db.failQuery({
      table: 'site_versions',
      mode: 'insert',
      error: { code: '42501', message: 'permission denied for site_versions' },
    });
    const response = await PUBLISH(post('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe('INTERNAL');
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(db.rows('flowstarter_agent_jobs')).toEqual([]);
  });
});

// ── 14. Serving the site: the two other shapes a manifest holds ────────────

describe('serving a manifest that has been built', () => {
  function withABuiltIndex(): void {
    const artifact = db
      .rows('flowstarter_project_artifacts')
      .find((row) => row.workspace_id === WORKSPACE_A);
    (artifact?.['preview_manifest'] as { files: Row[] }).files.push({
      path: 'dist/index.html',
      content:
        '<html><body><h1 data-flowstarter-id="hero">Decisions that hold</h1></body></html>',
    });
  }

  it('serves the built page, with the selection bridge in it', async () => {
    withABuiltIndex();
    const response = await PREVIEW(
      get('/x'),
      params(WORKSPACE_A, ['index.html'])
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8'
    );
    const html = await response.text();
    expect(html).toContain('Decisions that hold');
    // Click-to-select has to reach the built page too, or the panel cannot
    // address anything on it.
    expect(html).toContain('flowstarter-site-preview');
  });

  it('serves the root of a built site the same way', async () => {
    withABuiltIndex();
    // No path segments at all: the frame's own src.
    const response = await PREVIEW(get('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Decisions that hold');
  });

  it('serves a stored binary as bytes rather than as text', async () => {
    const bytes = pngBytes();
    const artifact = db
      .rows('flowstarter_project_artifacts')
      .find((row) => row.workspace_id === WORKSPACE_A);
    (artifact?.['preview_manifest'] as { files: Row[] }).files.push({
      path: 'public/flowstarter-media/hero-13.png',
      content: bytes.toString('base64'),
      encoding: 'base64',
    });

    const response = await PREVIEW(
      get('/x'),
      params(WORKSPACE_A, ['flowstarter-media', 'hero-13.png'])
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const served = Buffer.from(await response.arrayBuffer());
    expect(served.equals(bytes)).toBe(true);
  });
});

// ── 15. Bigger changes: the quote, and the client's answer to it ───────────

const CHANGE_QUOTED = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CHANGE_OTHER_TENANT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

function seedChangeRequest(overrides: Row = {}): Row {
  const row: Row = {
    id: CHANGE_QUOTED,
    workspace_id: WORKSPACE_A,
    message_id: null,
    request: 'Add a page for group workshops',
    classification: 'structural',
    matched_rules: ['structural:new-thing'],
    status: 'quoted',
    quote_minor: 19_000,
    currency: 'eur',
    quote_note: 'One new page, copy included.',
    quoted_by: 'user_operator',
    quoted_at: '2026-09-01T09:00:00.000Z',
    responded_at: null,
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    paid_at: null,
    completed_at: null,
    created_by: 'user_client_a',
    created_at: '2026-09-01T08:00:00.000Z',
    updated_at: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
  db.seed('flowstarter_change_requests', [row]);
  return row;
}

function respond(
  changeId: string,
  body?: unknown,
  origin?: string
): NextRequest {
  return new NextRequest('http://localhost/x', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function changeRow(id: string): Row | undefined {
  return db.rows('flowstarter_change_requests').find((row) => row.id === id);
}

describe('the change requests a client can see', () => {
  it('lists this workspace’s requests and nobody else’s', async () => {
    seedChangeRequest();
    seedChangeRequest({
      id: CHANGE_OTHER_TENANT,
      workspace_id: WORKSPACE_B,
      request: 'Somebody else’s change',
    });

    const response = await LIST_CHANGES(get('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    // Never cached: a quote changes and a stale one is a wrong price.
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    const body = (await response.json()) as {
      requests: Array<{ id: string; quoteMinor: number; status: string }>;
    };
    expect(body.requests.map((row) => row.id)).toEqual([CHANGE_QUOTED]);
    expect(body.requests[0]).toMatchObject({
      status: 'quoted',
      quoteMinor: 19_000,
    });
    // The operator's opening number is not the client's business.
    expect(body.requests[0]).not.toHaveProperty('suggestedQuoteMinor');
  });

  it('is 404 on a workspace that is not yours', async () => {
    seedChangeRequest({ id: CHANGE_OTHER_TENANT, workspace_id: WORKSPACE_B });
    db.queries.length = 0;
    const response = await LIST_CHANGES(get('/x'), params(WORKSPACE_B));
    expect(response.status).toBe(404);
    expect(dataQueries()).toEqual([]);
  });

  it('reports a failure to read rather than an empty list', async () => {
    db.failQuery({
      table: 'flowstarter_change_requests',
      mode: 'select',
      error: { message: 'statement timeout' },
    });
    const response = await LIST_CHANGES(get('/x'), params(WORKSPACE_A));
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe('INTERNAL');
  });
});

describe('answering a quote', () => {
  it('is 404 on a workspace that is not yours, and answers nothing', async () => {
    seedChangeRequest({ id: CHANGE_OTHER_TENANT, workspace_id: WORKSPACE_B });
    db.queries.length = 0;
    const response = await RESPOND(
      respond(CHANGE_OTHER_TENANT, { decision: 'accept' }),
      changeParams(WORKSPACE_B, CHANGE_OTHER_TENANT)
    );
    expect(response.status).toBe(404);
    expect(dataQueries()).toEqual([]);
    expect(checkout.calls).toHaveLength(0);
    expect(changeRow(CHANGE_OTHER_TENANT)?.status).toBe('quoted');
  });

  it('refuses an id that is not an id', async () => {
    const response = await RESPOND(
      respond('nope', { decision: 'accept' }),
      changeParams(WORKSPACE_A, 'nope')
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID');
  });

  it('refuses a decision it does not recognise', async () => {
    seedChangeRequest();
    const response = await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'maybe' }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/accept or decline/);
    expect(changeRow(CHANGE_QUOTED)?.status).toBe('quoted');
  });

  it('will not answer another tenant’s quote', async () => {
    // The id is real, and it is not this workspace's. 404, not 403: the
    // answer must not confirm that somebody else's request exists.
    seedChangeRequest({ id: CHANGE_OTHER_TENANT, workspace_id: WORKSPACE_B });
    const response = await RESPOND(
      respond(CHANGE_OTHER_TENANT, { decision: 'accept' }),
      changeParams(WORKSPACE_A, CHANGE_OTHER_TENANT)
    );
    expect(response.status).toBe(404);
    expect(checkout.calls).toHaveLength(0);
    expect(changeRow(CHANGE_OTHER_TENANT)?.status).toBe('quoted');
  });

  it('says a request has not been quoted yet rather than pricing it', async () => {
    seedChangeRequest({ status: 'requested', quote_minor: null });
    const response = await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'accept' }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('CHANGE_REQUEST_TRANSITION');
    expect(body.error).toMatch(/not quoted this yet/);
    expect(checkout.calls).toHaveLength(0);
  });

  it('says what a settled request already is', async () => {
    seedChangeRequest({ status: 'paid', paid_at: '2026-09-02T09:00:00.000Z' });
    const response = await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'decline' }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('This request is already paid.');
  });

  it('declines a quote, and records who declined it', async () => {
    seedChangeRequest();
    const response = await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'decline' }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(200);
    expect((await response.json()).request).toMatchObject({
      status: 'declined',
      respondedAt: expect.any(String),
    });
    expect(changeRow(CHANGE_QUOTED)?.status).toBe('declined');

    const event = db
      .rows('project_events')
      .find((row) => row.kind === 'change_request_declined');
    expect(event?.actor).toBe('user_client_a');
    expect(event?.payload).toMatchObject({ by: 'client' });
  });

  it('will not decline a request that is already in checkout', async () => {
    // Stripe may be about to report that session as paid; declining it here
    // would leave a paid request marked declined.
    seedChangeRequest({
      status: 'accepted',
      stripe_checkout_session_id: 'cs_test_open',
    });
    const response = await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'decline' }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/cannot be declined here/);
    expect(changeRow(CHANGE_QUOTED)?.status).toBe('accepted');
  });

  it('settles a zero quote without sending anyone to Stripe', async () => {
    seedChangeRequest({ quote_minor: 0 });
    const response = await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'accept' }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(200);
    expect((await response.json()).request).toMatchObject({
      status: 'paid',
      quoteMinor: 0,
    });
    // There is nothing to collect, so no session is opened.
    expect(checkout.calls).toHaveLength(0);
    const event = db
      .rows('project_events')
      .find((row) => row.kind === 'change_request_paid');
    expect(event?.payload).toMatchObject({ amountMinor: 0, free: true });
  });

  it('will not re-settle a zero quote that is already in checkout', async () => {
    seedChangeRequest({ quote_minor: 0, status: 'accepted' });
    const response = await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'accept' }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('CHANGE_REQUEST_TRANSITION');
  });

  it('opens a checkout for a priced quote, with the client’s own details', async () => {
    seedChangeRequest();
    const workspace = db
      .rows('workspaces')
      .find((row) => row.id === WORKSPACE_A);
    if (workspace) workspace['client_email'] = 'owner@halden-roe.test';

    const response = await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'accept' }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      checkoutUrl: 'https://checkout.stripe.test/session/cs_test_123',
    });
    expect(checkout.calls).toHaveLength(1);
    expect(checkout.calls[0]).toMatchObject({
      clientEmail: 'owner@halden-roe.test',
      businessName: 'Halden & Roe',
    });
  });

  it('sends the client back to this deployment, not to a header they chose', async () => {
    seedChangeRequest();
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app.flowstarter.test';
    try {
      await RESPOND(
        respond(CHANGE_QUOTED, { decision: 'accept' }, 'https://attacker.test'),
        changeParams(WORKSPACE_A, CHANGE_QUOTED)
      );
      expect(checkout.calls[0]).toMatchObject({
        origin: 'https://app.flowstarter.test',
      });
    } finally {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    }
  });

  it('falls back to the request’s own origin when none is configured', async () => {
    seedChangeRequest();
    delete process.env.NEXT_PUBLIC_SITE_URL;
    await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'accept' }, 'https://studio.example/'),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(checkout.calls[0]).toMatchObject({
      origin: 'https://studio.example',
    });
  });

  it('uses a loopback origin in development', async () => {
    seedChangeRequest();
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';
    try {
      await RESPOND(
        respond(CHANGE_QUOTED, { decision: 'accept' }),
        changeParams(WORKSPACE_A, CHANGE_QUOTED)
      );
      expect(checkout.calls[0]).toMatchObject({
        origin: 'http://localhost:3000',
      });
    } finally {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    }
  });

  it('ignores a configured origin that is not a usable one', async () => {
    seedChangeRequest();
    // Plain http on a public host would send a paying client over the wire in
    // the clear, so it is not used.
    process.env.NEXT_PUBLIC_SITE_URL = 'http://app.flowstarter.test';
    try {
      await RESPOND(
        respond(CHANGE_QUOTED, { decision: 'accept' }),
        changeParams(WORKSPACE_A, CHANGE_QUOTED)
      );
      expect(checkout.calls[0]).toMatchObject({ origin: 'http://localhost' });
    } finally {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    }
  });

  it('ignores a configured origin that is not a url at all', async () => {
    seedChangeRequest();
    process.env.NEXT_PUBLIC_SITE_URL = 'not a url';
    try {
      await RESPOND(
        respond(CHANGE_QUOTED, { decision: 'accept' }),
        changeParams(WORKSPACE_A, CHANGE_QUOTED)
      );
      expect(checkout.calls[0]).toMatchObject({ origin: 'http://localhost' });
    } finally {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    }
  });

  it('passes a payments failure through in its own words', async () => {
    seedChangeRequest();
    checkout.failure = new ChangeRequestError(
      'Payments are not configured.',
      'STRIPE_UNCONFIGURED',
      503
    );
    const response = await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'accept' }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Payments are not configured.',
      code: 'STRIPE_UNCONFIGURED',
    });
    expect(changeRow(CHANGE_QUOTED)?.status).toBe('quoted');
  });

  it('refuses a decline that lost a race to something else', async () => {
    // The compare-and-set found nothing to update: the row moved on between
    // the read and the write.
    seedChangeRequest();
    db.failQuery({
      table: 'flowstarter_change_requests',
      mode: 'update',
      data: [],
    });
    const response = await RESPOND(
      respond(CHANGE_QUOTED, { decision: 'decline' }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('CHANGE_REQUEST_STALE');
    expect(body.error).toMatch(/Reload and try again/);
    expect(db.rows('project_events')).toEqual([]);
  });

  it('refuses a body that is not JSON', async () => {
    seedChangeRequest();
    const response = await RESPOND(
      new NextRequest('http://localhost/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'yes please',
      }),
      changeParams(WORKSPACE_A, CHANGE_QUOTED)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Send a JSON body');
  });
});
