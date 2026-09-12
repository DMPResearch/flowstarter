import 'server-only';
/**
 * The upload half of the concierge loop, in one place.
 *
 * A client could already be *asked* for photographs; until this landed there
 * was nowhere for them to arrive. The rules that make an arriving file safe
 * are all here rather than in the route handlers, so the same guarantees hold
 * whichever handler grows next:
 *
 *  - Bytes decide the format. `assertSafeUploadedImage` reads magic bytes and
 *    accepts PNG/JPEG/GIF/WebP only. The file name and the browser's
 *    Content-Type are never consulted, so an SVG renamed `logo.png` and sent
 *    as `image/png` is refused — which matters because SVG is XML that can
 *    carry script, and these files end up rendered on the client's own site.
 *  - Paths are content-addressed and tenant-scoped. `assetObjectPath` builds
 *    `tenant/{workspaceId}/assets/{sha256}.{ext}` and `assertTenantPath`
 *    re-checks the result immediately before the storage call, so a path can
 *    never be the thing that crosses a tenant boundary.
 *  - Dedupe is the database's job. `assets` carries a partial unique index on
 *    (workspace_id, sha256), so a re-upload of the same photograph races
 *    safely: we insert, and on 23505 we return the row that already existed.
 *    Checking first and inserting second would be a lie under concurrency.
 *  - The browser's filename is stored, but only as `original_name`, never as
 *    anything address-shaped. The object's real name is its content hash; a
 *    client's own name for their file is prose an operator reads later, not
 *    a path component, so it never touches `assetObjectPath` or storage.
 *
 * Rights are deliberately NOT confirmed here. Uploading a file says "here is a
 * picture"; it does not say "I own this and you may publish it". The client
 * makes that statement over a named set of assets in `rights/route.ts`, and
 * anything without `rights_confirmed_at` is reported as unusable.
 */
import { createHash } from 'node:crypto';
import { assertSafeUploadedImage } from '@flowstarter/agentic-codegen/src/flowstarter/site-media';
import { probeImageSize } from '@flowstarter/agentic-codegen/src/flowstarter/preview-assets';
import { assertTenantPath, assetObjectPath } from '@/lib/storage-paths';
import { withTenant } from '@/lib/tenancy';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

/** The private bucket created in 20260830140000. Never public. */
export const TENANT_ASSET_BUCKET = 'tenant-assets';

/**
 * Per-file cap. Matches `assertSafeUploadedImage`'s own limit so the client
 * gets one consistent number, and sits under the bucket's 10MiB ceiling so a
 * file we accept is never rejected by storage afterwards.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** A handful at a time. A drag-and-drop of a phone album is not an ask. */
export const MAX_FILES_PER_REQUEST = 8;

/** Whole-request cap, so eight maximum-size files cannot be sent as one body. */
export const MAX_REQUEST_BYTES = 24 * 1024 * 1024;

/** How long a display URL lives. Long enough to render, short enough to leak badly. */
export const SIGNED_URL_TTL_SECONDS = 300;

/** Content types, derived from the verified bytes — never from the upload. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Slot hints a client UI may attach to an upload, mapped onto the `usable_for`
 * vocabulary the sufficiency gate reads. An unknown hint is dropped rather
 * than stored: `usable_for` is a claim about what an image is fit for, and a
 * claim nobody checked is worse than no claim.
 */
const USABLE_FOR_BY_SLOT: Record<string, string[]> = {
  hero: ['hero'],
  logo: ['logo'],
  section: ['section'],
  gallery: ['section'],
  team: ['section'],
};

export class AssetUploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AssetUploadError';
  }
}

export interface UploadedAsset {
  id: string;
  sha256: string;
  storagePath: string;
  mime: string;
  kind: string | null;
  width: number | null;
  height: number | null;
  usableFor: string[];
  rightsConfirmedAt: string | null;
  /** True when this upload matched a file the workspace already had. */
  deduplicated: boolean;
}

export interface VerifiedFile {
  bytes: Buffer;
  extension: string;
  mime: string;
  sha256: string;
  width: number | null;
  height: number | null;
}

/**
 * Verifies one file's bytes and derives everything that gets stored about it.
 * Throws `AssetUploadError` with the status the caller should return: 413 for
 * "too big", 400 for "not an image we accept".
 */
export function verifyUpload(bytes: Buffer): VerifiedFile {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new AssetUploadError(
      `That file is larger than ${Math.floor(
        MAX_UPLOAD_BYTES / (1024 * 1024)
      )}MB. Please send a smaller version.`,
      413
    );
  }

  let extension: string;
  try {
    // Magic bytes only. SVG is not in the accepted set at all, so a renamed
    // `.png` with a spoofed `image/png` header dies here.
    ({ extension } = assertSafeUploadedImage(bytes));
  } catch (error) {
    throw new AssetUploadError(
      error instanceof Error
        ? error.message
        : 'That file is not an image we can use',
      400
    );
  }

  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) {
    // Unreachable while the validator's format list and this map agree; kept
    // so they cannot silently drift into storing an unknown content type.
    throw new AssetUploadError('That image format is not supported', 400);
  }

  const size = probeImageSize(bytes);
  return {
    bytes,
    extension,
    mime,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

/** The `usable_for` array for a slot hint, or an empty array. */
export function usableForSlot(slot: string | null): string[] {
  if (!slot) return [];
  return USABLE_FOR_BY_SLOT[slot.trim().toLowerCase()] ?? [];
}

export interface StoreUploadInput {
  workspaceId: string;
  file: VerifiedFile;
  /** Optional slot the ask was about, e.g. `hero` or `logo`. */
  slot?: string | null;
  /** `assets.kind`; `logo` is meaningful to the sufficiency gate. */
  kind?: string | null;
  /**
   * The browser's own name for the file, display-only. It is never the thing
   * that addresses the object — `assetObjectPath` does that from the content
   * hash — so a caller may pass through whatever a client typed or renamed
   * their photo to without it ever reaching a path.
   */
  originalName?: string | null;
}

/**
 * Puts one verified file in the bucket and records it.
 *
 * The object is written before the row, and with `upsert`, because the path is
 * the content hash: writing the same bytes to the same path twice is a no-op
 * by construction, so a retry cannot fork an object away from its row.
 */
export async function storeUpload({
  workspaceId,
  file,
  slot = null,
  kind = null,
  originalName = null,
}: StoreUploadInput): Promise<UploadedAsset> {
  const storagePath = assetObjectPath({
    workspaceId,
    sha256: file.sha256,
    extension: file.extension,
  });
  // Belt and braces: the path was just built from a validated workspace id,
  // and is checked again against that id right before it reaches storage.
  assertTenantPath(storagePath, workspaceId);

  const supabase = createSupabaseServiceRoleClient();
  const { error: uploadError } = await supabase.storage
    .from(TENANT_ASSET_BUCKET)
    .upload(storagePath, file.bytes, {
      contentType: file.mime,
      upsert: true,
    });
  if (uploadError) {
    console.error('[api/client/assets] storage upload failed', uploadError);
    throw new AssetUploadError(
      'Could not store that file. Please try again.',
      502
    );
  }

  const usableFor = usableForSlot(slot);
  const resolvedKind = kind ?? (slot === 'logo' ? 'logo' : null);

  const { data: inserted, error: insertError } = await withTenant(
    supabase,
    workspaceId
  )
    .from('assets')
    .insert({
      source: 'upload',
      kind: resolvedKind,
      storage_path: storagePath,
      sha256: file.sha256,
      mime: file.mime,
      original_name: originalName,
      width: file.width,
      height: file.height,
      usable_for: usableFor,
      is_placeholder: false,
      ai_generated: false,
    })
    .select('id, kind, width, height, usable_for, rights_confirmed_at')
    .maybeSingle<AssetRowShape>();

  if (!insertError && inserted) {
    return {
      id: inserted.id,
      sha256: file.sha256,
      storagePath,
      mime: file.mime,
      kind: inserted.kind,
      width: inserted.width,
      height: inserted.height,
      usableFor: inserted.usable_for ?? [],
      rightsConfirmedAt: inserted.rights_confirmed_at,
      deduplicated: false,
    };
  }

  // 23505: the partial unique index on (workspace_id, sha256) fired. The
  // client sent a photograph this workspace already has, which is a
  // successful no-op, not an error — return what is already there.
  if (!isUniqueViolation(insertError)) {
    console.error('[api/client/assets] asset insert failed', insertError);
    throw new AssetUploadError(
      'Could not record that file. Please try again.',
      500
    );
  }

  const existing = await findBySha256(workspaceId, file.sha256);
  if (!existing) {
    throw new AssetUploadError(
      'Could not record that file. Please try again.',
      500
    );
  }
  return { ...existing, deduplicated: true };
}

interface AssetRowShape {
  id: string;
  kind: string | null;
  width: number | null;
  height: number | null;
  usable_for: string[] | null;
  rights_confirmed_at: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

async function findBySha256(
  workspaceId: string,
  sha256: string
): Promise<UploadedAsset | null> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await withTenant(supabase, workspaceId)
    .from('assets')
    .select(
      'id, kind, width, height, usable_for, rights_confirmed_at, storage_path, mime'
    )
    .eq('sha256', sha256)
    .maybeSingle<
      AssetRowShape & { storage_path: string | null; mime: string | null }
    >();
  if (error || !data) return null;
  return {
    id: data.id,
    sha256,
    storagePath: data.storage_path ?? '',
    mime: data.mime ?? '',
    kind: data.kind,
    width: data.width,
    height: data.height,
    usableFor: data.usable_for ?? [],
    rightsConfirmedAt: data.rights_confirmed_at,
    deduplicated: true,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Reading back
// ───────────────────────────────────────────────────────────────────────────

export interface ClientAsset {
  id: string;
  source: string;
  kind: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  usableFor: string[];
  selected: boolean;
  rightsConfirmedAt: string | null;
  createdAt: string | null;
  /**
   * The whole point of the flag: an asset nobody has claimed the rights to is
   * *not* material we may publish, however good it looks. Anything that feeds
   * the generator must filter on this, not merely display it.
   */
  usable: boolean;
  /** Short-lived signed URL, or null when the object could not be signed. */
  url: string | null;
}

export interface ListedAssetsRow extends AssetRowShape {
  source: string;
  mime: string | null;
  selected: boolean;
  created_at: string | null;
  storage_path: string | null;
}

/**
 * The workspace's assets, each with a short-lived signed URL.
 *
 * Raw `storage_path` values never leave this function. The bucket is private,
 * so a path is not a URL — returning one would either be useless or, worse,
 * become a public URL the day somebody flips the bucket.
 */
export async function listWorkspaceAssets(
  workspaceId: string,
  limit = 200
): Promise<ClientAsset[]> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await withTenant(supabase, workspaceId)
    .from('assets')
    .select(
      'id, source, kind, mime, width, height, usable_for, selected, rights_confirmed_at, created_at, storage_path'
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[api/client/assets] asset list failed', error);
    throw new AssetUploadError('Could not load your files.', 500);
  }

  const rows = (data ?? []) as unknown as ListedAssetsRow[];
  return Promise.all(
    rows.map((row) => toClientAsset(supabase, workspaceId, row))
  );
}

async function toClientAsset(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  workspaceId: string,
  row: ListedAssetsRow
): Promise<ClientAsset> {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    mime: row.mime,
    width: row.width,
    height: row.height,
    usableFor: row.usable_for ?? [],
    selected: Boolean(row.selected),
    rightsConfirmedAt: row.rights_confirmed_at,
    createdAt: row.created_at,
    usable: Boolean(row.rights_confirmed_at),
    url: await signedUrl(supabase, workspaceId, row.storage_path),
  };
}

/**
 * A display URL for one object, or null.
 *
 * The path is re-asserted against the workspace before it is signed. A row
 * whose `storage_path` somehow points at another tenant is a bug worth
 * shouting about, and it must not be signed on the way past.
 */
async function signedUrl(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  workspaceId: string,
  storagePath: string | null
): Promise<string | null> {
  if (!storagePath) return null;
  try {
    assertTenantPath(storagePath, workspaceId);
  } catch (error) {
    console.error('[api/client/assets] refusing to sign a foreign path', {
      workspaceId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
  try {
    const { data, error } = await supabase.storage
      .from(TENANT_ASSET_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * The one door callers outside this module get to `signedUrl` through.
 *
 * Every other reader of a private object (the client's own asset list, the
 * operator's change-request picker) needs the exact same guarantee: the
 * tenant path is re-asserted right before signing, and a failure degrades to
 * `null` instead of failing whatever page or endpoint asked for a thumbnail.
 * Rather than let a second place learn to sign a storage path, they call this.
 */
export async function signedAssetUrl(
  workspaceId: string,
  storagePath: string | null
): Promise<string | null> {
  return signedUrl(createSupabaseServiceRoleClient(), workspaceId, storagePath);
}

/**
 * Best-effort audit trail. A failure here must never lose a file the client
 * successfully sent, so it is logged and swallowed — same contract as
 * `recordEvent` in lib/flowstarter/messaging.ts.
 */
export async function recordAssetEvent(
  workspaceId: string,
  kind: string,
  actor: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const supabase = createSupabaseServiceRoleClient();
    const { error } = await withTenant(supabase, workspaceId)
      .from('project_events')
      .insert({ kind, actor, payload });
    if (error) {
      console.warn('[api/client/assets] event not recorded', {
        kind,
        error: error.message,
      });
    }
  } catch (error) {
    console.warn('[api/client/assets] event not recorded', {
      kind,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/**
 * What is still outstanding, counting ONLY assets whose rights are confirmed.
 *
 * `collectSufficiencyInput` reports every asset the workspace holds, which is
 * the right answer for "what do we have"; it is the wrong answer for "what may
 * we build with". The images and logo are re-filtered here so an unconfirmed
 * upload never makes a project look ready.
 *
 * Returns null when the gate cannot be evaluated (a workspace mid-setup, a
 * template not chosen yet). A missing readiness figure is honest; a fabricated
 * one is not.
 */
export async function readinessAfterUpload(
  workspaceId: string,
  confirmedAssetIds: ReadonlySet<string>
): Promise<{ ready: boolean; missing: unknown[] } | null> {
  try {
    const [{ collectSufficiencyInput }, { evaluateSufficiency }] =
      await Promise.all([
        import('@/lib/flowstarter/messaging'),
        import('@/lib/flowstarter/sufficiency'),
      ]);
    const input = await collectSufficiencyInput(workspaceId);
    const result = evaluateSufficiency({
      ...input,
      images: (input.images ?? []).filter((image) =>
        confirmedAssetIds.has(image.id)
      ),
      logo:
        input.logo && confirmedAssetIds.has(input.logo.id) ? input.logo : null,
    });
    return { ready: result.ready, missing: result.missing };
  } catch (error) {
    console.warn('[api/client/assets] sufficiency unavailable', {
      workspaceId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

/** The caller's IP, as far as the proxy chain is willing to say. */
export function clientIp(request: Request): string | null {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    null
  );
}
