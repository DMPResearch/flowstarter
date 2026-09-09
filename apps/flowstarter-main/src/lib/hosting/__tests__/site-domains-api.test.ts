/**
 * Attaching a custom domain to a workspace's site — the shared handler both
 * `/api/admin/.../site/domains` and `/api/team/.../site/domains` re-export.
 *
 * The case this suite exists to pin down: a client's domain almost never
 * lives in a zone we manage, so the "not automated" path is the common one,
 * not the edge case — and it must hand back a record an operator can paste
 * into a support reply, not just an error string.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const AUTHORIZED = {
  authorized: true as const,
  userId: 'user_team_1',
  role: 'team' as const,
};
const requireTeamAuth = vi.fn(async () => AUTHORIZED as unknown);
vi.mock('@/lib/api-auth', () => ({
  requireTeamAuth: () => requireTeamAuth(),
}));

// ─── Cloudflare mock ────────────────────────────────────────────────────────
const cloudflare = {
  findZoneByName: vi.fn(),
  upsertRecord: vi.fn(),
  deleteRecord: vi.fn(),
};

class MockCloudflareApiError extends Error {
  constructor(
    public status: number,
    public errors: Array<{ code: number; message: string }>
  ) {
    super('Cloudflare API error');
    this.name = 'CloudflareApiError';
  }
}

vi.mock('../cloudflare', () => ({
  CloudflareClient: class {
    findZoneByName = cloudflare.findZoneByName;
    upsertRecord = cloudflare.upsertRecord;
    deleteRecord = cloudflare.deleteRecord;
  },
  CloudflareApiError: MockCloudflareApiError,
}));

// ─── Supabase mock: a script per table, keyed the way the handler reads it ──
interface Script {
  workspace?: { data: unknown; error: unknown };
  hostingServer?: { data: unknown; error: unknown };
  existingHosts?: { data: unknown; error: unknown };
  updatedHosts?: { data: unknown; error: unknown };
  /** Errors keyed by the write the handler makes, so one can fail alone. */
  hostInsertError?: string;
  hostUpdateError?: string;
  hostDeleteError?: string;
}
const script: Script = {};
const captured: {
  hostInsert?: Record<string, unknown>;
  hostUpdate?: Record<string, unknown>;
  workspaceUpdate?: Record<string, unknown>;
  hostDelete: boolean;
} = { hostDelete: false };

function builderFor(table: string) {
  let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
  const builder = {
    select() {
      return builder;
    },
    insert(values: Record<string, unknown>) {
      mode = 'insert';
      if (table === 'workspace_hosts') captured.hostInsert = values;
      return builder;
    },
    update(values: Record<string, unknown>) {
      mode = 'update';
      if (table === 'workspaces') captured.workspaceUpdate = values;
      if (table === 'workspace_hosts') captured.hostUpdate = values;
      return builder;
    },
    delete() {
      mode = 'delete';
      if (table === 'workspace_hosts') captured.hostDelete = true;
      return builder;
    },
    eq() {
      return builder;
    },
    maybeSingle() {
      if (table === 'workspaces') {
        return Promise.resolve(
          script.workspace ?? {
            data: {
              id: 'ws_1',
              slug: 'acme',
              hosting_server_id: 'srv_1',
              cloudflare_zone_id: null,
              cloudflare_record_ids: {},
            },
            error: null,
          }
        );
      }
      if (table === 'hosting_servers') {
        return Promise.resolve(
          script.hostingServer ?? { data: { ipv4: '203.0.113.5' }, error: null }
        );
      }
      return Promise.resolve({ data: null, error: null });
    },
    then(resolve: (v: { data: unknown; error: unknown }) => void) {
      // workspace_hosts .select().eq() resolves as a thenable when awaited
      // directly (no .maybeSingle()) — that is how "existing hosts" is read.
      if (table !== 'workspace_hosts') {
        resolve({ data: null, error: null });
        return;
      }
      const writeError =
        mode === 'insert'
          ? script.hostInsertError
          : mode === 'update'
          ? script.hostUpdateError
          : mode === 'delete'
          ? script.hostDeleteError
          : undefined;
      if (mode !== 'select') {
        resolve({
          data: null,
          error: writeError ? { message: writeError } : null,
        });
        return;
      }
      resolve(script.existingHosts ?? { data: [], error: null });
    },
  };
  return builder;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builderFor }),
}));

function makeReq(body: unknown, url?: string): NextRequest {
  return {
    json: async () => body,
    url:
      url ??
      'https://example.com/api/team/projects/ws_1/site/domains?domain=acme.example.com',
    headers: new Headers(),
  } as unknown as NextRequest;
}

/** A request whose body is not JSON at all — the handler must not 500. */
function makeUnparseableReq(): NextRequest {
  return {
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
    url: 'https://example.com/api/team/projects/ws_1/site/domains',
    headers: new Headers(),
  } as unknown as NextRequest;
}

const ctx = { params: Promise.resolve({ id: 'ws_1' }) };

beforeEach(() => {
  delete script.workspace;
  delete script.hostingServer;
  delete script.existingHosts;
  delete script.hostInsertError;
  delete script.hostUpdateError;
  delete script.hostDeleteError;
  captured.hostInsert = undefined;
  captured.hostUpdate = undefined;
  captured.workspaceUpdate = undefined;
  captured.hostDelete = false;
  requireTeamAuth.mockReset();
  requireTeamAuth.mockResolvedValue(AUTHORIZED);
  cloudflare.findZoneByName.mockReset();
  cloudflare.upsertRecord.mockReset();
  cloudflare.deleteRecord.mockReset();
  delete process.env.CLOUDFLARE_API_TOKEN;
});

describe('addWorkspaceDomainHandler', () => {
  it('attaches the domain and hands back a manual A record when Cloudflare is not configured', async () => {
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');

    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.dns.automated).toBe(false);
    expect(body.dns.manualRecord).toMatchObject({
      type: 'A',
      name: 'acme.example.com',
      value: '203.0.113.5',
    });
    expect(body.dns.error).toMatch(/not configured/);
    expect(captured.hostInsert).toMatchObject({
      workspace_id: 'ws_1',
      hostname: 'acme.example.com',
    });
  });

  it('automates the DNS record when Cloudflare manages the zone', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    cloudflare.findZoneByName.mockImplementation(async (name: string) =>
      name === 'example.com' ? { id: 'zone1', name: 'example.com' } : null
    );
    cloudflare.upsertRecord.mockResolvedValue({ id: 'rec1' });

    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    const body = await res.json();

    expect(body.dns.automated).toBe(true);
    expect(body.dns.manualRecord).toBeNull();
    expect(body.dns.recordId).toBe('rec1');
    expect(cloudflare.upsertRecord).toHaveBeenCalledWith(
      expect.objectContaining({ zoneId: 'zone1', content: '203.0.113.5' })
    );
    // The zone id is remembered on the workspace for later teardown.
    expect(captured.workspaceUpdate).toMatchObject({
      cloudflare_zone_id: 'zone1',
    });
  });

  it('still hands back a manual record when Cloudflare is configured but does not manage this zone', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    cloudflare.findZoneByName.mockResolvedValue(null);

    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    const body = await res.json();

    expect(body.dns.automated).toBe(false);
    expect(body.dns.manualRecord?.value).toBe('203.0.113.5');
    expect(body.dns.error).toMatch(/not.*manage/);
  });

  it('has no manual record to offer when the server has no ipv4 yet', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    script.hostingServer = { data: { ipv4: null }, error: null };

    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    const body = await res.json();

    expect(body.dns.manualRecord).toBeNull();
    expect(body.dns.error).toMatch(/no ipv4/i);
  });

  it('refuses when the workspace has no allocated server', async () => {
    script.workspace = {
      data: {
        id: 'ws_1',
        slug: 'acme',
        hosting_server_id: null,
        cloudflare_zone_id: null,
        cloudflare_record_ids: {},
      },
      error: null,
    };

    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    expect(res.status).toBe(404);
    expect(captured.hostInsert).toBeUndefined();
  });

  it('refuses a domain already attached to the workspace', async () => {
    script.existingHosts = {
      data: [{ hostname: 'acme.example.com', is_primary: true }],
      error: null,
    };

    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    expect(res.status).toBe(409);
  });

  it('rejects a malformed domain before touching the database', async () => {
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'not a domain' }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(captured.hostInsert).toBeUndefined();
  });
});

describe('removeWorkspaceDomainHandler', () => {
  it('detaches the domain', async () => {
    const { removeWorkspaceDomainHandler } = await import(
      '../site-domains-api'
    );
    const res = await removeWorkspaceDomainHandler(makeReq({}), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.domain).toBe('acme.example.com');
    expect(captured.hostDelete).toBe(true);
  });
});

describe('addWorkspaceDomainHandler, the refusals and the write failures', () => {
  it('hands back the auth response and never reaches the database', async () => {
    const denied = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    requireTeamAuth.mockResolvedValue({
      authorized: false as const,
      response: denied,
    });
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    expect(res).toBe(denied);
    expect(captured.hostInsert).toBeUndefined();
  });

  it('treats an unparseable body as an empty one and answers 400', async () => {
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(makeUnparseableReq(), ctx);
    expect(res.status).toBe(400);
  });

  it.each([
    ['a non-string', 42],
    ['a single label', 'localhost'],
    ['a label that is too long', `${'a'.repeat(300)}.com`],
    ['a leading dot', '.example.com'],
  ])('rejects %s domain', async (_label, domain) => {
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(makeReq({ domain }), ctx);
    expect(res.status).toBe(400);
    expect(captured.hostInsert).toBeUndefined();
  });

  it('trims and lowercases the domain before it is attached', async () => {
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: '  ACME.Example.COM ' }),
      ctx
    );
    const body = await res.json();
    expect(body.domain).toBe('acme.example.com');
    expect(captured.hostInsert).toMatchObject({ hostname: 'acme.example.com' });
  });

  it('surfaces a workspace read failure as a 500', async () => {
    script.workspace = { data: null, error: { message: 'pg: timeout' } };
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('pg: timeout');
  });

  it('404s for a workspace that does not exist', async () => {
    script.workspace = { data: null, error: null };
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Workspace not found');
  });

  it('surfaces an existing-hosts read failure as a 500', async () => {
    script.existingHosts = { data: null, error: { message: 'pg: no hosts' } };
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    expect(res.status).toBe(500);
    expect(captured.hostInsert).toBeUndefined();
  });

  it('demotes the current primary before promoting the new domain', async () => {
    script.existingHosts = {
      data: [{ hostname: 'old.example.com', is_primary: true }],
      error: null,
    };
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'new.example.com', primary: true }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(captured.hostUpdate).toEqual({ is_primary: false });
    expect(captured.hostInsert).toMatchObject({
      hostname: 'new.example.com',
      is_primary: true,
    });
  });

  it('has nothing to demote when no host is primary yet', async () => {
    script.existingHosts = {
      data: [{ hostname: 'old.example.com', is_primary: false }],
      error: null,
    };
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    await addWorkspaceDomainHandler(
      makeReq({ domain: 'new.example.com', primary: true }),
      ctx
    );
    expect(captured.hostUpdate).toBeUndefined();
  });

  it('stops at a 500 rather than leaving two primary domains attached', async () => {
    script.existingHosts = {
      data: [{ hostname: 'old.example.com', is_primary: true }],
      error: null,
    };
    script.hostUpdateError = 'pg: demote failed';
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'new.example.com', primary: true }),
      ctx
    );
    expect(res.status).toBe(500);
    expect(captured.hostInsert).toBeUndefined();
  });

  it('surfaces a failed host insert as a 500', async () => {
    script.hostInsertError = 'pg: unique violation';
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('pg: unique violation');
  });

  it('reports a Cloudflare API refusal in the operator-readable dns.error', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    cloudflare.findZoneByName.mockResolvedValue({
      id: 'zone1',
      name: 'example.com',
    });
    cloudflare.upsertRecord.mockRejectedValue(
      new MockCloudflareApiError(403, [
        { code: 1003, message: 'invalid token' },
        { code: 9103, message: 'unauthorized' },
      ])
    );
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    const body = await res.json();
    expect(body.dns.automated).toBe(false);
    expect(body.dns.error).toBe(
      'Cloudflare error: invalid token; unauthorized'
    );
    // The domain is still attached, with instructions the client can act on.
    expect(captured.hostInsert).toMatchObject({ hostname: 'acme.example.com' });
    expect(body.dns.manualRecord?.value).toBe('203.0.113.5');
  });

  it('reports a plain network failure without pretending it was Cloudflare', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    cloudflare.findZoneByName.mockRejectedValue(new Error('ECONNRESET'));
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    const body = await res.json();
    // findManagedZone swallows per-attempt failures, so every candidate label
    // fails and the answer is "not a zone we manage", not a stack trace.
    expect(body.dns.automated).toBe(false);
    expect(body.dns.error).toMatch(/not.*manage/);
  });

  it('walks up to the parent zone when the exact hostname is not one', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    cloudflare.findZoneByName.mockImplementation(async (name: string) =>
      name === 'example.com' ? { id: 'zone1', name: 'example.com' } : null
    );
    cloudflare.upsertRecord.mockResolvedValue({ id: 'rec1' });
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    await addWorkspaceDomainHandler(
      makeReq({ domain: 'shop.acme.example.com' }),
      ctx
    );
    expect(cloudflare.findZoneByName.mock.calls.map((c) => c[0])).toEqual([
      'shop.acme.example.com',
      'acme.example.com',
      'example.com',
    ]);
  });

  it('keeps the zone id the workspace already had', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    script.workspace = {
      data: {
        id: 'ws_1',
        slug: 'acme',
        hosting_server_id: 'srv_1',
        cloudflare_zone_id: 'zone-original',
        cloudflare_record_ids: null,
      },
      error: null,
    };
    cloudflare.findZoneByName.mockResolvedValue({
      id: 'zone-new',
      name: 'example.com',
    });
    cloudflare.upsertRecord.mockResolvedValue({ id: 'rec1' });
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    expect(captured.workspaceUpdate).toMatchObject({
      cloudflare_zone_id: 'zone-original',
      cloudflare_record_ids: {
        'acme.example.com': { recordId: 'rec1', zoneId: 'zone-new' },
      },
    });
  });

  it('has no manual record to offer when the server row is missing entirely', async () => {
    script.hostingServer = { data: null, error: null };
    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    const body = await res.json();
    expect(body.dns.manualRecord).toBeNull();
    expect(captured.hostInsert).toMatchObject({ hostname: 'acme.example.com' });
  });
});

describe('removeWorkspaceDomainHandler, the rest of it', () => {
  it('hands back the auth response and never deletes', async () => {
    const denied = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    requireTeamAuth.mockResolvedValue({
      authorized: false as const,
      response: denied,
    });
    const { removeWorkspaceDomainHandler } = await import(
      '../site-domains-api'
    );
    const res = await removeWorkspaceDomainHandler(makeReq({}), ctx);
    expect(res).toBe(denied);
    expect(captured.hostDelete).toBe(false);
  });

  it('400s without a domain query param', async () => {
    const { removeWorkspaceDomainHandler } = await import(
      '../site-domains-api'
    );
    const res = await removeWorkspaceDomainHandler(
      makeReq({}, 'https://example.com/api/team/projects/ws_1/site/domains'),
      ctx
    );
    expect(res.status).toBe(400);
    expect(captured.hostDelete).toBe(false);
  });

  it('surfaces a workspace read failure as a 500 and a missing one as a 404', async () => {
    const { removeWorkspaceDomainHandler } = await import(
      '../site-domains-api'
    );
    script.workspace = { data: null, error: { message: 'pg: timeout' } };
    expect((await removeWorkspaceDomainHandler(makeReq({}), ctx)).status).toBe(
      500
    );
    script.workspace = { data: null, error: null };
    const res = await removeWorkspaceDomainHandler(makeReq({}), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Workspace not found');
    expect(captured.hostDelete).toBe(false);
  });

  it('deletes the Cloudflare record it created and forgets the mapping', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    script.workspace = {
      data: {
        id: 'ws_1',
        cloudflare_record_ids: {
          'acme.example.com': { recordId: 'rec1', zoneId: 'zone1' },
          'other.example.com': { recordId: 'rec2', zoneId: 'zone1' },
        },
      },
      error: null,
    };
    const { removeWorkspaceDomainHandler } = await import(
      '../site-domains-api'
    );
    const res = await removeWorkspaceDomainHandler(makeReq({}), ctx);
    const body = await res.json();
    expect(cloudflare.deleteRecord).toHaveBeenCalledWith('zone1', 'rec1');
    expect(body.dnsError).toBeNull();
    // The other domain's record survives the detach.
    expect(captured.workspaceUpdate?.cloudflare_record_ids).toEqual({
      'other.example.com': { recordId: 'rec2', zoneId: 'zone1' },
    });
  });

  it('still detaches the domain when the Cloudflare delete fails', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    script.workspace = {
      data: {
        id: 'ws_1',
        cloudflare_record_ids: {
          'acme.example.com': { recordId: 'rec1', zoneId: 'zone1' },
        },
      },
      error: null,
    };
    cloudflare.deleteRecord.mockRejectedValue(new Error('cloudflare 502'));
    const { removeWorkspaceDomainHandler } = await import(
      '../site-domains-api'
    );
    const res = await removeWorkspaceDomainHandler(makeReq({}), ctx);
    const body = await res.json();
    expect(body.dnsError).toBe('cloudflare 502');
    expect(captured.hostDelete).toBe(true);
  });

  it('does not call Cloudflare for a domain it never automated', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    script.workspace = {
      data: { id: 'ws_1', cloudflare_record_ids: null },
      error: null,
    };
    const { removeWorkspaceDomainHandler } = await import(
      '../site-domains-api'
    );
    const res = await removeWorkspaceDomainHandler(makeReq({}), ctx);
    expect(cloudflare.deleteRecord).not.toHaveBeenCalled();
    expect((await res.json()).dnsError).toBeNull();
  });

  it('surfaces a failed detach as a 500', async () => {
    script.hostDeleteError = 'pg: delete failed';
    const { removeWorkspaceDomainHandler } = await import(
      '../site-domains-api'
    );
    const res = await removeWorkspaceDomainHandler(makeReq({}), ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('pg: delete failed');
  });
});

describe('a DNS write that fails for a reason Cloudflare never named', () => {
  it('reports the raw error and still attaches the domain', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    cloudflare.findZoneByName.mockResolvedValue({
      id: 'zone1',
      name: 'example.com',
    });
    cloudflare.upsertRecord.mockRejectedValue(new Error('ETIMEDOUT'));

    const { addWorkspaceDomainHandler } = await import('../site-domains-api');
    const res = await addWorkspaceDomainHandler(
      makeReq({ domain: 'acme.example.com' }),
      ctx
    );
    const body = await res.json();
    expect(body.dns.automated).toBe(false);
    expect(body.dns.error).toBe('ETIMEDOUT');
    expect(captured.hostInsert).toMatchObject({ hostname: 'acme.example.com' });
    expect(body.dns.manualRecord?.value).toBe('203.0.113.5');
  });
});
