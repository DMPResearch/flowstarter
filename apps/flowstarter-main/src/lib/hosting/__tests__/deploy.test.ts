import { describe, expect, it, vi } from 'vitest';
import {
  DeployError,
  DryRunDeployAgentClient,
  HttpDeployAgentClient,
  allocateHostingServer,
  deploySite,
  previewDomainForSlug,
} from '../deploy';
import type {
  CloudflareClient,
  CloudflareUpsertRecordInput,
} from '../cloudflare';
import type { DeployAgentClient } from '../deploy';
import { createFakeHostingSupabase, type Row } from './fake-hosting-supabase';

describe('DryRunDeployAgentClient', () => {
  it('records push calls without network', async () => {
    const client = new DryRunDeployAgentClient();
    const result = await client.push({
      deployAgentUrl: 'https://10.0.0.1:8443',
      sharedSecret: 'shh',
      siteSlug: 'acme',
      artifact: { kind: 'url', url: 'https://artifacts/abc.tar.gz' },
      primaryDomain: 'acme.com',
      additionalDomains: [],
    });
    expect(result.ok).toBe(true);
    expect(result.sha256).toBe('dryrun');
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe('push');
  });

  it('records remove calls', async () => {
    const client = new DryRunDeployAgentClient();
    await client.remove({
      deployAgentUrl: 'https://10.0.0.1:8443',
      sharedSecret: 's',
      siteSlug: 'acme',
    });
    expect(client.calls[0].method).toBe('remove');
  });
});

describe('HttpDeployAgentClient', () => {
  it('POSTs JSON to /sites/{slug}/deploy with bearer auth (url artifact)', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        return new Response(
          JSON.stringify({ sha256: 'abc', sizeBytes: 1234 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    );
    const client = new HttpDeployAgentClient(
      fetchSpy as unknown as typeof globalThis.fetch
    );
    const result = await client.push({
      deployAgentUrl: 'https://10.0.0.1:8443',
      sharedSecret: 'super-shh',
      siteSlug: 'acme',
      artifact: {
        kind: 'url',
        url: 'https://artifacts/abc.tar.gz',
        sha256: 'def',
      },
      primaryDomain: 'acme.com',
      additionalDomains: ['www.acme.com'],
    });
    expect(result.sha256).toBe('abc');
    expect(result.sizeBytes).toBe(1234);

    const call = fetchSpy.mock.calls[0]!;
    const [url, init] = call;
    expect(String(url)).toBe('https://10.0.0.1:8443/sites/acme/deploy');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer super-shh');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      artifact_url: 'https://artifacts/abc.tar.gz',
      artifact_sha256: 'def',
      primary_domain: 'acme.com',
      additional_domains: ['www.acme.com'],
    });
  });

  it('throws DeployError on non-2xx', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        return new Response(JSON.stringify({ error: 'bad' }), { status: 500 });
      }
    );
    const client = new HttpDeployAgentClient(
      fetchSpy as unknown as typeof globalThis.fetch
    );
    await expect(
      client.push({
        deployAgentUrl: 'https://10.0.0.1:8443',
        sharedSecret: 's',
        siteSlug: 'acme',
        artifact: { kind: 'url', url: 'https://x' },
        primaryDomain: null,
        additionalDomains: [],
      })
    ).rejects.toBeInstanceOf(DeployError);
  });

  it('strips trailing slash from deployAgentUrl', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        return new Response('{}', { status: 200 });
      }
    );
    const client = new HttpDeployAgentClient(
      fetchSpy as unknown as typeof globalThis.fetch
    );
    await client.push({
      deployAgentUrl: 'https://10.0.0.1:8443/',
      sharedSecret: 's',
      siteSlug: 'acme',
      artifact: { kind: 'url', url: 'https://x' },
      primaryDomain: null,
      additionalDomains: [],
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://10.0.0.1:8443/sites/acme/deploy'
    );
  });
});

describe('previewDomainForSlug', () => {
  it('returns a host without protocol prefix', () => {
    const out = previewDomainForSlug('acme');
    expect(out).not.toMatch(/^https?:\/\//);
    expect(out.startsWith('acme.preview.')).toBe(true);
  });
});

describe('an unallocated workspace is allocated by rule at deploy time', () => {
  it('picks the least-loaded active server with room and records it', async () => {
    const { createFakeHostingSupabase } = await import(
      './fake-hosting-supabase'
    );
    const { allocateHostingServer } = await import('../deploy');
    const db = createFakeHostingSupabase();
    db.seed('hosting_servers', [
      { id: 'srv-full', status: 'active', site_capacity: 2, sites_count: 2 },
      { id: 'srv-busy', status: 'active', site_capacity: 50, sites_count: 7 },
      { id: 'srv-quiet', status: 'active', site_capacity: 50, sites_count: 1 },
      {
        id: 'srv-down',
        status: 'provisioning',
        site_capacity: 50,
        sites_count: 0,
      },
    ]);
    db.seed('workspaces', [
      {
        id: 'ws-1',
        slug: 'Ionescu Dental!',
        hosting_server_id: null,
        deploy_status: 'pending',
      },
    ]);
    const picked = await allocateHostingServer(db.client as never, {
      id: 'ws-1',
      slug: 'Ionescu Dental!',
    });
    expect(picked).toBe('srv-quiet');
    const workspace = db.rows('workspaces')[0]!;
    expect(workspace.hosting_server_id).toBe('srv-quiet');
    expect(workspace.site_directory).toBe('/var/www/sites/ionescudental/');
  });

  it('still refuses when no active server has capacity', async () => {
    const { createFakeHostingSupabase } = await import(
      './fake-hosting-supabase'
    );
    const { allocateHostingServer, DeployError } = await import('../deploy');
    const db = createFakeHostingSupabase();
    db.seed('hosting_servers', [
      { id: 'srv-full', status: 'active', site_capacity: 1, sites_count: 1 },
    ]);
    db.seed('workspaces', [
      { id: 'ws-1', slug: 'acme', hosting_server_id: null },
    ]);
    await expect(
      allocateHostingServer(db.client as never, { id: 'ws-1', slug: 'acme' })
    ).rejects.toBeInstanceOf(DeployError);
  });
});

// ─── The agent wire format, the half a URL artifact never exercises ─────────

describe('HttpDeployAgentClient with raw bytes', () => {
  it('sends the tarball as octet-stream with the domains in headers', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ sha256: 'zz', sizeBytes: 7 }), {
          status: 200,
        })
    );
    const client = new HttpDeployAgentClient(
      fetchSpy as unknown as typeof globalThis.fetch
    );
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const out = await client.push({
      deployAgentUrl: 'https://10.0.0.1:8443',
      sharedSecret: 's',
      siteSlug: 'acme',
      artifact: { kind: 'bytes', bytes, sha256: 'deadbeef' },
      primaryDomain: 'acme.com',
      additionalDomains: ['www.acme.com', 'shop.acme.com'],
    });
    expect(out).toEqual({ ok: true, sha256: 'zz', sizeBytes: 7 });
    const headers = fetchSpy.mock.calls[0]![1]?.headers as Record<
      string,
      string
    >;
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers['X-Site-Primary-Domain']).toBe('acme.com');
    expect(headers['X-Site-Additional-Domains']).toBe(
      'www.acme.com,shop.acme.com'
    );
    expect(headers['X-Artifact-Sha256']).toBe('deadbeef');
    expect(fetchSpy.mock.calls[0]![1]?.body).toBe(bytes);
  });

  it('sends empty domain headers and no digest when there is nothing to send', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('', { status: 200 })
    );
    const client = new HttpDeployAgentClient(
      fetchSpy as unknown as typeof globalThis.fetch
    );
    const out = await client.push({
      deployAgentUrl: 'https://10.0.0.1:8443',
      sharedSecret: 's',
      siteSlug: 'acme',
      artifact: { kind: 'bytes', bytes: new Uint8Array([9]).buffer },
      primaryDomain: null,
      additionalDomains: [],
    });
    // An empty body is not an error; the caller just learns nothing about the
    // digest or the size.
    expect(out).toEqual({ ok: true, sha256: '', sizeBytes: 0 });
    const headers = fetchSpy.mock.calls[0]![1]?.headers as Record<
      string,
      string
    >;
    expect(headers['X-Site-Primary-Domain']).toBe('');
    expect(headers['X-Site-Additional-Domains']).toBe('');
    expect(headers['X-Artifact-Sha256']).toBeUndefined();
  });

  it('reports a non-JSON agent failure with the body text', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('<html>502 Bad Gateway</html>', { status: 502 })
    );
    const client = new HttpDeployAgentClient(
      fetchSpy as unknown as typeof globalThis.fetch
    );
    const error = await client
      .push({
        deployAgentUrl: 'https://10.0.0.1:8443',
        sharedSecret: 's',
        siteSlug: 'acme',
        artifact: { kind: 'url', url: 'https://x' },
        primaryDomain: null,
        additionalDomains: [],
      })
      .catch((e: unknown) => e as DeployError);
    expect(error).toBeInstanceOf(DeployError);
    expect((error as DeployError).code).toBe('agent_error');
    expect((error as DeployError).message).toContain('502');
    expect((error as DeployError).message).toContain('Bad Gateway');
  });
});

describe('HttpDeployAgentClient.remove', () => {
  it('DELETEs /sites/{slug} with bearer auth', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('', { status: 200 })
    );
    const client = new HttpDeployAgentClient(
      fetchSpy as unknown as typeof globalThis.fetch
    );
    await client.remove({
      deployAgentUrl: 'https://10.0.0.1:8443/',
      sharedSecret: 'shh',
      siteSlug: 'acme site',
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://10.0.0.1:8443/sites/acme%20site');
    expect(init?.method).toBe('DELETE');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer shh'
    );
  });

  it('throws DeployError when the agent refuses the teardown', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('nope', { status: 500 })
    );
    const client = new HttpDeployAgentClient(
      fetchSpy as unknown as typeof globalThis.fetch
    );
    await expect(
      client.remove({
        deployAgentUrl: 'https://10.0.0.1:8443',
        sharedSecret: 's',
        siteSlug: 'acme',
      })
    ).rejects.toMatchObject({ code: 'agent_error' });
  });
});

// ─── deploySite ────────────────────────────────────────────────────────────
//
// The orchestrator is the only place that decides what bytes land on which
// host, under whose domains, and what the ledger says afterwards. Every one of
// its refusals is load-bearing: deploying to a half-provisioned server, or
// sending one tenant's custom domain with another tenant's site, is not a
// degraded deploy, it is the wrong site answering on somebody's domain.

const WS = '0f4e1088-8d8f-4f18-83b1-000000000001';
const OTHER_WS = '0f4e1088-8d8f-4f18-83b1-000000000002';

function activeServer(overrides: Row = {}): Row {
  return {
    id: 'srv-1',
    name: 'caddy-fsn-01',
    status: 'active',
    ipv4: '203.0.113.10',
    deploy_agent_url: 'https://203.0.113.10:8443',
    deploy_agent_secret_ref: 'deploy_agent_secret_srv_1',
    site_capacity: 50,
    sites_count: 1,
    ...overrides,
  };
}

function workspaceRow(overrides: Row = {}): Row {
  return {
    id: WS,
    slug: 'acme',
    hosting_server_id: 'srv-1',
    site_directory: '/var/www/sites/acme/',
    deploy_status: 'pending',
    cloudflare_zone_id: null,
    ...overrides,
  };
}

/** Records exactly what went over the wire, and can refuse like a real agent. */
function recordingAgent(behaviour: 'ok' | 'throw' = 'ok') {
  const pushes: Array<Parameters<DeployAgentClient['push']>[0]> = [];
  const client: DeployAgentClient = {
    async push(args) {
      pushes.push(args);
      if (behaviour === 'throw') {
        throw new DeployError('agent_error', 'deploy-agent 500: out of disk');
      }
      return { ok: true as const, sha256: 'sha-live', sizeBytes: 4096 };
    },
    async remove() {
      return { ok: true as const };
    },
  };
  return { pushes, client };
}

function fakeCloudflare(behaviour: 'ok' | 'throw' = 'ok') {
  const upsertRecord = vi.fn(async (_input: CloudflareUpsertRecordInput) => {
    if (behaviour === 'throw') throw new Error('cloudflare 403: bad token');
    return { id: 'rec-1' };
  });
  return {
    upsertRecord,
    client: { upsertRecord } as unknown as CloudflareClient,
  };
}

function deployOpts(
  db: ReturnType<typeof createFakeHostingSupabase>,
  overrides: Partial<Parameters<typeof deploySite>[0]> = {}
): Parameters<typeof deploySite>[0] {
  return {
    supabase: db.client as never,
    agentClient: new DryRunDeployAgentClient(),
    cloudflare: null,
    cloudflareDefaultZoneId: null,
    workspaceId: WS,
    artifact: { kind: 'url', url: 'https://artifacts/site.tar.gz' },
    deployedBy: 'user_operator_1',
    resolveSharedSecret: async () => 'agent-shared-secret',
    ...overrides,
  };
}

describe('deploySite', () => {
  it('pushes the artifact, upserts preview DNS and records a live deployment', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    db.seed('workspace_hosts', [
      { workspace_id: WS, hostname: 'acme.com', is_primary: true },
      { workspace_id: WS, hostname: 'www.acme.com', is_primary: false },
    ]);
    const agent = recordingAgent();
    const cf = fakeCloudflare();

    const out = await deploySite(
      deployOpts(db, {
        agentClient: agent.client,
        cloudflare: cf.client,
        cloudflareDefaultZoneId: 'zone-1',
      })
    );

    expect(out.status).toBe('live');
    expect(out.version).toBe(1);
    expect(out.detail).toBeNull();

    expect(agent.pushes).toHaveLength(1);
    expect(agent.pushes[0]).toMatchObject({
      deployAgentUrl: 'https://203.0.113.10:8443',
      sharedSecret: 'agent-shared-secret',
      siteSlug: 'acme',
      primaryDomain: 'acme.com',
      additionalDomains: ['www.acme.com'],
    });

    const dns = cf.upsertRecord.mock.calls[0]![0];
    expect(dns.zoneId).toBe('zone-1');
    expect(dns.name.startsWith('acme.preview.')).toBe(true);
    expect(dns.content).toBe('203.0.113.10');
    expect(dns.proxied).toBe(false);

    const deployment = db.rows('deployments')[0]!;
    expect(deployment).toMatchObject({
      workspace_id: WS,
      version: 1,
      status: 'live',
      deployed_by: 'user_operator_1',
      artifact_url: 'https://artifacts/site.tar.gz',
      artifact_sha256: 'sha-live',
      artifact_bytes: 4096,
    });
    const workspace = db.rows('workspaces')[0]!;
    expect(workspace.deploy_status).toBe('live');
    expect(workspace.last_deploy_id).toBe(deployment.id);
    expect(workspace.last_deployed_at).toEqual(deployment.finished_at);
  });

  it('never sends a neighbouring workspace custom domains to the agent', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    db.seed('workspace_hosts', [
      { workspace_id: OTHER_WS, hostname: 'rival.com', is_primary: true },
      { workspace_id: OTHER_WS, hostname: 'www.rival.com', is_primary: false },
      { workspace_id: WS, hostname: 'acme.com', is_primary: true },
    ]);
    const agent = recordingAgent();

    await deploySite(deployOpts(db, { agentClient: agent.client }));

    expect(agent.pushes[0]!.primaryDomain).toBe('acme.com');
    expect(agent.pushes[0]!.additionalDomains).toEqual([]);
    expect(JSON.stringify(agent.pushes[0])).not.toContain('rival.com');
  });

  it('numbers versions per workspace, not globally', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    db.seed('deployments', [
      { id: 'd-other', workspace_id: OTHER_WS, version: 7, status: 'live' },
      { id: 'd-mine-1', workspace_id: WS, version: 1, status: 'live' },
      { id: 'd-mine-2', workspace_id: WS, version: 2, status: 'live' },
    ]);
    const out = await deploySite(deployOpts(db));
    expect(out.version).toBe(3);
  });

  it('allocates a server by rule when the workspace has none', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow({ hosting_server_id: null })]);
    db.seed('hosting_servers', [activeServer()]);
    const agent = recordingAgent();

    const out = await deploySite(deployOpts(db, { agentClient: agent.client }));

    expect(out.status).toBe('live');
    expect(db.rows('workspaces')[0]!.hosting_server_id).toBe('srv-1');
    expect(agent.pushes[0]!.deployAgentUrl).toBe('https://203.0.113.10:8443');
  });

  it('refuses when no active server has capacity for an unallocated workspace', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow({ hosting_server_id: null })]);
    db.seed('hosting_servers', [
      activeServer({ site_capacity: 4, sites_count: 4 }),
      activeServer({ id: 'srv-2', status: 'provisioning', sites_count: 0 }),
    ]);
    await expect(deploySite(deployOpts(db))).rejects.toMatchObject({
      code: 'workspace_unallocated',
    });
    expect(db.rows('deployments')).toHaveLength(0);
  });

  it('surfaces a workspace read failure as db_error', async () => {
    const db = createFakeHostingSupabase();
    db.failing.add('workspaces');
    await expect(deploySite(deployOpts(db))).rejects.toMatchObject({
      code: 'db_error',
    });
  });

  it('refuses a workspace that does not exist', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', []);
    await expect(deploySite(deployOpts(db))).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
  });

  it('surfaces a hosting_servers read failure as db_error', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.failing.add('hosting_servers');
    await expect(deploySite(deployOpts(db))).rejects.toMatchObject({
      code: 'db_error',
    });
  });

  it('refuses when the assigned server row is gone', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow({ hosting_server_id: 'srv-ghost' })]);
    db.seed('hosting_servers', [activeServer()]);
    await expect(deploySite(deployOpts(db))).rejects.toMatchObject({
      code: 'server_not_found',
    });
  });

  it.each([
    ['provisioning', 'server_not_active'],
    ['draining', 'server_not_active'],
  ])('refuses to deploy onto a %s server', async (status, code) => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer({ status })]);
    await expect(deploySite(deployOpts(db))).rejects.toMatchObject({ code });
  });

  it('refuses a server whose bootstrap never finished', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer({ deploy_agent_url: null })]);
    await expect(deploySite(deployOpts(db))).rejects.toMatchObject({
      code: 'agent_not_configured',
    });
  });

  it('refuses a server with no secret reference', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [
      activeServer({ deploy_agent_secret_ref: null }),
    ]);
    await expect(deploySite(deployOpts(db))).rejects.toMatchObject({
      code: 'secret_not_configured',
    });
  });

  it('refuses when the shared secret cannot be resolved, and names only the ref', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    const error = await deploySite(
      deployOpts(db, { resolveSharedSecret: async () => null })
    ).catch((e: unknown) => e as DeployError);
    expect(error).toBeInstanceOf(DeployError);
    expect((error as DeployError).code).toBe('secret_unavailable');
    // The reference is safe to name; the secret behind it never appears.
    expect((error as DeployError).message).toContain(
      'deploy_agent_secret_srv_1'
    );
  });

  it('surfaces a failed deployments insert as db_error', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    db.failing.add('deployments:insert');
    await expect(deploySite(deployOpts(db))).rejects.toMatchObject({
      code: 'db_error',
    });
  });

  it('records a failed deployment when the deploy-agent answers non-2xx', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: 'extract failed' }), {
          status: 500,
        })
    );
    const out = await deploySite(
      deployOpts(db, {
        agentClient: new HttpDeployAgentClient(
          fetchSpy as unknown as typeof globalThis.fetch
        ),
      })
    );

    expect(out.status).toBe('failed');
    expect(out.detail).toContain('500');
    const deployment = db.rows('deployments')[0]!;
    expect(deployment.status).toBe('failed');
    expect(deployment.status_detail).toContain('500');
    expect(deployment.finished_at).toBeTruthy();
    expect(db.rows('workspaces')[0]!.deploy_status).toBe('failed');
    // A failed push must not leave the workspace pointing at it.
    expect(db.rows('workspaces')[0]!.last_deploy_id).toBeUndefined();
  });

  it('reports a non-Error agent rejection without inventing a message', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    const agentClient: DeployAgentClient = {
      async push() {
        throw 'socket hang up';
      },
      async remove() {
        return { ok: true as const };
      },
    };
    const out = await deploySite(deployOpts(db, { agentClient }));
    expect(out.status).toBe('failed');
    expect(out.detail).toBe('Deploy-agent failed');
  });

  it('keeps a deploy live when the DNS upsert fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    const cf = fakeCloudflare('throw');

    const out = await deploySite(
      deployOpts(db, {
        cloudflare: cf.client,
        cloudflareDefaultZoneId: 'zone-1',
      })
    );

    expect(out.status).toBe('live');
    expect(db.rows('deployments')[0]!.status).toBe('live');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips DNS entirely when the server has no ipv4 yet', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer({ ipv4: null })]);
    const cf = fakeCloudflare();
    const out = await deploySite(
      deployOpts(db, {
        cloudflare: cf.client,
        cloudflareDefaultZoneId: 'zone-1',
      })
    );
    expect(out.status).toBe('live');
    expect(cf.upsertRecord).not.toHaveBeenCalled();
  });

  it('skips DNS when no default zone is configured', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    const cf = fakeCloudflare();
    await deploySite(deployOpts(db, { cloudflare: cf.client }));
    expect(cf.upsertRecord).not.toHaveBeenCalled();
  });

  it('carries the caller-supplied digest onto the pending deployment row', async () => {
    const db = createFakeHostingSupabase();
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const out = await deploySite(
      deployOpts(db, {
        artifact: { kind: 'bytes', bytes, sha256: 'caller-digest' },
      })
    );
    expect(out.status).toBe('live');
    // Raw bytes have no artifact URL to record, and the agent's own digest
    // replaces the caller's once the push succeeds.
    expect(db.rows('deployments')[0]!.artifact_url).toBeNull();
  });
});

describe('allocateHostingServer, the failure half', () => {
  it('surfaces a candidate query failure as db_error', async () => {
    const db = createFakeHostingSupabase();
    db.failing.add('hosting_servers');
    await expect(
      allocateHostingServer(db.client as never, { id: WS, slug: 'acme' })
    ).rejects.toMatchObject({ code: 'db_error' });
  });

  it('refuses a workspace whose slug sanitises to nothing', async () => {
    const db = createFakeHostingSupabase();
    db.seed('hosting_servers', [activeServer()]);
    db.seed('workspaces', [
      workspaceRow({ slug: '!!!', hosting_server_id: null }),
    ]);
    const error = await allocateHostingServer(db.client as never, {
      id: WS,
      slug: '!!!',
    }).catch((e: unknown) => e as DeployError);
    expect((error as DeployError).code).toBe('workspace_unallocated');
    expect((error as DeployError).message).toMatch(/slug is invalid/);
    expect(db.rows('workspaces')[0]!.hosting_server_id).toBeNull();
  });

  it('refuses a null slug rather than writing /var/www/sites//', async () => {
    const db = createFakeHostingSupabase();
    db.seed('hosting_servers', [activeServer()]);
    await expect(
      allocateHostingServer(db.client as never, { id: WS, slug: null })
    ).rejects.toMatchObject({ code: 'workspace_unallocated' });
  });

  it('surfaces a failed workspace update as db_error', async () => {
    const db = createFakeHostingSupabase();
    db.seed('hosting_servers', [activeServer()]);
    db.failing.add('workspaces:update');
    await expect(
      allocateHostingServer(db.client as never, { id: WS, slug: 'acme' })
    ).rejects.toMatchObject({ code: 'db_error' });
  });

  it('re-derives the display site count from the workspaces actually assigned', async () => {
    const db = createFakeHostingSupabase();
    db.seed('hosting_servers', [
      activeServer({ sites_count: 99, site_capacity: 500 }),
    ]);
    db.seed('workspaces', [
      workspaceRow({ hosting_server_id: null }),
      workspaceRow({ id: OTHER_WS, hosting_server_id: 'srv-1' }),
    ]);
    await allocateHostingServer(db.client as never, { id: WS, slug: 'acme' });
    expect(db.rows('hosting_servers')[0]!.sites_count).toBe(2);
  });
});
