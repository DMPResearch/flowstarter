import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactUrlError,
  assertUsableArtifactUrl,
  authorizeBuildWorker,
  buildWorkerSecret,
  deployAgentClientFromEnv,
  deployBuildArtifact,
  resolveDeployAgentSecret,
} from '../build-worker-deploy';
import { createFakeHostingSupabase } from './fake-hosting-supabase';
import { DryRunDeployAgentClient, HttpDeployAgentClient } from '../deploy';
import { deployedSiteUrl, localSiteBaseUrl } from '../site-urls';

const SECRET = 's'.repeat(48);

describe('buildWorkerSecret', () => {
  it('refuses a secret short enough to brute force', () => {
    expect(
      buildWorkerSecret({ FLOWSTARTER_BUILD_WORKER_SECRET: 'short' })
    ).toBeNull();
    expect(buildWorkerSecret({})).toBeNull();
    expect(buildWorkerSecret({ FLOWSTARTER_BUILD_WORKER_SECRET: SECRET })).toBe(
      SECRET
    );
  });
});

describe('authorizeBuildWorker', () => {
  const env = { FLOWSTARTER_BUILD_WORKER_SECRET: SECRET };

  it('accepts the dispatch secret the worker already holds', () => {
    expect(authorizeBuildWorker(`Bearer ${SECRET}`, env)).toBe(true);
  });

  it('rejects a wrong, truncated, missing or unscheme-d credential', () => {
    expect(authorizeBuildWorker(`Bearer ${'x'.repeat(48)}`, env)).toBe(false);
    expect(authorizeBuildWorker(`Bearer ${SECRET.slice(0, 47)}`, env)).toBe(
      false
    );
    expect(authorizeBuildWorker(SECRET, env)).toBe(false);
    expect(authorizeBuildWorker(null, env)).toBe(false);
    expect(authorizeBuildWorker(undefined, env)).toBe(false);
  });

  it('rejects everything when no secret is configured, rather than opening up', () => {
    expect(authorizeBuildWorker('Bearer ', {})).toBe(false);
    expect(authorizeBuildWorker(`Bearer ${SECRET}`, {})).toBe(false);
  });
});

describe('assertUsableArtifactUrl', () => {
  it('accepts https anywhere', () => {
    expect(
      assertUsableArtifactUrl('https://cdn.example/site.tar.gz', {
        NODE_ENV: 'production',
      }).protocol
    ).toBe('https:');
  });

  it('accepts plain http on loopback outside production, where the worker serves its own artifact', () => {
    for (const host of ['127.0.0.1', 'localhost']) {
      expect(
        assertUsableArtifactUrl(`http://${host}:8787/artifacts/a.tar.gz`, {
          NODE_ENV: 'development',
        }).hostname
      ).toContain(host === 'localhost' ? 'localhost' : '127.0.0.1');
    }
  });

  it('refuses plain http off loopback, and refuses it entirely in production', () => {
    expect(() =>
      assertUsableArtifactUrl('http://evil.example/site.tar.gz', {
        NODE_ENV: 'development',
      })
    ).toThrow(ArtifactUrlError);
    expect(() =>
      assertUsableArtifactUrl('http://127.0.0.1:8787/a.tar.gz', {
        NODE_ENV: 'production',
      })
    ).toThrow(ArtifactUrlError);
  });

  it('refuses a non-http scheme and a malformed URL', () => {
    expect(() =>
      assertUsableArtifactUrl('file:///etc/passwd', { NODE_ENV: 'development' })
    ).toThrow(ArtifactUrlError);
    expect(() =>
      assertUsableArtifactUrl('not a url', { NODE_ENV: 'development' })
    ).toThrow(ArtifactUrlError);
  });
});

describe('resolveDeployAgentSecret', () => {
  it('prefers the per-server ref, then the single-server dev fallback', () => {
    const env = {
      DEPLOY_AGENT_SHARED_SECRET_LOCAL_DEV: 'per-server',
      DEPLOY_AGENT_SHARED_SECRET: 'global',
    };
    expect(
      resolveDeployAgentSecret('deploy_agent_shared_secret_local_dev', env)
    ).toBe('per-server');
    expect(
      resolveDeployAgentSecret('deploy_agent_shared_secret_other', env)
    ).toBe('global');
    expect(resolveDeployAgentSecret('anything', {})).toBeNull();
  });
});

describe('deployAgentClientFromEnv', () => {
  it('honours the dry-run switch and defaults to the real HTTP client', () => {
    expect(
      deployAgentClientFromEnv({ DEPLOY_AGENT_DRY_RUN: 'true' })
    ).toBeInstanceOf(DryRunDeployAgentClient);
    expect(deployAgentClientFromEnv({})).toBeInstanceOf(HttpDeployAgentClient);
  });
});

describe('deployedSiteUrl', () => {
  it('prefers the custom domain the client actually paid for', () => {
    expect(
      deployedSiteUrl({
        slug: 'calm-path',
        primaryDomain: 'calmpath.ro',
        env: { FLOWSTARTER_LOCAL_SITE_BASE_URL: 'http://localhost:8788' },
      })
    ).toBe('https://calmpath.ro');
  });

  it('uses the local path-served URL when a local deploy-agent is serving', () => {
    expect(
      deployedSiteUrl({
        slug: 'calm-path',
        env: { FLOWSTARTER_LOCAL_SITE_BASE_URL: 'http://localhost:8788/' },
      })
    ).toBe('http://localhost:8788/calm-path/');
  });

  it("falls back to the site's own final hostname, never a preview name", () => {
    const url = deployedSiteUrl({ slug: 'calm-path', env: {} });
    expect(url).toBe('https://calm-path.flowstarter.dev');
    expect(url).not.toContain('preview');
  });

  it('uses the production zone in production', () => {
    expect(
      deployedSiteUrl({ slug: 'calm-path', env: { NODE_ENV: 'production' } })
    ).toBe('https://calm-path.flowstarter.net');
  });

  it('never serves the local base URL in production', () => {
    const env = {
      NODE_ENV: 'production',
      FLOWSTARTER_LOCAL_SITE_BASE_URL: 'http://localhost:8788',
    };
    expect(localSiteBaseUrl(env)).toBeNull();
    expect(deployedSiteUrl({ slug: 'calm-path', env })).toMatch(/^https:\/\//);
  });
});

// ─── deployBuildArtifact ───────────────────────────────────────────────────

describe('deployBuildArtifact', () => {
  const WS = '0f4e1088-8d8f-4f18-83b1-000000000001';

  function seeded() {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [
      {
        id: WS,
        slug: 'acme',
        hosting_server_id: 'srv-1',
        deploy_status: 'pending',
        cloudflare_zone_id: null,
      },
    ]);
    db.seed('hosting_servers', [
      {
        id: 'srv-1',
        name: 'caddy-fsn-01',
        status: 'active',
        ipv4: '203.0.113.10',
        deploy_agent_url: 'https://203.0.113.10:8443',
        deploy_agent_secret_ref: 'deploy_agent_secret_srv_1',
        site_capacity: 50,
        sites_count: 1,
      },
    ]);
    return db;
  }

  it('deploys through the shared path and answers with the preview URL', async () => {
    const db = seeded();
    const { deployment, siteUrl } = await deployBuildArtifact({
      supabase: db.client as never,
      workspaceId: WS,
      artifactUrl: 'https://artifacts.test/site.tar.gz',
      artifactSha256: 'abc123',
      deployedBy: 'build-worker',
      env: {
        DEPLOY_AGENT_DRY_RUN: 'true',
        DEPLOY_AGENT_SHARED_SECRET: 'dev-shared-secret',
      },
    });

    expect(deployment.status).toBe('live');
    expect(deployment.version).toBe(1);
    expect(db.rows('deployments')[0]!.artifact_url).toBe(
      'https://artifacts.test/site.tar.gz'
    );
    expect(siteUrl).toBe('https://acme.flowstarter.dev');
  });

  it('prefers the workspace primary domain over the platform hostname', async () => {
    const db = seeded();
    db.seed('workspace_hosts', [
      { workspace_id: WS, hostname: 'www.acme.com', is_primary: false },
      { workspace_id: WS, hostname: 'acme.com', is_primary: true },
    ]);
    const { siteUrl } = await deployBuildArtifact({
      supabase: db.client as never,
      workspaceId: WS,
      artifactUrl: 'https://artifacts.test/site.tar.gz',
      deployedBy: 'build-worker',
      env: {
        DEPLOY_AGENT_DRY_RUN: 'true',
        DEPLOY_AGENT_SHARED_SECRET: 'dev-shared-secret',
      },
    });
    expect(siteUrl).toBe('https://acme.com');
  });

  it('uses the local deploy-agent URL when one is configured', async () => {
    const db = seeded();
    const { siteUrl } = await deployBuildArtifact({
      supabase: db.client as never,
      workspaceId: WS,
      artifactUrl: 'http://127.0.0.1:8788/site.tar.gz',
      deployedBy: 'build-worker',
      env: {
        DEPLOY_AGENT_DRY_RUN: 'true',
        DEPLOY_AGENT_SHARED_SECRET: 'dev-shared-secret',
        FLOWSTARTER_LOCAL_SITE_BASE_URL: 'http://localhost:8788/',
      },
    });
    expect(siteUrl).toBe('http://localhost:8788/acme/');
  });

  it('has no URL to offer when the workspace vanished after the deploy', async () => {
    const db = seeded();
    const deleteAfterDeploy = {
      from(table: string) {
        // The deploy runs first and needs a real workspace; the post-deploy
        // lookup is the one that must survive finding nothing.
        if (table === 'workspaces' && db.rows('deployments').length > 0) {
          db.seed('workspaces', []);
        }
        return (db.client as { from: (t: string) => unknown }).from(table);
      },
      get storage() {
        return undefined;
      },
    } as never;
    const { siteUrl } = await deployBuildArtifact({
      supabase: deleteAfterDeploy,
      workspaceId: WS,
      artifactUrl: 'https://artifacts.test/site.tar.gz',
      deployedBy: 'build-worker',
      env: {
        DEPLOY_AGENT_DRY_RUN: 'true',
        DEPLOY_AGENT_SHARED_SECRET: 'dev-shared-secret',
      },
    });
    expect(siteUrl).toBeNull();
  });

  it('builds a Cloudflare client only when a token is configured', async () => {
    const db = seeded();
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: [],
          }),
          { status: 200 }
        )
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const { deployment } = await deployBuildArtifact({
        supabase: db.client as never,
        workspaceId: WS,
        artifactUrl: 'https://artifacts.test/site.tar.gz',
        deployedBy: 'build-worker',
        env: {
          DEPLOY_AGENT_DRY_RUN: 'true',
          DEPLOY_AGENT_SHARED_SECRET: 'dev-shared-secret',
          CLOUDFLARE_API_TOKEN: 'cf-token',
          CLOUDFLARE_DEFAULT_ZONE_ID: 'zone-1',
        },
      });
      expect(deployment.status).toBe('live');
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
        '/zones/zone-1/dns_records'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
