// @vitest-environment node
/**
 * POST /api/admin/hosting/servers/connect takes no body — every interesting
 * case here is either "who is calling" (auth) or "what did the connect
 * helper decide" (success vs. each `ConnectExistingServerError` code vs. an
 * unexpected throw). The helper itself is unit-tested in
 * `src/lib/hosting/__tests__/connect-existing-server.test.ts`; this file only
 * pins down that the route wires it up and maps codes to statuses correctly.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  /** Set to make requireTeamAuth refuse; undefined means an authorized team user. */
  authOverride: undefined as unknown,
}));

vi.mock('@/lib/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-auth')>(
    '@/lib/api-auth'
  );
  return {
    ...actual,
    requireTeamAuth: async () =>
      state.authOverride ?? {
        authorized: true as const,
        userId: 'user_team_1',
        role: 'team' as const,
      },
  };
});

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));

const connectExistingHostingServerMock = vi.fn();

vi.mock('@/lib/hosting/connect-existing-server', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/hosting/connect-existing-server')
  >('@/lib/hosting/connect-existing-server');
  return {
    ...actual,
    connectExistingHostingServer: (...args: unknown[]) =>
      connectExistingHostingServerMock(...args),
  };
});

import { POST } from '../route';
import { ConnectExistingServerError } from '@/lib/hosting/connect-existing-server';

beforeEach(() => {
  vi.clearAllMocks();
  state.authOverride = undefined;
});

describe('POST /api/admin/hosting/servers/connect', () => {
  it('rejects a signed-out / non-team caller before touching the connect helper', async () => {
    state.authOverride = {
      authorized: false,
      response: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    };

    const res = await POST();

    expect(res.status).toBe(401);
    expect(connectExistingHostingServerMock).not.toHaveBeenCalled();
  });

  it('returns the connected server on success', async () => {
    const server = {
      id: 'srv_1',
      name: 'ops-box-1',
      provider: 'hetzner',
      hetzner_server_id: '12345',
      ipv4: '203.0.113.10',
      location: 'fsn1',
      server_type: 'cpx31',
      status: 'active',
      site_capacity: 50,
      sites_count: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    connectExistingHostingServerMock.mockResolvedValue(server);

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ server });
    expect(connectExistingHostingServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'user_team_1' })
    );
  });

  const CASES: Array<{
    code: ConnectExistingServerError['code'];
    status: number;
  }> = [
    { code: 'config_missing', status: 409 },
    { code: 'config_invalid', status: 409 },
    { code: 'secret_unavailable', status: 500 },
    { code: 'health_check_failed', status: 502 },
    { code: 'hetzner_api_failed', status: 502 },
    { code: 'server_not_ready', status: 409 },
    { code: 'db_error', status: 500 },
  ];

  it.each(CASES)(
    'maps ConnectExistingServerError code "$code" to HTTP $status',
    async ({ code, status }) => {
      connectExistingHostingServerMock.mockRejectedValue(
        new ConnectExistingServerError(code, `boom: ${code}`)
      );

      const res = await POST();
      const body = await res.json();

      expect(res.status).toBe(status);
      expect(body).toEqual({ error: `boom: ${code}`, code });
    }
  );

  it('falls back to a 500 with the error message for an unexpected throw', async () => {
    connectExistingHostingServerMock.mockRejectedValue(
      new Error('unexpected failure')
    );

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'unexpected failure' });
  });
});
