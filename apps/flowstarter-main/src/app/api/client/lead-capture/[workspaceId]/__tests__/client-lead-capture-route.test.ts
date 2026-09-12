// @vitest-environment node
/**
 * The client's own contact form token, through the REAL route handlers.
 *
 * Two things are defended:
 *
 *  1. TENANCY. Both handlers query with the service role, which bypasses RLS,
 *     so `requireWorkspaceAccess` running first is the entire boundary. The
 *     cross-tenant case asserts the 404 *and* that the other workspace's token
 *     was neither returned nor rotated: a 404 that still rotated somebody
 *     else's token would be a green test and a live outage of their form.
 *  2. ROTATION IS NOT IDEMPOTENT, and must not look it. Each POST mints a new
 *     value and the previous one stops resolving.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '../route';
import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';

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
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

const params = (workspaceId: string) => ({
  params: Promise.resolve({ workspaceId }),
});

const get = (workspaceId: string) =>
  new NextRequest(`http://localhost/api/client/lead-capture/${workspaceId}`);

const post = (workspaceId: string) =>
  new NextRequest(`http://localhost/api/client/lead-capture/${workspaceId}`, {
    method: 'POST',
  });

const tokenOf = (workspaceId: string) =>
  db.rows('workspaces').find((row) => row['id'] === workspaceId)?.[
    'lead_capture_token'
  ];

beforeEach(() => {
  db.reset();
  authState.userId = 'user_client_a';
  authState.role = undefined;
  db.seed('workspaces', [
    {
      id: WORKSPACE_A,
      slug: 'salon-elena',
      lead_capture_token: 'a'.repeat(43),
    },
    { id: WORKSPACE_B, slug: 'halden-roe', lead_capture_token: 'b'.repeat(43) },
  ]);
  db.seed('workspace_memberships', [
    {
      workspace_id: WORKSPACE_A,
      clerk_user_id: 'user_client_a',
      role: 'client',
    },
    {
      workspace_id: WORKSPACE_B,
      clerk_user_id: 'user_client_b',
      role: 'client',
    },
  ]);
});

describe('GET', () => {
  it('returns the member own token', async () => {
    const response = await GET(get(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: 'a'.repeat(43),
      slug: 'salon-elena',
    });
  });

  it('mints one when the row has none', async () => {
    db.rows('workspaces')[0]!['lead_capture_token'] = null;
    const response = await GET(get(WORKSPACE_A), params(WORKSPACE_A));
    const json = await response.json();
    expect(json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenOf(WORKSPACE_A)).toBe(json.token);
  });

  it('404s another workspace without telling the caller it exists', async () => {
    const response = await GET(get(WORKSPACE_B), params(WORKSPACE_B));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('b'.repeat(43));
  });

  it('reports a lookup it could not make', async () => {
    db.failing.add('workspaces');
    const response = await GET(get(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(500);
  });

  it('404s a workspace the membership outlived', async () => {
    // A team caller passes the access check for any id, so the row going
    // missing is a real state and not an unreachable branch.
    authState.role = 'team';
    const response = await GET(
      get('11111111-2222-4333-8444-555555555555'),
      params('11111111-2222-4333-8444-555555555555')
    );
    expect(response.status).toBe(404);
  });

  it('401s a signed-out caller', async () => {
    authState.userId = null;
    const response = await GET(get(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(401);
  });
});

describe('POST (rotate)', () => {
  it('mints a new token and stores it', async () => {
    const before = tokenOf(WORKSPACE_A);
    const response = await POST(post(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.token).not.toBe(before);
    expect(tokenOf(WORKSPACE_A)).toBe(json.token);
  });

  it('is not idempotent: twice is two tokens', async () => {
    const first = await (
      await POST(post(WORKSPACE_A), params(WORKSPACE_A))
    ).json();
    const second = await (
      await POST(post(WORKSPACE_A), params(WORKSPACE_A))
    ).json();
    expect(second.token).not.toBe(first.token);
  });

  it('records the rotation against that workspace', async () => {
    await POST(post(WORKSPACE_A), params(WORKSPACE_A));
    const event = db.rows('project_events')[0];
    expect(event?.['kind']).toBe('lead_capture_rotated');
    expect(event?.['workspace_id']).toBe(WORKSPACE_A);
    expect(event?.['actor']).toBe('user_client_a');
  });

  it('refuses to rotate another workspace token', async () => {
    const before = tokenOf(WORKSPACE_B);
    const response = await POST(post(WORKSPACE_B), params(WORKSPACE_B));
    expect(response.status).toBe(404);
    expect(tokenOf(WORKSPACE_B)).toBe(before);
    expect(db.rows('project_events')).toHaveLength(0);
  });

  it('404s a rotation of a workspace that is no longer there', async () => {
    authState.role = 'team';
    const response = await POST(
      post('11111111-2222-4333-8444-555555555555'),
      params('11111111-2222-4333-8444-555555555555')
    );
    expect(response.status).toBe(404);
  });

  it('reports a write it could not make', async () => {
    db.failing.add('workspaces');
    const response = await POST(post(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(500);
  });
});
