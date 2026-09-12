import 'server-only';
/**
 * POST /api/client/site/[workspaceId]/publish: mark the current version as
 * the one that should go live, and start the build that puts it there.
 *
 * WHY THIS ENQUEUES INSTEAD OF DEPLOYING. `deploySite` takes a built artifact,
 * a tarball or an HTTPS URL, and hands it to the per-host deploy agent, which
 * extracts it under /var/www/sites and reloads Caddy. What an editor produces
 * is an edited *source* manifest: Astro components and content files. Pushing
 * those to the agent would publish source, not a site, and pushing the last
 * build's `preview_artifact_url` instead would publish the client's site
 * without the change they just made and report success. So the missing piece
 * was never a deploy call here, it was a build of the edited manifest.
 *
 * That build is a SITE_REBUILD job. The version is stamped `published_at`, and
 * a job is queued and the worker is nudged; the worker materializes the same
 * manifest column a full build reads, validates it, commits, and deploys the
 * build output. A rebuild already `running` has frozen the manifest it will
 * build, so it cannot pick up this publish's edit: `enqueueSiteRebuild` joins
 * a `queued` job if one is waiting, otherwise starts a new one behind a
 * partial unique index that allows at most one `queued` SITE_REBUILD per
 * workspace, so at most one job ever waits behind whatever is running. The
 * response names what actually happened, including the two cases where no
 * build is started: a project with no server allocated yet, and an environment
 * with no deploy agent configured, where a build would have nowhere to go.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  ASSET_NOT_BINARY,
  describeAssetProblems,
  describePlaceholderImageIssue,
  findNonBinaryAssets,
  findPlaceholderImageReferencesInFiles,
  PLACEHOLDER_IMAGE_SHIPPED,
  sanitiseSeedPlaceholders,
} from '@flowstarter/agentic-codegen';
import {
  markVersionPublished,
  recordSiteEditorEvent,
  saveSiteVersion,
} from '@/lib/flowstarter/site-editor';
import { dispatchAgentJob } from '@/lib/flowstarter/pipeline/dispatch';
import { findBuiltIndex } from '@/lib/flowstarter/site-preview';
import { enqueueSiteRebuild } from '@/lib/flowstarter/site-rebuild';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  openSiteEditorContext,
  refuseUnlessAllowed,
  siteEditorFailure,
} from '../../site-editor-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HostingRow {
  deploy_agent_url: string | null;
}

/**
 * The three honest answers to "did my change go live?": no server yet, no
 * deploy agent in this environment, or a build is running that will put it
 * there.
 */
type PublishMode = 'no_host' | 'dry_run' | 'rebuild_queued';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;
  const opened = await openSiteEditorContext(workspaceId);
  if (!opened.ok) return opened.response;
  const { context } = opened;

  const refusal = refuseUnlessAllowed(
    context,
    'content',
    'inline_content_agent',
  );
  if (refusal) return refusal;

  // The manifest this publish would build from is the last place the bytes
  // are still ours to refuse. An image whose `encoding: 'base64'` flag was
  // dropped somewhere upstream is, in this manifest, a string of printable
  // base64 behind a `.png` name, and every step after this one is happy to
  // carry it all the way to a client's live site. The worker runs the same
  // check on its build output; this one runs before a job is even queued, so
  // a broken manifest fails loudly instead of costing a build.
  const assetProblems = findNonBinaryAssets(context.site.files);
  if (assetProblems.length > 0) {
    console.error(
      `[site-publish] ${workspaceId}: ${describeAssetProblems(assetProblems)}`,
    );
    return NextResponse.json(
      {
        error:
          'This site cannot be published: some of its images are not image ' +
          'files. The build team has been given the details.',
        code: ASSET_NOT_BINARY,
        paths: assetProblems.map((problem) => problem.path).slice(0, 20),
      },
      { status: 422 },
    );
  }

  // Same rule, over images: a brief with no portrait or no project
  // screenshot must publish a site that says so honestly, not one wearing
  // the template's own stand-in art (a design-review guide graphic, a stock
  // screenshot of someone else's product) as if it were the client's own.
  // The worker's build validator runs the same check on the compiled output
  // by content hash; this one runs before a job is even queued.
  //
  // Asked of the manifest *after* the seed rule has run over it, because that
  // rule is what the rebuild will materialise. A site published before #110
  // carries the template's whole `public/images/` library in its manifest and
  // may well point at one of those pictures from a case-study cover; refusing
  // the publish outright would leave a client unable to fix their own typo on
  // a site we delivered. The rule blanks the reference and drops the file, the
  // rebuild does the same again on its way to `dist/`, and what is left here
  // is a placeholder no rule can account for — which is worth a 422.
  const placeholderImages = findPlaceholderImageReferencesInFiles(
    sanitiseSeedPlaceholders(context.site.files).files,
  );
  if (placeholderImages.length > 0) {
    console.error(
      `[site-publish] ${workspaceId}: ${describePlaceholderImageIssue(placeholderImages)}`,
    );
    return NextResponse.json(
      {
        error:
          'This site cannot be published: it still shows a template ' +
          'placeholder image instead of the client’s own content. The ' +
          'build team has been given the details.',
        code: PLACEHOLDER_IMAGE_SHIPPED,
        paths: placeholderImages.map((finding) => finding.path).slice(0, 20),
      },
      { status: 422 },
    );
  }

  try {
    // A site that has never been edited has no snapshot yet; publishing it
    // means recording the delivered manifest as version 1 so there is a
    // version to name.
    let version = context.site.version;
    if (version === 0) {
      version = await saveSiteVersion({
        workspaceId: context.workspaceId,
        files: context.site.files,
        summary: 'The site as it was delivered',
        createdBy: context.access.actorId,
      });
    }
    await markVersionPublished(context.workspaceId, version);

    const supabase = createSupabaseServiceRoleClient();
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('hosting_server_id, slug, deploy_status')
      .eq('id', context.workspaceId)
      .maybeSingle();

    let deployAgentUrl: string | null = null;
    if (workspace?.hosting_server_id) {
      const { data: host } = await supabase
        .from('hosting_servers')
        .select('deploy_agent_url')
        .eq('id', workspace.hosting_server_id)
        .maybeSingle<HostingRow>();
      deployAgentUrl = host?.deploy_agent_url ?? null;
    }

    const hasHost = Boolean(workspace?.hosting_server_id);
    const agentConfigured = Boolean(
      deployAgentUrl && process.env.DEPLOY_AGENT_SHARED_SECRET?.trim(),
    );
    const hasBuild = Boolean(findBuiltIndex(context.site.files));

    // A rebuild is only worth starting where its output has somewhere to land:
    // a server has to be allocated, and a site that is already built is served
    // by a deploy agent that has to be configured to receive the new build.
    // The other two answers say which of those is missing.
    const canRebuild = hasHost && (!hasBuild || agentConfigured);

    let rebuildJobId: string | null = null;
    let dispatched = false;
    if (canRebuild) {
      const rebuild = await enqueueSiteRebuild({
        supabase,
        workspaceId: context.workspaceId,
        version,
        publishedBy: context.access.actorId,
      });
      rebuildJobId = rebuild.jobId;
      // The ledger row is the commitment; this is only a nudge. An unreachable
      // worker leaves a queued job an operator can re-dispatch, which is a far
      // better outcome than failing a publish that is already recorded.
      try {
        await dispatchAgentJob(rebuild.jobId);
        dispatched = true;
      } catch (error) {
        console.warn(
          '[site-publish] could not nudge the build worker:',
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Named so the UI does not have to guess which sentence to print.
    const mode: PublishMode = canRebuild
      ? 'rebuild_queued'
      : !hasHost
        ? 'no_host'
        : 'dry_run';

    const detail: Record<PublishMode, string> = {
      no_host:
        'This project does not have a server allocated yet, so your change is saved and marked to publish. We will put it live when the site is hosted.',
      dry_run:
        'Your change is saved and marked to publish. This environment has no deploy agent configured, so nothing was pushed to a server (dry run).',
      rebuild_queued:
        'Your change is saved and the site is being rebuilt from it now. It goes live as soon as that build passes, and nothing else is needed from you.',
    };

    await recordSiteEditorEvent({
      workspaceId: context.workspaceId,
      kind: 'site_publish_requested',
      actor: context.access.actorId,
      payload: {
        version,
        mode,
        hasHost,
        agentConfigured,
        hasBuild,
        rebuildJobId,
        dispatched,
      },
    });

    return NextResponse.json({
      version,
      rebuildJobId,
      deploy: {
        mode,
        detail: detail[mode],
        hasHost,
        agentConfigured,
        hasBuild,
      },
    });
  } catch (error) {
    return siteEditorFailure(error);
  }
}
