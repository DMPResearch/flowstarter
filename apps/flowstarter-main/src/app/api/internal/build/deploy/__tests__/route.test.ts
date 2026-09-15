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

const sendOpsAlertMock =
  vi.fn<
    (input: { event: string; discriminator: string }) => Promise<unknown>
  >();
vi.mock('@/lib/ops/send-ops-alert', () => ({
  sendOpsAlert: (input: { event: string; discriminator: string }) =>
    sendOpsAlertMock(input),
}));

import { DeployError } from '@/lib/hosting/deploy';
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
  sendOpsAlertMock.mockReset();
  sendOpsAlertMock.mockResolvedValue({ sent: true });
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

/**
 * A deploy that failed because there is nowhere to deploy to.
 *
 * Run 9 of workspace ba3e9323 spent two of its three attempts rediscovering a
 * 409 `workspace_unallocated` — a workspace with no host allocated, which no
 * retry can conjure — and nothing told anybody. The build worker records this
 * class of failure as terminal on purpose; this is the half that makes a
 * terminal job reach a person.
 */
describe('a deploy that needs an operator', () => {
  it('alerts, and still answers the worker with the code it can classify', async () => {
    deployBuildArtifactMock.mockRejectedValue(
      new DeployError('workspace_unallocated', 'workspace has no server')
    );

    const res = await POST(
      req({
        workspaceId: WORKSPACE,
        artifactUrl: 'https://artifacts.test/site.tar.gz',
        artifactSha256: GOOD_SHA256,
      }) as never
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: 'workspace_unallocated',
    });
    expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);
    expect(sendOpsAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'deploy_needs_operator',
        // Per workspace and reason: the same workspace still unallocated an
        // hour later is the same news; a second workspace hitting it is not.
        discriminator: `${WORKSPACE}:workspace_unallocated`,
        workspaceId: WORKSPACE,
      })
    );
  });

  it('stays quiet for a deploy that is simply worth trying again', async () => {
    // A busy or unreachable deploy-agent is the retryable kind. Paging on it
    // would page on every transient 502, which is how an alert stops being
    // read at all.
    deployBuildArtifactMock.mockRejectedValue(
      new DeployError('agent_error', 'deploy-agent 502')
    );

    const res = await POST(
      req({
        workspaceId: WORKSPACE,
        artifactUrl: 'https://artifacts.test/site.tar.gz',
        artifactSha256: GOOD_SHA256,
      }) as never
    );

    expect(res.status).toBe(502);
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });
});
