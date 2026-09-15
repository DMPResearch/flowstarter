import 'server-only';

/**
 * The funnel's "Publishing your live preview" step.
 *
 * Three publishers, one rule picking between them
 * (`preview-publisher-rule.ts`), and one shape they all satisfy — the
 * `PreviewPublisher` the generation pipeline calls with a finished workspace.
 *
 *  - `platform` (the default). Build the generated Astro site statically, the
 *    same fixed `astro build` the build worker runs for a site somebody paid
 *    for, and push the compiled `dist/` to the previews deploy-agent on the
 *    platform host through the same hosting client the post-claim deploy
 *    uses. The visitor's iframe gets `https://{slug}.preview.flowstarter.dev`
 *    (`.net` in production), carrying the teaser blur the pipeline injected
 *    and the 14-day expiry the reaper acts on.
 *  - `local-static` (a developer machine with no previews host). The same
 *    build, served from this process by `local-static-preview.ts`.
 *  - `daytona` (only when an operator asks for it by name). The old sandbox
 *    path, unchanged, kept because a live sandbox is still the nicest thing
 *    to have when you are debugging a generation.
 *
 * What no longer exists anywhere is `astro dev`. The workspace copy each
 * publisher keeps is a build input and an edit target, never a running
 * server, so there is nothing that can outlive the job that started it.
 */

import type {
  PreviewPublisher,
  TemplateScaffoldFile,
} from '@flowstarter/agentic-codegen';
import { readPreviewWorkspaceFiles } from '@/lib/discovery/preview-workspace';
import {
  resolvePreviewPublisher,
  type PreviewPublisherDecision,
} from '@/lib/discovery/preview-publisher-rule';
import {
  buildStaticPreview,
  type StaticPreviewBuild,
} from '@/lib/discovery/static-preview-build';
import {
  serveStaticPreview,
  type LocalStaticPreview,
} from '@/lib/discovery/local-static-preview';
import { publishFunnelPreview } from '@/lib/hosting/preview-publisher';
import type { ArchiveFile } from '@/lib/hosting/site-archive';
import { applyIntegrationsToWorkspace } from '@flowstarter/agentic-codegen';
import { previewLeadCaptureEndpoint } from '@/lib/flowstarter/lead-capture-scaffold';

/** The phase label the wizard shows while this step runs. */
export const PUBLISH_PHASE = 'Publishing your live preview';
/** The one before it: the build the publish step needs. */
export const BUILD_PHASE = 'Building your site';

export interface FunnelPreviewPublisherHooks {
  /** Streamed to the wizard as the step's label. */
  onPhase: (phase: string) => void;
  /**
   * The workspace copy the build ran in. The free-edit loop targets it, and
   * the job's teardown removes it.
   */
  onWorkspace: (root: string) => void;
  /** The durable hosted copy, once (if) the previews agent reports it live. */
  onHosted: (hosted: {
    status: string;
    url?: string;
    expiresAt?: string;
    detail?: string | null;
  }) => void;
}

export interface FunnelPreviewPublisher {
  publisher: PreviewPublisher;
  decision: PreviewPublisherDecision;
  /**
   * Rebuild the workspace copy and put the result back where the visitor is
   * looking. Called by the free-edit route after an edit lands on disk.
   *
   * Undefined for the Daytona publisher, whose sandbox serves the workspace
   * directly and needs no rebuild.
   */
  republish?: () => Promise<void>;
}

function asArchiveFiles(files: readonly TemplateScaffoldFile[]): ArchiveFile[] {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
    ...(file.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
  }));
}

/**
 * Deploys a built preview to the previews host and returns its URL.
 *
 * A publish that does not end `live` throws. The funnel's contract is that a
 * failed publish steps the visitor down to the deterministic demo; reporting
 * a URL that answers 404 would be worse than saying the build did not finish.
 */
async function deployToPlatform(input: {
  previewId: string;
  sourceFiles: readonly TemplateScaffoldFile[];
  builtFiles: readonly ArchiveFile[];
  templateSlug: string | null;
  brandConfig: unknown;
  hooks: FunnelPreviewPublisherHooks;
}): Promise<{ url: string; hostname: string }> {
  const published = await publishFunnelPreview({
    previewId: input.previewId,
    files: asArchiveFiles(input.sourceFiles),
    builtFiles: input.builtFiles,
    templateSlug: input.templateSlug,
    brandConfig: input.brandConfig,
  });
  input.hooks.onHosted({
    status: published.status,
    ...(published.status === 'live'
      ? { url: published.url, expiresAt: published.expiresAt }
      : {}),
    detail: published.detail,
  });
  if (published.status !== 'live') {
    throw new Error(
      `the previews host did not serve this preview: ${
        published.detail ?? 'unknown reason'
      }`
    );
  }
  return { url: published.url, hostname: published.hostname };
}

/**
 * The publisher this process uses, wired to the job it is publishing for.
 *
 * `env` and `decide` are seams: the tests assert which publisher is built for
 * a given environment without standing anything up.
 */
export function createFunnelPreviewPublisher(input: {
  previewId: string;
  hooks: FunnelPreviewPublisherHooks;
  env?: Record<string, string | undefined>;
  decision?: PreviewPublisherDecision;
}): FunnelPreviewPublisher {
  const decision =
    input.decision ?? resolvePreviewPublisher(input.env ?? process.env);

  if (decision.publisher === 'daytona') {
    return {
      publisher: daytonaPublisher(input.previewId, input.hooks),
      decision,
    };
  }

  // Both remaining publishers build the same way and differ only in where the
  // compiled output goes, so the build and its bookkeeping live here once.
  let build: StaticPreviewBuild | undefined;
  let local: LocalStaticPreview | undefined;
  let template: { slug: string | null; brandConfig: unknown } = {
    slug: null,
    brandConfig: {},
  };

  /**
   * The contact form's endpoint, written into the workspace copy before it is
   * compiled.
   *
   * The same injector the paid build runs (`applyIntegrationsToWorkspace`),
   * pointed at this preview's own token — so a preview and the site it becomes
   * cannot end up with two different contact forms, and so the paid build's
   * unconditional re-run replaces this block in place rather than finding
   * something it does not recognise.
   *
   * It has to happen HERE, on disk, in front of `astro build`. The route
   * already ran `injectLeadCapturePreviewIntoScaffoldFiles` over the manifest
   * it stashes for the claim, and that is still right — but it runs after this
   * publisher has compiled and deployed, so it never touched the site anybody
   * looks at. The preview recorded on 2026-09-15 served `data-contact-form`,
   * `data-contact-sent`, `data-contact-error` and the honeypot with zero
   * occurrences of the capture endpoint in the HTML or in any `_astro/*.js`
   * bundle: a form a visitor could fill in and submit into nothing.
   *
   * What the endpoint then does is deliberate and not a stopgap. A funnel
   * preview belongs to no workspace, so there is no tenant a lead could be
   * filed under; `/api/leads/capture/preview.{id}` recognises the shape a real
   * token provably cannot have and answers 403 with a sentence the injected
   * script shows the visitor — "This is a preview, so the form cannot send
   * anything yet. It starts working on the live site." A form that says that
   * is not a dead form, and it is the same ingress the endpoint applies to
   * every other request from a client site.
   */
  const prepare = async (workspaceRoot: string): Promise<void> => {
    await applyIntegrationsToWorkspace(workspaceRoot, {
      leadCapture: { endpoint: previewLeadCaptureEndpoint(input.previewId) },
    });
  };

  const compile = async (
    workspaceRoot: string,
    templateSlug: string,
    reuse: boolean
  ): Promise<StaticPreviewBuild> => {
    input.hooks.onPhase(BUILD_PHASE);
    const next = await buildStaticPreview({
      projectId: input.previewId,
      templateSlug,
      workspaceRoot,
      prepare,
      ...(reuse && build ? { existingWorkspaceRoot: build.workspaceRoot } : {}),
    });
    build = next;
    input.hooks.onWorkspace(next.workspaceRoot);
    return next;
  };

  const teardown = async () => {
    await local?.close().catch(() => {});
    local = undefined;
    await build?.cleanup().catch(() => {});
    build = undefined;
  };

  const publisher: PreviewPublisher = {
    publish: async (publishInput) => {
      // Read the SOURCE before building: it is what makes the preview
      // claimable, and `dist/` is not something a paid build can personalize.
      const files = await readPreviewWorkspaceFiles(publishInput.workspaceRoot);
      template = {
        slug: publishInput.template?.slug ?? null,
        brandConfig: publishInput.brandConfig,
      };
      // A second publish (the rendered-audit repair pass) gets a fresh copy of
      // the pipeline's workspace, not the stale one from the first attempt.
      await teardown();
      const compiled = await compile(
        publishInput.workspaceRoot,
        publishInput.template?.slug ?? '',
        false
      );

      input.hooks.onPhase(PUBLISH_PHASE);
      if (decision.publisher === 'platform') {
        const deployed = await deployToPlatform({
          previewId: input.previewId,
          sourceFiles: files,
          builtFiles: compiled.files,
          templateSlug: template.slug,
          brandConfig: template.brandConfig,
          hooks: input.hooks,
        });
        return {
          previewUrl: deployed.url,
          artifactUrl: `platform://${deployed.hostname}`,
          files,
          // Removes the workspace copy only. The hosted site is temporary by
          // its own expiry, not by this job's 45-minute reaper: a visitor who
          // closes the tab still has the link they were given.
          teardown,
        };
      }

      local = await serveStaticPreview(compiled.files);
      return {
        previewUrl: local.url,
        artifactUrl: `local://${compiled.workspaceRoot}`,
        files,
        teardown,
      };
    },
  };

  return {
    publisher,
    decision,
    republish: async () => {
      if (!build) return;
      // The same slug `publish` recorded, not a placeholder: a rebuild still
      // resolves the CLI at the template's own real path (see
      // static-preview-build.ts's `runAstroBuild`), which needs the slug to
      // find it even though the workspace copy itself is being reused.
      const rebuilt = await compile(
        build.workspaceRoot,
        template.slug ?? '',
        true
      );
      if (decision.publisher === 'platform') {
        await deployToPlatform({
          previewId: input.previewId,
          sourceFiles: await readPreviewWorkspaceFiles(rebuilt.workspaceRoot),
          builtFiles: rebuilt.files,
          templateSlug: template.slug,
          brandConfig: template.brandConfig,
          hooks: input.hooks,
        });
        return;
      }
      local?.update(rebuilt.files);
    },
  };
}

/**
 * The Daytona sandbox path, unchanged and no longer a default.
 *
 * It keeps its own compile step (`buildSandboxStaticFiles`, inside the
 * sandbox, so the app host never runs tenant code on this path) and its own
 * fire-and-forget push to the previews host, because with a live sandbox the
 * iframe already has a URL and the hosted copy is a bonus rather than the
 * product.
 */
function daytonaPublisher(
  previewId: string,
  hooks: FunnelPreviewPublisherHooks
): PreviewPublisher {
  return {
    publish: async (publishInput) => {
      const { previewInSandbox } = await import('@flowstarter/daytona-utils');
      const files = await readPreviewWorkspaceFiles(publishInput.workspaceRoot);
      const preview = await previewInSandbox(publishInput.workspaceRoot, {
        projectId: publishInput.projectId,
        env: { DAYTONA_API_KEY: process.env.DAYTONA_API_KEY },
        onProgress: () => hooks.onPhase(PUBLISH_PHASE),
      });
      if (!preview.success || !preview.previewUrl || !preview.sandboxId) {
        await preview.teardown().catch(() => {});
        throw new Error(preview.error ?? 'Preview sandbox unavailable');
      }
      const { buildSandboxStaticFiles } = await import(
        '@/lib/hosting/sandbox-static-build'
      );
      const builtFiles = await buildSandboxStaticFiles(
        preview.sandboxId,
        asArchiveFiles(files)
      ).catch(() => undefined);
      void publishFunnelPreview({
        previewId,
        files: asArchiveFiles(files),
        ...(builtFiles ? { builtFiles } : {}),
        templateSlug: publishInput.template?.slug ?? null,
        brandConfig: publishInput.brandConfig,
      })
        .then((published) =>
          hooks.onHosted({
            status: published.status,
            ...(published.status === 'live'
              ? { url: published.url, expiresAt: published.expiresAt }
              : {}),
            detail: published.detail,
          })
        )
        .catch(() => hooks.onHosted({ status: 'failed' }));
      return {
        previewUrl: preview.previewUrl,
        artifactUrl: `daytona://${preview.sandboxId}`,
        files,
        sandboxId: preview.sandboxId,
        teardown: preview.teardown,
      };
    },
  };
}
