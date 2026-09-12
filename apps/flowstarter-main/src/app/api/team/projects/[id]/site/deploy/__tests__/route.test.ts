// @vitest-environment node
/**
 * POST /api/team/projects/[id]/site/deploy
 *
 * The one thing this file pins down that unit tests on `deploySite` /
 * `HttpDeployAgentClient` cannot: that the ROUTE itself refuses a request
 * with no `artifact_sha256` (or a malformed one) before ever calling
 * `deploySite` — the deploy-agent will not extract an unverified artifact,
 * so letting a bad request reach it would only trade a clear 400 here for a
 * confusing 502 from the agent.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
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

const deploySiteMock = vi.fn();

vi.mock('@/lib/hosting/deploy', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hosting/deploy')>(
    '@/lib/hosting/deploy'
  );
  return {
    ...actual,
    deploySite: (...args: unknown[]) => deploySiteMock(...args),
  };
});

import { POST } from '../route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/team/projects/ws/site/deploy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = () => ({ params: Promise.resolve({ id: 'ws-1' }) });

const GOOD_SHA256 = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  state.authOverride = undefined;
  deploySiteMock.mockReset();
  deploySiteMock.mockResolvedValue({
    deploymentId: 'dep_1',
    version: 1,
    status: 'live',
    detail: null,
  });
});

describe('artifact_sha256 is required', () => {
  it('refuses a body with no artifact_sha256, without calling deploySite', async () => {
    const res = await POST(
      req({ artifact_url: 'https://artifacts.test/site.tar.gz' }) as never,
      params()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('artifact_sha256');
    expect(deploySiteMock).not.toHaveBeenCalled();
  });

  it('refuses an artifact_sha256 that is not 64 hex characters', async () => {
    const res = await POST(
      req({
        artifact_url: 'https://artifacts.test/site.tar.gz',
        artifact_sha256: 'not-a-real-digest',
      }) as never,
      params()
    );
    expect(res.status).toBe(400);
    expect(deploySiteMock).not.toHaveBeenCalled();
  });

  it('accepts a well-formed digest and forwards it to deploySite', async () => {
    const res = await POST(
      req({
        artifact_url: 'https://artifacts.test/site.tar.gz',
        artifact_sha256: GOOD_SHA256,
      }) as never,
      params()
    );
    expect(res.status).toBe(200);
    expect(deploySiteMock).toHaveBeenCalledTimes(1);
    const call = deploySiteMock.mock.calls[0]![0] as {
      artifact: { sha256: string };
    };
    expect(call.artifact.sha256).toBe(GOOD_SHA256);
  });
});
