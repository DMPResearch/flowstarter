import { NextRequest, NextResponse } from 'next/server';
import { requireTeamAuth } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { finalHostname, isValidSiteLabel } from '@/lib/hosting/site-hostnames';

function sanitizeSlug(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const lower = input.trim().toLowerCase();
  return isValidSiteLabel(lower) ? lower : null;
}

/**
 * The site's own name, `{slug}.{platformDomain}` — not a preview name.
 *
 * This endpoint used to answer `previewDomain`, and the operator's hosting tab
 * labelled it "Preview domain", for a workspace that had been paid for and
 * deployed. One rule now, in `site-hostnames.ts`, for the deploy, the DNS
 * record, the Caddy snippet and this.
 */
function siteDomainFor(slug: string | null): string | null {
  const clean = sanitizeSlug(slug);
  return clean ? finalHostname(clean) : null;
}

/**
 * GET /api/team/projects/[id]/site
 *
 * Returns the workspace's hosting state — the assigned hosting_server (if
 * any), and the most recent 10 deployments.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const { id: workspaceId } = await params;
  const supabase = createSupabaseServiceRoleClient();

  const { data: workspace, error: wsErr } = await supabase
    .from('workspaces')
    .select(
      `id, slug, name, hosting_server_id, site_directory, deploy_status,
       last_deployed_at, ssl_status, ssl_issued_at,
       cloudflare_zone_id, cloudflare_record_ids`
    )
    .eq('id', workspaceId)
    .maybeSingle();

  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const { data: server } = workspace.hosting_server_id
    ? await supabase
        .from('hosting_servers')
        .select(
          `id, name, provider, location, server_type, status, ipv4, ipv6,
           site_capacity, sites_count`
        )
        .eq('id', workspace.hosting_server_id)
        .maybeSingle()
    : { data: null };

  const { data: deployments } = await supabase
    .from('deployments')
    .select(
      `id, version, status, status_detail, artifact_url, artifact_sha256,
       started_at, finished_at, deployed_by, rolled_back_from_id`
    )
    .eq('workspace_id', workspaceId)
    .order('version', { ascending: false })
    .limit(10);

  const siteDomain = siteDomainFor(workspace.slug);

  return NextResponse.json({
    workspace,
    server,
    siteDomain,
    deployments: deployments ?? [],
  });
}

/**
 * POST /api/team/projects/[id]/site
 *
 * Allocate the workspace to a hosting_server. Body:
 *   { server_id?: string }
 *
 * Defaults:
 *   - server_id ← least-loaded active server (sites_count < site_capacity)
 *
 * Idempotent: if the workspace is already allocated and the caller passes no
 * fields, returns the existing assignment.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const { id: workspaceId } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    server_id?: unknown;
  };

  const supabase = createSupabaseServiceRoleClient();

  const { data: workspace, error: wsErr } = await supabase
    .from('workspaces')
    .select('id, slug, hosting_server_id, site_directory, deploy_status')
    .eq('id', workspaceId)
    .maybeSingle();
  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const slug = sanitizeSlug(workspace.slug);
  if (!slug) {
    return NextResponse.json(
      {
        error: 'Workspace slug is invalid; cannot derive site directory.',
      },
      { status: 400 }
    );
  }

  // Resolve server: explicit → least-loaded active → 409.
  let serverId: string | null = null;
  if (typeof body.server_id === 'string' && body.server_id.length > 0) {
    const { data: server } = await supabase
      .from('hosting_servers')
      .select('id, status, site_capacity, sites_count')
      .eq('id', body.server_id)
      .maybeSingle();
    if (!server) {
      return NextResponse.json(
        { error: 'server_id not found' },
        { status: 404 }
      );
    }
    if (server.status !== 'active') {
      return NextResponse.json(
        {
          error: `Server status is ${server.status}; can only allocate to active servers.`,
        },
        { status: 409 }
      );
    }
    if (server.sites_count >= server.site_capacity) {
      return NextResponse.json(
        { error: 'Server is at capacity' },
        { status: 409 }
      );
    }
    serverId = server.id;
  } else {
    const { data: candidates } = await supabase
      .from('hosting_servers')
      .select('id, site_capacity, sites_count')
      .eq('status', 'active')
      .order('sites_count', { ascending: true })
      .limit(5);
    const pick = (candidates ?? []).find(
      (s) => s.sites_count < s.site_capacity
    );
    if (!pick) {
      return NextResponse.json(
        {
          error:
            'No active hosting servers with capacity. Provision one via /api/team/hosting/servers.',
        },
        { status: 409 }
      );
    }
    serverId = pick.id;
  }

  if (workspace.hosting_server_id) {
    if (workspace.hosting_server_id === serverId) {
      return NextResponse.json({ workspace, reused: true });
    }
    // Re-allocating involves volume migration + Caddy reconfig; refuse.
    return NextResponse.json(
      {
        error:
          'Workspace is already allocated. Decommission the existing site before re-allocating.',
        workspace,
      },
      { status: 409 }
    );
  }

  const siteDirectory = `/var/www/sites/${slug}/`;
  const { data: updated, error: updateErr } = await supabase
    .from('workspaces')
    .update({
      hosting_server_id: serverId,
      site_directory: siteDirectory,
      deploy_status: 'pending',
      updated_at: new Date().toISOString(),
    })
    .eq('id', workspaceId)
    .select()
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? 'Failed to allocate workspace' },
      { status: 500 }
    );
  }

  await syncServerSitesCount(supabase, serverId!);

  return NextResponse.json(
    { workspace: updated, reused: false },
    { status: 201 }
  );
}

async function syncServerSitesCount(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  serverId: string
) {
  const { count, error } = await supabase
    .from('workspaces')
    .select('id', { count: 'exact', head: true })
    .eq('hosting_server_id', serverId);
  if (error || count === null) return;
  await supabase
    .from('hosting_servers')
    .update({
      sites_count: count,
      updated_at: new Date().toISOString(),
    })
    .eq('id', serverId);
}
