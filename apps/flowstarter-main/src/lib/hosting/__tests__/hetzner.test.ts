import { describe, expect, it, vi } from 'vitest';
import { HetznerApiError, HetznerClient, hetznerFromEnv } from '../hetzner';

function mockFetch(responseBody: unknown, init: { status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify(responseBody), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('HetznerClient', () => {
  it('throws if constructed without a token', () => {
    expect(() => new HetznerClient({ token: '' })).toThrow();
  });

  it('createServer POSTs to /servers with bearer auth', async () => {
    const fetchSpy = mockFetch({
      server: { id: 12345, name: 'caddy-fra-01', status: 'initializing' },
      action: { id: 99, status: 'running', command: 'create_server' },
      next_actions: [],
      root_password: null,
    });

    const client = new HetznerClient({
      token: 'tok-123',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });

    const out = await client.createServer({
      name: 'caddy-fra-01',
      server_type: 'cx22',
      image: 'ubuntu-24.04',
      location: 'fsn1',
      user_data: '#cloud-config\n',
    });

    expect(out.server.id).toBe(12345);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.hetzner.cloud/v1/servers');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer tok-123'
    );
    expect(JSON.parse(init?.body as string)).toMatchObject({
      name: 'caddy-fra-01',
      server_type: 'cx22',
    });
  });

  it('getServer returns the server payload', async () => {
    const fetchSpy = mockFetch({
      server: { id: 1, name: 'x', status: 'running' },
    });
    const client = new HetznerClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const server = await client.getServer(1);
    expect(server.id).toBe(1);
    expect(server.status).toBe('running');
  });

  it('listServers passes label_selector + pagination params', async () => {
    const fetchSpy = mockFetch({
      servers: [],
      meta: { pagination: { page: 1, per_page: 25, total_entries: 0 } },
    });
    const client = new HetznerClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await client.listServers({
      label_selector: 'role=caddy',
      page: 2,
      per_page: 50,
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('label_selector=role%3Dcaddy');
    expect(String(url)).toContain('page=2');
    expect(String(url)).toContain('per_page=50');
  });

  it('throws HetznerApiError on non-2xx', async () => {
    const fetchSpy = mockFetch(
      { error: { code: 'invalid_input', message: 'bad name' } },
      { status: 400 }
    );
    const client = new HetznerClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await expect(
      client.createServer({
        name: '',
        server_type: 'cx22',
        image: 'ubuntu-24.04',
      })
    ).rejects.toBeInstanceOf(HetznerApiError);
  });
});

describe('hetznerFromEnv', () => {
  it('throws when HETZNER_API_TOKEN is missing', () => {
    expect(() => hetznerFromEnv({} as unknown as NodeJS.ProcessEnv)).toThrow(
      /HETZNER_API_TOKEN/
    );
  });
  it('returns a client when set', () => {
    const c = hetznerFromEnv({
      HETZNER_API_TOKEN: 'x',
    } as unknown as NodeJS.ProcessEnv);
    expect(c).toBeInstanceOf(HetznerClient);
  });
});

describe('HetznerClient.deleteServer', () => {
  it('DELETEs the server and returns the action', async () => {
    const fetchSpy = mockFetch({
      action: { id: 42, status: 'running', command: 'delete_server' },
    });
    const client = new HetznerClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const out = await client.deleteServer(12345);
    expect(out.action.command).toBe('delete_server');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.hetzner.cloud/v1/servers/12345');
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
  });
});

describe('HetznerClient error shapes that are not the documented envelope', () => {
  it('reports unknown_error with a synthesised message when the body is not the API envelope', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('<html>503 Service Unavailable</html>', { status: 503 })
    );
    const client = new HetznerClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const error = await client
      .getServer(1)
      .catch((e: unknown) => e as HetznerApiError);
    expect(error).toBeInstanceOf(HetznerApiError);
    expect((error as HetznerApiError).status).toBe(503);
    expect((error as HetznerApiError).code).toBe('unknown_error');
    expect((error as HetznerApiError).message).toBe(
      'Hetzner API 503 on GET /servers/1'
    );
    expect((error as HetznerApiError).details).toBeUndefined();
  });

  it('uses the default message when the error payload carries no message', async () => {
    const fetchSpy = mockFetch(
      { error: { code: 'rate_limit_exceeded' } },
      { status: 429 }
    );
    const client = new HetznerClient({
      token: 't',
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const error = await client
      .listServers()
      .catch((e: unknown) => e as HetznerApiError);
    expect((error as HetznerApiError).code).toBe('rate_limit_exceeded');
    expect((error as HetznerApiError).message).toBe(
      'Hetzner API 429 on GET /servers'
    );
  });
});
