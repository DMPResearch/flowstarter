import 'server-only';

/**
 * Pictures a visitor gives us before they are anybody.
 *
 * The quick intake asks for an Instagram and a LinkedIn so the palette can be
 * read from a public profile. Measured against the real pages, both usually
 * expose nothing at all to an anonymous reader: Instagram answers 200 with an
 * application shell and no OpenGraph tags, LinkedIn refuses outright. When
 * that happens the visitor is offered one upload instead, a logo or a profile
 * picture, so the colours still come from their own material.
 *
 * That upload arrives before the claim, which is the whole difficulty. There
 * is no workspace, no membership row and no Clerk session, so there is no
 * tenant to scope the row or the object to. This module is the answer:
 *
 *   store    a row in `funnel_assets`, keyed on the preview id, and an object
 *            under `funnel/{previewId}/assets/`. Server-only on both sides.
 *   claim    copy the row into `assets` under the new workspace and the object
 *            into `tenant/{workspaceId}/assets/`, carrying the rights
 *            confirmation across, so `loadUsableAssets` can see it.
 *   reap     delete both when the preview expires unclaimed.
 *
 * The claim is idempotent by construction: `funnel_assets.claimed_asset_id` is
 * written last, and a row that already carries one is skipped. A redelivered
 * claim therefore copies nothing twice, which matters because `claimPreview`
 * has no transaction around it and is explicitly built to be re-runnable.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database.types';
import {
  assetObjectPath,
  assertTenantPath,
  funnelAssetPath,
  funnelPreviewPrefix,
} from '@/lib/storage-paths';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

type ServiceClient = SupabaseClient<Database>;

/** The private bucket everything here lives in. Same one the tenant uses. */
export const TENANT_ASSET_BUCKET = 'tenant-assets';

/** How long a signed URL for a funnel picture is good for. */
export const SIGNED_URL_TTL_SECONDS = 300;

/**
 * At most one picture per preview is the product rule: this is a fallback for
 * a palette, not an asset library. The cap is enforced here rather than in the
 * route so a second entry point cannot quietly lift it.
 */
export const MAX_FUNNEL_ASSETS_PER_PREVIEW = 3;

export interface FunnelAssetRow {
  id: string;
  previewId: string;
  source: string;
  kind: string | null;
  storagePath: string | null;
  sha256: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  usableFor: string[];
  rightsConfirmedAt: string | null;
  claimedAssetId: string | null;
  /** The provider URL the bytes came off, for a picture we downloaded. */
  sourceUrl: string | null;
  /** When we downloaded it. Null for a file the visitor sent us. */
  fetchedAt: string | null;
}

interface RawRow {
  id: string;
  preview_id: string;
  source: string;
  kind: string | null;
  storage_path: string | null;
  sha256: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  usable_for: string[] | null;
  rights_confirmed_at: string | null;
  claimed_asset_id: string | null;
  source_url: string | null;
  fetched_at: string | null;
}

const COLUMNS =
  'id, preview_id, source, kind, storage_path, sha256, mime, width, height, usable_for, rights_confirmed_at, claimed_asset_id, source_url, fetched_at';

function toRow(raw: RawRow): FunnelAssetRow {
  return {
    id: raw.id,
    previewId: raw.preview_id,
    source: raw.source,
    kind: raw.kind,
    storagePath: raw.storage_path,
    sha256: raw.sha256,
    mime: raw.mime,
    width: raw.width,
    height: raw.height,
    usableFor: raw.usable_for ?? [],
    rightsConfirmedAt: raw.rights_confirmed_at,
    claimedAssetId: raw.claimed_asset_id,
    sourceUrl: raw.source_url,
    fetchedAt: raw.fetched_at,
  };
}

/** Postgres unique violation: the same file uploaded twice for one preview. */
const UNIQUE_VIOLATION = '23505';

/**
 * The values `assets.source` accepts, which since
 * `20260913120000_portrait_from_social.sql` are the same values
 * `funnel_assets.source` accepts. The two check constraints are deliberately
 * identical, so the network a picture was read from survives the claim instead
 * of being rounded off at it. Anything outside the set is still refused rather
 * than written, because an unrecognised source is a guess, and a guess is what
 * a rights complaint would be answered with.
 */
const ASSET_SOURCES = new Set([
  'upload',
  'generated',
  'og',
  'gbp',
  'old_site',
  'social',
  'instagram',
  'linkedin',
  'github',
]);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoreFunnelAssetInput {
  previewId: string;
  /** Already verified by `verifyUpload`; this module does not sniff bytes. */
  file: {
    bytes: Buffer;
    extension: string;
    mime: string;
    sha256: string;
    width: number | null;
    height: number | null;
  };
  /** `logo` or `photo`. Decides what the picture may be used for later. */
  kind: 'logo' | 'photo';
  /**
   * Where the bytes came from. `upload` is the visitor handing us a file;
   * `instagram`, `linkedin` and `og` are us reading a page they pointed at.
   * The distinction is the whole rights question, so it is stored rather than
   * inferred.
   */
  source?: FunnelAssetSource;
  /**
   * Roles the picture is fit for, if we already know. Roles are not rights: a
   * picture may be the right shape for an about section and still be one we
   * are not allowed to publish.
   */
  usableFor?: readonly string[];
  /**
   * The visitor's on-the-record statement that the picture is theirs, or
   * `null` when there is not one.
   *
   * `null` is the normal case for a picture we fetched from a public profile,
   * and it is load bearing: without `rights_confirmed_at` the row is invisible
   * to `loadUsableAssets`, so a paid build cannot publish it however it
   * travels. The claim page is what turns a null into a confirmation.
   */
  rights: {
    confirmed: boolean;
    statementVersion: string;
    ip: string | null;
    userAgent: string | null;
  } | null;
  /**
   * Where the bytes were downloaded from, and when, for a picture we fetched.
   *
   * Absent for an upload, and that absence is the record: a picture we
   * downloaded is not a file the client sent, and in six months the row is the
   * only thing that can tell them apart. A provider's picture URL expires, so
   * the pair is also the only account of what the profile looked like at the
   * moment we read it.
   */
  provenance?: { sourceUrl: string; fetchedAt: string };
  supabase?: ServiceClient;
}

/** Mirrors the check constraint on `funnel_assets.source`. */
export type FunnelAssetSource =
  | 'upload'
  | 'generated'
  | 'og'
  | 'gbp'
  | 'old_site'
  | 'social'
  | 'instagram'
  | 'linkedin'
  | 'github';

export class FunnelAssetError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'FunnelAssetError';
  }
}

/**
 * Writes the object and the row. Content addressed, so the same picture
 * uploaded twice resolves to one row rather than two.
 *
 * The object goes up first. An object with no row is garbage the reaper's
 * prefix sweep collects anyway; a row with no object is a broken reference the
 * palette step would trip over.
 */
export async function storeFunnelAsset(
  input: StoreFunnelAssetInput
): Promise<FunnelAssetRow> {
  const supabase = input.supabase ?? createSupabaseServiceRoleClient();
  const { previewId, file } = input;

  const existing = await supabase
    .from('funnel_assets')
    .select(COLUMNS)
    .eq('preview_id', previewId);
  if (existing.error) throw existing.error;
  const rows = (existing.data ?? []) as unknown as RawRow[];
  const already = rows.find((row) => row.sha256 === file.sha256);
  if (already) return toRow(already);
  if (rows.length >= MAX_FUNNEL_ASSETS_PER_PREVIEW) {
    throw new FunnelAssetError(
      'That is more pictures than this step takes. One is enough.',
      400
    );
  }

  const storagePath = funnelAssetPath({
    previewId,
    sha256: file.sha256,
    extension: file.extension,
  });

  const upload = await supabase.storage
    .from(TENANT_ASSET_BUCKET)
    .upload(storagePath, file.bytes, {
      contentType: file.mime,
      upsert: true,
    });
  if (upload.error) throw upload.error;

  const now = new Date().toISOString();
  const insert = await supabase
    .from('funnel_assets')
    .insert({
      preview_id: previewId,
      source: input.source ?? 'upload',
      kind: input.kind,
      storage_path: storagePath,
      sha256: file.sha256,
      mime: file.mime,
      width: file.width,
      height: file.height,
      // A logo is placed in the header; a photo is a section image until
      // something measures it and says otherwise. A caller that has already
      // measured passes its own list.
      usable_for: input.usableFor
        ? [...input.usableFor]
        : input.kind === 'logo'
        ? ['logo']
        : ['section'],
      rights_confirmed_at: input.rights?.confirmed ? now : null,
      rights_statement_version: input.rights?.confirmed
        ? input.rights.statementVersion
        : null,
      rights_ip: input.rights?.confirmed ? input.rights.ip : null,
      rights_user_agent: input.rights?.confirmed
        ? input.rights.userAgent?.slice(0, 500) ?? null
        : null,
      // Null when the visitor handed us the file. See `provenance` above.
      source_url: input.provenance?.sourceUrl ?? null,
      fetched_at: input.provenance?.fetchedAt ?? null,
    })
    .select(COLUMNS)
    .single();

  if (insert.error) {
    // Two uploads of one file raced. The other one won; read its row.
    if ((insert.error as { code?: string }).code === UNIQUE_VIOLATION) {
      const reread = await supabase
        .from('funnel_assets')
        .select(COLUMNS)
        .eq('preview_id', previewId)
        .eq('sha256', file.sha256)
        .maybeSingle();
      if (reread.error) throw reread.error;
      if (reread.data) return toRow(reread.data as unknown as RawRow);
    }
    throw insert.error;
  }
  return toRow(insert.data as unknown as RawRow);
}

/** Every picture held for one preview, oldest first. */
export async function listFunnelAssets(
  previewId: string,
  supabase?: ServiceClient
): Promise<FunnelAssetRow[]> {
  const client = supabase ?? createSupabaseServiceRoleClient();
  const { data, error } = await client
    .from('funnel_assets')
    .select(COLUMNS)
    .eq('preview_id', previewId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as RawRow[]).map(toRow);
}

/**
 * A short-lived URL for one funnel picture.
 *
 * The bucket is private and the object sits outside `tenant/`, so no browser
 * session can read it: the only way to show a visitor the picture we took off
 * their own profile is a signed URL, and the only reason to show it is the
 * claim page's one question. Returns null rather than throwing, because a
 * picture we cannot display is a checkbox we do not render, not an error.
 */
export async function signFunnelAsset(
  storagePath: string,
  supabase?: ServiceClient
): Promise<string | null> {
  if (!storagePath.startsWith('funnel/')) return null;
  const client = supabase ?? createSupabaseServiceRoleClient();
  const { data, error } = await client.storage
    .from(TENANT_ASSET_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** The bytes of one funnel picture, for the palette step. */
export async function readFunnelAssetBytes(
  storagePath: string,
  supabase?: ServiceClient
): Promise<Buffer | null> {
  if (!storagePath.startsWith('funnel/')) return null;
  const client = supabase ?? createSupabaseServiceRoleClient();
  const { data, error } = await client.storage
    .from(TENANT_ASSET_BUCKET)
    .download(storagePath);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export interface ClaimFunnelAssetsResult {
  /** How many rows were copied into `assets` on this run. */
  moved: number;
  /** How many were already carried across by an earlier run. */
  alreadyClaimed: number;
  /** Rows that could not be carried, with why, for the job log. */
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Carries a preview's pictures into the workspace that just claimed it.
 *
 * Copies rather than moves the object, for the same reason the artifact does:
 * the funnel preview may still be serving, and the reaper's prefix sweep will
 * collect the funnel copy when the preview expires.
 *
 * The rights confirmation is carried verbatim. That is the load-bearing part:
 * an `assets` row without `rights_confirmed_at` is invisible to
 * `loadUsableAssets`, so a picture that arrives here with rights confirmed and
 * loses them in transit is a picture the client gave us and the generator will
 * never see.
 *
 * Never throws. A claim that fails to carry a logo is a worse site, not a lost
 * workspace, and `claimPreview` has other work to finish.
 */
export async function claimFunnelAssets(input: {
  previewId: string;
  workspaceId: string;
  supabase?: ServiceClient;
}): Promise<ClaimFunnelAssetsResult> {
  const supabase = input.supabase ?? createSupabaseServiceRoleClient();
  const result: ClaimFunnelAssetsResult = {
    moved: 0,
    alreadyClaimed: 0,
    failed: [],
  };

  let rows: FunnelAssetRow[];
  try {
    rows = await listFunnelAssets(input.previewId, supabase);
  } catch (error) {
    result.failed.push({
      id: input.previewId,
      reason: error instanceof Error ? error.message : 'could not list',
    });
    return result;
  }

  for (const row of rows) {
    if (row.claimedAssetId) {
      result.alreadyClaimed += 1;
      continue;
    }
    try {
      await carryOne(supabase, row, input.workspaceId);
      result.moved += 1;
    } catch (error) {
      result.failed.push({
        id: row.id,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
  return result;
}

async function carryOne(
  supabase: ServiceClient,
  row: FunnelAssetRow,
  workspaceId: string
): Promise<void> {
  if (!row.storagePath || !row.sha256) {
    throw new Error('row has no stored object');
  }
  const extension = row.storagePath.split('.').pop() ?? 'png';
  const destination = assetObjectPath({
    workspaceId,
    sha256: row.sha256,
    extension,
  });
  // Belt and braces: the path was built from a validated workspace id a line
  // ago, and this is the check that runs immediately before every storage call
  // in the tenant half of the app.
  assertTenantPath(destination, workspaceId);

  const copy = await supabase.storage
    .from(TENANT_ASSET_BUCKET)
    .copy(row.storagePath, destination);
  if (copy.error) {
    // A re-run finds the object already there. That is success, not failure.
    const message = copy.error.message ?? '';
    if (!/exist/i.test(message)) throw copy.error;
  }

  const insert = await supabase
    .from('assets')
    .insert({
      workspace_id: workspaceId,
      // Provenance now SURVIVES the claim rather than being rounded off at
      // it. `assets.source` used to know none of the networks, so a picture
      // read off somebody's Instagram arrived in the workspace saying
      // `social` and the workspace kept the file while losing the answer to
      // "where did this come from" - which is the first question anybody asks
      // when a rights complaint arrives. Both check constraints now accept
      // the same vocabulary, so the source is carried verbatim. The guard
      // stays for a value neither table knows, which would otherwise be a row
      // the insert refuses outright.
      source: ASSET_SOURCES.has(row.source) ? row.source : 'social',
      kind: row.kind,
      storage_path: destination,
      sha256: row.sha256,
      mime: row.mime,
      width: row.width,
      height: row.height,
      usable_for: row.usableFor,
      // The two provenance columns travel with it, for the same reason: a
      // picture we downloaded is not a file the client sent, and in six
      // months the row is the only thing that can tell them apart.
      source_url: row.sourceUrl,
      fetched_at: row.fetchedAt,
      // Carried across, not re-derived. See the note above.
      rights_confirmed_at: row.rightsConfirmedAt,
      selected: Boolean(row.rightsConfirmedAt),
    })
    .select('id')
    .single();

  let assetId = insert.data?.id ?? null;
  if (insert.error) {
    if ((insert.error as { code?: string }).code !== UNIQUE_VIOLATION) {
      throw insert.error;
    }
    // The workspace already holds this exact file: `assets` is unique on
    // (workspace_id, sha256). Adopt the existing row rather than duplicating.
    const existing = await supabase
      .from('assets')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('sha256', row.sha256)
      .maybeSingle();
    if (existing.error) throw existing.error;
    assetId = existing.data?.id ?? null;
  }
  if (!assetId) throw new Error('asset row was not created');

  // Written last, so a crash anywhere above leaves the row unclaimed and the
  // next run retries it instead of skipping it.
  const mark = await supabase
    .from('funnel_assets')
    .update({ claimed_workspace_id: workspaceId, claimed_asset_id: assetId })
    .eq('id', row.id);
  if (mark.error) throw mark.error;
}

// ---------------------------------------------------------------------------
// Reap
// ---------------------------------------------------------------------------

/**
 * Deletes a dead preview's pictures, object and row.
 *
 * Called by the preview reaper alongside the artifact delete. Refuses any path
 * outside the preview's own prefix, the same way `deleteFunnelPreviewArtifact`
 * does: a delete built from a stored string is exactly the operation that must
 * not be talked into touching `tenant/`.
 */
export async function deleteFunnelAssets(input: {
  previewId: string;
  supabase?: ServiceClient;
}): Promise<{ removed: number }> {
  const supabase = input.supabase ?? createSupabaseServiceRoleClient();
  const prefix = funnelPreviewPrefix(input.previewId);
  const rows = await listFunnelAssets(input.previewId, supabase);
  const paths = rows
    .map((row) => row.storagePath)
    .filter(
      (path): path is string => Boolean(path) && path!.startsWith(prefix)
    );

  if (paths.length > 0) {
    const removed = await supabase.storage
      .from(TENANT_ASSET_BUCKET)
      .remove(paths);
    if (removed.error) throw removed.error;
  }
  const deleted = await supabase
    .from('funnel_assets')
    .delete()
    .eq('preview_id', input.previewId);
  if (deleted.error) throw deleted.error;
  return { removed: paths.length };
}

/**
 * Records that the visitor said we may publish a picture we fetched for them.
 *
 * This is the one write that turns a profile picture from "dressing the
 * preview" into "may appear on a paid site". It exists as its own function,
 * rather than a flag on the claim, because the confirmation is evidence: it
 * happens at a moment, by a person, against a statement version, and all three
 * of those have to be on the row afterwards.
 *
 * Scoped to pictures we FETCHED. A visitor tapping "use my profile picture"
 * cannot retroactively confirm rights over something else that happens to be
 * filed against the same preview, so the update names the sources it applies
 * to rather than taking whatever is there.
 */
export async function confirmFetchedPictureRights(input: {
  previewId: string;
  statementVersion: string;
  ip: string | null;
  userAgent: string | null;
  supabase?: ServiceClient;
}): Promise<{ confirmed: number }> {
  const supabase = input.supabase ?? createSupabaseServiceRoleClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('funnel_assets')
    .update({
      rights_confirmed_at: now,
      rights_statement_version: input.statementVersion,
      rights_ip: input.ip,
      rights_user_agent: input.userAgent?.slice(0, 500) ?? null,
    })
    .eq('preview_id', input.previewId)
    .in('source', FETCHED_SOURCES)
    .is('rights_confirmed_at', null)
    .select('id');
  if (error) throw error;
  return { confirmed: (data ?? []).length };
}

/** The sources that mean "we read this off a page", not "they sent it". */
const FETCHED_SOURCES = ['instagram', 'linkedin', 'github', 'og'];
