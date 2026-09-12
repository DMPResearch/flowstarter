// @vitest-environment node
/**
 * POST /api/internal/build/deploy
 *
 * Pins down that the route refuses a request with no (or a malformed)
 * `artifactSha256` before ever calling `deployBuildArtifact` — the
 * deploy-agent will not extract an unverified artifact, so this is the
 * difference between a clear 400 here and a confusing 502 from the agent.
 * `LocalSitePublisher` (the one real caller of this route) already always
 * sends a real digest; this test is about a caller that doesn't.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

process.env.FLOWSTARTER_BUILD_WORKER_SECRET = 's'.repeat(32);

const deployBuildArtifactMock = vi.fn();

vi.mock('@/lib/hosting/build-worker-deploy', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/hosting/build-worker-deploy')
  >('@/lib/hosting/build-worker-deploy');
  return {
    ...actual,
    deployBuildArtifact: (...args: unknown[]) =>
      deployBuildArtifactMock(...args),
  };
});

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));

import { POST } from '../route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/internal/build/deploy', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${'s'.repeat(32)}`,
    },
    body: JSON.stringify(body),
  });
}

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const GOOD_SHA256 = 'b'.repeat(64);

beforeEach(() => {
  deployBuildArtifactMock.mockReset();
  deployBuildArtifactMock.mockResolvedValue({
    deployment: {
      deploymentId: 'dep_1',
      version: 1,
      status: 'live',
      detail: null,
    },
    siteUrl: 'https://acme.flowstarter.dev',
  });
});

describe('artifactSha256 is required', () => {
  it('refuses a body with no artifactSha256, without calling deployBuildArtifact', async () => {
    const res = await POST(
      req({
        workspaceId: WORKSPACE,
        artifactUrl: 'https://artifacts.test/site.tar.gz',
      }) as never
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('artifactSha256');
    expect(deployBuildArtifactMock).not.toHaveBeenCalled();
  });

  it('refuses an artifactSha256 that is not 64 hex characters', async () => {
    const res = await POST(
      req({
        workspaceId: WORKSPACE,
        artifactUrl: 'https://artifacts.test/site.tar.gz',
        artifactSha256: 'short',
      }) as never
    );
    expect(res.status).toBe(400);
    expect(deployBuildArtifactMock).not.toHaveBeenCalled();
  });

  it('accepts a well-formed digest and forwards it to deployBuildArtifact', async () => {
    const res = await POST(
      req({
        workspaceId: WORKSPACE,
        artifactUrl: 'https://artifacts.test/site.tar.gz',
        artifactSha256: GOOD_SHA256,
      }) as never
    );
    expect(res.status).toBe(200);
    expect(deployBuildArtifactMock).toHaveBeenCalledTimes(1);
    const call = deployBuildArtifactMock.mock.calls[0]![0] as {
      artifactSha256: string;
    };
    expect(call.artifactSha256).toBe(GOOD_SHA256);
  });
});
