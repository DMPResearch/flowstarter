import 'server-only';

/**
 * The durable record behind an anonymous funnel preview.
 *
 * A preview used to exist only in two process-local Maps. That made the claim
 * a coin flip in any deployment with more than one worker: the visitor who
 * generated a preview on instance A and signed in against instance B got a
 * workspace with no artifacts — an owned project that can take a deposit and
 * has nothing to build from. `funnel_previews` is the truth instead; the Maps
 * stay only as a same-process fast path.
 *
 * Everything here is service-role. A funnel preview belongs to nobody yet, so
 * there is no tenant to scope a policy to: the table has RLS on with zero
 * policies, and the artifact lives under `funnel/{previewId}/` — outside the
 * `tenant/` prefix the bucket's read policy grants — precisely so that "no
 * tenant" cannot accidentally mean "everyone's".
 *
 * Nothing in this module throws at the caller. A preview that could not be
 * persisted must not cost the visitor the preview they are looking at, and a
 * preview that could not be read back must not cost them the workspace they
 * are claiming — both are degradations, and both are reported by returning
 * null/false rather than by unwinding a generation that ran for minutes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../database.types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  funnelPreviewArtifactPath,
  previewArtifactPath,
} from '@/lib/storage-paths';

/** The private bucket from 20260830140000. Same one tenant assets live in. */
export const TENANT_ASSET_BUCKET = 'tenant-assets';

/**
 * How long an unclaimed preview is hosted, in days.
 *
 * A preview is temporary by rule, not by neglect: the URL is handed out with
 * "your preview link works until <date>" printed next to it, this is the
 * number that date comes from, and `preview-reaper.ts` is what makes the
 * sentence true. Two weeks is long enough that "let me show my business
 * partner next weekend" works and short enough that we are not serving a
 * stranger's business name at a URL nobody can account for.
 *
 * `FLOWSTARTER_PREVIEW_TTL_DAYS` overrides it. Values that are not a positive
 * number are ignored rather than obeyed: a typo in an env file must not mint
 * previews that expire in the past or never.
 */
export const DEFAULT_PREVIEW_TTL_DAYS = 14;

const DAY_MS = 24 * 60 * 60_000;

export function previewTtlDays(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = Number(env.FLOWSTARTER_PREVIEW_TTL_DAYS?.trim());
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PREVIEW_TTL_DAYS;
  return raw;
}

export function previewTtlMs(
  env: Record<string, string | undefined> = process.env
): number {
  return previewTtlDays(env) * DAY_MS;
}

/** The TTL this process was started with. */
export const PREVIEW_TTL_MS = previewTtlMs();

/**
 * How long a CLAIMED preview is kept. At claim the site belongs to somebody
 * and the artifact has been copied under their tenant prefix; the funnel row
 * lives on mostly so the hosted preview URL keeps working while the real build
 * is produced.
 */
export const CLAIMED_PREVIEW_TTL_MS = 30 * DAY_MS;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FunnelPreviewDeployStatus =
  | 'pending'
  | 'live'
  | 'failed'
  | 'removed';

export interface FunnelPreviewRow {
  previewId: string;
  templateSlug: string | null;
  templateVersion: string | null;
  brandConfig: unknown;
  manifest: unknown;
  artifactPath: string | null;
  hostname: string | null;
  deployStatus: FunnelPreviewDeployStatus;
  deploymentError: string | null;
  expiresAt: string;
  claimedWorkspaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

type Client = SupabaseClient<Database>;

function client(supabase?: Client): Client {
  return supabase ?? (createSupabaseServiceRoleClient() as Client);
}

function isValidPreviewId(previewId: string): boolean {
  return typeof previewId === 'string' && UUID.test(previewId);
}

function warn(message: string, error: unknown): void {
  // Postgrest errors are plain objects with a `message`, not Errors; stringing
  // them gives "[object Object]", which is the least useful log line there is.
  const detail =
    error instanceof Error
      ? error.message
      : (error as { message?: string } | null)?.message ?? String(error);
  console.warn(`[funnel-previews] ${message}: ${detail}`);
}

interface RawRow {
  preview_id: string;
  template_slug: string | null;
  template_version: string | null;
  brand_config: Json;
  manifest: Json;
  artifact_path: string | null;
  hostname: string | null;
  deploy_status: string;
  deployment_error: string | null;
  expires_at: string;
  claimed_workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  'preview_id, template_slug, template_version, brand_config, manifest, ' +
  'artifact_path, hostname, deploy_status, deployment_error, expires_at, ' +
  'claimed_workspace_id, created_at, updated_at';

function toRow(raw: RawRow): FunnelPreviewRow {
  return {
    previewId: raw.preview_id,
    templateSlug: raw.template_slug,
    templateVersion: raw.template_version,
    brandConfig: raw.brand_config,
    manifest: raw.manifest,
    artifactPath: raw.artifact_path,
    hostname: raw.hostname,
    deployStatus: (raw.deploy_status ?? 'pending') as FunnelPreviewDeployStatus,
    deploymentError: raw.deployment_error,
    expiresAt: raw.expires_at,
    claimedWorkspaceId: raw.claimed_workspace_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export interface SaveFunnelPreviewInput {
  previewId: string;
  templateSlug?: string | null;
  templateVersion?: string | null;
  brandConfig?: unknown;
  /** The `TemplateScaffoldFile[]` a claim rebuilds from. */
  manifest?: unknown;
  artifactPath?: string | null;
  /** Defaults to now + {@link previewTtlMs}. */
  expiresAt?: Date;
  supabase?: Client;
}

/**
 * Writes (or replaces) the row for one preview. Idempotent on `preview_id`, so
 * a regenerated preview overwrites its own record rather than forking one.
 *
 * `claimed_workspace_id` is deliberately absent from the payload: a re-run of
 * the generator must never un-claim a preview somebody already owns.
 */

/**
 * Postgres jsonb rejects strings containing U+0000 ("unsupported Unicode
 * escape sequence"), and one such string anywhere in a manifest lost the whole
 * row — the preview was generated, hosted, and unclaimable. The collector now
 * base64-encodes binaries at the source; this is the guard for anything that
 * still slips through: a file whose content carries NUL is re-encoded as
 * base64 with the encoding marker, and everything else is left untouched.
 */
export function manifestSafeForJson<T>(manifest: T): {
  value: T;
  reencoded: string[];
} {
  const reencoded: string[] = [];
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      if (
        typeof rec.path === 'string' &&
        typeof rec.content === 'string' &&
        rec.content.includes('\u0000')
      ) {
        reencoded.push(rec.path);
        return {
          ...rec,
          content: Buffer.from(rec.content, 'utf8').toString('base64'),
          encoding: 'base64',
        };
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(rec)) out[key] = walk(rec[key]);
      return out;
    }
    if (typeof node === 'string' && node.includes('\u0000'))
      return node.split('\u0000').join('');
    return node;
  };
  return { value: walk(manifest) as T, reencoded };
}

export async function saveFunnelPreview(
  input: SaveFunnelPreviewInput
): Promise<boolean> {
  if (!isValidPreviewId(input.previewId)) return false;
  const expiresAt = input.expiresAt ?? new Date(Date.now() + previewTtlMs());
  const { value: safeManifest, reencoded } = manifestSafeForJson(
    input.manifest ?? {}
  );
  if (reencoded.length > 0) {
    warn(
      `re-encoded ${reencoded.length} manifest file(s) with NUL bytes as base64 for ${input.previewId}`,
      reencoded.slice(0, 5).join(', ')
    );
  }
  try {
    const { error } = await client(input.supabase)
      .from('funnel_previews')
      .upsert(
        {
          preview_id: input.previewId,
          template_slug: input.templateSlug ?? null,
          template_version: input.templateVersion ?? null,
          brand_config: (input.brandConfig ?? {}) as Json,
          manifest: safeManifest as Json,
          artifact_path: input.artifactPath ?? null,
          expires_at: expiresAt.toISOString(),
        },
        { onConflict: 'preview_id' }
      );
    if (error) {
      warn(`could not persist preview ${input.previewId}`, error);
      return false;
    }
    return true;
  } catch (error) {
    warn(`could not persist preview ${input.previewId}`, error);
    return false;
  }
}

/**
 * The row for one preview, or null when there isn't one.
 *
 * `includeExpired` is false by default: an expired preview is one whose site
 * has been (or is about to be) torn down, and handing its manifest to a claim
 * would mint a workspace pointing at a site that no longer exists.
 */
export async function loadFunnelPreview(
  previewId: string,
  opts: { includeExpired?: boolean; supabase?: Client } = {}
): Promise<FunnelPreviewRow | null> {
  if (!isValidPreviewId(previewId)) return null;
  try {
    const { data, error } = await client(opts.supabase)
      .from('funnel_previews')
      .select(COLUMNS)
      .eq('preview_id', previewId)
      .maybeSingle();
    if (error || !data) {
      if (error) warn(`could not read preview ${previewId}`, error);
      return null;
    }
    const row = toRow(data as unknown as RawRow);
    if (!opts.includeExpired && isExpired(row)) return null;
    return row;
  } catch (error) {
    warn(`could not read preview ${previewId}`, error);
    return null;
  }
}

/** Expired means "past its TTL and nobody claimed it". A claim un-expires. */
export function isExpired(row: FunnelPreviewRow, now = Date.now()): boolean {
  if (row.claimedWorkspaceId) return false;
  const expiresAt = Date.parse(row.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

/** Records what the previews deploy-agent did with this preview. */
export async function markFunnelPreviewDeployment(input: {
  previewId: string;
  hostname?: string | null;
  status: FunnelPreviewDeployStatus;
  error?: string | null;
  supabase?: Client;
}): Promise<boolean> {
  if (!isValidPreviewId(input.previewId)) return false;
  try {
    const { error } = await client(input.supabase)
      .from('funnel_previews')
      .update({
        ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
        deploy_status: input.status,
        deployment_error: input.error ?? null,
      })
      .eq('preview_id', input.previewId);
    if (error) {
      warn(`could not mark preview ${input.previewId} ${input.status}`, error);
      return false;
    }
    return true;
  } catch (error) {
    warn(`could not mark preview ${input.previewId} ${input.status}`, error);
    return false;
  }
}

/**
 * Marks the preview as owned and pushes its TTL out.
 *
 * Returns the row as it was BEFORE the claim, so the caller can see what it
 * just adopted (and, in particular, where the artifact was). Null when there
 * is no claimable row — an expired preview is not claimable, which is the
 * point: the site behind it is gone.
 */
export async function claimFunnelPreview(input: {
  previewId: string;
  workspaceId: string;
  ttlMs?: number;
  supabase?: Client;
}): Promise<FunnelPreviewRow | null> {
  const existing = await loadFunnelPreview(input.previewId, {
    supabase: input.supabase,
  });
  if (!existing) return null;
  const expiresAt = new Date(
    Date.now() + (input.ttlMs ?? CLAIMED_PREVIEW_TTL_MS)
  );
  try {
    const { error } = await client(input.supabase)
      .from('funnel_previews')
      .update({
        claimed_workspace_id: input.workspaceId,
        expires_at: expiresAt.toISOString(),
      })
      .eq('preview_id', input.previewId);
    if (error) {
      warn(`could not mark preview ${input.previewId} claimed`, error);
      return existing;
    }
  } catch (error) {
    warn(`could not mark preview ${input.previewId} claimed`, error);
  }
  return existing;
}

/** Rows whose hosted site is due for teardown. Claimed previews never match. */
export async function listExpiredFunnelPreviews(opts: {
  now?: Date;
  limit?: number;
  supabase?: Client;
}): Promise<FunnelPreviewRow[]> {
  const now = opts.now ?? new Date();
  try {
    const { data, error } = await client(opts.supabase)
      .from('funnel_previews')
      .select(COLUMNS)
      .is('claimed_workspace_id', null)
      .lte('expires_at', now.toISOString())
      .neq('deploy_status', 'removed')
      .order('expires_at', { ascending: true })
      .limit(opts.limit ?? 100);
    if (error) {
      warn('could not list expired previews', error);
      return [];
    }
    return ((data ?? []) as unknown as RawRow[]).map(toRow);
  } catch (error) {
    warn('could not list expired previews', error);
    return [];
  }
}

// ─── The artifact ──────────────────────────────────────────────────────────

function storage(supabase?: Client) {
  const c = client(supabase) as unknown as {
    storage?: {
      from(bucket: string): {
        upload(
          path: string,
          body: ArrayBuffer | Uint8Array | Buffer,
          opts?: { contentType?: string; upsert?: boolean }
        ): Promise<{ error: unknown }>;
        download(path: string): Promise<{ data: Blob | null; error: unknown }>;
        remove(paths: string[]): Promise<{ error: unknown }>;
        createSignedUrl(
          path: string,
          expiresIn: number
        ): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
      };
    };
  };
  // Not every caller has Storage wired (unit tests hand us a bare `from`
  // stub). Missing storage degrades the artifact, never the row.
  return c.storage ? c.storage.from(TENANT_ASSET_BUCKET) : null;
}

/**
 * Puts the packaged preview in the bucket under `funnel/{previewId}/`.
 * Returns the path on success, null on any failure.
 */
export async function uploadFunnelPreviewArtifact(input: {
  previewId: string;
  tarball: Uint8Array;
  supabase?: Client;
}): Promise<string | null> {
  if (!isValidPreviewId(input.previewId)) return null;
  const bucket = storage(input.supabase);
  if (!bucket) return null;
  const path = funnelPreviewArtifactPath(input.previewId);
  try {
    const { error } = await bucket.upload(path, input.tarball, {
      contentType: 'application/gzip',
      upsert: true,
    });
    if (error) {
      warn(`could not upload artifact for ${input.previewId}`, error);
      return null;
    }
    return path;
  } catch (error) {
    warn(`could not upload artifact for ${input.previewId}`, error);
    return null;
  }
}

/**
 * A short-lived signed URL the previews deploy-agent can fetch the artifact
 * from. The agent runs on a different machine and holds no Supabase
 * credentials, so this is the only way it ever sees the bytes.
 */
export async function signFunnelPreviewArtifact(input: {
  path: string;
  expiresInSeconds?: number;
  supabase?: Client;
}): Promise<string | null> {
  const bucket = storage(input.supabase);
  if (!bucket) return null;
  try {
    const { data, error } = await bucket.createSignedUrl(
      input.path,
      input.expiresInSeconds ?? 600
    );
    if (error || !data?.signedUrl) {
      if (error) warn(`could not sign ${input.path}`, error);
      return null;
    }
    return data.signedUrl;
  } catch (error) {
    warn(`could not sign ${input.path}`, error);
    return null;
  }
}

/**
 * Copies the funnel artifact under the claiming workspace's tenant prefix.
 *
 * A copy rather than a move: the hosted preview is still being served from the
 * funnel object until it is torn down, and losing it mid-claim would blank the
 * site the client is looking at while they sign in.
 */
export async function copyFunnelArtifactToTenant(input: {
  previewId: string;
  workspaceId: string;
  sourcePath: string;
  supabase?: Client;
}): Promise<string | null> {
  const bucket = storage(input.supabase);
  if (!bucket) return null;
  const target = previewArtifactPath({
    workspaceId: input.workspaceId,
    projectId: input.previewId,
  });
  try {
    const { data, error } = await bucket.download(input.sourcePath);
    if (error || !data) {
      if (error) warn(`could not read ${input.sourcePath}`, error);
      return null;
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    const { error: uploadError } = await bucket.upload(target, bytes, {
      contentType: 'application/gzip',
      upsert: true,
    });
    if (uploadError) {
      warn(`could not copy artifact to ${target}`, uploadError);
      return null;
    }
    return target;
  } catch (error) {
    warn(`could not copy artifact to ${target}`, error);
    return null;
  }
}

/**
 * Deletes the FUNNEL copy of the artifact. Never touches anything under
 * `tenant/`: a claimed preview's artifact belongs to the client who claimed
 * it, and the reaper's job is to reclaim what nobody owns.
 */
export async function deleteFunnelPreviewArtifact(input: {
  path: string;
  supabase?: Client;
}): Promise<boolean> {
  if (!input.path.startsWith('funnel/')) {
    warn(
      'refusing to delete a non-funnel artifact path',
      new Error(input.path)
    );
    return false;
  }
  const bucket = storage(input.supabase);
  if (!bucket) return false;
  try {
    const { error } = await bucket.remove([input.path]);
    if (error) {
      warn(`could not delete ${input.path}`, error);
      return false;
    }
    return true;
  } catch (error) {
    warn(`could not delete ${input.path}`, error);
    return false;
  }
}

/**
 * The guest deposit's side channel: Stripe metadata caps values at 500 chars,
 * so the info-agent conversation cannot ride the checkout session. It is
 * stashed onto the durable preview's manifest at checkout time instead, and
 * the webhook reads it back when it claims the preview for the freshly minted
 * account. A targeted read-merge-update on the one key, not the general save,
 * so a concurrent publisher write cannot be clobbered.
 */
export async function stashGuestIntakeChat(
  previewId: string,
  chat: unknown,
  supabase?: Client
): Promise<boolean> {
  if (!isValidPreviewId(previewId)) return false;
  const sb = client(supabase);
  try {
    const { data, error } = await sb
      .from('funnel_previews')
      .select('manifest')
      .eq('preview_id', previewId)
      .maybeSingle<{ manifest: Json }>();
    if (error) throw error;
    if (!data) return false;
    const manifest =
      data.manifest &&
      typeof data.manifest === 'object' &&
      !Array.isArray(data.manifest)
        ? (data.manifest as Record<string, unknown>)
        : {};
    const { error: updateError } = await sb
      .from('funnel_previews')
      .update({
        manifest: { ...manifest, guestIntakeChat: chat } as Json,
        updated_at: new Date().toISOString(),
      })
      .eq('preview_id', previewId);
    if (updateError) throw updateError;
    return true;
  } catch (error) {
    warn(`could not stash the intake chat for ${previewId}`, error);
    return false;
  }
}

/** The reader half; the consumer validates the shape before trusting it. */
export async function readGuestIntakeChat(
  previewId: string,
  supabase?: Client
): Promise<unknown> {
  if (!isValidPreviewId(previewId)) return undefined;
  const sb = client(supabase);
  try {
    const { data, error } = await sb
      .from('funnel_previews')
      .select('manifest')
      .eq('preview_id', previewId)
      .maybeSingle<{ manifest: Json }>();
    if (error) throw error;
    const manifest = data?.manifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
      return undefined;
    return (manifest as Record<string, unknown>)['guestIntakeChat'];
  } catch (error) {
    warn(`could not read the intake chat for ${previewId}`, error);
    return undefined;
  }
}
