/**
 * Putting the client's own pictures where the build agent can use them.
 *
 * Two callers now, one rule. A change request names the pictures it was
 * quoted on; the in-depth brief names the portrait, the project screenshots,
 * the photographs and the design references a paid build is written from.
 * Both arrive as `{ assetId, manifestPath }` pairs on the job payload and both
 * need the same thing done to them, so the loader below is shared and the two
 * differ in exactly one policy, `onMissing`, which is documented where it is
 * declared.
 *
 * A change request like "add a gallery with the three screenshots I uploaded"
 * is unanswerable unless those screenshots are files on disk in the build
 * worktree. They are not: they live in the private `tenant-assets` bucket,
 * content-addressed under `tenant/{workspaceId}/assets/{sha256}.{ext}`, and
 * before this nothing in the product ever handed one to a generator -- the
 * one reader allowed to (`loadUsableAssets`) was imported by its own test and
 * by nothing else.
 *
 * So the seeded manifest gets them appended as ordinary base64 files under
 * `public/flowstarter-media/`, which is the directory the client's own
 * Pictures tab already publishes into, and the prompt names those exact
 * paths.
 *
 * Two things are deliberately NOT trusted from the job payload:
 *
 *   - the storage path. It is read from the `assets` row here, through
 *     `withTenant`, so a hand-edited payload cannot point this at another
 *     tenant's object however plausible the string looks.
 *   - the rights. `rights_confirmed_at` is re-checked at build time rather
 *     than relied on from the moment the payload was written. Rights are a
 *     statement a client makes and can withdraw, and the build is the last
 *     moment before those bytes are on a public website.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assertSafeUploadedImage,
  type ChangeRequestAsset,
  type TemplateScaffoldFile,
} from '@flowstarter/agentic-codegen';
import { withTenant } from './tenancy';

/** The private bucket `apps/flowstarter-main` uploads tenant media into. */
export const TENANT_ASSET_BUCKET = 'tenant-assets';

export class ChangeRequestAssetError extends Error {}

interface AssetRow {
  id: string;
  storage_path: string | null;
  rights_confirmed_at: string | null;
}

/**
 * True when a storage path belongs to this workspace. The same shape
 * `assertTenantPath` enforces in the main app, restated here because this
 * process has its own Supabase client and no access to that module.
 */
export function isTenantAssetPath(path: string, workspaceId: string): boolean {
  if (path.includes('..') || path.startsWith('/')) return false;
  return path.toLowerCase().startsWith(`tenant/${workspaceId.toLowerCase()}/`);
}

/**
 * Every named asset as a manifest file, ready to be seeded into a worktree.
 *
 * An asset that cannot be delivered -- deleted, rights withdrawn, bytes gone,
 * or no longer an image -- throws rather than being quietly dropped. The
 * request was quoted and paid on the understanding that those pictures would
 * be used, and a build that silently ran without them would produce a site
 * the applied-change gate then fails anyway, several agent minutes later, with
 * a worse explanation.
 */
export async function loadChangeRequestAssetFiles(input: {
  client: SupabaseClient;
  workspaceId: string;
  assets: readonly ChangeRequestAsset[];
}): Promise<TemplateScaffoldFile[]> {
  const { files } = await loadTenantAssetFiles({
    ...input,
    onMissing: 'throw',
  });
  return files;
}

/** The two ways an undeliverable asset can be handled, and who picks which. */
export type MissingAssetPolicy = 'throw' | 'skip';

export interface LoadedTenantAssets {
  files: TemplateScaffoldFile[];
  /** Asset ids that could not be delivered. Always empty under `throw`. */
  skipped: { assetId: string; reason: string }[];
}

/**
 * The shared loader.
 *
 * `onMissing: 'throw'` is the change request's policy and is argued for above:
 * the request was quoted and paid on those pictures.
 *
 * `onMissing: 'skip'` is the brief's policy, and the reasoning is the mirror
 * image. A brief carries everything the client has, not a list somebody was
 * invoiced for, and one photograph whose rights were withdrawn between the
 * moment the payload was composed and the moment the build ran is not a reason
 * to refuse to build a site that was paid for in full. What must not happen is
 * the prompt naming a path with nothing behind it, so the caller takes the
 * skipped ids back out of the brief before the agent is told about them.
 */
export async function loadTenantAssetFiles(input: {
  client: SupabaseClient;
  workspaceId: string;
  assets: readonly ChangeRequestAsset[];
  onMissing: MissingAssetPolicy;
}): Promise<LoadedTenantAssets> {
  const { client, workspaceId, assets, onMissing } = input;
  const skipped: { assetId: string; reason: string }[] = [];
  if (assets.length === 0) return { files: [], skipped };

  /**
   * One undeliverable asset, handled by policy. Returns true when the caller
   * should move on to the next one.
   */
  const refuse = (assetId: string, reason: string): boolean => {
    if (onMissing === 'throw') throw new ChangeRequestAssetError(reason);
    skipped.push({ assetId, reason });
    return true;
  };

  const { data, error } = await withTenant(client, workspaceId)
    .from('assets')
    .select('id, storage_path, rights_confirmed_at')
    .in(
      'id',
      assets.map((asset) => asset.assetId),
    );
  if (error) throw error;
  const rows = new Map(
    ((data ?? []) as unknown as AssetRow[]).map((row) => [row.id, row]),
  );

  const files: TemplateScaffoldFile[] = [];
  for (const asset of assets) {
    const row = rows.get(asset.assetId);
    if (!row) {
      refuse(
        asset.assetId,
        `Asset ${asset.assetId} is no longer in this workspace's library, so ` +
          'the build cannot use it.',
      );
      continue;
    }
    if (!row.rights_confirmed_at) {
      refuse(
        asset.assetId,
        `Asset ${asset.assetId} no longer has confirmed rights, so it must ` +
          'not be published.',
      );
      continue;
    }
    if (
      !row.storage_path ||
      !isTenantAssetPath(row.storage_path, workspaceId)
    ) {
      refuse(
        asset.assetId,
        `Asset ${asset.assetId} has no stored copy inside this workspace.`,
      );
      continue;
    }

    const download = await client.storage
      .from(TENANT_ASSET_BUCKET)
      .download(row.storage_path);
    if (download.error || !download.data) {
      refuse(
        asset.assetId,
        `Asset ${asset.assetId} could not be read from storage: ` +
          (download.error?.message ?? 'no data'),
      );
      continue;
    }
    const bytes = Buffer.from(await download.data.arrayBuffer());
    try {
      // The same magic-byte check the upload and the Pictures tab both run. A
      // row written before that check existed still cannot put an SVG, or a
      // renamed script, onto a client's live site.
      assertSafeUploadedImage(bytes);
    } catch (error) {
      if (onMissing === 'throw') throw error;
      skipped.push({
        assetId: asset.assetId,
        reason: error instanceof Error ? error.message : 'not a usable image',
      });
      continue;
    }

    files.push({
      path: asset.manifestPath,
      content: bytes.toString('base64'),
      encoding: 'base64',
      type: 'file',
    });
  }
  return { files, skipped };
}

/**
 * The seed manifest with the client's pictures folded in.
 *
 * A path already in the manifest is replaced rather than added: the client may
 * have put the same file into a slot through the Pictures tab, and
 * `materializeScaffold` writes with `wx`, so a duplicate path would fail the
 * build on a filesystem error rather than on anything meaningful.
 */
export function withChangeRequestAssets(
  seed: readonly TemplateScaffoldFile[],
  assetFiles: readonly TemplateScaffoldFile[],
): TemplateScaffoldFile[] {
  if (assetFiles.length === 0) return [...seed];
  const added = new Map(assetFiles.map((file) => [file.path, file]));
  const merged = seed.map((file) => added.get(file.path) ?? file);
  const seen = new Set(seed.map((file) => file.path));
  for (const file of assetFiles) {
    if (!seen.has(file.path)) merged.push(file);
  }
  return merged;
}
