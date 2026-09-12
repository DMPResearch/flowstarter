/**
 * POST /api/internal/build/deploy
 *
 * The build worker's callback: "I finished a build, here is the tarball, put
 * it on the client's host." Runs the ordinary `deploySite` path — same
 * deploy-agent, same `deployments` row, same DNS upsert — so a build deployed
 * this way is indistinguishable from one the operator deployed by hand.
 *
 * Auth: `Authorization: Bearer <FLOWSTARTER_BUILD_WORKER_SECRET>`, the same
 * secret this app signs its dispatch to the worker with. No user session: the
 * caller is a service.
 *
 * Body: { workspaceId, artifactUrl, artifactSha256 }
 * 200:  { deployment, siteUrl }
 *
 * `artifactSha256` is required — the deploy-agent will not extract an
 * artifact it cannot verify against it, and `LocalSitePublisher` /
 * `GitHubPullRequestPublisher` both already have the digest by the time
 * they call here (packaging the tarball computes it).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { DeployError } from '@/lib/hosting/deploy';
import {
  ArtifactUrlError,
  assertUsableArtifactUrl,
  authorizeBuildWorker,
  buildWorkerSecret,
  deployBuildArtifact,
} from '@/lib/hosting/build-worker-deploy';
import { notifyChangeRequestLive } from '@/lib/hosting/change-request-live-email';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEPLOY_ERROR_STATUS: Record<string, number> = {
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

export async function POST(req: NextRequest) {
  if (!buildWorkerSecret()) {
    return NextResponse.json(
      {
        error:
          'FLOWSTARTER_BUILD_WORKER_SECRET is not configured (must be at least 32 characters)',
      },
      { status: 503 }
    );
  }
  if (!authorizeBuildWorker(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    workspaceId?: unknown;
    artifactUrl?: unknown;
    artifactSha256?: unknown;
    // Set only by a CHANGE_REQUEST_BUILD. It is the difference between "your
    // site is live" and "the change you paid for is live", and the deploy is
    // the moment either sentence becomes true.
    changeRequestId?: unknown;
    siteVersion?: unknown;
  };

  if (typeof body.workspaceId !== 'string' || !UUID.test(body.workspaceId)) {
    return NextResponse.json(
      { error: 'workspaceId must be a canonical UUID' },
      { status: 400 }
    );
  }
  if (typeof body.artifactUrl !== 'string' || body.artifactUrl.length === 0) {
    return NextResponse.json(
      { error: 'artifactUrl is required' },
      { status: 400 }
    );
  }
  try {
    assertUsableArtifactUrl(body.artifactUrl);
  } catch (error) {
    if (error instanceof ArtifactUrlError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  if (
    typeof body.artifactSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(body.artifactSha256)
  ) {
    return NextResponse.json(
      {
        error:
          'artifactSha256 is required and must be a 64-character hex sha256',
      },
      { status: 400 }
    );
  }

  const changeRequestId =
    typeof body.changeRequestId === 'string' && UUID.test(body.changeRequestId)
      ? body.changeRequestId
      : null;

  try {
    const supabase = createSupabaseServiceRoleClient();
    const result = await deployBuildArtifact({
      supabase,
      workspaceId: body.workspaceId,
      artifactUrl: body.artifactUrl,
      artifactSha256: body.artifactSha256,
      deployedBy: 'build-worker',
    });
    // Only once the deploy genuinely reached `live`. `notifyChangeRequestLive`
    // never throws, so a mail problem cannot fail a deploy that has already
    // put the client's site on the internet.
    if (changeRequestId && result.deployment?.status === 'live') {
      await notifyChangeRequestLive({
        supabase,
        workspaceId: body.workspaceId,
        changeRequestId,
        version:
          typeof body.siteVersion === 'number' &&
          Number.isInteger(body.siteVersion)
            ? body.siteVersion
            : 0,
      });
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DeployError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: DEPLOY_ERROR_STATUS[error.code] ?? 500 }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Deploy failed' },
      { status: 500 }
    );
  }
}
