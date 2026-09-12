/**
 * Storage object paths for tenant-owned files.
 *
 * Every object a workspace owns — an uploaded asset, a generated asset, a
 * preview build artifact — lives under `tenant/{workspaceId}/...`. No bucket
 * exists yet (Storage isn't wired up), so this file is pure path logic: it
 * builds and validates strings, and never talks to Supabase Storage. That
 * keeps it trivially testable now, and gives whatever wraps the real bucket
 * client later a single place both to build paths from and to double-check
 * them against before an upload/download/delete goes out.
 *
 * `assertTenantPath` is the guard everything else should be checked against
 * before it reaches a storage call: it throws unless the path is scoped to
 * exactly the given workspace and free of traversal tricks.
 */

/** Same canonical-UUID pattern used in `src/lib/tenancy.ts`. */
const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A sha256 hex digest, as used for content-addressed asset filenames. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

/** Extensions this module knows how to place in a tenant path. */
export const ALLOWED_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'avif',
  'svg',
  'tar.gz',
  'json',
] as const;

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoragePathError';
  }
}

function assertWorkspaceId(workspaceId: string): void {
  if (
    typeof workspaceId !== 'string' ||
    !WORKSPACE_ID_PATTERN.test(workspaceId)
  ) {
    throw new StoragePathError(
      `"${String(workspaceId)}" is not a canonical workspace UUID`
    );
  }
}

function assertExtension(
  extension: string
): asserts extension is AllowedExtension {
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new StoragePathError(
      `"${extension}" is not an allowed extension (expected one of: ${ALLOWED_EXTENSIONS.join(
        ', '
      )})`
    );
  }
}

/** Non-empty, no path separators, no traversal, no NUL. Used for path segments. */
function assertSafeSegment(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StoragePathError(`${field} must be a non-empty string`);
  }
  if (
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new StoragePathError(
      `${field} must not contain path separators, "..", or NUL`
    );
  }
}

/**
 * A content-addressed filename has to be exactly that. Shared by the tenant
 * asset path and the funnel one so a file cannot be addressed differently on
 * the two sides of a claim.
 */
function assertSha256(sha256: string): void {
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new StoragePathError(
      `"${String(sha256)}" is not a lowercase sha256 hex digest`
    );
  }
}

export interface AssetObjectPathInput {
  workspaceId: string;
  sha256: string;
  extension: string;
}

/**
 * `tenant/{workspaceId}/assets/{sha256}.{ext}` — an uploaded, content
 * addressed asset. The sha256 is the filename so the same upload from the
 * same workspace always resolves to the same object.
 */
export function assetObjectPath({
  workspaceId,
  sha256,
  extension,
}: AssetObjectPathInput): string {
  assertWorkspaceId(workspaceId);
  assertExtension(extension);
  assertSha256(sha256);
  return `tenant/${workspaceId}/assets/${sha256.toLowerCase()}.${extension}`;
}

export interface GeneratedAssetPathInput {
  workspaceId: string;
  /** Logical name for the generated artifact, e.g. a variant or job id. */
  name: string;
  extension: string;
}

/**
 * `tenant/{workspaceId}/generated/{name}.{ext}` — an asset Flowstarter
 * produced itself (e.g. an AI-generated image), as opposed to one a client
 * uploaded.
 */
export function generatedAssetPath({
  workspaceId,
  name,
  extension,
}: GeneratedAssetPathInput): string {
  assertWorkspaceId(workspaceId);
  assertSafeSegment(name, 'name');
  assertExtension(extension);
  return `tenant/${workspaceId}/generated/${name}.${extension}`;
}

export interface PreviewArtifactPathInput {
  workspaceId: string;
  projectId: string;
}

/**
 * `tenant/{workspaceId}/previews/{projectId}/site.tar.gz` — the packaged
 * preview build for one project.
 */
export function previewArtifactPath({
  workspaceId,
  projectId,
}: PreviewArtifactPathInput): string {
  assertWorkspaceId(workspaceId);
  assertSafeSegment(projectId, 'projectId');
  return `tenant/${workspaceId}/previews/${projectId}/site.tar.gz`;
}

/**
 * `funnel/{previewId}/site.tar.gz` — the packaged build for an ANONYMOUS
 * funnel preview.
 *
 * Deliberately outside the `tenant/` prefix, because at the moment a funnel
 * preview is generated there is no workspace and no membership: there is no
 * tenant to scope it to, and inventing one would put a stranger's bytes under
 * somebody's else's id. The bucket's read policy only ever grants
 * `tenant/{workspaceId}/...` (`tenant_path_workspace_id` returns null for any
 * other shape, and `is_workspace_member(null)` is false), so an object under
 * `funnel/` is unreadable by every browser session by construction — writes
 * and reads are the service role's alone, and the app hands out short-lived
 * signed URLs when the deploy-agent needs to fetch one.
 *
 * On claim the object is copied to `previewArtifactPath({workspaceId, projectId})`,
 * which is where a tenant-owned artifact belongs and where the tenant read
 * policy applies to it.
 */
export function funnelPreviewArtifactPath(previewId: string): string {
  assertSafeSegment(previewId, 'previewId');
  return `funnel/${previewId}/site.tar.gz`;
}

/**
 * `funnel/{previewId}/assets/{sha256}.{ext}` — a picture a visitor uploaded
 * before there was a workspace to own it.
 *
 * The intake asks for an Instagram and a LinkedIn so a palette can be read
 * from a public profile. Both frequently expose nothing to an anonymous
 * reader, and the visitor is then offered a single upload instead: a logo or a
 * profile picture, so the colours still come from their material rather than
 * from a tone chip. That upload happens before the claim, so it has the same
 * problem the artifact has and takes the same answer.
 *
 * Deliberately under the SAME `funnel/{previewId}/` prefix as the artifact,
 * not a sibling `funnel-assets/` one, for two concrete reasons:
 *
 *   - the bucket's read policy grants `tenant/{workspaceId}/...` and nothing
 *     else, so anything under `funnel/` is already unreadable by every browser
 *     session by construction, and
 *   - the reaper tears a dead preview down by its own prefix. Keeping the
 *     pictures inside it means an expiring preview takes its uploads with it
 *     instead of leaving orphans in a directory nothing sweeps.
 *
 * On claim the object is copied to `assetObjectPath({workspaceId, sha256, extension})`,
 * which is where a tenant-owned asset belongs and where the tenant read policy
 * starts applying to it.
 */
export function funnelAssetPath(input: {
  previewId: string;
  sha256: string;
  extension: string;
}): string {
  assertSafeSegment(input.previewId, 'previewId');
  assertSha256(input.sha256);
  assertExtension(input.extension);
  return `funnel/${input.previewId}/assets/${input.sha256.toLowerCase()}.${
    input.extension
  }`;
}

/**
 * The prefix every object belonging to one funnel preview lives under. The
 * reaper lists and deletes by this, so a preview's artifact and its uploads
 * go together.
 */
export function funnelPreviewPrefix(previewId: string): string {
  assertSafeSegment(previewId, 'previewId');
  return `funnel/${previewId}`;
}

/**
 * Throws unless `path` is scoped to exactly `tenant/{workspaceId}/...` and
 * carries no traversal or injection tricks. Meant to run immediately before
 * any storage call that takes a path built elsewhere (or supplied by a
 * caller) as a final check, independent of how the path was constructed.
 */
export function assertTenantPath(path: string, workspaceId: string): void {
  assertWorkspaceId(workspaceId);
  if (typeof path !== 'string' || path.length === 0) {
    throw new StoragePathError('path must be a non-empty string');
  }
  if (path.startsWith('/')) {
    throw new StoragePathError('path must not start with "/"');
  }
  if (path.includes('\\')) {
    throw new StoragePathError('path must not contain backslashes');
  }
  if (path.includes('\0')) {
    throw new StoragePathError('path must not contain NUL');
  }
  if (path.includes('..')) {
    throw new StoragePathError('path must not contain ".."');
  }
  const prefix = `tenant/${workspaceId}/`;
  if (!path.startsWith(prefix)) {
    throw new StoragePathError(
      `path "${path}" is not scoped to workspace "${workspaceId}" (expected it to start with "${prefix}")`
    );
  }
}
