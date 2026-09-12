import 'server-only';

/**
 * The only part of the portrait pipeline that writes.
 *
 * `portrait-config.ts` holds the numbers, `portrait-source.ts` holds the rule
 * that judges a picture, `portrait-connect.ts` holds the round trip to the
 * provider. None of them touch a table. The rule decided; this files the
 * result: one row in `portrait_connections` saying who authorised us, and one
 * picture, either against the anonymous funnel preview or against the
 * workspace that has already claimed it.
 *
 * RIGHTS, which is the load-bearing difference between this file and
 * `profile-picture.ts`. That module fetches a picture off a public page and
 * files it with `rights_confirmed_at` NULL, because reading somebody's
 * OpenGraph tag is not the same as them handing us a photograph. A CONNECT
 * FLOW IS THE OPPOSITE CASE. The person went to LinkedIn or to Instagram, saw
 * in the provider's own words what we were asking for, and approved it. That
 * is the consent, and asking a second time on the brief would be asking a
 * question they have already answered, so a connect flow writes the
 * confirmation itself. The three automatic sources still write nothing and
 * still wait for the client to tap "Use this".
 *
 * NEVER THROWS. Every failure is a `skipped` with a reason from a closed set,
 * because a portrait we could not get is a preview that looks less like the
 * client, not a broken funnel. The reasons are codes rather than sentences:
 * the words live in `src/locales/en.ts`, where somebody who is not a
 * programmer can change them.
 *
 * THE CONNECTION ROW IS WRITTEN FIRST, before a single byte is downloaded. A
 * provider that turns out to have no picture at all, or a CDN that refuses us,
 * still leaves a record that this person connected this account to this
 * preview, which is the fact the intake and the brief need in order to say
 * anything true about what happened.
 */
import { createHash } from 'node:crypto';

import { probeImageSize } from '@flowstarter/agentic-codegen/src/flowstarter/preview-assets';
import { assertSafeUploadedImage } from '@flowstarter/agentic-codegen/src/flowstarter/site-media';
import type { SupabaseClient } from '@supabase/supabase-js';

import { CURRENT_RIGHTS_STATEMENT_VERSION } from '@/components/flowstarter/rights-statement';
import type { Database } from '@/lib/database.types';
import { assertTenantPath, assetObjectPath } from '@/lib/storage-paths';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

import { TENANT_ASSET_BUCKET, storeFunnelAsset } from './funnel-assets';
import {
  type EnvLike,
  type PortraitProvider,
  isPortraitProvider,
  portraitBudgets,
  portraitSizeFloors,
} from './portrait-config';
import type { PortraitProfile } from './portrait-connect';
import {
  type PortraitPlacement,
  type PortraitSizeVerdict,
  isFetchablePictureUrl,
  longEdgeOf,
  placementsFor,
  sizeVerdictFor,
} from './portrait-source';

type ServiceClient = SupabaseClient<Database>;

/** Postgres unique violation: somebody raced us to the same row. */
const UNIQUE_VIOLATION = '23505';

/**
 * Content types, derived from the verified bytes and never from a header. The
 * validator answers with an extension and nothing else, so the mime is
 * computed here rather than read off a response a CDN wrote.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * What the size verdict makes the picture fit for, in the `usable_for`
 * vocabulary the generator reads.
 *
 * A portrait-sized picture may be placed in a section or used as the about
 * portrait. An avatar-sized one may only be the small round byline, and it is
 * never given a role that would let something scale it up. The two empty
 * verdicts cannot reach a stored row at all, and are here so the map is total
 * rather than because they are paths.
 */
const USABLE_FOR_BY_VERDICT: Record<PortraitSizeVerdict, readonly string[]> = {
  portrait: ['section', 'portrait'],
  avatar: ['avatar'],
  too_small: [],
  unknown: [],
};

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

/**
 * Why a capture filed no picture. A closed set, because each member becomes a
 * sentence the client reads about their own photograph, and two reasons that
 * read the same are two reasons nobody can act on differently.
 */
export type PortraitCaptureFailure =
  | 'not_public_url'
  | 'unreadable'
  | 'too_large'
  | 'not_an_image'
  | 'below_avatar_floor'
  | 'store_failed';

export interface CapturedPortrait {
  connectionId: string;
  funnelAssetId: string | null;
  assetId: string | null;
  width: number | null;
  height: number | null;
  /** From portrait-source.ts `sizeVerdictFor`. */
  verdict: PortraitSizeVerdict;
  placements: readonly PortraitPlacement[];
}

export type PortraitCaptureOutcome =
  | { status: 'captured'; portrait: CapturedPortrait }
  | { status: 'skipped'; reason: PortraitCaptureFailure };

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

type DownloadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: PortraitCaptureFailure };

/**
 * The bytes behind a provider's picture URL, under a timeout and a cap.
 *
 * The declared length and the real one are both checked: a content-length
 * header is a claim, and a body that keeps arriving after the claim ran out is
 * exactly the shape of a download nobody meant to accept.
 */
async function downloadPicture(input: {
  url: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
}): Promise<DownloadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'image/*' },
    });
    if (!response.ok) return { ok: false, reason: 'unreadable' };
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > input.maxBytes) return { ok: false, reason: 'too_large' };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > input.maxBytes) {
      return { ok: false, reason: 'too_large' };
    }
    return { ok: true, bytes };
  } catch {
    // A timeout, a DNS failure, a socket hang up. All the same answer: we do
    // not have the picture, and the funnel carries on without it.
    return { ok: false, reason: 'unreadable' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The connection row
// ---------------------------------------------------------------------------

interface ConnectionKey {
  connectionId: string;
  provider: PortraitProvider;
  accountId: string;
  previewId: string | null;
  workspaceId: string | null;
}

/**
 * Finds the connection for one account, in whichever half of the pipeline the
 * caller is in.
 *
 * The table's two unique indexes are partial, on (preview_id, provider,
 * provider_account_id) and on (workspace_id, provider, provider_account_id),
 * because exactly one of the two keys is set on any given row. supabase-js
 * `upsert` has no way to name a partial index, so the read and the write are
 * separate statements here and the race is handled where it actually happens,
 * on the insert.
 */
async function findConnection(
  supabase: ServiceClient,
  key: ConnectionKey
): Promise<string | null> {
  let query = supabase
    .from('portrait_connections')
    .select('id')
    .eq('provider', key.provider)
    .eq('provider_account_id', key.accountId);
  if (key.previewId) {
    query = query.eq('preview_id', key.previewId);
  } else if (key.workspaceId) {
    query = query.eq('workspace_id', key.workspaceId);
  } else {
    // Neither key: a connection that belongs to nothing yet, which is only
    // ever addressed by the id the signed state minted for it.
    query = query.eq('id', key.connectionId);
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * Records that this person connected this account, whatever happens to the
 * picture afterwards.
 *
 * Returns the id of the row that now holds them, which is the minted one for a
 * first connection and the existing one for a reconnect: a person who connects
 * twice is one person, and two rows disagreeing about them would be a table
 * nobody could read an answer out of.
 */
async function upsertConnection(
  supabase: ServiceClient,
  input: { key: ConnectionKey; profile: PortraitProfile }
): Promise<string> {
  const { key, profile } = input;
  const details = {
    display_name: profile.name || null,
    headline: profile.headline || null,
    picture_url: profile.pictureUrl || null,
  };

  const existing = await findConnection(supabase, key);
  if (existing) {
    const updated = await supabase
      .from('portrait_connections')
      .update(details)
      .eq('id', existing);
    if (updated.error) throw updated.error;
    return existing;
  }

  const inserted = await supabase
    .from('portrait_connections')
    .insert({
      id: key.connectionId,
      provider: key.provider,
      provider_account_id: key.accountId,
      preview_id: key.previewId,
      workspace_id: key.workspaceId,
      ...details,
    })
    .select('id')
    .single();
  if (!inserted.error && inserted.data) return inserted.data.id;

  if ((inserted.error as { code?: string } | null)?.code !== UNIQUE_VIOLATION) {
    throw inserted.error;
  }
  // Somebody raced us: two tabs, or a provider that delivered the callback
  // twice. Re-read rather than insert a second row for one person.
  const raced = await findConnection(supabase, key);
  if (!raced) throw new Error('portrait connection was not recorded');
  return raced;
}

// ---------------------------------------------------------------------------
// The picture
// ---------------------------------------------------------------------------

interface StoredPicture {
  bytes: Buffer;
  extension: string;
  mime: string;
  sha256: string;
  width: number | null;
  height: number | null;
  usableFor: readonly string[];
  sourceUrl: string;
  fetchedAt: string;
}

/**
 * Writes the object into the workspace's own prefix and records the asset.
 *
 * The same shape `claimFunnelAssets` uses, and for the same reasons: the path
 * is content addressed so a retry cannot fork an object away from its row, it
 * is re-asserted against the workspace immediately before the storage call,
 * and a 23505 on (workspace_id, sha256) means the workspace already holds this
 * exact file, which is a successful no-op rather than an error.
 */
async function storeWorkspacePortrait(
  supabase: ServiceClient,
  input: {
    workspaceId: string;
    provider: PortraitProvider;
    picture: StoredPicture;
    now: string;
  }
): Promise<string> {
  const { workspaceId, picture } = input;
  const destination = assetObjectPath({
    workspaceId,
    sha256: picture.sha256,
    extension: picture.extension,
  });
  // Belt and braces: the path was built from a validated workspace id a line
  // ago, and this is the check that runs immediately before every storage call
  // in the tenant half of the app.
  assertTenantPath(destination, workspaceId);

  const upload = await supabase.storage
    .from(TENANT_ASSET_BUCKET)
    .upload(destination, picture.bytes, {
      contentType: picture.mime,
      upsert: true,
    });
  if (upload.error) throw upload.error;

  const insert = await supabase
    .from('assets')
    .insert({
      workspace_id: workspaceId,
      source: input.provider,
      kind: 'portrait',
      storage_path: destination,
      sha256: picture.sha256,
      mime: picture.mime,
      width: picture.width,
      height: picture.height,
      usable_for: [...picture.usableFor],
      source_url: picture.sourceUrl,
      fetched_at: picture.fetchedAt,
      // The connect action is the consent. See the module header.
      rights_confirmed_at: input.now,
      selected: true,
    })
    .select('id')
    .single();

  let assetId = insert.data?.id ?? null;
  if (insert.error) {
    if ((insert.error as { code?: string }).code !== UNIQUE_VIOLATION) {
      throw insert.error;
    }
    const already = await supabase
      .from('assets')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('sha256', picture.sha256)
      .maybeSingle();
    if (already.error) throw already.error;
    assetId = already.data?.id ?? null;
  }
  if (!assetId) throw new Error('asset row was not created');
  return assetId;
}

// ---------------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------------

/**
 * One provider's answer, filed.
 *
 * The connection row goes down first, then the bytes are fetched, verified,
 * measured and judged, and only a picture that cleared the avatar floor is
 * stored. A picture below that floor is not filed at all: it is too small for
 * the one slot it could have had, and the alternative is upscaling it, which
 * on a paid site reads as a mistake rather than as a photograph.
 */
export async function capturePortraitFromProvider(input: {
  connectionId: string;
  profile: PortraitProfile;
  previewId: string | null;
  workspaceId: string | null;
  fetchImpl?: typeof fetch;
  supabase?: ServiceClient;
  env?: EnvLike;
  now?: Date;
}): Promise<PortraitCaptureOutcome> {
  const supabase = input.supabase ?? createSupabaseServiceRoleClient();
  const env = input.env ?? process.env;
  const fetchedAt = (input.now ?? new Date()).toISOString();
  const profile = input.profile;
  const floors = portraitSizeFloors(env);
  const budgets = portraitBudgets(env);

  let connectionId: string;
  try {
    connectionId = await upsertConnection(supabase, {
      key: {
        connectionId: input.connectionId,
        provider: profile.provider,
        accountId: profile.accountId,
        previewId: input.previewId,
        workspaceId: input.workspaceId,
      },
      profile,
    });
  } catch {
    return { status: 'skipped', reason: 'store_failed' };
  }

  // An account with no picture, or one behind a URL we are not willing to
  // request, is still a connection worth having: the name and the headline are
  // the client's own prose about themselves and the brief can use both.
  if (!profile.pictureUrl || !isFetchablePictureUrl(profile.pictureUrl)) {
    return { status: 'skipped', reason: 'not_public_url' };
  }

  const download = await downloadPicture({
    url: profile.pictureUrl,
    fetchImpl: input.fetchImpl ?? fetch,
    timeoutMs: budgets.providerTimeoutMs,
    maxBytes: budgets.maxBytes,
  });
  if (!download.ok) return { status: 'skipped', reason: download.reason };
  const bytes = download.bytes;

  // Magic bytes, not the content type: a provider's CDN is not a trusted
  // source of image bytes, and nothing that arrives over the wire is. The
  // floor passed is our own avatar floor, because a hundred-pixel Instagram
  // portrait is exactly the picture this feature exists to file.
  let extension: string;
  try {
    ({ extension } = assertSafeUploadedImage(bytes, {
      minEdge: floors.avatarEdge,
    }));
  } catch {
    return { status: 'skipped', reason: 'not_an_image' };
  }

  const size = probeImageSize(bytes);
  const width = size?.width ?? null;
  const height = size?.height ?? null;
  const verdict = sizeVerdictFor(
    longEdgeOf({ url: profile.pictureUrl, width, height }),
    floors
  );
  if (verdict === 'too_small' || verdict === 'unknown') {
    // Measured, and too small for even a byline avatar, or never measured at
    // all. Either way it is a picture we have no honest use for, so the
    // connection stands and the file does not.
    return { status: 'skipped', reason: 'below_avatar_floor' };
  }

  const picture: StoredPicture = {
    bytes,
    extension,
    mime: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width,
    height,
    usableFor: USABLE_FOR_BY_VERDICT[verdict],
    sourceUrl: profile.pictureUrl,
    fetchedAt,
  };

  let funnelAssetId: string | null = null;
  let assetId: string | null = null;
  try {
    if (input.previewId) {
      const stored = await storeFunnelAsset({
        previewId: input.previewId,
        file: {
          bytes: picture.bytes,
          extension: picture.extension,
          mime: picture.mime,
          sha256: picture.sha256,
          width: picture.width,
          height: picture.height,
        },
        kind: 'photo',
        source: profile.provider,
        usableFor: picture.usableFor,
        provenance: {
          sourceUrl: picture.sourceUrl,
          fetchedAt: picture.fetchedAt,
        },
        // Confirmed, unlike every other fetched picture in the funnel. The
        // connect action IS the consent: the person went to the provider, saw
        // what we were asking for, and authorised it there.
        rights: {
          confirmed: true,
          statementVersion: CURRENT_RIGHTS_STATEMENT_VERSION,
          ip: null,
          userAgent: null,
        },
        supabase,
      });
      funnelAssetId = stored.id;
    } else if (input.workspaceId) {
      assetId = await storeWorkspacePortrait(supabase, {
        workspaceId: input.workspaceId,
        provider: profile.provider,
        picture,
        now: fetchedAt,
      });
    }

    const marked = await supabase
      .from('portrait_connections')
      .update({
        funnel_asset_id: funnelAssetId,
        asset_id: assetId,
        picture_width: picture.width,
        picture_height: picture.height,
        fetched_at: picture.fetchedAt,
        rights_confirmed_at: fetchedAt,
        rights_statement_version: CURRENT_RIGHTS_STATEMENT_VERSION,
      })
      .eq('id', connectionId);
    if (marked.error) throw marked.error;
  } catch {
    return { status: 'skipped', reason: 'store_failed' };
  }

  return {
    status: 'captured',
    portrait: {
      connectionId,
      funnelAssetId,
      assetId,
      width: picture.width,
      height: picture.height,
      verdict,
      placements: placementsFor(verdict),
    },
  };
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

/** What the intake and the brief read back. */
export interface PortraitConnectionView {
  id: string;
  provider: 'linkedin' | 'instagram';
  displayName: string | null;
  headline: string | null;
  width: number | null;
  height: number | null;
  rightsConfirmedAt: string | null;
  funnelAssetId: string | null;
  assetId: string | null;
}

const CONNECTION_COLUMNS =
  'id, provider, display_name, headline, picture_width, picture_height, rights_confirmed_at, funnel_asset_id, asset_id';

interface RawConnection {
  id: string;
  provider: string;
  display_name: string | null;
  headline: string | null;
  picture_width: number | null;
  picture_height: number | null;
  rights_confirmed_at: string | null;
  funnel_asset_id: string | null;
  asset_id: string | null;
}

function toView(raw: RawConnection): PortraitConnectionView {
  return {
    id: raw.id,
    // The check constraint allows exactly the two connect providers, so this
    // is a narrowing rather than a decision. An unrecognised value is not
    // reported as one of the two.
    provider: isPortraitProvider(raw.provider) ? raw.provider : 'linkedin',
    displayName: raw.display_name,
    headline: raw.headline,
    width: raw.picture_width,
    height: raw.picture_height,
    rightsConfirmedAt: raw.rights_confirmed_at,
    funnelAssetId: raw.funnel_asset_id,
    assetId: raw.asset_id,
  };
}

/**
 * Every connection held for one preview or one workspace, oldest first.
 *
 * Answers with an empty list rather than throwing, and for the same reason the
 * capture never throws: a connection we cannot read is a page with one fewer
 * thing on it, and the intake still has a form to render.
 */
export async function loadPortraitConnections(input: {
  previewId?: string | null;
  workspaceId?: string | null;
  supabase?: ServiceClient;
}): Promise<PortraitConnectionView[]> {
  if (!input.previewId && !input.workspaceId) return [];
  const supabase = input.supabase ?? createSupabaseServiceRoleClient();
  const base = supabase.from('portrait_connections').select(CONNECTION_COLUMNS);
  const filtered = input.previewId
    ? base.eq('preview_id', input.previewId)
    : base.eq('workspace_id', input.workspaceId as string);
  const { data, error } = await filtered.order('created_at', {
    ascending: true,
  });
  if (error) return [];
  return ((data ?? []) as unknown as RawConnection[]).map(toView);
}
