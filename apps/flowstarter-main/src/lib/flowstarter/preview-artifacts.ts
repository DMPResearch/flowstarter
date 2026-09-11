/**
 * Persists the approved preview so a paid build has something to build from.
 *
 * The build worker reads `flowstarter_project_artifacts` and refuses a job
 * without it ("Workspace has no approved preview artifacts to build from"),
 * so until this row exists a deposit buys a build that cannot start. Every
 * shape the worker asserts on is validated here, at write time, rather than
 * discovered later when a client has already paid.
 */
import type {
  BrandConfig,
  BusinessIntakePayload,
  TemplateScaffoldFile,
  TemplateSelection,
} from '@flowstarter/agentic-codegen';
import {
  describeAssetProblems,
  findNonBinaryAssets,
} from '@flowstarter/agentic-codegen';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import type { Json } from '@/lib/database.types';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The worker rebuilds from these files, so an empty set is never valid. */
const MAX_MANIFEST_FILES = 2_000;
const MAX_MANIFEST_BYTES = 24 * 1024 * 1024;

export class PreviewArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewArtifactError';
  }
}

export interface SavePreviewArtifactsInput {
  workspaceId: string;
  intake: BusinessIntakePayload;
  brandConfig: BrandConfig;
  template: TemplateSelection;
  files: readonly TemplateScaffoldFile[];
  previewArtifactUrl?: string;
  /** Raw scrape evidence, kept for provenance; never required by the worker. */
  scrapeManifest?: unknown;
  /** Advance the lifecycle to PREVIEW_READY in the same operation. */
  advanceToPreviewReady?: boolean;
}

export interface SavePreviewArtifactsResult {
  workspaceId: string;
  fileCount: number;
  templateSlug: string;
  advanced: boolean;
}

/**
 * Writes (or replaces) the artifacts for one workspace. Safe to call again for
 * a regenerated preview: the row is keyed one-to-one on the workspace, so the
 * newest approved preview is the one a later deposit builds.
 */
export async function savePreviewArtifacts(
  input: SavePreviewArtifactsInput
): Promise<SavePreviewArtifactsResult> {
  if (!UUID.test(input.workspaceId)) {
    throw new PreviewArtifactError('Invalid workspace id');
  }
  // The worker cross-checks this and fails the job if they disagree, so a
  // mismatch has to be caught before the row is written.
  if (
    input.intake.projectId?.toLowerCase() !== input.workspaceId.toLowerCase()
  ) {
    throw new PreviewArtifactError(
      'intake.projectId must match the workspace the preview belongs to'
    );
  }
  if (!input.template?.slug) {
    throw new PreviewArtifactError('Preview has no template selection');
  }
  if (input.files.length === 0) {
    throw new PreviewArtifactError(
      'Preview manifest is empty; the worker would have nothing to build'
    );
  }
  if (input.files.length > MAX_MANIFEST_FILES) {
    throw new PreviewArtifactError('Preview manifest holds too many files');
  }

  let bytes = 0;
  for (const file of input.files) {
    if (typeof file.path !== 'string' || file.path.length === 0) {
      throw new PreviewArtifactError(
        'Preview manifest holds a file with no path'
      );
    }
    if (typeof file.content !== 'string') {
      throw new PreviewArtifactError(
        `Preview manifest file ${file.path} has no content`
      );
    }
    bytes += Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_MANIFEST_BYTES) {
      throw new PreviewArtifactError('Preview manifest exceeds the size limit');
    }
  }

  // An image that lost its `encoding: 'base64'` flag is, in this row, a string
  // of printable base64 behind a `.png` name. The worker materializes this
  // manifest verbatim, so writing one is how a client ends up with a site
  // whose every image is a broken icon. Caught here, at write time, like every
  // other shape the worker asserts on.
  const assetProblems = findNonBinaryAssets(input.files);
  if (assetProblems.length > 0) {
    throw new PreviewArtifactError(describeAssetProblems(assetProblems));
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id, project_state')
    .eq('id', input.workspaceId)
    .maybeSingle();
  if (workspaceError) throw workspaceError;
  if (!workspace) throw new PreviewArtifactError('Workspace does not exist');

  const now = new Date().toISOString();
  const { error: upsertError } = await supabase
    .from('flowstarter_project_artifacts')
    .upsert(
      {
        workspace_id: input.workspaceId,
        intake_payload: input.intake as unknown as Json,
        brand_config: input.brandConfig as unknown as Json,
        preview_manifest: {
          files: input.files.map((file) => ({
            path: file.path,
            content: file.content,
            ...(file.encoding ? { encoding: file.encoding } : {}),
          })),
        } as unknown as Json,
        scrape_manifest: (input.scrapeManifest ?? {}) as Json,
        template_slug: input.template.slug,
        template_selection_reason: input.template.reason ?? null,
        preview_artifact_url: input.previewArtifactUrl ?? null,
        updated_at: now,
      },
      { onConflict: 'workspace_id' }
    );
  if (upsertError) throw upsertError;

  let advanced = false;
  if (input.advanceToPreviewReady) {
    // Only from a pre-preview state: a workspace that already took a deposit
    // must not be walked backwards by a regenerated preview.
    const { data: moved, error: stateError } = await supabase
      .from('workspaces')
      .update({ project_state: ProjectState.PREVIEW_READY, updated_at: now })
      .eq('id', input.workspaceId)
      .in('project_state', [ProjectState.INTAKE, ProjectState.PREVIEW_READY])
      .select('id')
      .maybeSingle();
    if (stateError) throw stateError;
    advanced = Boolean(moved);
  }

  return {
    workspaceId: input.workspaceId,
    fileCount: input.files.length,
    templateSlug: input.template.slug,
    advanced,
  };
}
