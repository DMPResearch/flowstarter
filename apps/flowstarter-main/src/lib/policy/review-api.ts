import 'server-only';

/**
 * The operator board's half of the acceptable-use gate, once, for both
 * `/api/admin/*` and `/api/team/*` (the route files re-export these).
 *
 * Two handlers and nothing else: read the reviews on a project, and resolve
 * one. The hold itself lives in `policy_reviews`; approving is what lifts it.
 *
 * Approving a brief hold also starts the build the save did not start. That is
 * the whole point of the hold: the client paid, finished their brief, and the
 * gate stopped the dispatch. If approval only flipped a status, an operator
 * would have to remember to go and nudge the build too, and the day they
 * forgot would look exactly like the four paid builds that went missing in
 * PR #119.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireTeamAuth } from '@/lib/api-auth';
import { enqueueBuildOnBriefReady } from '@/lib/flowstarter/deposit-workflow';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

import { categoryById } from './acceptable-use';
import { clearAcceptableUseCache } from './classifier';
import {
  listPolicyReviews,
  PolicyReviewError,
  resolvePolicyReview,
  type PolicyReviewRow,
} from './review';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

function fail(message: string, code: string, status: number) {
  return NextResponse.json({ error: message, code }, { status });
}

async function operator(ctx: Ctx) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return { ok: false as const, response: auth.response };
  const params = await ctx.params;
  if (!UUID.test(params.id)) {
    return {
      ok: false as const,
      response: fail('Invalid project id', 'INVALID_ID', 400),
    };
  }
  return { ok: true as const, userId: auth.userId, workspaceId: params.id };
}

/**
 * A review as the board renders it: the row plus the policy's own words for
 * the category, so the operator reads "prostitution and escort services" and
 * the reason we refuse it rather than an id.
 */
export interface PolicyReviewView extends PolicyReviewRow {
  categoryLabel: string;
  categoryReason: string;
  /** 'prohibited' | 'review' | 'clean', or 'unknown' for a stale id. */
  disposition: string;
}

export function toPolicyReviewView(row: PolicyReviewRow): PolicyReviewView {
  const category = categoryById(row.categoryId);
  return {
    ...row,
    categoryLabel: category?.label ?? row.categoryId,
    categoryReason: category?.reason ?? '',
    disposition: category?.disposition ?? 'unknown',
  };
}

// ─── GET /projects/[id]/policy ──────────────────────────────────────────────

export async function listPolicyReviewsHandler(
  _req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const op = await operator(ctx);
  if (!op.ok) return op.response;
  const rows = await listPolicyReviews(op.workspaceId);
  const reviews = rows.map(toPolicyReviewView);
  return NextResponse.json({
    reviews,
    openCount: reviews.filter((review) => review.status === 'open').length,
  });
}

// ─── POST /projects/[id]/policy/decision ────────────────────────────────────

const decisionSchema = z.object({
  reviewId: z.string().uuid(),
  decision: z.enum(['approve', 'refuse']),
  /**
   * Why. Required on an approval, because "a human said yes" is only worth
   * something if the human wrote down what they checked: a licence number, a
   * phone call, the jurisdiction. Optional on a refusal, where the category
   * and the classifier's evidence already say it.
   */
  note: z.string().trim().max(1_000).optional().default(''),
});

const MIN_APPROVAL_NOTE_CHARS = 10;

export async function resolvePolicyReviewHandler(
  req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const op = await operator(ctx);
  if (!op.ok) return op.response;

  const parsed = decisionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      'Send a review id and either approve or refuse.',
      'INVALID_BODY',
      400
    );
  }
  if (
    parsed.data.decision === 'approve' &&
    parsed.data.note.length < MIN_APPROVAL_NOTE_CHARS
  ) {
    return fail(
      'Say what you checked before approving. A licence number, a call, the jurisdiction.',
      'NOTE_REQUIRED',
      400
    );
  }

  try {
    const row = await resolvePolicyReview({
      reviewId: parsed.data.reviewId,
      workspaceId: op.workspaceId,
      status: parsed.data.decision === 'approve' ? 'approved' : 'refused',
      actor: op.userId,
      note: parsed.data.note,
    });

    // The classifier's cache would otherwise keep answering with the verdict
    // the operator has just overruled, and the client's next save would be
    // held all over again by an answer nobody is allowed to disagree with.
    clearAcceptableUseCache();

    let build: { outcome: string; jobId: string | null } | null = null;
    if (parsed.data.decision === 'approve') {
      await liftHold(op.workspaceId);
      if (row.surface === 'brief') {
        // Idempotent and never throws: the same helper the brief save and the
        // deposit both use. A build already queued or running is recognised.
        const enqueued = await enqueueBuildOnBriefReady({
          workspaceId: op.workspaceId,
        });
        build = { outcome: enqueued.outcome, jobId: enqueued.jobId };
      }
    }

    return NextResponse.json({
      review: toPolicyReviewView(row),
      ...(build ? { build } : {}),
    });
  } catch (error) {
    if (error instanceof PolicyReviewError) {
      return fail(error.message, error.code, error.status);
    }
    console.error('[policy] could not resolve the review', error);
    return fail('Could not record that decision', 'DB_ERROR', 500);
  }
}

/**
 * Move the workspace off the review shelf.
 *
 * `build` is where a project sits while the work is being made, which is what
 * an approved project goes back to. Best-effort: the hold that mattered is the
 * `policy_reviews` row, and that is already resolved.
 */
async function liftHold(workspaceId: string): Promise<void> {
  try {
    const supabase = createSupabaseServiceRoleClient();
    const { error } = await supabase
      .from('workspaces')
      .update({ concierge_stage: 'build' })
      .eq('id', workspaceId);
    if (error) {
      console.error(
        `[policy] could not lift the hold on ${workspaceId}`,
        error
      );
    }
  } catch (error) {
    console.error(`[policy] lifting the hold on ${workspaceId} threw`, error);
  }
}
