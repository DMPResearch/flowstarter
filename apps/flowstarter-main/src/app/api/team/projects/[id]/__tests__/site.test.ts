/**
 * GET / POST /api/{team,admin}/projects/[id]/site.
 *
 * GET reports a workspace's hosting state; POST allocates the workspace to a
 * hosting server, which is the step that decides where a paying client's site
 * lives and what the preview domain resolves to. Re-allocation is refused on
 * purpose — moving a live site means a volume migration and a Caddy reconfig,
 * so the handler must not quietly repoint it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  createFakeSupabase,
  failures,
  nullData,
  resetFakeSupabase,
  rowsOf,
  seed,
  type Row,
} from '../../__tests__/_support/fake-supabase';

vi.mock('server-only', () => ({}));

// ─── Clerk ──────────────────────────────────────────────────────────────────
const authState = vi.hoisted(() => ({
  userId: 'user_operator' as string | null,
  role: 'team' as string | undefined,
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: authState.role ? { metadata: { role: authState.role } } : {},
    getToken: async () => 'test-token',
  }),
  currentUser: async () => null,
  clerkClient: async () => ({
    users: {
      getUser: async () => ({
        publicMetadata: {},
        emailAddresses: [{ id: 'idn_1', emailAddress: 'client@gmail.com' }],
        primaryEmailAddressId: 'idn_1',
      }),
    },
  }),
}));

// ─── Supabase ───────────────────────────────────────────────────────────────
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => buildFake(),
}));

function buildFake() {
  return createFakeSupabase();
}

// ─── platform-config ────────────────────────────────────────────────────────
// Not mocked. `resolvePlatformDomain` is the rule under test here as much as
// the route is, and a stub would let the route agree with a fiction. The
// suite runs as `test`, so the domain is the development one.

import { GET as teamGet, POST as teamPost } from '../site/route';
import {
  GET as adminGet,
  POST as adminPost,
} from '../../../../admin/projects/[id]/site/route';

// ─── Helpers ────────────────────────────────────────────────────────────────
const WORKSPACE_ID = '4f9c1a3e-0b7d-4a52-9c31-2f8e6d5b7a01';
const OTHER_WORKSPACE_ID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const SERVER_ID = 'srv_active_1';

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: NextRequest, ctx: Ctx) => Promise<Response>;

function ctx(id = WORKSPACE_ID): Ctx {
  return { params: Promise.resolve({ id }) };
}

function req(body?: unknown): NextRequest {
  return {
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON');
      return body;
    },
  } as unknown as NextRequest;
}

function seedWorkspace(overrides: Row = {}) {
  seed('workspaces', {
    id: WORKSPACE_ID,
    slug: 'acme-coaching',
    name: 'Acme Coaching',
    hosting_server_id: null,
    site_directory: null,
    deploy_status: null,
    last_deployed_at: null,
    ssl_status: null,
    ssl_issued_at: null,
    cloudflare_zone_id: null,
    cloudflare_record_ids: null,
    ...overrides,
  });
}

function seedServer(overrides: Row = {}) {
  const row: Row = {
    id: SERVER_ID,
    name: 'fsn1-a',
    provider: 'hetzner',
    location: 'fsn1',
    server_type: 'cx22',
    status: 'active',
    ipv4: '203.0.113.10',
    ipv6: null,
    site_capacity: 40,
    sites_count: 3,
    ...overrides,
  };
  seed('hosting_servers', row);
  return row;
}

function workspace(id = WORKSPACE_ID): Row | undefined {
  return rowsOf('workspaces').find((row) => row.id === id);
}

const GETS: Array<[string, Handler]> = [
  ['team', teamGet as Handler],
  ['admin', adminGet as Handler],
];
const POSTS: Array<[string, Handler]> = [
  ['team', teamPost as Handler],
  ['admin', adminPost as Handler],
];
const ALL: Array<[string, Handler]> = [
  ...GETS.map(([t, h]) => [`${t} GET`, h] as [string, Handler]),
  ...POSTS.map(([t, h]) => [`${t} POST`, h] as [string, Handler]),
];

beforeEach(() => {
  resetFakeSupabase();
  authState.userId = 'user_operator';
  authState.role = 'team';
});

describe('site: who may read or move hosting', () => {
  it.each(ALL)(
    '%s refuses an unauthenticated caller with 401',
    async (_name, handler) => {
      authState.userId = null;
      seedWorkspace();
      seedServer();

      const res = await handler(req({}), ctx());
      expect(res.status).toBe(401);
      expect(workspace()?.hosting_server_id).toBeNull();
    }
  );

  it.each(ALL)(
    '%s refuses a signed-in caller who is not an operator with 403',
    async (_name, handler) => {
      authState.userId = 'user_plain_client';
      authState.role = undefined;
      seedWorkspace();
      seedServer();

      const res = await handler(req({}), ctx());
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
      expect(workspace()?.hosting_server_id).toBeNull();
    }
  );

  it.each(ALL)(
    '%s returns 500 without leaking credentials when the read fails',
    async (_name, handler) => {
      failures['workspaces:select'] = {
        message: 'permission denied for table workspaces',
      };

      const res = await handler(req({}), ctx());
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|eyJ/);
    }
  );

  it.each(ALL)(
    '%s answers 404 for a workspace that does not exist',
    async (_name, handler) => {
      const res = await handler(req({}), ctx());
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: 'Workspace not found',
      });
    }
  );
});

describe.each(GETS)('GET /api/%s/projects/[id]/site', (_tree, handler) => {
  it('reports an unallocated workspace with no server', async () => {
    seedWorkspace();

    const res = await handler(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server).toBeNull();
    expect(body.deployments).toEqual([]);
    // The site's own name. It used to be `acme-coaching.preview.…`, which
    // put a paid site in the namespace the throwaway previews are reaped out
    // of.
    expect(body.siteDomain).toBe('acme-coaching.flowstarter.dev');
    expect(body.siteDomain).not.toContain('preview');
    expect(body.workspace).toMatchObject({ id: WORKSPACE_ID });
  });

  it('reports the assigned server and the last deployments', async () => {
    seedWorkspace({ hosting_server_id: SERVER_ID, deploy_status: 'deployed' });
    seedServer();
    seed(
      'deployments',
      {
        id: 'dep_1',
        workspace_id: WORKSPACE_ID,
        version: '1',
        status: 'succeeded',
      },
      {
        id: 'dep_2',
        workspace_id: WORKSPACE_ID,
        version: '2',
        status: 'succeeded',
      },
      {
        id: 'dep_other',
        workspace_id: OTHER_WORKSPACE_ID,
        version: '9',
        status: 'succeeded',
      }
    );

    const res = await handler(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server).toMatchObject({ id: SERVER_ID, ipv4: '203.0.113.10' });
    // Newest first, and only this workspace's.
    expect(body.deployments.map((d: Row) => d.id)).toEqual(['dep_2', 'dep_1']);
  });

  it('reports no deployments rather than null when the driver returns nothing', async () => {
    seedWorkspace();
    nullData.add('deployments:select');

    const res = await handler(req(), ctx());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deployments: [] });
  });
});

describe.each(POSTS)(
  'POST /api/%s/projects/[id]/site — allocation',
  (_tree, handler) => {
    it('picks the least-loaded active server with room', async () => {
      seedWorkspace();
      seedServer({ id: 'srv_busy', sites_count: 30 });
      seedServer({ id: 'srv_quiet', sites_count: 1 });
      seedServer({ id: 'srv_draining', status: 'draining', sites_count: 0 });

      const res = await handler(req({}), ctx());
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.reused).toBe(false);
      expect(body.workspace).toMatchObject({
        hosting_server_id: 'srv_quiet',
        site_directory: '/var/www/sites/acme-coaching/',
        deploy_status: 'pending',
      });

      // The chosen server's site count is resynced from the workspaces table.
      expect(
        rowsOf('hosting_servers').find((s) => s.id === 'srv_quiet')?.sites_count
      ).toBe(1);
    });

    it('treats a body that is not JSON as an empty one and still allocates', async () => {
      seedWorkspace();
      seedServer();

      const res = await handler(req(), ctx());
      expect(res.status).toBe(201);
    });

    it('refuses a workspace whose slug cannot be a directory', async () => {
      seedWorkspace({ slug: '../etc/passwd' });
      seedServer();

      const res = await handler(req({}), ctx());
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining('slug is invalid'),
      });
      expect(workspace()?.site_directory).toBeNull();
    });

    it('refuses a workspace with no slug at all', async () => {
      seedWorkspace({ slug: null });
      seedServer();

      const res = await handler(req({}), ctx());
      expect(res.status).toBe(400);
    });

    it('answers 409 when no active server has capacity', async () => {
      seedWorkspace();
      seedServer({ id: 'srv_full', sites_count: 40, site_capacity: 40 });

      const res = await handler(req({}), ctx());
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining(
          'No active hosting servers with capacity'
        ),
      });
      expect(workspace()?.hosting_server_id).toBeNull();
    });
  }
);

describe.each(POSTS)(
  'POST /api/%s/projects/[id]/site — an explicit server',
  (_tree, handler) => {
    it('allocates to the named server', async () => {
      seedWorkspace();
      seedServer({ id: 'srv_quiet', sites_count: 0 });
      seedServer({ id: 'srv_named', sites_count: 5 });

      const res = await handler(req({ server_id: 'srv_named' }), ctx());
      expect(res.status).toBe(201);
      expect(workspace()?.hosting_server_id).toBe('srv_named');
    });

    it('answers 404 for a server_id that does not exist', async () => {
      seedWorkspace();
      seedServer();

      const res = await handler(req({ server_id: 'srv_ghost' }), ctx());
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: 'server_id not found',
      });
    });

    it('refuses a server that is not active', async () => {
      seedWorkspace();
      seedServer({ status: 'provisioning' });

      const res = await handler(req({ server_id: SERVER_ID }), ctx());
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining('provisioning'),
      });
    });

    it('refuses a server that is at capacity', async () => {
      seedWorkspace();
      seedServer({ sites_count: 40, site_capacity: 40 });

      const res = await handler(req({ server_id: SERVER_ID }), ctx());
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: 'Server is at capacity',
      });
    });

    it('ignores an empty server_id and falls back to the automatic pick', async () => {
      seedWorkspace();
      seedServer({ id: 'srv_quiet', sites_count: 0 });

      const res = await handler(req({ server_id: '' }), ctx());
      expect(res.status).toBe(201);
      expect(workspace()?.hosting_server_id).toBe('srv_quiet');
    });
  }
);

describe.each(POSTS)(
  'POST /api/%s/projects/[id]/site — already allocated',
  (_tree, handler) => {
    it('is idempotent when the answer is the same server', async () => {
      seedWorkspace({ hosting_server_id: SERVER_ID });
      seedServer();

      const res = await handler(req({ server_id: SERVER_ID }), ctx());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reused).toBe(true);
      expect(body.workspace).toMatchObject({ hosting_server_id: SERVER_ID });
    });

    it('refuses to repoint a workspace at a different server', async () => {
      seedWorkspace({ hosting_server_id: 'srv_current' });
      seedServer({ id: 'srv_current' });
      seedServer({ id: 'srv_other', sites_count: 0 });

      const res = await handler(req({ server_id: 'srv_other' }), ctx());
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining('already allocated'),
      });
      // Still pointing at the original host: no silent migration.
      expect(workspace()?.hosting_server_id).toBe('srv_current');
    });
  }
);

describe.each(POSTS)(
  'POST /api/%s/projects/[id]/site — write failures',
  (_tree, handler) => {
    it('returns 500 without leaking credentials when the update fails', async () => {
      seedWorkspace();
      seedServer();
      failures['workspaces:update'] = {
        message: 'permission denied for table workspaces',
      };

      const res = await handler(req({}), ctx());
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE_KEY|eyJ/);
    });

    it('returns 500 when the update reports neither a row nor an error', async () => {
      seedWorkspace();
      seedServer();
      nullData.add('workspaces:update');

      const res = await handler(req({}), ctx());
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({
        error: 'Failed to allocate workspace',
      });
    });
  }
);
