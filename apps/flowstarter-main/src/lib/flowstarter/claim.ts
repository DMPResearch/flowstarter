/**
 * The seam between the anonymous funnel and an owned project.
 *
 * The discovery wizard generates a real, personalized preview against a
 * throwaway `demoId`: no workspace, no membership, no artifacts. The deposit
 * half of the product expects the opposite — a workspace the caller is a
 * member of, in PREVIEW_READY, with a quote and an artifacts row for the build
 * worker to build from. Nothing converted one into the other, so the two
 * halves could never meet.
 *
 * Claiming is that conversion. It runs once per preview and is safe to retry:
 * `workspaces.claimed_preview_id` carries a partial unique index, so a double
 * submit (or a browser retry after a slow response) converges on the same
 * workspace instead of minting a second one.
 *
 * Two things are deliberately server-owned here and are never read from the
 * request body:
 *   - the preview manifest, brand config and template — captured by the
 *     generation pipeline itself (`rememberClaimablePreview`), because the
 *     browser never sees them and must not be able to dictate what gets built;
 *   - the money. The wizard sends a tier *name*; the euro figure comes from
 *     the same published price table the pricing page quotes.
 */
import type {
  BrandConfig,
  BusinessIntakePayload,
  TemplateScaffoldFile,
  TemplateSelection,
} from '@flowstarter/agentic-codegen';
import type {
  ApprovedPreviewEdit,
  ScrapedTextDocument,
} from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  TIER_SETUP_FROM,
  type Tier,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import type { Json } from '@/lib/database.types';
import {
  claimFunnelPreview,
  copyFunnelArtifactToTenant,
  loadFunnelPreview,
  saveFunnelPreview,
} from '@/lib/hosting/funnel-previews';
import { recordIntakeSubmission } from './intake-submission';
import { ensureClientMembership } from './membership';
import { appendClientReplyToCorpus } from './messaging';
import { savePreviewArtifacts } from './preview-artifacts';
import {
  injectCalComPreviewDemoIntoScaffoldFiles,
  resolveTenantCalComUrl,
} from './cal-com';
import {
  appliedPreviewEdit,
  MAX_CARRIED_EDITS,
  parseAppliedEdits,
} from './preview-intent';
import { parseQuoteInputToMinor } from './quote';
import type { RoutingResult } from './routing-rules';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

// ─── The claimable-preview stash ───────────────────────────────────────────
//
// The Map below is a CACHE, not the record. `funnel_previews` is the record.
//
// This used to be the only place a generated preview existed, which made the
// claim a coin flip in any deployment with more than one worker: a visitor who
// generated on instance A and signed in against instance B got a workspace
// with no artifacts behind it — an owned project that can take a deposit and
// has nothing to build from — and a restart between "look at this" and "make
// it mine" did the same. `rememberClaimablePreview` now writes a row (and
// stores the packaged site); `getClaimablePreview` falls back to that row
// whenever this process does not happen to be the one that generated it.
//
// The Map is kept because the same-process case is the common one and a
// round-trip per claim buys nothing there.

/** Everything `savePreviewArtifacts` needs, as the pipeline produced it. */
export interface ClaimablePreview {
  previewId: string;
  intake: BusinessIntakePayload;
  brandConfig: BrandConfig;
  template: TemplateSelection;
  files: readonly TemplateScaffoldFile[];
  /** Tenant Cal.com URL captured at preview time (from intake). */
  calComUrl?: string | null;
  /** `daytona://<sandbox>` or `local://<path>` — provenance, not a promise. */
  previewArtifactUrl?: string;
  previewUrl?: string;
  /**
   * The free changes the visitor made to this preview, oldest first, with the
   * text each one introduced. `files` above is already the edited set — this
   * is the record of *why* it differs from what the generator first produced,
   * and it is what the paid build is told to preserve and checked against.
   */
  appliedEdits?: ApprovedPreviewEdit[];
  capturedAt: number;
}

/** Manifests are large; keep the newest few and let the rest go. */
const MAX_STASHED_PREVIEWS = 40;
const STASH_TTL_MS = 6 * 60 * 60_000;

const stash = new Map<string, ClaimablePreview>();

/**
 * Called by the preview pipeline the moment a preview is publishable, so a
 * visitor who signs in minutes later claims the site they actually saw rather
 * than a regenerated approximation of it.
 *
 * The cache is populated synchronously — before the first `await` — so a
 * caller that does not await this still gets the same-process behaviour it
 * always had. The returned promise is the durable half: the row in
 * `funnel_previews` that makes the claim work on any other instance.
 *
 * The durable write cannot throw. A preview we failed to persist is a degraded
 * claim, not a reason to fail a generation that has already run for minutes.
 */
export async function rememberClaimablePreview(
  preview: Omit<ClaimablePreview, 'capturedAt'>
): Promise<void> {
  if (!UUID.test(preview.previewId)) return;
  reapStashedPreviews();
  stash.set(preview.previewId, { ...preview, capturedAt: Date.now() });
  while (stash.size > MAX_STASHED_PREVIEWS) {
    const oldest = stash.keys().next();
    if (oldest.done) break;
    stash.delete(oldest.value);
  }

  try {
    await saveFunnelPreview({
      previewId: preview.previewId,
      templateSlug: preview.template?.slug ?? null,
      templateVersion:
        (preview.template as { version?: string } | undefined)?.version ?? null,
      brandConfig: preview.brandConfig,
      manifest: {
        files: preview.files,
        intake: preview.intake,
        ...(preview.appliedEdits?.length
          ? { appliedEdits: preview.appliedEdits }
          : {}),
        ...(preview.calComUrl ? { calComUrl: preview.calComUrl } : {}),
        ...(preview.previewArtifactUrl
          ? { previewArtifactUrl: preview.previewArtifactUrl }
          : {}),
        ...(preview.previewUrl ? { previewUrl: preview.previewUrl } : {}),
      },
    });
  } catch (error) {
    console.warn(
      `[Flowstarter] preview ${preview.previewId} could not be persisted; ` +
        'a claim served by another instance will find nothing: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
}

/**
 * The preview, from this process's cache when it has it and from
 * `funnel_previews` when it does not.
 *
 * An EXPIRED row is deliberately not returned: `loadFunnelPreview` filters
 * them out, and a preview past its TTL is one whose hosted site has been (or
 * is about to be) torn down. Handing its manifest to a claim would mint a
 * workspace pointing at a site that no longer exists.
 */
export async function getClaimablePreview(
  previewId: string
): Promise<ClaimablePreview | undefined> {
  reapStashedPreviews();
  const cached = stash.get(previewId);
  if (cached) return cached;

  const row = await loadFunnelPreview(previewId);
  if (!row) return undefined;

  const manifest = (row.manifest ?? {}) as {
    files?: readonly TemplateScaffoldFile[];
    intake?: BusinessIntakePayload;
    appliedEdits?: unknown;
    calComUrl?: string;
    previewArtifactUrl?: string;
    previewUrl?: string;
  };
  if (!manifest.files?.length || !manifest.intake) return undefined;
  const appliedEdits = parseAppliedEdits(manifest.appliedEdits);

  return {
    previewId: row.previewId,
    intake: manifest.intake,
    brandConfig: (row.brandConfig ?? {}) as BrandConfig,
    template: {
      slug: row.templateSlug ?? '',
      ...(row.templateVersion ? { version: row.templateVersion } : {}),
    } as TemplateSelection,
    files: manifest.files,
    ...(manifest.calComUrl ? { calComUrl: manifest.calComUrl } : {}),
    ...(manifest.previewArtifactUrl
      ? { previewArtifactUrl: manifest.previewArtifactUrl }
      : {}),
    ...(manifest.previewUrl ? { previewUrl: manifest.previewUrl } : {}),
    ...(appliedEdits.length > 0 ? { appliedEdits } : {}),
    capturedAt: Date.parse(row.createdAt) || Date.now(),
  };
}

/**
 * Re-captures a preview after one of the visitor's free changes landed.
 *
 * This is the fix for the whole class of "the change I watched land is not on
 * the site I paid for". `rememberClaimablePreview` runs once, when the
 * generator finishes, and until now nothing ran afterwards: the edit runner
 * rewrote the live workspace, the visitor saw the change, and the manifest of
 * record still held the pre-edit files. The claim copied *that* into
 * `flowstarter_project_artifacts.preview_manifest`, and the build worker seeds
 * its worktree from exactly that column — so the paid build began from a site
 * the client had already rejected, and no amount of prompting downstream could
 * recover text nobody had kept.
 *
 * Calling this with the re-read workspace makes the edited files the manifest
 * of record, which is the strongest possible fix: the existing seeding spine
 * carries the change with no new mechanism at all. The returned edit record is
 * the audit trail on top of that, and it is what the build is later checked
 * against.
 *
 * Never throws. A preview we could not re-capture is a degraded build, not a
 * reason to tell a visitor their successful edit failed.
 */
export async function recordClaimablePreviewEdit(input: {
  previewId: string;
  instruction: string;
  /** The workspace as it is now, re-read after the edit runner finished. */
  files: readonly TemplateScaffoldFile[];
  appliedAt?: string;
}): Promise<ApprovedPreviewEdit | null> {
  if (!UUID.test(input.previewId)) return null;
  if (input.files.length === 0) return null;
  try {
    const previous = await getClaimablePreview(input.previewId);
    if (!previous) return null;
    const edit = appliedPreviewEdit({
      index: (previous.appliedEdits?.length ?? 0) + 1,
      instruction: input.instruction,
      before: previous.files,
      after: input.files,
      ...(input.appliedAt ? { appliedAt: input.appliedAt } : {}),
    });
    const appliedEdits = [...(previous.appliedEdits ?? []), edit].slice(
      -MAX_CARRIED_EDITS
    );
    const { capturedAt: _captured, ...carried } = previous;
    await rememberClaimablePreview({
      ...carried,
      files: input.files,
      appliedEdits,
    });
    return edit;
  } catch (error) {
    console.warn(
      `[Flowstarter] preview ${input.previewId} edit could not be re-captured; ` +
        'the paid build will not carry it: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return null;
  }
}

/** Test seam: the stash is module state, so suites must be able to reset it. */
export function clearClaimablePreviews(): void {
  stash.clear();
}

function reapStashedPreviews(): void {
  const cutoff = Date.now() - STASH_TTL_MS;
  for (const [id, preview] of Array.from(stash.entries())) {
    if (preview.capturedAt < cutoff) stash.delete(id);
  }
}

// ─── Pricing ───────────────────────────────────────────────────────────────

/**
 * The tier's published setup fee, in minor units.
 *
 * `TIER_SETUP_FROM` is display text ("€1,199"), and `parseQuoteInputToMinor`
 * treats a comma as a decimal separator, so the thousands separator has to go
 * before it is parsed — otherwise €1,199 would be quoted as €1.20.
 */
export function quoteMinorForTier(tier: Tier | '' | undefined): number | null {
  if (!tier || !(tier in TIER_SETUP_FROM)) return null;
  const digits = TIER_SETUP_FROM[tier as Tier].replace(/[^0-9.]/g, '');
  if (!digits) return null;
  try {
    const minor = parseQuoteInputToMinor(digits);
    return minor > 0 ? minor : null;
  } catch {
    return null;
  }
}

// ─── The intake conversation as evidence ───────────────────────────────────

/**
 * `sourceId` prefix, so the generator can tell a funnel conversation from a
 * scrape or a post-claim clarification. Mirrors `CLIENT_REPLY_SOURCE_PREFIX`
 * in `messaging.ts`, which is where this pattern comes from.
 */
export const INTAKE_CHAT_SOURCE_PREFIX = 'intake_chat';

/** Matches `messaging.ts`: enough for a real answer, not for a pasted inbox. */
const MAX_CHAT_DOCUMENT_CHARS = 1_200;

function slugTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Projects one info-agent conversation into the corpus shape the generator
 * already consumes.
 *
 * `platform: 'intake'` / `kind: 'intake_answer'` are the same pair
 * `clientReplyToCorpusDocument` uses, deliberately: to the honesty pass an
 * answer typed into the funnel chat is exactly the same kind of evidence as
 * an answer emailed back after the claim — something the business told us
 * directly — and reusing the existing union means no downstream code has to
 * learn a new case.
 *
 * `sourceId` is `intake_chat:<previewId>:<topic-or-index>`, stable across
 * retries so `appendClientReplyToCorpus` de-duplicates a re-claim instead of
 * citing the same sentence twice.
 *
 * The interviewer's own questions are NOT filed. Only the client's words are
 * evidence; a question we asked is not something the business said.
 */
export function intakeChatCorpusDocuments(input: {
  previewId: string;
  chat: ClaimIntakeChat;
  capturedAt?: string;
}): ScrapedTextDocument[] {
  const { previewId, chat } = input;
  const publishedAt = input.capturedAt;
  const documents: ScrapedTextDocument[] = [];
  const seen = new Set<string>();

  const push = (suffix: string, text: string) => {
    const body = text
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CHAT_DOCUMENT_CHARS);
    if (!body) return;
    let sourceId = `${INTAKE_CHAT_SOURCE_PREFIX}:${previewId}:${suffix}`;
    // A model that files two documents under one topic must not silently lose
    // one to de-duplication.
    for (let n = 2; seen.has(sourceId); n++) {
      sourceId = `${INTAKE_CHAT_SOURCE_PREFIX}:${previewId}:${suffix}-${n}`;
    }
    seen.add(sourceId);
    documents.push({
      sourceId,
      platform: 'intake',
      kind: 'intake_answer',
      text: body,
      ...(publishedAt ? { publishedAt } : {}),
    });
  };

  // Preferred: the interviewer's topically grouped documents.
  for (const document of chat.documents ?? []) {
    const topic = slugTopic(document.topic ?? '');
    if (!topic) continue;
    push(topic, document.text ?? '');
  }

  // Fallback: the raw client turns, for a conversation that never reached
  // `complete`. Skipped when documents already carry the same answers.
  if (documents.length === 0) {
    (chat.answers ?? []).forEach((answer, index) =>
      push(`answer-${index + 1}`, answer)
    );
  }

  const services = (chat.services ?? [])
    .map((service) => service.trim())
    .filter((service) => service.length > 0);
  if (services.length > 0) {
    push(
      'services',
      `Services, named the way the client names them: ${services.join(', ')}`
    );
  }

  return documents;
}

/**
 * Files the conversation against the workspace. Best effort by design: the
 * client owns the project either way, and losing an answer must never lose
 * them the workspace they just claimed. Returns how many were filed.
 */
async function fileIntakeChat(
  workspaceId: string,
  previewId: string,
  chat: ClaimIntakeChat | undefined
): Promise<number> {
  if (!chat) return 0;
  const documents = intakeChatCorpusDocuments({ previewId, chat });
  let filed = 0;
  for (const document of documents) {
    try {
      if (await appendClientReplyToCorpus(workspaceId, document)) filed++;
    } catch (error) {
      console.error(
        `[Flowstarter] claim ${previewId} could not file intake chat answer ` +
          `${document.sourceId}: ` +
          (error instanceof Error ? error.message : 'unknown error')
      );
    }
  }
  return filed;
}

// ─── Claiming ──────────────────────────────────────────────────────────────

export class PreviewClaimConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewClaimConflictError';
  }
}

/** €/month by plan name — mirror of the wizard's published SUBSCRIPTION_PLANS. */
const SUBSCRIPTION_MONTHLY_EUR = { starter: 49, pro: 99, max: 249 } as const;

export interface ClaimPreviewInput {
  /** The wizard's demo id — the preview the visitor is looking at. */
  previewId: string;
  clerkUserId: string;
  clientEmail?: string | null;
  clientName?: string | null;
  businessName?: string | null;
  /** Tier the visitor confirmed in the wizard; priced server-side. */
  tier?: Tier | '' | null;
  /** The monthly care plan the visitor confirmed at step 6, by name. */
  subscriptionPlan?: 'starter' | 'pro' | 'max';
  billingCadence?: 'monthly' | 'yearly';
  /** Wizard answers, kept on the claim event for provenance. */
  intakeSummary?: Record<string, unknown>;
  /**
   * Dedicated Cal.com booking URL from intake. Prefer this over scraping
   * `customIntegrations`. Also recovered from the stashed preview when the
   * guest-deposit path never re-sends wizard fields.
   */
  calComUrl?: string | null;
  /**
   * The info-agent conversation from step 7, if the visitor had one. These are
   * the client's own words about their own business — the best evidence the
   * generator will ever get — so they are filed as corpus documents rather
   * than left in an event payload nobody reads. See
   * {@link intakeChatCorpusDocuments}.
   */
  intakeChat?: ClaimIntakeChat;
  /**
   * The deterministic standard-vs-custom verdict, recomputed by the caller
   * from the answers rather than taken from the browser. `intake_submissions`
   * is NOT NULL on workspace_id, so a claim is the first moment it can be
   * persisted at all.
   */
  routing?: RoutingResult;
}

/** The info-agent conversation, as the wizard holds it. */
export interface ClaimIntakeChat {
  transcript?: ReadonlyArray<{ role: 'agent' | 'client'; text: string }>;
  /** Topically grouped answers, as the interviewer filed them. */
  documents?: ReadonlyArray<{ topic: string; text: string }>;
  /** Raw client turns, used when the interview never reached `complete`. */
  answers?: readonly string[];
  services?: readonly string[];
  phone?: string;
}

export interface ClaimPreviewResult {
  workspaceId: string;
  unlockUrl: string;
  /** True when this call found a workspace the same preview already made. */
  alreadyClaimed: boolean;
  /** True once artifacts exist and the workspace is in PREVIEW_READY. */
  previewReady: boolean;
  /** Null when the wizard sent no tier — the deposit will then be refused. */
  quoteMinor: number | null;
  /**
   * Set when membership could not be written. The workspace still exists and
   * is returned; the caller can retry. Never silently swallowed.
   */
  membershipError?: string;
  /** How many intake-chat answers were filed as citable evidence. */
  intakeChatDocuments?: number;
}

export async function claimPreview(
  input: ClaimPreviewInput
): Promise<ClaimPreviewResult> {
  if (!UUID.test(input.previewId)) {
    throw new Error('claimPreview requires a valid preview id');
  }
  if (!input.clerkUserId?.trim()) {
    throw new Error('claimPreview requires a clerkUserId');
  }

  const supabase = createSupabaseServiceRoleClient();

  const existing = await findClaimedWorkspace(input.previewId);
  if (existing) {
    await assertClaimableBy(existing, input.clerkUserId);
    const membershipError = await attachClient(existing, input.clerkUserId);
    // Idempotent: `appendClientReplyToCorpus` de-duplicates on `sourceId`, so
    // a re-claim re-files nothing but does pick up answers the first claim
    // raced past.
    const intakeChatDocuments = await fileIntakeChat(
      existing,
      input.previewId,
      input.intakeChat
    );
    // Idempotent, and needed on this path too: the first claim may have died
    // between creating the workspace and extending the preview's TTL.
    await adoptFunnelPreview(input.previewId, existing);
    return {
      workspaceId: existing,
      unlockUrl: unlockUrlFor(existing),
      alreadyClaimed: true,
      previewReady: await isPreviewReady(existing),
      quoteMinor: quoteMinorForTier(input.tier ?? ''),
      ...(membershipError ? { membershipError } : {}),
      intakeChatDocuments,
    };
  }

  const quoteMinor = quoteMinorForTier(input.tier ?? '');
  const businessName = input.businessName?.trim() || null;
  const name = businessName || `${input.clientName?.trim() || 'New'} project`;

  // Resolve Cal before insert so guest claims (no intakeSummary) still pick up
  // the URL stashed on the preview at generation time.
  const previewForCal = await getClaimablePreview(input.previewId);
  const calComUrl = resolveTenantCalComUrl({
    calComUrl:
      input.calComUrl ??
      (typeof input.intakeSummary?.['calComUrl'] === 'string'
        ? (input.intakeSummary['calComUrl'] as string)
        : null) ??
      previewForCal?.calComUrl ??
      null,
    customIntegrations:
      typeof input.intakeSummary?.['customIntegrations'] === 'string'
        ? (input.intakeSummary['customIntegrations'] as string)
        : null,
  });

  const insert = await supabase
    .from('workspaces')
    .insert({
      slug: uniqueSlug(name),
      name,
      // The funnel preview is an Astro template; a commerce build is
      // re-platformed by an operator, not guessed at from a wizard answer.
      site_kind: 'astro',
      client_name: input.clientName?.trim() || null,
      client_email: input.clientEmail?.trim() || null,
      client_business_name: businessName,
      claimed_preview_id: input.previewId,
      ...(calComUrl ? { cal_com_url: calComUrl } : {}),
      concierge_stage: 'intake',
      // Artifacts move this to PREVIEW_READY below; a workspace with no
      // preview behind it must not look ready to take a deposit.
      project_state: ProjectState.INTAKE,
      ...(quoteMinor ? { final_value_minor: quoteMinor } : {}),
      ...(input.tier ? { tier_name: input.tier } : {}),
      // The care plan is a name, not a price, for the same reason as the
      // tier: the server maps it, so the browser cannot quote itself. The
      // monthly fee is what later lets an operator activate the
      // subscription -- with it at zero the editor stays gated forever.
      ...(input.subscriptionPlan
        ? {
            monthly_fee: SUBSCRIPTION_MONTHLY_EUR[input.subscriptionPlan],
            billing_interval: input.billingCadence ?? 'monthly',
          }
        : {}),
    })
    .select('id')
    .maybeSingle();

  if (insert.error?.code === UNIQUE_VIOLATION) {
    // Two claims raced (double click, or a retry after a slow first call).
    // The loser adopts the winner's workspace rather than creating a second.
    const raced = await findClaimedWorkspace(input.previewId);
    if (!raced) throw insert.error;
    await assertClaimableBy(raced, input.clerkUserId);
    const membershipError = await attachClient(raced, input.clerkUserId);
    const intakeChatDocuments = await fileIntakeChat(
      raced,
      input.previewId,
      input.intakeChat
    );
    await adoptFunnelPreview(input.previewId, raced);
    return {
      workspaceId: raced,
      unlockUrl: unlockUrlFor(raced),
      alreadyClaimed: true,
      previewReady: await isPreviewReady(raced),
      quoteMinor,
      ...(membershipError ? { membershipError } : {}),
      intakeChatDocuments,
    };
  }
  if (insert.error || !insert.data) {
    throw insert.error ?? new Error('Could not create the claimed workspace');
  }
  const workspaceId = insert.data.id;

  // Artifacts before membership: a workspace nobody can open is recoverable
  // (the same preview id re-claims it); a paid build with nothing to build
  // from is not.
  let previewReady = false;
  const preview = previewForCal ?? (await getClaimablePreview(input.previewId));
  if (preview) {
    try {
      // Keep the blurred preview demo in artifacts; live Cal.com is wired only
      // when the full-site build runs (workspaces.cal_com_url).
      const files = injectCalComPreviewDemoIntoScaffoldFiles(preview.files);
      const saved = await savePreviewArtifacts({
        workspaceId,
        // The manifest was generated against the demo id. The build worker
        // cross-checks intake.projectId against the workspace and fails the
        // job when they disagree, so it is re-pointed at its new home.
        intake: {
          ...preview.intake,
          projectId: workspaceId,
          business: {
            ...preview.intake.business,
            // The claim carries the wizard's own page-count answer even when
            // the preview was generated without it. It is the input to the
            // page-set rule the paid build is gated on, so a brief that says
            // "Under 5" must not reach the build as "unsure".
            ...(typeof input.intakeSummary?.['pageCount'] === 'string' &&
            input.intakeSummary['pageCount']
              ? { pageCount: input.intakeSummary['pageCount'] as string }
              : {}),
          },
        },
        brandConfig: preview.brandConfig,
        template: preview.template,
        files,
        ...(preview.previewArtifactUrl
          ? { previewArtifactUrl: preview.previewArtifactUrl }
          : {}),
        advanceToPreviewReady: true,
      });
      previewReady = saved.advanced;
    } catch (error) {
      // A preview we cannot persist is not a reason to lose the workspace:
      // the client still gets an owned project, and the unlock page correctly
      // refuses to sell a deposit against a build that has no source.
      console.error(
        `[Flowstarter] claim ${input.previewId} created workspace ${workspaceId} ` +
          'but could not persist its preview artifacts: ' +
          (error instanceof Error ? error.message : 'unknown error')
      );
    }
  } else {
    console.warn(
      `[Flowstarter] claim ${input.previewId} has no stashed preview manifest; ` +
        `workspace ${workspaceId} stays in ${ProjectState.INTAKE}`
    );
  }

  // The funnel preview now belongs to somebody: extend its TTL so the reaper
  // leaves the hosted site alone, and copy the packaged site out of the
  // anonymous `funnel/` prefix and under the workspace's own tenant path,
  // where the bucket's read policy applies to it.
  //
  // Best effort, and after the artifacts row: a preview record we could not
  // update is a preview that gets torn down early, which is recoverable. A
  // workspace lost to a storage hiccup is not.
  await adoptFunnelPreview(input.previewId, workspaceId);

  // Evidence goes in after the artifacts row exists, because that row is what
  // holds `client_reply_corpus`; before it there is nothing to append to.
  const intakeChatDocuments = await fileIntakeChat(
    workspaceId,
    input.previewId,
    input.intakeChat
  );

  const membershipError = await attachClient(workspaceId, input.clerkUserId);

  // The routing verdict is calibration data, not a gate: losing it must not
  // cost the client the project they just claimed.
  if (input.routing) {
    try {
      await recordIntakeSubmission({
        workspaceId,
        payload: input.intakeSummary ?? {},
        routing: input.routing,
      });
    } catch (error) {
      console.error(
        `[Flowstarter] claim ${input.previewId} could not record the intake ` +
          'submission for calibration: ' +
          (error instanceof Error ? error.message : 'unknown error')
      );
    }
  }

  await recordEvent(workspaceId, 'preview_claimed', input.clerkUserId, {
    previewId: input.previewId,
    previewReady,
    quoteMinor,
    tier: input.tier ?? null,
    routingDecision: input.routing?.decision ?? null,
    previewUrl: preview?.previewUrl ?? null,
    templateSlug: preview?.template.slug ?? null,
    fileCount: preview?.files.length ?? 0,
    intake: input.intakeSummary ?? {},
    intakeChatDocuments,
    intakeChatTurns: input.intakeChat?.transcript?.length ?? 0,
    ...(membershipError ? { membershipError } : {}),
  });

  return {
    workspaceId,
    unlockUrl: unlockUrlFor(workspaceId),
    alreadyClaimed: false,
    previewReady,
    quoteMinor,
    ...(membershipError ? { membershipError } : {}),
    intakeChatDocuments,
  };
}

/**
 * Hands the funnel preview over to the workspace that just claimed it.
 *
 * Two effects, both idempotent so a retried claim converges rather than
 * duplicating:
 *   - `expires_at` moves out to the claimed TTL, which takes the row out of
 *     the reaper's candidate set for good;
 *   - the packaged site is copied from `funnel/{previewId}/site.tar.gz` to
 *     `tenant/{workspaceId}/previews/{previewId}/site.tar.gz`, which is where
 *     a tenant-owned artifact belongs and the only prefix the bucket's read
 *     policy ever grants.
 *
 * A copy, not a move: the hosted preview is still being served until the site
 * is torn down, and pulling the artifact out from under it mid-claim would
 * blank the page the client is looking at while they sign in.
 *
 * Never throws. The workspace already exists at this point and is the thing
 * worth protecting.
 */
async function adoptFunnelPreview(
  previewId: string,
  workspaceId: string
): Promise<void> {
  try {
    const row = await claimFunnelPreview({ previewId, workspaceId });
    if (!row?.artifactPath) return;
    await copyFunnelArtifactToTenant({
      previewId,
      workspaceId,
      sourcePath: row.artifactPath,
    });
  } catch (error) {
    console.warn(
      `[Flowstarter] claim ${previewId} could not adopt the funnel preview ` +
        `for workspace ${workspaceId}: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
}

async function findClaimedWorkspace(
  previewId: string
): Promise<string | undefined> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('workspaces')
    .select('id')
    .eq('claimed_preview_id', previewId)
    .maybeSingle();
  if (error) throw error;
  return data?.id;
}

/**
 * A preview id travels inside the generated site (the unlock link), so it is
 * not a secret. Re-claiming your own preview is idempotent; claiming one that
 * already belongs to somebody else is not allowed to hand over their project.
 */
async function assertClaimableBy(
  workspaceId: string,
  clerkUserId: string
): Promise<void> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('workspace_memberships')
    .select('clerk_user_id')
    .eq('workspace_id', workspaceId);
  if (error) throw error;
  const members = data ?? [];
  if (members.length === 0) return;
  if (members.some((member) => member.clerk_user_id === clerkUserId)) return;
  throw new PreviewClaimConflictError(
    'This preview has already been claimed by another account'
  );
}

/** Returns an error message instead of throwing: see ClaimPreviewResult. */
async function attachClient(
  workspaceId: string,
  clerkUserId: string
): Promise<string | undefined> {
  try {
    await ensureClientMembership({ workspaceId, clerkUserId });
    return undefined;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'unknown membership error';
    console.error(
      `[Flowstarter] workspace ${workspaceId} was claimed but the client could ` +
        `not be given membership and cannot open it: ${message}`
    );
    await recordEvent(
      workspaceId,
      'preview_claim_membership_failed',
      clerkUserId,
      { error: message }
    ).catch(() => {});
    return message;
  }
}

async function isPreviewReady(workspaceId: string): Promise<boolean> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('workspaces')
    .select('project_state')
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data?.project_state === ProjectState.PREVIEW_READY;
}

async function recordEvent(
  workspaceId: string,
  kind: string,
  actor: string,
  payload: Record<string, unknown>
): Promise<void> {
  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase.from('project_events').insert({
    workspace_id: workspaceId,
    kind,
    actor,
    payload: payload as Json,
  });
  if (error) {
    console.error(
      `[Flowstarter] could not record ${kind} for workspace ${workspaceId}: ${error.message}`
    );
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function uniqueSlug(base: string): string {
  const root = slugify(base) || 'workspace';
  return `${root}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Absolute when the configured origin is one we would put in front of a
 * client, relative otherwise — a misconfigured NEXT_PUBLIC_SITE_URL must not
 * cost the visitor the workspace they just claimed.
 */
export function unlockUrlFor(workspaceId: string): string {
  const path = `/unlock/${workspaceId}`;
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return path;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return path;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    return path;
  }
  return `${url.origin}${path}`;
}
