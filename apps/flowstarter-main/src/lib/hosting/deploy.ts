/**
 * Site deploy orchestrator.
 *
 * The unit of deployment is a workspace — each workspace gets its slug as
 * the on-disk site directory and (optionally) a primary custom domain stored
 * via workspace_hosts. Flow:
 *
 *   1. Caller provides a tarball (raw bytes) or an HTTPS artifact URL plus
 *      the workspace_id.
 *   2. We POST the artifact to the deploy-agent on the workspace's assigned
 *      hosting_servers.deploy_agent_url.
 *   3. The agent extracts to /var/www/sites/{slug}/, writes the Caddy site
 *      snippet, reloads Caddy, returns when ready.
 *   4. We upsert Cloudflare DNS for the slug's preview subdomain (and any
 *      configured custom domains) pointing to the server's IPv4.
 *   5. We record a `deployments` row + bump workspaces.last_deploy_id.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import { CloudflareClient } from './cloudflare';
import { getSubdomainUrl } from '@flowstarter/platform-config';

export class DeployError extends Error {
  constructor(public code: string, message: string, public cause?: unknown) {
    super(message);
    this.name = 'DeployError';
  }
}

export interface DeployAgentClient {
  /**
   * Push a deploy artifact to the agent.
   * The agent extracts and reloads Caddy synchronously.
   */
  push(opts: {
    deployAgentUrl: string;
    sharedSecret: string;
    siteSlug: string;
    /** Either an HTTPS URL the agent should fetch, or raw tarball bytes */
    artifact:
      | { kind: 'url'; url: string; sha256?: string }
      | { kind: 'bytes'; bytes: ArrayBuffer; sha256?: string };
    primaryDomain: string | null;
    additionalDomains: string[];
  }): Promise<{
    ok: true;
    sha256: string;
    sizeBytes: number;
  }>;

  /** Tear down a site directory + Caddy snippet. */
  remove(opts: {
    deployAgentUrl: string;
    sharedSecret: string;
    siteSlug: string;
  }): Promise<{ ok: true }>;
}

/**
 * Production deploy-agent client (talks to a real agent over HTTPS).
 */
export class HttpDeployAgentClient implements DeployAgentClient {
  constructor(
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch
  ) {}

  async push(opts: Parameters<DeployAgentClient['push']>[0]) {
    const url = `${opts.deployAgentUrl.replace(
      /\/$/,
      ''
    )}/sites/${encodeURIComponent(opts.siteSlug)}/deploy`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.sharedSecret}`,
    };

    let body: BodyInit;
    if (opts.artifact.kind === 'url') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        artifact_url: opts.artifact.url,
        artifact_sha256: opts.artifact.sha256 ?? null,
        primary_domain: opts.primaryDomain,
        additional_domains: opts.additionalDomains,
      });
    } else {
      headers['Content-Type'] = 'application/octet-stream';
      headers['X-Site-Primary-Domain'] = opts.primaryDomain ?? '';
      headers['X-Site-Additional-Domains'] =
        opts.additionalDomains.join(',') || '';
      if (opts.artifact.sha256) {
        headers['X-Artifact-Sha256'] = opts.artifact.sha256;
      }
      body = opts.artifact.bytes;
    }

    const res = await this.fetchImpl(url, { method: 'POST', headers, body });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // non-JSON
    }
    if (!res.ok) {
      throw new DeployError(
        'agent_error',
        `deploy-agent ${res.status}: ${text || res.statusText}`,
        parsed
      );
    }
    const data = (parsed ?? {}) as { sha256?: string; sizeBytes?: number };
    return {
      ok: true as const,
      sha256: data.sha256 ?? '',
      sizeBytes: data.sizeBytes ?? 0,
    };
  }

  async remove(opts: Parameters<DeployAgentClient['remove']>[0]) {
    const url = `${opts.deployAgentUrl.replace(
      /\/$/,
      ''
    )}/sites/${encodeURIComponent(opts.siteSlug)}`;
    const res = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${opts.sharedSecret}` },
    });
    if (!res.ok) {
      throw new DeployError('agent_error', `deploy-agent DELETE ${res.status}`);
    }
    return { ok: true as const };
  }
}

/**
 * Dry-run deploy-agent client. Used in tests and during bootstrap before
 * a real agent is reachable.
 */
export class DryRunDeployAgentClient implements DeployAgentClient {
  public readonly calls: Array<{ method: 'push' | 'remove'; args: unknown }> =
    [];
  async push(args: Parameters<DeployAgentClient['push']>[0]) {
    this.calls.push({ method: 'push', args });
    return { ok: true as const, sha256: 'dryrun', sizeBytes: 0 };
  }
  async remove(args: Parameters<DeployAgentClient['remove']>[0]) {
    this.calls.push({ method: 'remove', args });
    return { ok: true as const };
  }
}

/**
 * Top-level deploy flow. Loads the workspace + assigned hosting_server,
 * pushes the artifact to the agent, upserts DNS, records a `deployments`
 * row, bumps last_deploy_id on the workspace, returns the deploy.
 */
/**
 * The slug, sanitised, or a refusal.
 *
 * This used to live inside `allocateHostingServer`, which only runs when a
 * workspace has no `hosting_server_id` yet. A workspace that already had a
 * server assigned went straight to `agentClient.push({ siteSlug:
 * workspace.slug })` with nothing checked, so a null or non-slug-safe value
 * reached the deploy-agent as-is and `previewDomainForSlug` derived hostnames
 * like `null.preview.flowstarter.net`. The guard belongs on every path that
 * uses the slug, not on the one that happens to allocate.
 */
export function requireSiteSlug(raw: string | null | undefined): string {
  const slug = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 63);
  if (!slug) {
    throw new DeployError(
      'workspace_unallocated',
      'Workspace slug is invalid; cannot derive a site directory.'
    );
  }
  return slug;
}

/**
 * Gives an unallocated workspace a hosting server by the same rule the
 * operator route applies by hand: the least-loaded active server with room.
 * A paid build used to stop here with "allocate first", which made the
 * operator's click part of every guest deposit; the rule is deterministic,
 * so the deploy applies it and records the assignment the way the route
 * does. Exported for tests.
 */
export async function allocateHostingServer(
  supabase: SupabaseClient<Database>,
  workspace: { id: string; slug: string | null }
): Promise<string> {
  const { data: candidates, error } = await supabase
    .from('hosting_servers')
    .select('id, site_capacity, sites_count')
    .eq('status', 'active')
    .order('sites_count', { ascending: true })
    .limit(5);
  if (error) throw new DeployError('db_error', error.message, error);
  const pick = (candidates ?? []).find(
    (server) => server.sites_count < server.site_capacity
  );
  if (!pick) {
    throw new DeployError(
      'workspace_unallocated',
      'Workspace has no hosting server and no active server has capacity. Provision one via /api/admin/hosting/servers.'
    );
  }
  const slug = requireSiteSlug(workspace.slug);
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from('workspaces')
    .update({
      hosting_server_id: pick.id,
      site_directory: `/var/www/sites/${slug}/`,
      deploy_status: 'pending',
      updated_at: now,
    })
    .eq('id', workspace.id);
  if (updateError) {
    throw new DeployError('db_error', updateError.message, updateError);
  }
  // Best effort, like the operator route: the count is a display figure and
  // the next allocation re-derives it.
  try {
    const { count } = await supabase
      .from('workspaces')
      .select('id', { count: 'exact', head: true })
      .eq('hosting_server_id', pick.id);
    if (typeof count === 'number') {
      await supabase
        .from('hosting_servers')
        .update({ sites_count: count, updated_at: now })
        .eq('id', pick.id);
    }
  } catch {
    /* display figure only */
  }
  return pick.id;
}

export async function deploySite(opts: {
  supabase: SupabaseClient<Database>;
  agentClient: DeployAgentClient;
  cloudflare: CloudflareClient | null;
  cloudflareDefaultZoneId?: string | null;
  workspaceId: string;
  artifact:
    | { kind: 'url'; url: string; sha256?: string }
    | { kind: 'bytes'; bytes: ArrayBuffer; sha256?: string };
  deployedBy: string;
  /**
   * The deploy-agent shared secret is keyed by `hosting_servers.deploy_agent_secret_ref`
   * (typically pointing to a Supabase vault row). Caller resolves it.
   */
  resolveSharedSecret: (secretRef: string) => Promise<string | null>;
}): Promise<{
  deploymentId: string;
  version: number;
  status: 'live' | 'failed';
  detail: string | null;
}> {
  // Load the workspace row.
  const { data: workspace, error: wsErr } = await opts.supabase
    .from('workspaces')
    .select(
      `id, slug, hosting_server_id, site_directory, deploy_status,
       cloudflare_zone_id`
    )
    .eq('id', opts.workspaceId)
    .maybeSingle();

  if (wsErr) {
    throw new DeployError('db_error', wsErr.message, wsErr);
  }
  if (!workspace) {
    throw new DeployError(
      'workspace_not_found',
      `Workspace ${opts.workspaceId} not found`
    );
  }
  // Before anything is pushed or any DNS is written, and whether or not this
  // workspace needs allocating. Everything downstream uses this value rather
  // than `workspace.slug`.
  const siteSlug = requireSiteSlug(workspace.slug);

  const hostingServerId =
    workspace.hosting_server_id ??
    (await allocateHostingServer(opts.supabase, workspace));

  // Custom domains for this workspace, in workspace_hosts.
  const { data: hosts } = await opts.supabase
    .from('workspace_hosts')
    .select('hostname, is_primary')
    .eq('workspace_id', opts.workspaceId);
  const primaryDomain =
    (hosts ?? []).find((h) => h.is_primary)?.hostname ?? null;
  const additionalDomains = (hosts ?? [])
    .filter((h) => !h.is_primary)
    .map((h) => h.hostname);

  // Load the server row.
  const { data: server, error: serverErr } = await opts.supabase
    .from('hosting_servers')
    .select('*')
    .eq('id', hostingServerId)
    .maybeSingle();
  if (serverErr) {
    throw new DeployError('db_error', serverErr.message, serverErr);
  }
  if (!server) {
    throw new DeployError(
      'server_not_found',
      `Server ${hostingServerId} not found for this workspace`
    );
  }
  if (server.status !== 'active') {
    throw new DeployError(
      'server_not_active',
      `Server status is ${server.status}; cannot deploy`
    );
  }
  if (!server.deploy_agent_url) {
    throw new DeployError(
      'agent_not_configured',
      `Server ${server.name} has no deploy_agent_url set; finish bootstrap first`
    );
  }
  if (!server.deploy_agent_secret_ref) {
    throw new DeployError(
      'secret_not_configured',
      `Server ${server.name} has no deploy_agent_secret_ref set`
    );
  }

  const sharedSecret = await opts.resolveSharedSecret(
    server.deploy_agent_secret_ref
  );
  if (!sharedSecret) {
    throw new DeployError(
      'secret_unavailable',
      `Could not resolve shared secret for ${server.deploy_agent_secret_ref}`
    );
  }

  // Compute next version (monotonic per workspace).
  const { data: lastDeploy } = await opts.supabase
    .from('deployments')
    .select('version')
    .eq('workspace_id', workspace.id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (lastDeploy?.version ?? 0) + 1;

  // Insert pending deployment.
  const { data: deploy, error: deployInsertErr } = await opts.supabase
    .from('deployments')
    .insert({
      workspace_id: workspace.id,
      version: nextVersion,
      status: 'building',
      deployed_by: opts.deployedBy,
      artifact_url: opts.artifact.kind === 'url' ? opts.artifact.url : null,
      artifact_sha256: opts.artifact.sha256 ?? null,
    })
    .select()
    .single();
  if (deployInsertErr || !deploy) {
    throw new DeployError(
      'db_error',
      deployInsertErr?.message ?? 'Failed to insert deployment row'
    );
  }

  // Mark workspace as deploying.
  await opts.supabase
    .from('workspaces')
    .update({ deploy_status: 'deploying' })
    .eq('id', workspace.id);

  let agentResult: { sha256: string; sizeBytes: number };
  try {
    agentResult = await opts.agentClient.push({
      deployAgentUrl: server.deploy_agent_url,
      sharedSecret,
      siteSlug,
      artifact: opts.artifact,
      primaryDomain,
      additionalDomains,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Deploy-agent failed';
    await opts.supabase
      .from('deployments')
      .update({
        status: 'failed',
        status_detail: message,
        finished_at: new Date().toISOString(),
      })
      .eq('id', deploy.id);
    await opts.supabase
      .from('workspaces')
      .update({ deploy_status: 'failed' })
      .eq('id', workspace.id);
    return {
      deploymentId: deploy.id,
      version: nextVersion,
      status: 'failed',
      detail: message,
    };
  }

  // DNS: upsert preview subdomain → server IPv4 (Cloudflare optional).
  const previewDomain = previewDomainForSlug(siteSlug);
  if (
    opts.cloudflare &&
    opts.cloudflareDefaultZoneId &&
    previewDomain &&
    server.ipv4
  ) {
    try {
      await opts.cloudflare.upsertRecord({
        zoneId: opts.cloudflareDefaultZoneId,
        type: 'A',
        name: previewDomain,
        content: String(server.ipv4),
        ttl: 60,
        proxied: false,
        comment: `flowstarter site ${siteSlug}`,
      });
    } catch (e) {
      // DNS errors don't fail the deploy; the artifact is on the server,
      // they just need a manual DNS fixup.
      console.warn(
        '[deploySite] DNS upsert failed (deploy succeeded):',
        e instanceof Error ? e.message : e
      );
    }
  }

  // Mark deployment + workspace as live.
  const finishedAt = new Date().toISOString();
  await opts.supabase
    .from('deployments')
    .update({
      status: 'live',
      finished_at: finishedAt,
      artifact_sha256: agentResult.sha256 || null,
      artifact_bytes: agentResult.sizeBytes || null,
    })
    .eq('id', deploy.id);

  await opts.supabase
    .from('workspaces')
    .update({
      deploy_status: 'live',
      last_deploy_id: deploy.id,
      last_deployed_at: finishedAt,
    })
    .eq('id', workspace.id);

  return {
    deploymentId: deploy.id,
    version: nextVersion,
    status: 'live',
    detail: null,
  };
}

/**
 * Helper to derive what the preview domain SHOULD be for a slug.
 */
export function previewDomainForSlug(slug: string): string {
  const url = getSubdomainUrl(`${slug}.preview`);
  return url.replace(/^https?:\/\//, '');
}
