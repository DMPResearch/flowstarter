/**
 * "Your site is live", from the one place a site actually goes live.
 *
 * Two halves are worth proving separately. `notifySiteLive` has to resolve the
 * address the same way the deploy does, including the local deploy-agent case
 * that a real end-to-end run on one machine landed in and that the dashboard
 * used to get wrong. And `deploySite` has to actually call it, once per
 * version, without ever letting a mail problem turn a deploy that worked into
 * a deploy reported as failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostingSupabase, type Row } from './fake-hosting-supabase';

vi.mock('server-only', () => ({}));

const sendEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

// `notifyClientOnce` falls back to this when no client is passed. Nothing in
// this file takes that path, but the module is imported either way and must
// not reach for a real Supabase connection at import time.
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => {
    throw new Error('service-role client should not be used here');
  },
}));

import { DryRunDeployAgentClient, deploySite } from '../deploy';
import { notifySiteLive } from '../site-live-email';

const WS = '0f4e1088-8d8f-4f18-83b1-000000000001';

function workspaceRow(overrides: Row = {}): Row {
  return {
    id: WS,
    slug: 'acme',
    name: 'Acme workspace',
    client_email: 'client@example.com',
    client_name: 'Darius',
    client_business_name: 'Acme Dental',
    hosting_server_id: 'srv-1',
    site_directory: '/var/www/sites/acme/',
    deploy_status: 'pending',
    cloudflare_zone_id: null,
    ...overrides,
  };
}

function activeServer(): Row {
  return {
    id: 'srv-1',
    name: 'caddy-fsn-01',
    status: 'active',
    ipv4: '203.0.113.10',
    deploy_agent_url: 'https://203.0.113.10:8443',
    deploy_agent_secret_ref: 'deploy_agent_secret_srv_1',
    site_capacity: 50,
    sites_count: 1,
  };
}

let db: ReturnType<typeof createFakeHostingSupabase>;

beforeEach(() => {
  db = createFakeHostingSupabase();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true, id: 'em_1' });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

function sentHtml(call = 0): string {
  return (sendEmail.mock.calls[call]![0] as { html: string }).html;
}

describe('notifySiteLive', () => {
  beforeEach(() => {
    db.seed('workspaces', [workspaceRow()]);
  });

  it('sends the client the address their site is actually served at', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://flowstarter.dev';
    const sent = await notifySiteLive({
      supabase: db.client as never,
      workspaceId: WS,
      version: 1,
      slug: 'acme',
      primaryDomain: 'acmedental.ie',
      deploymentId: 'dep-1',
    });

    expect(sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(mail.to).toBe('client@example.com');
    expect(mail.subject).toBe('Your site is live');
    expect(mail.html).toContain('https://acmedental.ie');
    expect(mail.html).toContain(
      `https://flowstarter.dev/dashboard/projects/${WS}`
    );
    expect(mail.html).toContain('Acme Dental');
  });

  it('uses the local deploy-agent URL when there is no public preview host', async () => {
    // The case a whole real run fell into: the site was published and served
    // on the machine, and the only link the client was given resolved nowhere.
    const sent = await notifySiteLive({
      supabase: db.client as never,
      workspaceId: WS,
      version: 1,
      slug: 'acme',
      primaryDomain: null,
      env: {
        NODE_ENV: 'development',
        FLOWSTARTER_LOCAL_SITE_BASE_URL: 'http://127.0.0.1:8842',
      },
    });

    expect(sent).toBe(true);
    expect(sentHtml()).toContain('http://127.0.0.1:8842/acme/');
  });

  it("falls back to the site's own final hostname", async () => {
    await notifySiteLive({
      supabase: db.client as never,
      workspaceId: WS,
      version: 1,
      slug: 'acme',
      env: { NODE_ENV: 'production' },
    });
    expect(sentHtml()).toContain('https://acme.flowstarter.net');
    expect(sentHtml()).not.toContain('acme.preview.');
  });

  it('records the version and the resolved URL for an operator', async () => {
    await notifySiteLive({
      supabase: db.client as never,
      workspaceId: WS,
      version: 7,
      slug: 'acme',
      primaryDomain: 'acmedental.ie',
      deploymentId: 'dep-7',
    });
    expect(db.rows('project_events')[0]!.payload).toMatchObject({
      notification: 'site_live',
      dedupeKey: '7',
      version: 7,
      siteUrl: 'https://acmedental.ie',
      deploymentId: 'dep-7',
    });
  });

  it('says nothing twice about the same version, and once about the next', async () => {
    const args = {
      supabase: db.client as never,
      workspaceId: WS,
      slug: 'acme',
      primaryDomain: 'acmedental.ie',
    };
    expect(await notifySiteLive({ ...args, version: 1 })).toBe(true);
    expect(await notifySiteLive({ ...args, version: 1 })).toBe(false);
    // A client who publishes an edit really has put a new site live.
    expect(await notifySiteLive({ ...args, version: 2 })).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('reports false rather than throwing when there is no address', async () => {
    db.reset();
    db.seed('workspaces', [workspaceRow({ client_email: null })]);
    await expect(
      notifySiteLive({
        supabase: db.client as never,
        workspaceId: WS,
        version: 1,
        slug: 'acme',
      })
    ).resolves.toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('deploySite tells the client', () => {
  function opts(overrides: Record<string, unknown> = {}) {
    return {
      supabase: db.client as never,
      agentClient: new DryRunDeployAgentClient(),
      cloudflare: null,
      cloudflareDefaultZoneId: null,
      workspaceId: WS,
      artifact: { kind: 'url' as const, url: 'https://artifacts/site.tar.gz' },
      deployedBy: 'user_operator_1',
      resolveSharedSecret: async () => 'agent-shared-secret',
      ...overrides,
    };
  }

  beforeEach(() => {
    db.seed('workspaces', [workspaceRow()]);
    db.seed('hosting_servers', [activeServer()]);
    db.seed('workspace_hosts', [
      { workspace_id: WS, hostname: 'acmedental.ie', is_primary: true },
    ]);
  });

  it('emails once when the deploy goes live, keyed on the version', async () => {
    const first = await deploySite(opts());
    expect(first.status).toBe('live');
    expect(first.version).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sentHtml()).toContain('https://acmedental.ie');

    const second = await deploySite(opts());
    expect(second.version).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('sends nothing when the deploy fails', async () => {
    const failing = {
      async push() {
        throw new Error('deploy-agent 500: out of disk');
      },
      async remove() {
        return { ok: true as const };
      },
    };
    const out = await deploySite(opts({ agentClient: failing }));
    expect(out.status).toBe('failed');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('still reports the deploy live when the mailer is down', async () => {
    sendEmail.mockRejectedValue(new Error('socket hang up'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const out = await deploySite(opts());
    expect(out.status).toBe('live');
    expect(out.detail).toBeNull();
    expect(db.rows('workspaces')[0]!.deploy_status).toBe('live');
  });
});
