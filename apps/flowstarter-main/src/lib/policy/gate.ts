import 'server-only';

/**
 * The one call an enforcement point makes.
 *
 * Six places in the app have to ask "may we build this?": the live preview,
 * the claim, the guest deposit checkout, the brief save, a change request
 * being filed, and an operator pricing one. A seventh asks it of a built site.
 * Each of them calls `screenAcceptableUse` and reads the verdict. None of them
 * knows what a category is, what a threshold is, or which classifier answered.
 *
 * Classify, decide, record, and hand back a notice. In that order, every time.
 */

import { blocks, decide, type PolicyVerdict } from './acceptable-use';
import {
  classifyAcceptableUse,
  type AcceptableUseClassification,
} from './classifier';
import { noticeFor, type PolicyNotice } from './copy';
import {
  recordPolicyOutcome,
  type PolicyReviewClient,
  type PolicySurface,
} from './review';

export interface ScreenInput {
  surface: PolicySurface;
  /** The composed subject. Build it with `./subject.ts`, never by hand. */
  text: string;
  workspaceId?: string | null;
  projectId?: string | null;
  /** Who triggered this, for the timeline. Defaults to 'system'. */
  actor?: string;
  /**
   * Skip the audit row. Set only where the caller writes its own row with
   * more context, never to make a gate quieter.
   */
  skipRecord?: boolean;
  /**
   * Turn a refusal into a hold.
   *
   * Set at the surfaces that run AFTER the client has paid: the brief, a
   * change request, an operator's quote. A deposit has already changed hands
   * there, and a machine slamming the door on paid work with no appeal is
   * worse than a machine asking a person to look at it today. The work still
   * stops and the build still does not dispatch; the difference is that a
   * human, not a threshold, writes the final no.
   *
   * Never set on the pre-payment surfaces. A refusal there costs the visitor
   * nothing, and routing every one of them to a person would make the review
   * queue the funnel.
   */
  refusalBecomesReview?: boolean;
  signal?: AbortSignal;
  db?: PolicyReviewClient;
}

export interface ScreenResult {
  verdict: PolicyVerdict;
  classification: AcceptableUseClassification;
  /** Null when the verdict allows. */
  notice: PolicyNotice | null;
  /** The review row, when one was opened. */
  reviewId: string | null;
  /** Convenience: true when the flow must stop. */
  blocked: boolean;
}

/**
 * Screen one submission.
 *
 * Never throws. Every failure inside the classifier is already a
 * classification carrying `failed`, and the rule layer turns that into a
 * review in production. An enforcement point that had to wrap this in a
 * try/catch would eventually be the one that forgot to.
 */
export async function screenAcceptableUse(
  input: ScreenInput
): Promise<ScreenResult> {
  const classification = await classifyAcceptableUse({
    surface: input.surface,
    text: input.text,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    signal: input.signal,
  });
  const decided = decide(classification);
  const verdict: PolicyVerdict =
    input.refusalBecomesReview && decided.decision === 'refuse'
      ? { ...decided, decision: 'review' }
      : decided;
  const blocked = blocks(verdict);

  let reviewId: string | null = null;
  if (blocked && !input.skipRecord) {
    // A cached verdict is recorded once. The partial unique index in
    // `policy_reviews` is the authority on that; this only avoids the round
    // trip when we already know the answer came out of memory.
    const outcome = await recordPolicyOutcome({
      surface: input.surface,
      verdict,
      classification,
      workspaceId: input.workspaceId,
      actor: input.actor,
      db: input.db,
    });
    reviewId = outcome.reviewId;
  }

  return {
    verdict,
    classification,
    notice: noticeFor({
      decision: verdict.decision,
      category: verdict.category,
    }),
    reviewId,
    blocked,
  };
}

/**
 * The JSON body a blocked route returns.
 *
 * One shape for all six enforcement points, so a client that handles the
 * refusal on the preview step handles it on the brief too. `error` is present
 * because every route in this app answers a refusal with `error`; `policy`
 * carries the parts a UI wants to render.
 */
export function policyErrorBody(notice: PolicyNotice): {
  error: string;
  code: 'ACCEPTABLE_USE';
  policy: PolicyNotice;
} {
  return { error: notice.message, code: 'ACCEPTABLE_USE', policy: notice };
}

/**
 * The HTTP status for a blocked verdict.
 *
 * 451 for a refusal: the request was understood, the content is the reason,
 * and a 400 would read as "you typed it wrong". 202 is not used for the hold
 * because the caller is not getting what it asked for; a review answers 409,
 * which is what "your request conflicts with the current state of this
 * workspace" means.
 */
export function policyStatusFor(verdict: PolicyVerdict): number {
  return verdict.decision === 'refuse' ? 451 : 409;
}
