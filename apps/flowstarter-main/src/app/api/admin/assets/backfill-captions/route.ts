import 'server-only';
/**
 * POST /api/admin/assets/backfill-captions — the one-off sweep for every
 * asset that predates auto-captioning.
 *
 * `storeUpload` (src/app/api/client/assets/asset-storage.ts) captions every
 * upload the moment it arrives, but that is only true from the moment it
 * shipped. Everything a client sent before then still has `caption is
 * null`, and stays that way until something runs the same bounded vision
 * call over it after the fact. This route is that something, and it is
 * deliberately NOT wired into any deploy step, cron, or migration: sweeping
 * a workspace's whole asset history through a paid model is an operator's
 * call to make once, reviewed, not something that fires itself.
 *
 * IMPORTANT — this route has never been invoked against a real stack. It
 * shipped alongside the migration that added `caption_source`/`auto_caption`
 * to `public.assets`, as the documented, reviewed way to run the backfill —
 * not as a step this change request itself performed. An operator triggers
 * it deliberately, from an admin surface or a direct authenticated request,
 * against whichever stack (dev, staging, or — with real budget awareness —
 * production) they have decided is ready for it.
 *
 * One request handles one bounded page (`limit`, capped at
 * `MAX_BATCH_LIMIT`) rather than the whole table, both because a route
 * handler has a wall-clock budget (`maxDuration` below) that a full sweep of
 * a large table could exceed, and because a bounded, reviewable page is
 * easier for an operator to sanity-check than a response that silently ran
 * for an hour. `hasMore` says whether another call would find more work; an
 * operator (or a short script that only ever calls THIS route, never the
 * server-only modules underneath it directly) loops on it.
 *
 * Calls are made one at a time, not in parallel, for the same reason
 * `asset-caption.ts` bounds a single call: a burst of concurrent vision
 * calls is not something to trade for a shorter response when nobody is
 * waiting on this response the way a client waits on an upload.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireTeamAuth } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { autoCaptionAsset, type AutoCaption } from '@/lib/ai/asset-caption';
import { TENANT_ASSET_BUCKET } from '@/app/api/client/assets/asset-storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** One page of sequential vision calls; generous against a serverless ceiling. */
export const maxDuration = 300;

/** Default page size when the caller does not ask for a specific one. */
const DEFAULT_BATCH_LIMIT = 25;
/** However badly a caller misconfigures `limit`, one request stays bounded. */
const MAX_BATCH_LIMIT = 100;

interface BackfillRow {
  id: string;
  workspace_id: string;
  storage_path: string | null;
  mime: string | null;
  sha256: string | null;
}

interface BackfillSummary {
  scanned: number;
  captioned: number;
  reusedFromCache: number;
  failed: number;
  skippedNoBytes: number;
  hasMore: boolean;
}

function clampedLimit(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : DEFAULT_BATCH_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH_LIMIT;
  return Math.min(n, MAX_BATCH_LIMIT);
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  let body: { workspaceId?: unknown; dryRun?: unknown; limit?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const workspaceId =
    typeof body.workspaceId === 'string' && UUID.test(body.workspaceId)
      ? body.workspaceId
      : null;
  const dryRun = body.dryRun === true;
  const limit = clampedLimit(body.limit);

  try {
    const summary = await backfillOnePage({ workspaceId, dryRun, limit });
    return NextResponse.json({ summary });
  } catch (error) {
    console.error('[admin/assets/backfill-captions] failed', error);
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }
}

/**
 * The same content-hash cache `storeUpload` checks on every new upload,
 * read here from the table itself rather than accumulated request-to-request:
 * this route has no memory between calls, so a cache hit only exists when an
 * earlier row (this page or a previous one, this run or an earlier one) has
 * already written its `auto_caption` back to the table.
 */
async function findCachedAutoCaption(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  sha256: string
): Promise<AutoCaption | null> {
  const { data, error } = (await supabase
    .from('assets')
    .select('auto_caption')
    .eq('sha256', sha256)
    .not('auto_caption', 'is', null)
    .limit(1)) as {
    data: Array<{ auto_caption: AutoCaption | null }> | null;
    error: unknown;
  };
  if (error || !data || data.length === 0) return null;
  return data[0]?.auto_caption ?? null;
}

async function backfillOnePage(options: {
  workspaceId: string | null;
  dryRun: boolean;
  limit: number;
}): Promise<BackfillSummary> {
  const supabase = createSupabaseServiceRoleClient();
  const summary: BackfillSummary = {
    scanned: 0,
    captioned: 0,
    reusedFromCache: 0,
    failed: 0,
    skippedNoBytes: 0,
    hasMore: false,
  };

  // One extra row than the page asks for, so a full page's presence of an
  // (options.limit + 1)th candidate is exactly what `hasMore` reports —
  // never a guess based on whether the page happened to be full.
  let query = supabase
    .from('assets')
    .select('id, workspace_id, storage_path, mime, sha256')
    .is('caption', null)
    .not('storage_path', 'is', null)
    .order('created_at', { ascending: true })
    .limit(options.limit + 1);
  if (options.workspaceId)
    query = query.eq('workspace_id', options.workspaceId);

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as BackfillRow[];
  summary.hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit);

  for (const row of page) {
    summary.scanned += 1;
    const outcome = await captionOne(supabase, row, options.dryRun);
    if (outcome === 'captioned') summary.captioned += 1;
    else if (outcome === 'cached') summary.reusedFromCache += 1;
    else if (outcome === 'no_bytes' || outcome === 'no_caption')
      summary.skippedNoBytes += 1;
    else summary.failed += 1;
  }

  return summary;
}

type Outcome = 'captioned' | 'cached' | 'no_bytes' | 'no_caption' | 'failed';

async function captionOne(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  row: BackfillRow,
  dryRun: boolean
): Promise<Outcome> {
  if (!row.storage_path) return 'no_bytes';

  const cached = row.sha256
    ? await findCachedAutoCaption(supabase, row.sha256)
    : null;
  let auto = cached;

  if (!auto) {
    const { data, error } = await supabase.storage
      .from(TENANT_ASSET_BUCKET)
      .download(row.storage_path);
    if (error || !data) {
      console.warn(
        `[admin/assets/backfill-captions] could not read bytes for ${row.id}`,
        error
      );
      return 'no_bytes';
    }
    const bytes = Buffer.from(await data.arrayBuffer());
    // Fail-closed exactly as the live upload path does: a caption nobody
    // could produce stays absent, not guessed at a second way here.
    auto = await autoCaptionAsset({
      bytes,
      mime: row.mime ?? 'image/jpeg',
      workspaceId: row.workspace_id,
    });
    if (!auto) return 'no_caption';
  }

  if (dryRun) return cached ? 'cached' : 'captioned';

  const { error: updateError } = await supabase
    .from('assets')
    .update({
      caption: auto.subject,
      caption_source: 'auto',
      auto_caption: auto,
    })
    .eq('id', row.id);
  if (updateError) {
    console.error(
      `[admin/assets/backfill-captions] could not write caption for ${row.id}`,
      updateError
    );
    return 'failed';
  }
  return cached ? 'cached' : 'captioned';
}
