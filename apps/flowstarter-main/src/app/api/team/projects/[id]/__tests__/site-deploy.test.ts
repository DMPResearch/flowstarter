/**
 * POST /api/{team,admin}/projects/[id]/site/deploy.
 *
 * This is the route that pushes a build to a real host and repoints DNS, so
 * the deploy itself (`deploySite`) is the injected seam and it is mocked: no
 * artifact leaves the test, no agent is called, no Cloudflare record is
 * touched. What is proved is everything around it — the operator gate, the
 * artifact_url validation that runs before any client is built, the failure
 * codes mapped to statuses a caller can act on, and the shared-secret lookup
 * the handler hands to the deploy layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  createFakeSupabase,
  resetFakeSupabase,
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

// ─── The deploy seam ────────────────────────────────────────────────────────
// Only `deploySite` is replaced; DeployError and the two agent clients stay
// real so the `instanceof` mapping under test is the production one.
const deploySite = vi.hoisted(() => vi.fn());
vi.mock('@/lib/hosting/deploy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hosting/deploy')>();
  return { ...actual, deploySite };
});

import {
  DeployError,
  DryRunDeployAgentClient,
  HttpDeployAgentClient,
} from '@/lib/hosting/deploy';
import { CloudflareClient } from '@/lib/hosting/cloudflare';

import { POST as teamDeploy } from '../site/deploy/route';
import { POST as adminDeploy } from '../../../../admin/projects/[id]/site/deploy/route';

// ─── Helpers ────────────────────────────────────────────────────────────────
const WORKSPACE_ID = '4f9c1a3e-0b7d-4a52-9c31-2f8e6d5b7a01';
const ARTIFACT_URL = 'https://artifacts.flowstarter.dev/acme/v3.tar.gz';

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: NextRequest, ctx: Ctx) => Promise<Response>;

const HANDLERS: Array<[string, Handler]> = [
  ['team', teamDeploy as Handler],
  ['admin', adminDeploy as Handler],
];

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

type DeployArgs = Parameters<
  typeof import('@/lib/hosting/deploy')['deploySite']
>[0];

function lastCall(): DeployArgs {
  return deploySite.mock.calls.at(-1)![0] as DeployArgs;
}

const RESULT = {
  id: 'dep_3',
  version: 3,
  status: 'succeeded',
  primaryDomain: 'acme-coaching.preview.flowstarter.dev',
};

beforeEach(() => {
  resetFakeSupabase();
  authState.userId = 'user_operator';
  authState.role = 'team';
  deploySite.mockReset();
  deploySite.mockResolvedValue(RESULT);
  vi.unstubAllEnvs();
});

describe('site/deploy: who may ship', () => {
  it.each(HANDLERS)(
    '%s refuses an unauthenticated caller with 401',
    async (_tree, handler) => {
      authState.userId = null;

      const res = await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      expect(res.status).toBe(401);
      expect(deploySite).not.toHaveBeenCalled();
    }
  );

  it.each(HANDLERS)(
    '%s refuses a signed-in caller who is not an operator with 403',
    async (_tree, handler) => {
      authState.userId = 'user_plain_client';
      authState.role = undefined;

      const res = await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
      expect(deploySite).not.toHaveBeenCalled();
    }
  );
});

describe.each(HANDLERS)(
  'site/deploy (%s): the artifact it accepts',
  (_tree, handler) => {
    it('answers a body that is not JSON with 400, not 500', async () => {
      const res = await handler(req(), ctx());
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining('artifact_url is required'),
      });
      expect(deploySite).not.toHaveBeenCalled();
    });

    it.each([
      ['a missing artifact_url', {}],
      ['an empty artifact_url', { artifact_url: '' }],
      ['a non-string artifact_url', { artifact_url: 42 }],
    ])('refuses %s with 400', async (_case, body) => {
      const res = await handler(req(body), ctx());
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining('artifact_url is required'),
      });
      expect(deploySite).not.toHaveBeenCalled();
    });

    it('refuses a non-http(s) scheme', async () => {
      const res = await handler(
        req({ artifact_url: 'file:///etc/passwd' }),
        ctx()
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'artifact_url must be http(s)',
      });
      expect(deploySite).not.toHaveBeenCalled();
    });

    it('refuses a string that is not a URL at all', async () => {
      const res = await handler(req({ artifact_url: 'v3.tar.gz' }), ctx());
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'artifact_url is not a valid URL',
      });
      expect(deploySite).not.toHaveBeenCalled();
    });

    it('accepts plain http as well as https', async () => {
      const res = await handler(
        req({ artifact_url: 'http://localhost:9000/acme/v3.tar.gz' }),
        ctx()
      );
      expect(res.status).toBe(200);
    });
  }
);

describe.each(HANDLERS)(
  'site/deploy (%s): what it hands the deploy layer',
  (_tree, handler) => {
    it('passes the artifact, the workspace and the operator', async () => {
      const res = await handler(
        req({ artifact_url: ARTIFACT_URL, artifact_sha256: 'abc123' }),
        ctx()
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        deployment: RESULT,
        dryRun: false,
      });
      expect(lastCall()).toMatchObject({
        workspaceId: WORKSPACE_ID,
        deployedBy: 'user_operator',
        artifact: { kind: 'url', url: ARTIFACT_URL, sha256: 'abc123' },
      });
    });

    it('drops a non-string checksum rather than passing it through', async () => {
      await handler(
        req({ artifact_url: ARTIFACT_URL, artifact_sha256: 12345 }),
        ctx()
      );
      expect(lastCall().artifact).toMatchObject({ sha256: undefined });
    });

    it('uses the real HTTP agent client by default', async () => {
      await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      expect(lastCall().agentClient).toBeInstanceOf(HttpDeployAgentClient);
    });

    it('uses the dry-run client when DEPLOY_AGENT_DRY_RUN is set', async () => {
      vi.stubEnv('DEPLOY_AGENT_DRY_RUN', 'true');

      const res = await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ dryRun: true });
      expect(lastCall().agentClient).toBeInstanceOf(DryRunDeployAgentClient);
    });

    it('passes no Cloudflare client when no token is configured', async () => {
      vi.stubEnv('CLOUDFLARE_API_TOKEN', undefined);

      await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      expect(lastCall().cloudflare).toBeNull();
      expect(lastCall().cloudflareDefaultZoneId).toBeNull();
    });

    it('passes a Cloudflare client and the default zone when both are configured', async () => {
      vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-test-token');
      vi.stubEnv('CLOUDFLARE_DEFAULT_ZONE_ID', 'zone_123');

      await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      expect(lastCall().cloudflare).toBeInstanceOf(CloudflareClient);
      expect(lastCall().cloudflareDefaultZoneId).toBe('zone_123');
    });
  }
);

describe.each(HANDLERS)(
  'site/deploy (%s): the shared-secret lookup it provides',
  (_tree, handler) => {
    it('prefers the per-server secret, then the global one, then nothing', async () => {
      vi.stubEnv('DEPLOY_AGENT_SHARED_SECRET_FSN1_A', 'per-server-secret');
      vi.stubEnv('DEPLOY_AGENT_SHARED_SECRET', 'global-secret');

      await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      const resolve = lastCall().resolveSharedSecret!;

      await expect(resolve('deploy_agent_shared_secret_fsn1_a')).resolves.toBe(
        'per-server-secret'
      );
      await expect(resolve('deploy_agent_shared_secret_fsn1_b')).resolves.toBe(
        'global-secret'
      );

      vi.stubEnv('DEPLOY_AGENT_SHARED_SECRET', undefined);
      await expect(
        resolve('deploy_agent_shared_secret_fsn1_b')
      ).resolves.toBeNull();
    });
  }
);

describe.each(HANDLERS)(
  'site/deploy (%s): how failures reach the caller',
  (_tree, handler) => {
    it.each([
      ['workspace_not_found', 404],
      ['workspace_unallocated', 409],
      ['server_not_found', 404],
      ['server_not_active', 409],
      ['agent_not_configured', 409],
      ['secret_not_configured', 409],
      ['secret_unavailable', 500],
      ['agent_error', 502],
      ['db_error', 500],
    ])('maps %s to %i', async (code, status) => {
      deploySite.mockRejectedValueOnce(
        new DeployError(code as string, `deploy failed: ${code}`)
      );

      const res = await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toMatchObject({ code });
    });

    it('falls back to 500 for a deploy code it does not know', async () => {
      deploySite.mockRejectedValueOnce(
        new DeployError('meteor_strike', 'unmapped')
      );

      const res = await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({
        error: 'unmapped',
        code: 'meteor_strike',
      });
    });

    it('reports an unexpected error as a plain 500', async () => {
      deploySite.mockRejectedValueOnce(new Error('socket hang up'));

      const res = await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: 'socket hang up' });
    });

    it('reports a non-Error rejection as a generic 500', async () => {
      deploySite.mockRejectedValueOnce('nope');

      const res = await handler(req({ artifact_url: ARTIFACT_URL }), ctx());
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: 'Deploy failed' });
    });
  }
);
