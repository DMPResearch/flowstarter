import 'server-only';

/**
 * The operator side of the acceptable-use gate: the review queue.
 *
 * A `review` verdict is a hold, not a rejection. It exists because the
 * expensive mistake is not letting one bad site through for an hour, it is
 * refusing a licensed pharmacy by machine and never hearing from them again.
 * So the gate parks the work, records the category and the classifier's one
 * sentence of evidence, and asks a person.
 *
 * What is written here and what is not:
 *
 *   WRITTEN   the category id, the rule that fired, the confidence, the tier,
 *             the prompt version, one sentence of evidence, and the evidence
 *             hash of the exact text.
 *   NOT       the text. Not in the row, not in the event payload, and not in
 *             any log line this module emits. The hash is the identifier.
 *
 * `policy_reviews` is server-only (RLS on, zero policies). It is not in the
 * generated `database.types.ts`, so the client is narrowed structurally the
 * same way `src/lib/ai/llm.ts` narrows `llm_usage`.
 *
 * Not every `review` verdict writes a row, and this is the other property
 * PR #193/#194 left undone until now. `blocks(verdict)` at the enforcement
 * point is true for every non-`allow` decision, including the three rules
 * that name no category (`needs_human_flag`, `clean_but_abstained`,
 * `unknown_category`) -- the classifier's own uncertainty about nothing in
 * particular, already routed to the scope head's `unsettled` bucket
 * (`docs/security/acceptable-use.md`). Writing THOSE to `policy_reviews` and
 * mailing an operator gives a person a card with nothing to check, and doing
 * it on every submission is how a review queue stops being read.
 * `reviewIsActionable` (`./acceptable-use`) is the one predicate that decides
 * whether this function does anything at all beyond the log line above: a
 * `refuse`, a `review` that names a category, `classifier_unavailable`'s
 * hold, and the scope gate's own two rules (#180) all qualify; the three
 * categoryless rules do not, and `recordPolicyOutcome` returns
 * `{ reviewId: null, recorded: false }` for them without touching the table.
 *
 * One more thing happens here, once a `review` row is actually written: an
 * operator email goes out (`policyReviewOperatorEmail`, `@/lib/email-
 * templates`), because before it existed a review sat on the board silently
 * and the only way to learn it was there was to go and look. `briefText`,
 * `linkUrl`/`linkLabel` and the caller's contact fields are the one exception
 * to the NOT list above -- they pass through this function to the email and
 * nowhere else, never into the row, the event payload or a log line.
 * `briefText` is the visitor's own words, verbatim; it is never the composed
 * subject a caller classified (`@/lib/policy/subject`'s `intakeSubject`
 * builds that for a model to reason over, and quoting it to a person is the
 * defect this comment is here to not let back in). Sent once per row: only
 * when the insert actually created one (a cache hit on a duplicate
 * submission does not re-notify, and neither does a verdict this module
 * declined to write), and only for `review`, never for `allow` (this
 * function is never called) or `refuse` (already closed, nothing for a
 * person to decide).
 */

import { publicAppOrigin } from '@flowstarter/platform-config';

import { resolveOperatorNotifyEmail, sendEmail } from '@/lib/email';
import { policyReviewOperatorEmail } from '@/lib/email-templates';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

import { reviewIsActionable, type PolicyVerdict } from './acceptable-use';
import type { AcceptableUseClassification } from './classifier';

/** Which enforcement point produced the row. */
export type PolicySurface =
  | 'preview'
  | 'claim'
  | 'guest_deposit'
  | 'brief'
  | 'change_request'
  | 'operator_quote'
  | 'built_site';

export type PolicyReviewStatus = 'open' | 'approved' | 'refused';

export interface PolicyReviewRow {
  id: string;
  workspaceId: string | null;
  surface: string;
  decision: 'review' | 'refuse';
  categoryId: string;
  confidence: number;
  rule: string;
  tier: string;
  promptVersion: string;
  evidenceHash: string;
  evidence: string;
  status: PolicyReviewStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

/** Event kinds this module appends to `project_events`. */
export const POLICY_EVENT_KINDS = {
  held: 'policy_review_opened',
  refused: 'policy_refused',
  approved: 'policy_review_approved',
  rejected: 'policy_review_refused',
} as const;

// ---------------------------------------------------------------------------
// The narrowed client
// ---------------------------------------------------------------------------

interface Thenable<T> {
  then<R>(onfulfilled: (value: T) => R): PromiseLike<R>;
}

type Result<T> = Thenable<{ data: T; error: { code?: string } | null }>;

interface SelectBuilder {
  eq(column: string, value: unknown): SelectBuilder;
  order(column: string, options: { ascending: boolean }): SelectBuilder;
  limit(count: number): SelectBuilder;
  maybeSingle(): Result<Record<string, unknown> | null>;
  then<R>(
    onfulfilled: (value: {
      data: Record<string, unknown>[] | null;
      error: { code?: string } | null;
    }) => R
  ): PromiseLike<R>;
}

interface UpdateBuilder {
  eq(column: string, value: unknown): UpdateBuilder;
  select(columns: string): {
    maybeSingle(): Result<Record<string, unknown> | null>;
  };
}

export interface PolicyReviewClient {
  from(table: string): {
    insert(values: Record<string, unknown>): {
      select(columns: string): {
        maybeSingle(): Result<Record<string, unknown> | null>;
      };
    } & Result<null>;
    select(columns: string): SelectBuilder;
    update(values: Record<string, unknown>): UpdateBuilder;
  };
}

/** The service-role client, narrowed to what this module touches. */
export function policyDb(): PolicyReviewClient {
  return createSupabaseServiceRoleClient() as unknown as PolicyReviewClient;
}

const ROW_COLUMNS =
  'id,workspace_id,surface,decision,category_id,confidence,rule,tier,prompt_version,evidence_hash,evidence,status,resolved_by,resolved_at,resolution_note,created_at';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toRow(raw: Record<string, unknown>): PolicyReviewRow {
  const status = str(raw.status);
  return {
    id: str(raw.id),
    workspaceId: typeof raw.workspace_id === 'string' ? raw.workspace_id : null,
    surface: str(raw.surface),
    decision: str(raw.decision) === 'refuse' ? 'refuse' : 'review',
    categoryId: str(raw.category_id),
    confidence: Number(raw.confidence ?? 0),
    rule: str(raw.rule),
    tier: str(raw.tier),
    promptVersion: str(raw.prompt_version),
    evidenceHash: str(raw.evidence_hash),
    evidence: str(raw.evidence),
    status:
      status === 'approved' || status === 'refused'
        ? (status as PolicyReviewStatus)
        : 'open',
    resolvedBy: typeof raw.resolved_by === 'string' ? raw.resolved_by : null,
    resolvedAt: typeof raw.resolved_at === 'string' ? raw.resolved_at : null,
    resolutionNote:
      typeof raw.resolution_note === 'string' ? raw.resolution_note : null,
    createdAt: str(raw.created_at),
  };
}

/**
 * Appends to the audit trail. Never throws into the caller: the hold has
 * already happened, and losing the note is not a reason to tell the client
 * their save failed. It is loud in the logs instead, and the log line carries
 * the category and the hash, never the text.
 */
async function recordEvent(
  db: PolicyReviewClient,
  row: {
    workspaceId: string;
    kind: string;
    actor: string;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await db.from('project_events').insert({
    workspace_id: row.workspaceId,
    kind: row.kind,
    actor: row.actor,
    payload: row.payload,
  });
  if (error) {
    console.error(
      `[policy] could not write ${row.kind} for ${row.workspaceId}`,
      error
    );
  }
}

// ---------------------------------------------------------------------------
// Writing an outcome
// ---------------------------------------------------------------------------

export interface RecordPolicyOutcomeInput {
  surface: PolicySurface;
  verdict: PolicyVerdict;
  classification: Pick<
    AcceptableUseClassification,
    'evidence' | 'evidenceHash' | 'promptVersion'
  >;
  workspaceId?: string | null;
  actor?: string;
  db?: PolicyReviewClient;
  /**
   * The visitor's own words, verbatim, for the operator email's quote block
   * only -- see the module doc's one exception to the NOT list. Never the
   * composed subject a caller classified. A caller with no text handy (or
   * that would rather not thread it here) simply gets an email with no
   * quoted brief; the row and the hold are unaffected either way.
   */
  briefText?: string;
  /** The visitor's own site or social link, when the caller has one. Email only, same as `briefText`. */
  linkUrl?: string | null;
  /** What `linkUrl` is, so the fact row reads right. Email only. */
  linkLabel?: string;
  /** The visitor's own name and address, when the caller has them. Email only, same as `briefText`. */
  contactName?: string | null;
  contactEmail?: string | null;
}

export interface RecordPolicyOutcomeResult {
  reviewId: string | null;
  /** False when the row could not be written. The hold still stands. */
  recorded: boolean;
}

/**
 * The review's own place on the admin board.
 *
 * A workspace-scoped review is read on that project's pipeline tab
 * (`PolicyReviewPanel`, which carries a matching `id="policy-review-<id>"` on
 * its card), so the link anchors straight to it. A `preview`-surface review
 * has no workspace by construction -- the visitor is anonymous, there is no
 * project yet -- and today there is no board card for one to anchor to
 * either; the link falls back to the pipeline board itself rather than a
 * 404, on the same reasoning `leadBoardUrl` in `@/lib/flowstarter/scope-gate`
 * uses for a lead with no id.
 */
function reviewBoardUrl(reviewId: string, workspaceId: string | null): string {
  const origin = publicAppOrigin();
  return workspaceId
    ? `${origin}/admin/dashboard/projects/${workspaceId}#policy-review-${reviewId}`
    : `${origin}/admin/dashboard/pipeline`;
}

/**
 * Tell an operator a review row is open.
 *
 * Called once, right after a `review` row is actually inserted (never for
 * `refuse`, which needs nobody, and never for a cache hit on a duplicate
 * submission, which already notified once). Never throws: the row is already
 * written and the hold already stands, so a failed send is logged and
 * swallowed, exactly like `fileCustomWorkLead`'s two sends in
 * `@/lib/flowstarter/scope-gate`.
 */
async function notifyOperatorOfReview(input: {
  reviewId: string;
  workspaceId: string | null;
  verdict: PolicyVerdict;
  briefText?: string;
  linkUrl?: string | null;
  linkLabel?: string;
  contactName?: string | null;
  contactEmail?: string | null;
}): Promise<void> {
  const operator = resolveOperatorNotifyEmail();
  if (!operator) return;
  try {
    const rendered = policyReviewOperatorEmail({
      rule: input.verdict.rule,
      categoryId: input.verdict.category.id,
      categoryLabel: input.verdict.category.label,
      briefText: input.briefText ?? '',
      linkUrl: input.linkUrl,
      linkLabel: input.linkLabel,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      reviewUrl: reviewBoardUrl(input.reviewId, input.workspaceId),
    });
    const sent = await sendEmail({
      to: operator,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (!sent.success) {
      console.warn(
        `[policy] the review notification did not send: ${
          sent.error ?? 'unknown error'
        }`
      );
    }
  } catch (error) {
    console.error('[policy] review notification threw', error);
  }
}

/**
 * Record one non-allow verdict.
 *
 * Never throws. A gate that cannot write its own audit row must still refuse:
 * failing the visitor's request because the ledger is down would turn a
 * database blip into an open door, and the enforcement points read the verdict
 * rather than this function's result.
 *
 * A duplicate (same workspace, surface and content hash, still open) is not an
 * error. The partial unique index exists so a client hammering save gets one
 * review rather than forty, and hitting it is the index doing its job.
 */
export async function recordPolicyOutcome(
  input: RecordPolicyOutcomeInput
): Promise<RecordPolicyOutcomeResult> {
  const verdict = input.verdict;
  if (verdict.decision === 'allow') return { reviewId: null, recorded: false };

  const workspaceId = input.workspaceId ?? null;

  console.warn(
    `[policy] ${verdict.decision} surface=${input.surface} category=${verdict.category.id} rule=${verdict.rule} tier=${verdict.tier} evidence=${input.classification.evidenceHash}`
  );

  // A review with no category and no other actionable rule is not a row an
  // operator can do anything with -- see `reviewIsActionable` and the module
  // doc. The log line above still fires (a developer can grep it); the row,
  // the email and the timeline entry below all stay quiet.
  const actionable = reviewIsActionable(verdict);

  let reviewId: string | null = null;
  let recorded = false;
  let db: PolicyReviewClient | null = null;
  try {
    // Inside the try, not above it. Building the service-role client reads
    // env and can throw on its own (a missing SUPABASE_URL is the obvious
    // one), and this function's whole contract is that it never throws into
    // the caller: a gate that could not write its audit row must still be
    // able to refuse. With the call outside, a misconfigured environment
    // turned every held verdict into a 500 at the route instead of a hold,
    // which is the exact opposite of what a fail-closed gate is for.
    //
    // Built even when `actionable` is false: the timeline write below still
    // needs a client, and a non-actionable verdict skips the INSERT only.
    db = input.db ?? policyDb();
    if (actionable) {
      const { data, error } = await db
        .from('policy_reviews')
        .insert({
          workspace_id: workspaceId,
          surface: input.surface,
          decision: verdict.decision,
          category_id: verdict.category.id,
          confidence: verdict.confidence,
          rule: verdict.rule,
          tier: verdict.tier,
          prompt_version: input.classification.promptVersion,
          evidence_hash: input.classification.evidenceHash,
          evidence: input.classification.evidence,
          status: verdict.decision === 'refuse' ? 'refused' : 'open',
          resolved_at:
            verdict.decision === 'refuse' ? new Date().toISOString() : null,
          resolved_by: verdict.decision === 'refuse' ? 'system' : null,
        })
        .select('id')
        .maybeSingle();
      if (error && error.code !== '23505') {
        console.error('[policy] could not write the review row', error);
      } else {
        recorded = !error;
        reviewId = typeof data?.id === 'string' ? data.id : null;
      }
    }
  } catch (error) {
    console.error('[policy] review insert threw', error);
  }

  // Once per row, and only for a hold: a duplicate submission (`recorded`
  // false on a 23505) already notified the first time, a refusal needs
  // nobody -- it is already closed -- and a verdict this function declined to
  // write (`actionable` false) never reaches here either, since `recorded`
  // stays false when nothing was inserted.
  if (recorded && reviewId && verdict.decision === 'review') {
    await notifyOperatorOfReview({
      reviewId,
      workspaceId,
      verdict,
      briefText: input.briefText,
      linkUrl: input.linkUrl,
      linkLabel: input.linkLabel,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
    });
  }

  // Only when there is a client to write with. A failure above already logged.
  if (workspaceId && db) {
    await recordEvent(db, {
      workspaceId,
      kind:
        verdict.decision === 'refuse'
          ? POLICY_EVENT_KINDS.refused
          : POLICY_EVENT_KINDS.held,
      actor: input.actor ?? 'system',
      payload: {
        surface: input.surface,
        categoryId: verdict.category.id,
        categoryLabel: verdict.category.label,
        rule: verdict.rule,
        tier: verdict.tier,
        confidence: verdict.confidence,
        evidence: input.classification.evidence,
        evidenceHash: input.classification.evidenceHash,
        promptVersion: input.classification.promptVersion,
        reviewId,
      },
    });
  }

  return { reviewId, recorded };
}

// ---------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------

const REVIEW_PAGE_SIZE = 50;

/** Every review row for one workspace, newest first. */
export async function listPolicyReviews(
  workspaceId: string,
  db: PolicyReviewClient = policyDb()
): Promise<PolicyReviewRow[]> {
  const { data, error } = await db
    .from('policy_reviews')
    .select(ROW_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(REVIEW_PAGE_SIZE);
  if (error || !Array.isArray(data)) {
    if (error) console.error('[policy] could not read the review queue', error);
    return [];
  }
  return data.map(toRow);
}

/**
 * True when this workspace is on hold.
 *
 * Read before a build is dispatched. Fails CLOSED on a read error: a gate that
 * cannot tell whether a hold exists must behave as though one does, or a
 * database blip becomes the way a parked workspace gets built anyway.
 */
export async function hasOpenPolicyReview(
  workspaceId: string,
  db: PolicyReviewClient = policyDb()
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('policy_reviews')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'open')
      .limit(1);
    if (error) {
      console.error('[policy] could not read the hold state', error);
      return true;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (error) {
    console.error('[policy] hold read threw', error);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Resolving one
// ---------------------------------------------------------------------------

export class PolicyReviewError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'PolicyReviewError';
  }
}

export interface ResolvePolicyReviewInput {
  reviewId: string;
  workspaceId: string;
  /** `approved` lets the work proceed; `refused` is final. */
  status: 'approved' | 'refused';
  actor: string;
  note?: string;
  db?: PolicyReviewClient;
}

/**
 * An operator's decision on one held review.
 *
 * Compare-and-set on `status = 'open'`, the same discipline the change-request
 * state machine uses: two operators clicking at once must not both believe
 * they were the one who approved it.
 */
export async function resolvePolicyReview(
  input: ResolvePolicyReviewInput
): Promise<PolicyReviewRow> {
  const db = input.db ?? policyDb();
  const { data, error } = await db
    .from('policy_reviews')
    .update({
      status: input.status,
      resolved_by: input.actor,
      resolved_at: new Date().toISOString(),
      resolution_note: input.note?.trim() || null,
    })
    .eq('id', input.reviewId)
    .eq('workspace_id', input.workspaceId)
    .eq('status', 'open')
    .select(ROW_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error('[policy] could not resolve the review', error);
    throw new PolicyReviewError(
      'DB_ERROR',
      'Could not record that decision',
      500
    );
  }
  if (!data) {
    throw new PolicyReviewError(
      'POLICY_REVIEW_STALE',
      'That review is not open any more. Reload the board and look again.',
      409
    );
  }

  const row = toRow(data);
  await recordEvent(db, {
    workspaceId: input.workspaceId,
    kind:
      input.status === 'approved'
        ? POLICY_EVENT_KINDS.approved
        : POLICY_EVENT_KINDS.rejected,
    actor: input.actor,
    payload: {
      reviewId: row.id,
      surface: row.surface,
      categoryId: row.categoryId,
      note: row.resolutionNote,
    },
  });
  return row;
}
