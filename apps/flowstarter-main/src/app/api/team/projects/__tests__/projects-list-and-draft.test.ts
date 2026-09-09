/**
 * The operator project list and the draft-workspace creator, in both trees:
 *
 *   GET  /api/{team,admin}/projects
 *   POST /api/{team,admin}/projects/draft
 *
 * These run with the service-role key, so RLS is not in the way: the role
 * check at the top of each handler is the whole of the isolation. The list is
 * cross-tenant on purpose (an operator sees every workspace), so what has to
 * be proved is the refusal — nobody without an operator role reaches the
 * query, and no database message escapes into the response body.
 *
 * Clerk and `@supabase/supabase-js` are mocked; both handlers run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFakeSupabase,
  failures,
  nullData,
  resetFakeSupabase,
  rowsOf,
  seed,
  type Row,
} from './_support/fake-supabase';

vi.mock('server-only', () => ({}));

// ─── Clerk ──────────────────────────────────────────────────────────────────
const authState = vi.hoisted(() => ({
  userId: 'user_operator' as string | null,
  /** Role on the session claim, the cheap path both trees try first. */
  claimRole: undefined as string | undefined,
  /** Role on Clerk's user record, the fallback lookup. */
  metadataRole: undefined as string | undefined,
  /** Primary verified email, the last fallback in `resolveUserRole`. */
  email: 'someone@gmail.com' as string | null,
  /** Set to make `auth()` throw, standing in for Clerk being unreachable. */
  throwOnAuth: false,
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => {
    if (authState.throwOnAuth) throw new Error('clerk unreachable');
    return {
      userId: authState.userId,
      sessionClaims: authState.claimRole
        ? { metadata: { role: authState.claimRole } }
        : {},
      getToken: async () => 'test-token',
    };
  },
  currentUser: async () =>
    authState.userId
      ? {
          publicMetadata: authState.metadataRole
            ? { role: authState.metadataRole }
            : {},
        }
      : null,
  clerkClient: async () => ({
    users: {
      getUser: async () => ({
        publicMetadata: authState.metadataRole
          ? { role: authState.metadataRole }
          : {},
        emailAddresses: authState.email
          ? [{ id: 'idn_1', emailAddress: authState.email }]
          : [],
        primaryEmailAddressId: authState.email ? 'idn_1' : null,
      }),
    },
  }),
}));

// ─── Supabase ───────────────────────────────────────────────────────────────
const clientState = vi.hoisted(() => ({ ctorError: null as unknown }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    if (clientState.ctorError) throw clientState.ctorError;
    return createFakeSupabaseLazy();
  },
}));

// Indirection so the hoisted factory does not capture the helper before the
// support module has finished evaluating.
function createFakeSupabaseLazy() {
  return createFakeSupabase();
}

import { GET as teamList } from '../route';
import { GET as adminList } from '../../../admin/projects/route';
import { POST as teamDraft } from '../draft/route';
import { POST as adminDraft } from '../../../admin/projects/draft/route';

// ─── Helpers ────────────────────────────────────────────────────────────────
function post(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

function postWithBrokenBody(): Request {
  return {
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  } as unknown as Request;
}

function seedWorkspaces() {
  seed(
    'workspaces',
    {
      id: 'ws-old',
      name: 'Older client',
      slug: 'older-client',
      created_at: '2026-01-01T00:00:00.000Z',
      concierge_stage: 'launched',
      deploy_status: 'deployed',
    },
    {
      id: 'ws-new',
      name: 'Newer client',
      slug: 'newer-client',
      created_at: '2026-05-01T00:00:00.000Z',
      concierge_stage: 'build',
      deploy_status: null,
    },
    {
      id: 'ws-other-tenant',
      name: 'A workspace this operator never joined',
      slug: 'other-tenant',
      created_at: '2026-03-01T00:00:00.000Z',
      concierge_stage: null,
      deploy_status: null,
    }
  );
}

const LISTS: Array<[string, () => Promise<Response>]> = [
  ['team', () => teamList()],
  ['admin', () => adminList()],
];

beforeEach(() => {
  resetFakeSupabase();
  authState.userId = 'user_operator';
  authState.claimRole = undefined;
  authState.metadataRole = undefined;
  authState.email = 'someone@gmail.com';
  authState.throwOnAuth = false;
  clientState.ctorError = null;
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('GET /api/{team,admin}/projects — who may read the list', () => {
  it.each(LISTS)(
    '%s refuses an unauthenticated caller with 401',
    async (_tree, call) => {
      authState.userId = null;
      seedWorkspaces();

      const res = await call();
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
    }
  );

  it.each(LISTS)(
    '%s refuses a signed-in caller with no operator role with 403',
    async (_tree, call) => {
      // A workspace client: signed in, no role claim, no role on the Clerk
      // record, and an email outside the flowstarter domains.
      authState.userId = 'user_plain_client';
      seedWorkspaces();

      const res = await call();
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'Not a team member' });
    }
  );

  it.each(LISTS)(
    '%s accepts the role from the session claim and lists every workspace',
    async (_tree, call) => {
      authState.claimRole = 'team';
      seedWorkspaces();

      const res = await call();
      expect(res.status).toBe(200);
      const body = await res.json();
      // Cross-tenant by design: the operator dashboards show workspaces the
      // caller is not a member of, newest first.
      expect(body.projects.map((p: Row) => p.id)).toEqual([
        'ws-new',
        'ws-other-tenant',
        'ws-old',
      ]);
      expect(body.projects.map((p: Row) => p.status)).toEqual([
        'building',
        'intake',
        'live',
      ]);
      expect(res.headers.get('Cache-Control')).toBe(
        'public, s-maxage=10, stale-while-revalidate=30'
      );
    }
  );

  it.each(LISTS)(
    '%s falls back to the role on the Clerk user record, case-insensitively',
    async (_tree, call) => {
      authState.claimRole = undefined;
      authState.metadataRole = 'ADMIN';
      seedWorkspaces();

      const res = await call();
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        projects: expect.any(Array),
      });
    }
  );

  it.each(LISTS)(
    '%s returns 500 without leaking credentials when the query fails',
    async (_tree, call) => {
      authState.claimRole = 'team';
      failures['workspaces:select'] = {
        message: 'relation "workspaces" does not exist',
      };

      const res = await call();
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|eyJ/);
    }
  );

  it.each(LISTS)(
    '%s returns a generic 500 when the client cannot be built',
    async (_tree, call) => {
      authState.claimRole = 'team';
      clientState.ctorError = new Error(
        'supabaseKey is required: sk_service_role_abc'
      );

      const res = await call();
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to fetch projects');
      expect(JSON.stringify(body)).not.toMatch(/sk_service_role_abc/);
    }
  );

  it.each(LISTS)(
    '%s treats a null result set as no projects',
    async (_tree, call) => {
      authState.claimRole = 'team';
      nullData.add('workspaces:select');

      const res = await call();
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ projects: [] });
    }
  );
});

describe('GET /api/admin/projects — the email-domain role fallback', () => {
  it('lets a flowstarter address through with no metadata at all', async () => {
    authState.email = 'newhire@flowstarter.dev';
    seedWorkspaces();

    const res = await adminList();
    expect(res.status).toBe(200);
  });

  it('still refuses an address outside the flowstarter domains', async () => {
    authState.email = 'newhire@notflowstarter.dev';
    seedWorkspaces();

    const res = await adminList();
    expect(res.status).toBe(403);
  });
});

describe('POST /api/{team,admin}/projects/draft — who may create', () => {
  it('refuses an unauthenticated caller with 401 on both trees', async () => {
    authState.userId = null;

    for (const handler of [teamDraft, adminDraft]) {
      const res = await handler(post({}));
      expect(res.status).toBe(401);
      expect(rowsOf('workspaces')).toHaveLength(0);
    }
  });

  it('admin refuses a signed-in caller with no operator role with 403', async () => {
    authState.userId = 'user_plain_client';

    const res = await adminDraft(post({}));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
    expect(rowsOf('workspaces')).toHaveLength(0);
  });

  it('team refuses a signed-in caller with no operator role with 403', async () => {
    // The twin of the admin case above, and the reason this file exists.
    // /api/team/projects/draft used to check only that somebody was signed in,
    // so any client of any workspace could mint a workspace here and be
    // written into workspace_memberships as its admin. Both trees are the same
    // surface under two names; they now refuse the same caller the same way,
    // and nothing is written.
    authState.userId = 'user_plain_client';

    const res = await teamDraft(post({}));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
    expect(rowsOf('workspaces')).toHaveLength(0);
    expect(rowsOf('workspace_memberships')).toHaveLength(0);
  });

  it('team refuses an anonymous caller with 401 and writes nothing', async () => {
    authState.userId = null;

    const res = await teamDraft(post({}));
    expect(res.status).toBe(401);
    expect(rowsOf('workspaces')).toHaveLength(0);
  });
});

const DRAFTS: Array<[string, (req: Request) => Promise<Response>]> = [
  ['team', teamDraft],
  ['admin', adminDraft],
];

describe.each(DRAFTS)(
  'POST /api/%s/projects/draft — what it writes',
  (_tree, handler) => {
    beforeEach(() => {
      authState.claimRole = 'team';
    });

    it('seeds the workspace from the discovery-call client info', async () => {
      const res = await handler(
        post({
          projectConfig: {
            clientInfo: {
              name: 'Ana Pop',
              email: 'ana@acme.test',
              phone: '+40 700 000 000',
              businessName: 'Acme Coaching',
            },
          },
        })
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBeTruthy();
      // The client reads both keys; keep them in step.
      expect(body.projectId).toBe(body.id);

      const [workspace] = rowsOf('workspaces');
      expect(workspace).toMatchObject({
        name: 'Acme Coaching',
        client_name: 'Ana Pop',
        client_email: 'ana@acme.test',
        client_phone: '+40 700 000 000',
        client_business_name: 'Acme Coaching',
        concierge_stage: 'intake',
        site_kind: 'astro',
        commerce_mode: 'none',
        commerce_status: 'not_needed',
      });
      expect(workspace.slug).toMatch(/^acme-coaching-[a-z0-9]{1,6}$/);

      // The creator is recorded as an admin member of what they just made.
      expect(rowsOf('workspace_memberships')).toEqual([
        expect.objectContaining({
          workspace_id: workspace.id,
          clerk_user_id: 'user_operator',
          role: 'admin',
        }),
      ]);
    });

    it('names the workspace after the client when there is no business name', async () => {
      const res = await handler(
        post({ projectConfig: { clientInfo: { name: 'Ana Pop' } } })
      );
      expect(res.status).toBe(200);
      expect(rowsOf('workspaces')[0]).toMatchObject({
        name: "Ana Pop's Project",
        client_business_name: null,
      });
    });

    it('falls back to the supplied project name, then to Untitled Project', async () => {
      await handler(post({ projectConfig: { name: 'Spring campaign' } }));
      expect(rowsOf('workspaces')[0].name).toBe('Spring campaign');

      resetFakeSupabase();
      await handler(post({}));
      expect(rowsOf('workspaces')[0]).toMatchObject({
        name: 'Untitled Project',
        slug: expect.stringMatching(/^untitled-project-/),
      });
    });

    it('treats an unparseable body as an empty one, not as a 500', async () => {
      const res = await handler(postWithBrokenBody());
      expect(res.status).toBe(200);
      expect(rowsOf('workspaces')[0].name).toBe('Untitled Project');
    });

    it('honours shopify_liquid and an explicit commerce plan', async () => {
      const res = await handler(
        post({
          projectConfig: {
            name: 'Merch shop',
            siteKind: 'shopify_liquid',
            commerceInfo: {
              mode: 'managed_storefront',
              productType: 'physical',
              provider: 'shopify',
              status: 'configured',
              productCount: '12',
              requirements: { sizes: ['S', 'M'] },
              notes: 'Ships from Cluj',
            },
          },
        })
      );

      expect(res.status).toBe(200);
      expect(rowsOf('workspaces')[0]).toMatchObject({
        site_kind: 'shopify_liquid',
        commerce_mode: 'managed_storefront',
        commerce_product_type: 'physical',
        commerce_provider: 'shopify',
        commerce_status: 'configured',
        commerce_product_count: 12,
        commerce_requirements: { sizes: ['S', 'M'] },
        commerce_notes: 'Ships from Cluj',
      });
    });

    it('infers a commerce plan from the free-text brief when none is given', async () => {
      const res = await handler(
        post({
          projectConfig: {
            name: 'Studio Nord',
            businessInfo: {
              summary: 'They sell an online course and an ebook.',
            },
            userInput: 'Everything is digital.',
          },
        })
      );

      expect(res.status).toBe(200);
      expect(rowsOf('workspaces')[0]).toMatchObject({
        commerce_mode: 'digital_delivery',
        commerce_product_type: 'digital',
        commerce_provider: 'lemon_squeezy',
        commerce_status: 'discovery',
        commerce_product_count: 1,
      });
    });

    it('returns 500 without leaking credentials when the insert fails', async () => {
      failures['workspaces:insert'] = {
        message: 'duplicate key value violates unique constraint',
      };

      const res = await handler(post({}));
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|eyJ/);
      expect(rowsOf('workspace_memberships')).toHaveLength(0);
    });

    it('still returns the workspace when the membership insert fails', async () => {
      // Best effort on purpose: the workspace exists, the operator can be added
      // later, and failing here would strand a created row.
      failures['workspace_memberships:insert'] = {
        message: 'workspace_memberships is being vacuumed',
      };

      const res = await handler(post({ projectConfig: { name: 'Acme' } }));
      expect(res.status).toBe(200);
      expect(rowsOf('workspaces')).toHaveLength(1);
    });

    it('returns a generic 500 when the client cannot be built', async () => {
      clientState.ctorError = new Error(
        'supabaseKey is required: sk_service_role_abc'
      );

      const res = await handler(post({}));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to create draft project');
      expect(JSON.stringify(body)).not.toMatch(/sk_service_role_abc/);
    });

    it('admin surfaces a Clerk outage as a 500, not as an open door', async () => {
      authState.throwOnAuth = true;

      const res = await adminDraft(post({}));
      expect(res.status).toBe(500);
      expect(rowsOf('workspaces')).toHaveLength(0);
    });
  }
);
