/**
 * The operator side of change requests, once, for both `/api/admin/*` and
 * `/api/team/*` (the route files re-export these handlers).
 *
 * List what the client asked for with the rule table's suggested price;
 * write the quote the client will see; decline; mark done once the work has
 * shipped. Every move is a compare-and-set in change-requests.ts, so the
 * operator and the client cannot race a request past its payment.
 */
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireTeamAuth } from '@/lib/api-auth';
import type { Json } from '@/lib/database.types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  ChangeRequestError,
  MAX_CHANGE_QUOTE_MINOR,
  MAX_COMPLETION_REASON_CHARS,
  completeChangeRequest,
  declineChangeRequest,
  getChangeRequest,
  listChangeRequests,
  quoteChangeRequest,
  toChangeRequestView,
} from './change-requests';
import { enqueueChangeRequestBuild } from './change-request-build';
import { changeRequestAssetLabel } from './change-request-asset-label';
import { loadUsableAssets } from './generation-assets';
import { dispatchAgentJob } from './pipeline/dispatch';
import { signedAssetUrl } from '@/app/api/client/assets/asset-storage';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };
type ChangeCtx = { params: Promise<{ id: string; changeId: string }> };

function fail(message: string, code: string, status: number) {
  return NextResponse.json({ error: message, code }, { status });
}

async function operator(ctx: Ctx | ChangeCtx) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return { ok: false as const, response: auth.response };
  const params = await ctx.params;
  if (!UUID.test(params.id)) {
    return {
      ok: false as const,
      response: fail('Invalid workspace id', 'BAD_REQUEST', 400),
    };
  }
  const changeId = 'changeId' in params ? params.changeId : null;
  if (changeId !== null && !UUID.test(changeId)) {
    return {
      ok: false as const,
      response: fail('Invalid change request id', 'BAD_REQUEST', 400),
    };
  }
  return {
    ok: true as const,
    userId: auth.userId,
    workspaceId: params.id,
    changeId,
    db: createSupabaseServiceRoleClient(),
  };
}

function handle(error: unknown): NextResponse {
  if (error instanceof ChangeRequestError) {
    return fail(error.message, error.code, error.status);
  }
  console.error('[change-requests] request failed:', error);
  return fail('Could not update the change request', 'DB_ERROR', 500);
}

async function recordEvent(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  row: { workspaceId: string; kind: string; actor: string; payload: Json }
) {
  const { error } = await db.from('project_events').insert({
    workspace_id: row.workspaceId,
    kind: row.kind,
    actor: row.actor,
    payload: row.payload,
  });
  if (error)
    console.error(`[change-requests] could not write ${row.kind}:`, error);
}

// ─── GET /projects/[id]/changes ─────────────────────────────────────────────

/**
 * One of the client's pictures, as the build card's picker needs to show it.
 *
 * `loadUsableAssets` and nothing else, for the same reason the build itself
 * uses only that reader: an operator must not be able to tick a box on a file
 * whose rights the client never confirmed. `changeRequestAssetLabel` builds
 * the label from the client's own caption or filename/dimensions/date — it
 * does not even accept a storage path, so a content hash can never surface
 * here again the way it did in PR #119. `thumbnailUrl` goes through the same
 * signed-URL path the client's own asset list uses, and is null rather than
 * fatal when signing fails.
 */
export interface ChangeRequestAssetOption {
  id: string;
  label: string;
  caption: string | null;
  thumbnailUrl: string | null;
}

export async function listChangeRequestsHandler(
  _req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const op = await operator(ctx);
  if (!op.ok) return op.response;
  try {
    const [rows, usable] = await Promise.all([
      listChangeRequests(op.db, op.workspaceId),
      loadUsableAssets(op.workspaceId),
    ]);
    const assets: ChangeRequestAssetOption[] = await Promise.all(
      usable.map(async (asset) => ({
        id: asset.id,
        label: changeRequestAssetLabel({
          caption: asset.caption,
          originalName: asset.originalName,
          width: asset.width,
          height: asset.height,
          createdAt: asset.createdAt,
        }),
        caption: asset.caption?.trim() || null,
        thumbnailUrl: await signedAssetUrl(op.workspaceId, asset.storagePath),
      }))
    );
    return NextResponse.json(
      {
        requests: rows.map((row) =>
          toChangeRequestView(row, { forOperator: true })
        ),
        assets,
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return handle(error);
  }
}

// ─── POST /projects/[id]/changes/[changeId]/quote ───────────────────────────

const quoteSchema = z.object({
  amountMinor: z.number().int().min(0).max(MAX_CHANGE_QUOTE_MINOR),
  note: z.string().trim().max(1_000).optional().default(''),
});

export async function quoteChangeRequestHandler(
  req: NextRequest,
  ctx: ChangeCtx
): Promise<NextResponse> {
  const op = await operator(ctx);
  if (!op.ok) return op.response;
  const parsed = quoteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      'Send a whole amount in minor units and an optional note.',
      'INVALID_BODY',
      400
    );
  }
  try {
    const row = await getChangeRequest(op.db, op.workspaceId, op.changeId!);
    if (!row) return fail('Change request not found', 'NOT_FOUND', 404);
    const quoted = await quoteChangeRequest(op.db, row, {
      amountMinor: parsed.data.amountMinor,
      note: parsed.data.note || null,
      quotedBy: op.userId,
    });
    await recordEvent(op.db, {
      workspaceId: op.workspaceId,
      kind: 'change_request_quoted',
      actor: op.userId,
      payload: {
        changeRequestId: row.id,
        amountMinor: parsed.data.amountMinor,
        currency: row.currency,
        requoted: row.status === 'quoted',
      },
    });
    return NextResponse.json({
      request: toChangeRequestView(quoted, { forOperator: true }),
    });
  } catch (error) {
    return handle(error);
  }
}

// ─── POST /projects/[id]/changes/[changeId]/status ──────────────────────────

const statusSchema = z.object({
  status: z.enum(['declined', 'done']),
  reason: z
    .string()
    .trim()
    .max(MAX_COMPLETION_REASON_CHARS)
    .optional()
    .default(''),
});

export async function setChangeRequestStatusHandler(
  req: NextRequest,
  ctx: ChangeCtx
): Promise<NextResponse> {
  const op = await operator(ctx);
  if (!op.ok) return op.response;
  const parsed = statusSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail('status must be declined or done', 'INVALID_BODY', 400);
  try {
    const row = await getChangeRequest(op.db, op.workspaceId, op.changeId!);
    if (!row) return fail('Change request not found', 'NOT_FOUND', 404);
    const moved =
      parsed.data.status === 'done'
        ? await completeChangeRequest(op.db, row, {
            reason: parsed.data.reason,
          })
        : await declineChangeRequest(op.db, row, 'operator');
    await recordEvent(op.db, {
      workspaceId: op.workspaceId,
      kind:
        parsed.data.status === 'done'
          ? 'change_request_done'
          : 'change_request_declined',
      actor: op.userId,
      payload: {
        changeRequestId: row.id,
        by: 'operator',
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      },
    });
    return NextResponse.json({
      request: toChangeRequestView(moved, { forOperator: true }),
    });
  } catch (error) {
    return handle(error);
  }
}

// ─── POST /projects/[id]/changes/[changeId]/build — do the paid work ────────

const buildSchema = z.object({
  /** What the operator wants the agents to know beyond the client's words. */
  note: z.string().trim().max(2_000).optional().default(''),
  /**
   * The client's pictures this change should carry. Omitted means "work it
   * out": every rights-confirmed picture the request names by caption, and
   * failing that all of them.
   */
  assetIds: z.array(z.string().uuid()).max(12).optional(),
});

/**
 * Queues the build that actually does a paid change request.
 *
 * This is the button that did not exist. Both gates are read from the
 * database, never from the body: the project has to be in a state where a
 * delivered site exists (HUMAN_QA or LIVE_SUBSCRIPTION), and the request has
 * to be `paid`. A request that is merely quoted has not been bought.
 *
 * The request is not moved here. It stays `paid` for the whole of the build
 * and is moved to `done` by the worker, in the same step that records the
 * version it went live in, so a crash anywhere in between leaves the row
 * saying the true thing.
 */
export async function buildChangeRequestHandler(
  req: NextRequest,
  ctx: ChangeCtx
): Promise<NextResponse> {
  const op = await operator(ctx);
  if (!op.ok) return op.response;
  const parsed = buildSchema.safeParse(
    (await req.json().catch(() => ({}))) ?? {}
  );
  if (!parsed.success) {
    return fail(
      'Send an optional note and an optional list of your files.',
      'INVALID_BODY',
      400
    );
  }
  try {
    const row = await getChangeRequest(op.db, op.workspaceId, op.changeId!);
    if (!row) return fail('Change request not found', 'NOT_FOUND', 404);

    const { data: workspace, error: workspaceError } = await op.db
      .from('workspaces')
      .select('id, project_state')
      .eq('id', op.workspaceId)
      .maybeSingle();
    if (workspaceError) throw workspaceError;
    if (!workspace) return fail('Project not found', 'NOT_FOUND', 404);

    const queued = await enqueueChangeRequestBuild({
      supabase: op.db,
      workspaceId: op.workspaceId,
      row,
      projectState: workspace.project_state,
      operatorNote: parsed.data.note || null,
      ...(parsed.data.assetIds
        ? { selectedAssetIds: parsed.data.assetIds }
        : {}),
    });

    // The ledger row is the commitment; this is only a nudge. An unreachable
    // worker leaves a queued job an operator can re-dispatch, which is far
    // better than failing a request that is already recorded as building.
    let dispatched = false;
    try {
      await dispatchAgentJob(queued.jobId);
      dispatched = true;
    } catch (error) {
      console.warn(
        '[change-requests] could not nudge the build worker:',
        error instanceof Error ? error.message : error
      );
    }

    await recordEvent(op.db, {
      workspaceId: op.workspaceId,
      kind: 'change_request_build_queued',
      actor: op.userId,
      payload: {
        changeRequestId: row.id,
        jobId: queued.jobId,
        created: queued.created,
        dispatched,
        seedVersion: queued.seedVersion,
        assets: queued.assets.map((asset) => asset.assetId),
      },
    });

    const refreshed = await getChangeRequest(op.db, op.workspaceId, row.id);
    return NextResponse.json({
      jobId: queued.jobId,
      created: queued.created,
      dispatched,
      seedVersion: queued.seedVersion,
      assets: queued.assets,
      request: toChangeRequestView(refreshed ?? row, { forOperator: true }),
    });
  } catch (error) {
    return handle(error);
  }
}
