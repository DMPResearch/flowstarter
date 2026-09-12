/**
 * Telling a client, once, that their build is waiting on them.
 *
 * The deposit enqueues a FULL_SITE_BUILD and the worker will not start it
 * until the in-depth brief is ready (see `claim()` in
 * `apps/build-worker/src/job-store.ts`). That is the right gate and it has one
 * failure mode: a client who paid, closed the tab, and never came back sits
 * behind a queued job forever while nobody says anything. This module is the
 * one thing that says something.
 *
 * WHAT IS DELIBERATELY NOT HERE: a scheduler. Nothing calls either function
 * below on a timer yet, and that is a decision rather than an omission. This
 * repo already has the precedent: `PREVIEW_REAP` is a job kind with a label on
 * the operator board, a route that runs it, and nothing enqueuing it, because
 * the rule was worth getting right before the cron was worth wiring. Same
 * here. Scheduling means deciding where the timer lives (a Vercel cron, a
 * ledger job kind the dispatcher polls, or a call at the end of the deposit
 * webhook with a delay), and each of those is a separate change with its own
 * failure modes. What this module guarantees in the meantime is that whatever
 * eventually schedules it has exactly one call to make, needs no state of its
 * own, and cannot send a client two copies of anything.
 *
 * The decisions are not made here either. `evaluateBriefReadiness` and
 * `briefReminderDue` in `brief-readiness.ts` are pure rules with no clock and
 * no I/O; this module reads rows, hands them over, and does what it is told.
 * Rules decide, and nothing here phrases anything a model wrote.
 *
 * Never throws, matching `notifyClientOnce`'s contract, so a caller inside a
 * webhook or a cron handler can await it without a guard.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import type { Database } from '@/lib/database.types';
import { briefIncompleteEmail } from '@/lib/email-templates/client-notices';
import { withTenant } from '@/lib/tenancy';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  briefReminderDue,
  evaluateBriefReadiness,
  type BriefInput,
  type BriefPhotoInput,
  type BriefProjectInput,
} from './brief-readiness';
import { notifyClientOnce } from './client-notifications';

type SupabaseServiceClient = SupabaseClient<Database>;

export interface BriefReminderResult {
  sent: boolean;
  /**
   * Why not, when nothing was sent. `brief_ready`, `too_soon` and `overridden`
   * come from the rule; the rest are this module's own, and every one of them
   * is a reason an operator might have to read out of a log.
   */
  reason?:
    | 'brief_ready'
    | 'too_soon'
    | 'overridden'
    | 'workspace_missing'
    | 'not_waiting'
    | 'lookup_failed'
    | 'already_sent'
    | 'no_recipient'
    | 'send_failed';
}

/** How many workspaces one sweep will look at. Bounded, like every board query. */
const SWEEP_LIMIT = 200;

/** The columns the decision is made from. */
const WORKSPACE_COLUMNS = 'id, deposit_paid_at, project_state';
const BRIEF_COLUMNS =
  'offer, projects, no_projects, design_reference_asset_ids, photo_asset_ids, ' +
  'ready_at, override_at';
const ASSET_COLUMNS = 'id, kind, width, height, rights_confirmed_at';

interface WorkspaceRow {
  id: string;
  deposit_paid_at: string | null;
  project_state: string | null;
}

interface BriefRow {
  offer: string | null;
  projects: unknown;
  no_projects: boolean | null;
  design_reference_asset_ids: string[] | null;
  photo_asset_ids: string[] | null;
  ready_at: string | null;
  override_at: string | null;
}

interface AssetRow {
  id: string;
  kind: string | null;
  width: number | null;
  height: number | null;
  rights_confirmed_at: string | null;
}

/**
 * `projects` is a jsonb column, so what comes back is whatever went in. Read
 * defensively for the same reason the brief route does: a row written by an
 * earlier shape, or by an operator with psql, must produce a verdict rather
 * than an exception inside a scheduled sweep.
 */
function storedProjects(value: unknown): BriefProjectInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return [
      {
        name: typeof record.name === 'string' ? record.name : '',
        line: typeof record.line === 'string' ? record.line : '',
        link: typeof record.link === 'string' ? record.link : '',
        screenshotAssetIds: Array.isArray(record.screenshotAssetIds)
          ? record.screenshotAssetIds.filter(
              (id): id is string => typeof id === 'string'
            )
          : [],
      },
    ];
  });
}

/**
 * The photographs the brief names, in the shape the rule reads.
 *
 * Same construction as `/api/client/brief/[workspaceId]`, and it has to stay
 * the same: a reminder that judged readiness differently from the page the
 * client is looking at would tell somebody they are missing a thing their own
 * dashboard shows as done.
 */
function photosFor(
  photoAssetIds: string[],
  assets: AssetRow[]
): BriefPhotoInput[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return photoAssetIds.flatMap((id) => {
    const asset = byId.get(id);
    if (!asset) return [];
    return [
      {
        assetId: asset.id,
        kind: asset.kind,
        width: asset.width,
        height: asset.height,
        // An unconfirmed photograph is a file we hold, not one we may publish.
        rightsConfirmed: Boolean(asset.rights_confirmed_at),
      },
    ];
  });
}

/** The brief as the rule wants it, from the row and the workspace's files. */
function briefInputFrom(row: BriefRow | null, assets: AssetRow[]): BriefInput {
  if (!row) {
    // No row at all: the client has not opened the page. Everything blocking
    // is outstanding, which is exactly what an empty brief evaluates to.
    return { offer: '', projects: [], noProjects: false };
  }
  return {
    offer: row.offer ?? '',
    projects: storedProjects(row.projects),
    noProjects: Boolean(row.no_projects),
    designReferenceAssetIds: row.design_reference_asset_ids ?? [],
    photos: photosFor(row.photo_asset_ids ?? [], assets),
  };
}

/**
 * Nudges one client if, and only if, the rule says so.
 *
 * `now` is injected rather than read from the clock so the whole decision is
 * testable and so a sweep judges every workspace against one instant instead
 * of drifting a few milliseconds down the list.
 */
export async function remindIfBriefIncomplete(input: {
  workspaceId: string;
  now?: Date;
  supabase?: SupabaseServiceClient;
}): Promise<BriefReminderResult> {
  const { workspaceId } = input;
  const now = input.now ?? new Date();
  try {
    const supabase = input.supabase ?? createSupabaseServiceRoleClient();

    const { data: workspace, error: workspaceError } = await supabase
      .from('workspaces')
      .select(WORKSPACE_COLUMNS)
      .eq('id', workspaceId)
      .maybeSingle<WorkspaceRow>();
    if (workspaceError) throw workspaceError;
    if (!workspace) {
      console.warn(
        `[brief-reminder] workspace ${workspaceId} no longer exists`
      );
      return { sent: false, reason: 'workspace_missing' };
    }

    // Only a project actually sitting behind the gate is waiting on anybody.
    // A build that is already running, in QA or live got past the brief one
    // way or another, and a "we are waiting on you" email about a site that is
    // being built is worse than silence.
    if (workspace.project_state !== ProjectState.DEPOSIT_PAID) {
      return { sent: false, reason: 'not_waiting' };
    }

    const tenant = withTenant(supabase, workspaceId);
    const { data: brief, error: briefError } = await tenant
      .from('workspace_briefs')
      .select(BRIEF_COLUMNS)
      .maybeSingle<BriefRow>();
    if (briefError) throw briefError;

    const { data: assetRows, error: assetError } = await tenant
      .from('assets')
      .select(ASSET_COLUMNS);
    if (assetError) throw assetError;

    const readiness = evaluateBriefReadiness(
      briefInputFrom(brief ?? null, (assetRows ?? []) as unknown as AssetRow[])
    );
    const verdict = briefReminderDue({
      readiness,
      depositPaidAt: workspace.deposit_paid_at,
      overrideAt: brief?.override_at ?? null,
      now,
    });
    if (!verdict.send) return { sent: false, reason: verdict.reason };

    const result = await notifyClientOnce({
      supabase,
      workspaceId,
      notification: 'brief_incomplete',
      render: (client) =>
        briefIncompleteEmail({
          // The brief lives one level under the client's own project page.
          briefUrl: `${client.dashboardUrl}/brief`,
          // The blocking asks only. The rule already filtered the list, and
          // an email that also asked for the nice-to-haves would read as a
          // longer job than it is, which is how a client puts it off.
          missing: verdict.missing.map((entry) => entry.message),
          clientName: client.clientName,
          businessName: client.businessName,
        }),
      // Codes, not the client's own words about their business.
      detail: {
        missing: verdict.missing.map((entry) => entry.code),
        completeness: readiness.completeness,
      },
    });
    return result.sent
      ? { sent: true }
      : { sent: false, reason: result.reason as BriefReminderResult['reason'] };
  } catch (error) {
    // Same contract as `notifyClientOnce`: a caller may await this without a
    // guard, including from inside a webhook whose money side has succeeded.
    console.error(
      `[brief-reminder] could not judge workspace ${workspaceId}: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return { sent: false, reason: 'lookup_failed' };
  }
}

/**
 * Every workspace that might be waiting on its client, judged one at a time.
 *
 * The candidate query is deliberately only "deposit paid, still in
 * DEPOSIT_PAID" rather than a join onto `workspace_briefs.ready_at is null`.
 * The workspace that most needs this email is the one with no brief row at
 * all, and a join could not see it: not having started is not a row. So the
 * cheap filter selects the population and the rule decides each case, which
 * also keeps the "is it time yet" logic in exactly one place.
 *
 * One await per workspace rather than a `Promise.all`: this is a background
 * sweep with no deadline, and firing two hundred concurrent mail sends at
 * Resend to save a few seconds is how a sweep becomes an incident.
 */
export async function remindAllIncompleteBriefs(input?: {
  now?: Date;
  limit?: number;
  supabase?: SupabaseServiceClient;
}): Promise<{ considered: number; sent: number }> {
  const now = input?.now ?? new Date();
  const limit = Math.max(1, Math.min(input?.limit ?? SWEEP_LIMIT, SWEEP_LIMIT));
  try {
    const supabase = input?.supabase ?? createSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('workspaces')
      .select('id')
      .eq('project_state', ProjectState.DEPOSIT_PAID)
      .not('deposit_paid_at', 'is', null)
      // Oldest deposit first: the client who has been waiting longest is the
      // one whose silence has cost the most.
      .order('deposit_paid_at', { ascending: true })
      .limit(limit);
    if (error) throw error;

    const rows = (data ?? []) as unknown as Array<{ id: string }>;
    let sent = 0;
    for (const row of rows) {
      const result = await remindIfBriefIncomplete({
        workspaceId: row.id,
        now,
        supabase,
      });
      if (result.sent) sent += 1;
    }
    return { considered: rows.length, sent };
  } catch (error) {
    console.error(
      '[brief-reminder] sweep failed: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return { considered: 0, sent: 0 };
  }
}
