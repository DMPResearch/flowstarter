/**
 * Connecting an existing Hetzner server, not creating one.
 *
 * The whole point of this endpoint is that the caller controls nothing: no
 * URL, no secret, no host id. So most of what's worth pinning down here is
 * "what happens when the operator's own env is wrong" and "what happens when
 * the agent it points to isn't actually ready" — never "what if a caller
 * passes X", because there is no caller input to pass.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFakeHostingSupabase } from './fake-hosting-supabase';
import {
  connectExistingHostingServer,
  readExistingHostConfig,
  type ConnectExistingServerErrorCode,
} from '../connect-existing-server';
import { HetznerApiError, type HetznerServer } from '../hetzner';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../database.types';

vi.mock('server-only', () => ({}));

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  FLOWSTARTER_EXISTING_HOST_ID: '12345',
  FLOWSTARTER_EXISTING_HOST_AGENT_URL: 'https://agent.example.com:8443',
  FLOWSTARTER_EXISTING_HOST_SECRET_REF: 'MY_HOST_SECRET',
  MY_HOST_SECRET: 'shh-shared-secret',
};

function okHealthFetch(body: unknown = { ok: true, siteRuntime: 'docker' }) {
  return vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status: 200 })
  );
}

function runningServer(overrides: Partial<HetznerServer> = {}): HetznerServer {
  return {
    id: 12345,
    name: 'ops-box-1',
    status: 'running',
    created: '2026-01-01T00:00:00Z',
    public_net: { ipv4: { ip: '203.0.113.10', blocked: false, dns_ptr: '' } },
    server_type: { id: 1, name: 'cpx31' },
    datacenter: {
      id: 1,
      name: 'fsn1-dc14',
      location: { name: 'fsn1', country: 'DE' },
    },
    image: { id: 1, name: 'ubuntu-24.04', type: 'system' },
    iso: null,
    rescue_enabled: false,
    locked: false,
    protection: { delete: false, rebuild: false },
    labels: {},
    ...overrides,
  };
}

/** Asserts a sync throw carries the expected `ConnectExistingServerError` code. */
function expectThrowsCode(
  fn: () => unknown,
  code: ConnectExistingServerErrorCode
) {
  try {
    fn();
  } catch (e) {
    expect(e).toMatchObject({
      name: 'ConnectExistingServerError',
      code,
    });
    return;
  }
  throw new Error(`expected function to throw ${code}, but it did not`);
}

/** Asserts a rejected promise carries the expected `ConnectExistingServerError` code. */
async function expectRejectsCode(
  promise: Promise<unknown>,
  code: ConnectExistingServerErrorCode
) {
  await expect(promise).rejects.toMatchObject({
    name: 'ConnectExistingServerError',
    code,
  });
}

describe('readExistingHostConfig', () => {
  it('reports config_missing when any of the three env vars is absent', () => {
    expectThrowsCode(
      () => readExistingHostConfig({ NODE_ENV: 'test' }),
      'config_missing'
    );
    expectThrowsCode(
      () =>
        readExistingHostConfig({
          NODE_ENV: 'test',
          FLOWSTARTER_EXISTING_HOST_ID: '1',
          FLOWSTARTER_EXISTING_HOST_AGENT_URL: 'https://x',
        }),
      'config_missing'
    );
  });

  it('rejects a non-numeric host id', () => {
    expectThrowsCode(
      () =>
        readExistingHostConfig({
          ...BASE_ENV,
          FLOWSTARTER_EXISTING_HOST_ID: 'not-a-number',
        }),
      'config_invalid'
    );
  });

  it('rejects an agent URL that is neither https nor loopback http', () => {
    expectThrowsCode(
      () =>
        readExistingHostConfig({
          ...BASE_ENV,
          FLOWSTARTER_EXISTING_HOST_AGENT_URL: 'http://10.0.0.5:8443',
        }),
      'config_invalid'
    );
  });

  it('accepts loopback http, for a local SSH tunnel', () => {
    const config = readExistingHostConfig({
      ...BASE_ENV,
      FLOWSTARTER_EXISTING_HOST_AGENT_URL: 'http://127.0.0.1:8443',
    });
    expect(config.agentUrl).toBe('http://127.0.0.1:8443');
  });

  it('rejects a secret ref that is not a strict uppercase env var name', () => {
    expectThrowsCode(
      () =>
        readExistingHostConfig({
          ...BASE_ENV,
          FLOWSTARTER_EXISTING_HOST_SECRET_REF: 'my_secret',
        }),
      'config_invalid'
    );
    expectThrowsCode(
      () =>
        readExistingHostConfig({
          ...BASE_ENV,
          FLOWSTARTER_EXISTING_HOST_SECRET_REF: 'has spaces',
        }),
      'config_invalid'
    );
  });
});

describe('connectExistingHostingServer', () => {
  it('fails fast on missing config before ever calling the agent or Hetzner', async () => {
    const db = createFakeHostingSupabase();
    const fetchImpl = vi.fn();
    const hetznerClient = { getServer: vi.fn() };

    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: { NODE_ENV: 'test' },
        fetchImpl,
        hetznerClient,
      }),
      'config_missing'
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(hetznerClient.getServer).not.toHaveBeenCalled();
  });

  it('fails when the ref names an env var that is not actually set', async () => {
    const db = createFakeHostingSupabase();
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: { ...BASE_ENV, MY_HOST_SECRET: undefined },
        fetchImpl: vi.fn(),
        hetznerClient: { getServer: vi.fn() },
      }),
      'secret_unavailable'
    );
  });

  it('sends the resolved secret, redirect:error and a timeout to /health, and requires ok:true + siteRuntime:docker', async () => {
    const db = createFakeHostingSupabase();
    const fetchImpl = okHealthFetch();
    const hetznerClient = { getServer: vi.fn(async () => runningServer()) };

    await connectExistingHostingServer({
      supabase: db.client as unknown as SupabaseClient<Database>,
      createdBy: 'user_ops_1',
      env: BASE_ENV,
      fetchImpl,
      hetznerClient,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://agent.example.com:8443/health');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer shh-shared-secret'
    );
  });

  it('rejects a health body missing ok:true', async () => {
    const db = createFakeHostingSupabase();
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: BASE_ENV,
        fetchImpl: okHealthFetch({ ok: false, siteRuntime: 'docker' }),
        hetznerClient: { getServer: vi.fn(async () => runningServer()) },
      }),
      'health_check_failed'
    );
  });

  it('rejects a health body missing siteRuntime:docker', async () => {
    const db = createFakeHostingSupabase();
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: BASE_ENV,
        fetchImpl: okHealthFetch({ ok: true, siteRuntime: 'bare-metal' }),
        hetznerClient: { getServer: vi.fn(async () => runningServer()) },
      }),
      'health_check_failed'
    );
  });

  it('rejects a non-2xx health response', async () => {
    const db = createFakeHostingSupabase();
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: BASE_ENV,
        fetchImpl,
        hetznerClient: { getServer: vi.fn(async () => runningServer()) },
      }),
      'health_check_failed'
    );
  });

  it('treats a redirect (thrown by fetch under redirect:"error") as a health failure', async () => {
    const db = createFakeHostingSupabase();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('unexpected redirect, redirect mode is set to error');
    });
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: BASE_ENV,
        fetchImpl,
        hetznerClient: { getServer: vi.fn(async () => runningServer()) },
      }),
      'health_check_failed'
    );
  });

  it('treats a network error reaching the agent as a health failure', async () => {
    const db = createFakeHostingSupabase();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: BASE_ENV,
        fetchImpl,
        hetznerClient: { getServer: vi.fn(async () => runningServer()) },
      }),
      'health_check_failed'
    );
  });

  it('treats a health-check timeout (abort) as a health failure', async () => {
    const db = createFakeHostingSupabase();
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: BASE_ENV,
        fetchImpl,
        hetznerClient: { getServer: vi.fn(async () => runningServer()) },
      }),
      'health_check_failed'
    );
  });

  it('surfaces a Hetzner API failure distinctly from a health failure', async () => {
    const db = createFakeHostingSupabase();
    const hetznerClient = {
      getServer: vi.fn(async () => {
        throw new HetznerApiError(
          404,
          'not_found',
          undefined,
          'no such server'
        );
      }),
    };
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: BASE_ENV,
        fetchImpl: okHealthFetch(),
        hetznerClient,
      }),
      'hetzner_api_failed'
    );
  });

  it('refuses a server that Hetzner reports as not running', async () => {
    const db = createFakeHostingSupabase();
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: BASE_ENV,
        fetchImpl: okHealthFetch(),
        hetznerClient: {
          getServer: vi.fn(async () => runningServer({ status: 'off' })),
        },
      }),
      'server_not_ready'
    );
  });

  it('refuses a running server with no public IPv4', async () => {
    const db = createFakeHostingSupabase();
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: BASE_ENV,
        fetchImpl: okHealthFetch(),
        hetznerClient: {
          getServer: vi.fn(async () => runningServer({ public_net: {} })),
        },
      }),
      'server_not_ready'
    );
  });

  it('inserts a new row with defaults, never leaking the agent URL or secret ref', async () => {
    const db = createFakeHostingSupabase();
    const result = await connectExistingHostingServer({
      supabase: db.client as unknown as SupabaseClient<Database>,
      createdBy: 'user_ops_1',
      env: BASE_ENV,
      fetchImpl: okHealthFetch(),
      hetznerClient: { getServer: vi.fn(async () => runningServer()) },
    });

    expect(result).toMatchObject({
      name: 'ops-box-1',
      provider: 'hetzner',
      hetzner_server_id: '12345',
      ipv4: '203.0.113.10',
      location: 'fsn1',
      server_type: 'cpx31',
      status: 'active',
      site_capacity: 50,
      sites_count: 0,
    });
    expect(result).not.toHaveProperty('deploy_agent_url');
    expect(result).not.toHaveProperty('deploy_agent_secret_ref');

    const row = db.rows('hosting_servers')[0];
    expect(row.created_by).toBe('user_ops_1');
    expect(row.deploy_agent_url).toBe('https://agent.example.com:8443');
    expect(row.deploy_agent_secret_ref).toBe('MY_HOST_SECRET');
  });

  it('is idempotent: reconnecting an already-connected server updates metadata without resetting sites_count', async () => {
    const db = createFakeHostingSupabase();
    db.seed('hosting_servers', [
      {
        id: '0f4e1088-8d8f-4f18-83b1-000000000001',
        provider: 'hetzner',
        hetzner_server_id: '12345',
        name: 'ops-box-1-old-name',
        ipv4: '203.0.113.9',
        location: 'fsn1',
        server_type: 'cpx21',
        status: 'error',
        site_capacity: 50,
        sites_count: 7,
        created_by: 'user_ops_1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);

    const result = await connectExistingHostingServer({
      supabase: db.client as unknown as SupabaseClient<Database>,
      createdBy: 'user_ops_2',
      env: BASE_ENV,
      fetchImpl: okHealthFetch(),
      hetznerClient: { getServer: vi.fn(async () => runningServer()) },
    });

    expect(db.rows('hosting_servers')).toHaveLength(1);
    expect(result).toMatchObject({
      id: '0f4e1088-8d8f-4f18-83b1-000000000001',
      name: 'ops-box-1',
      ipv4: '203.0.113.10',
      server_type: 'cpx31',
      status: 'active',
      sites_count: 7,
    });

    const row = db.rows('hosting_servers')[0];
    expect(row.sites_count).toBe(7);
    expect(row.created_by).toBe('user_ops_1');
  });

  it('surfaces a db error distinctly', async () => {
    const db = createFakeHostingSupabase();
    db.failing.add('hosting_servers');
    await expectRejectsCode(
      connectExistingHostingServer({
        supabase: db.client as unknown as SupabaseClient<Database>,
        createdBy: 'user_ops_1',
        env: BASE_ENV,
        fetchImpl: okHealthFetch(),
        hetznerClient: { getServer: vi.fn(async () => runningServer()) },
      }),
      'db_error'
    );
  });
});
