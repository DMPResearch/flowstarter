import { NextRequest, NextResponse } from 'next/server';
import { requireTeamAuth } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  HttpDeployAgentClient,
  DryRunDeployAgentClient,
  deploySite,
  DeployError,
} from '@/lib/hosting/deploy';
import { CloudflareClient } from '@/lib/hosting/cloudflare';

/**
 * POST /api/team/projects/[id]/site/deploy
 *
 * Deploy a build artifact for the project's allocated site.
 *
 * Body shapes:
 *   - JSON: { artifact_url: string, artifact_sha256: string }
 *     Agent fetches the URL and extracts. Best for large artifacts.
 *     `artifact_sha256` is required — the agent will not extract an
 *     artifact it cannot verify against it.
 *
 * Auth: team-only via requireTeamAuth.
 *
 * Behavior:
 *   - 404 if site is not allocated yet
 *   - 409 if server is not active
 *   - When DEPLOY_AGENT_DRY_RUN=true is set in env, uses a dry-run agent
 *     client that records calls without making network requests; useful
 *     before the real apps/deploy-agent/ is shipped.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const { id: workspaceId } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    artifact_url?: unknown;
    artifact_sha256?: unknown;
  };

  if (typeof body.artifact_url !== 'string' || body.artifact_url.length === 0) {
    return NextResponse.json(
      {
        error:
          'artifact_url is required (https URL the deploy-agent pulls from)',
      },
      { status: 400 }
    );
  }
  try {
    const u = new URL(body.artifact_url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return NextResponse.json(
        { error: 'artifact_url must be http(s)' },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'artifact_url is not a valid URL' },
      { status: 400 }
    );
  }
  // Required, not optional: the deploy-agent will not extract an artifact it
  // cannot verify against a caller-supplied digest, and asking the operator
  // for it here — rather than letting a bad or swapped URL reach a host
  // unverified — is the whole point of that check.
  if (
    typeof body.artifact_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(body.artifact_sha256)
  ) {
    return NextResponse.json(
      {
        error:
          'artifact_sha256 is required and must be a 64-character hex sha256',
      },
      { status: 400 }
    );
  }

  const supabase = createSupabaseServiceRoleClient();
  const dryRun = process.env.DEPLOY_AGENT_DRY_RUN === 'true';
  const agentClient = dryRun
    ? new DryRunDeployAgentClient()
    : new HttpDeployAgentClient();

  const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
  const cloudflare = cloudflareToken
    ? new CloudflareClient({ token: cloudflareToken })
    : null;

  try {
    const result = await deploySite({
      supabase,
      agentClient,
      cloudflare,
      cloudflareDefaultZoneId: process.env.CLOUDFLARE_DEFAULT_ZONE_ID ?? null,
      workspaceId,
      artifact: {
        kind: 'url',
        url: body.artifact_url,
        sha256: body.artifact_sha256,
      },
      deployedBy: auth.userId,
      resolveSharedSecret: async (ref) => {
        // v1 shortcut: secrets reach Netlify via env. Slice 2.7+ moves these
        // into Supabase Vault. ref looks like "deploy_agent_shared_secret_<server-name>".
        // Allow a global fallback for the dev/single-server case.
        return (
          process.env[ref.toUpperCase()] ??
          process.env.DEPLOY_AGENT_SHARED_SECRET ??
          null
        );
      },
    });

    return NextResponse.json({
      deployment: result,
      dryRun,
    });
  } catch (e) {
    if (e instanceof DeployError) {
      const statusByCode: Record<string, number> = {
        workspace_not_found: 404,
        workspace_unallocated: 409,
        server_not_found: 404,
        server_not_active: 409,
        agent_not_configured: 409,
        secret_not_configured: 409,
        secret_unavailable: 500,
        agent_error: 502,
        db_error: 500,
      };
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: statusByCode[e.code] ?? 500 }
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Deploy failed' },
      { status: 500 }
    );
  }
}
