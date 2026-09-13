/**
 * POST /api/admin/hosting/previews/reap — tear down expired funnel previews.
 *
 * The reaper is meant to run on a schedule (`PREVIEW_REAP` in the job ledger).
 * This is the operator's hand on the same lever: when previews are piling up on
 * a host, or a sweep needs to be forced before a maintenance window, an
 * operator can run it and see exactly what came down.
 *
 * Team-only. Reaping is destructive to a hosted site, and the previews it
 * touches belong to visitors who have no account and cannot be asked.
 *
 * GET is the same query without the teardown: what WOULD be reaped right now.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireTeamAuth } from '@/lib/api-auth';
import { listExpiredFunnelPreviews } from '@/lib/hosting/funnel-previews';
import { reapExpiredPreviews } from '@/lib/hosting/preview-reaper';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One sweep should finish inside an operator's patience, not a cron's. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function limitFrom(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export async function GET(req: NextRequest) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const limit = limitFrom(req.nextUrl.searchParams.get('limit'));
  const due = await listExpiredFunnelPreviews({ limit });
  return NextResponse.json({
    due: due.length,
    previews: due.map((row) => ({
      previewId: row.previewId,
      hostname: row.hostname,
      deployStatus: row.deployStatus,
      expiresAt: row.expiresAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const result = await reapExpiredPreviews({ limit: limitFrom(body.limit) });

  // `dryRun` is surfaced rather than hidden: when the previews agent is not
  // configured nothing was actually removed on any host, and an operator who
  // read "reaped: 12" without it would believe otherwise.
  return NextResponse.json({
    considered: result.considered,
    reaped: result.reaped,
    skippedClaimed: result.skippedClaimed,
    failed: result.failed,
    dryRun: result.dryRun,
    previews: result.previews,
    uploadSessions: result.uploadSessions,
  });
}
