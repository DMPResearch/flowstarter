/**
 * POST /api/flowstarter/projects/claim
 *
 * Turns the anonymous preview the visitor is looking at into a workspace they
 * own. This is the only route that crosses from the funnel into the concierge
 * product: before it, a preview is a demo id and nothing is persisted; after
 * it, `/unlock/[workspaceId]` and the deposit Checkout have everything they
 * check for — a membership row, PREVIEW_READY, artifacts and a quote.
 *
 * Signed-out callers get 401 rather than an orphan workspace: ownership is the
 * entire point of the conversion, so there is nothing useful to do without an
 * identity to attach.
 *
 * The body carries only what the wizard actually holds — the demo id, the
 * answers the visitor typed, and the tier they confirmed. The preview manifest
 * and the price are resolved server-side; neither is accepted from a browser.
 */
import { IntakeChatSchema } from '@/lib/flowstarter/intake-chat-schema';
import { currentUser } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { recommendTier } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import type {
  CatalogSize,
  CommerceMode,
  DiscoveryData,
  PageCount,
  TimelineId,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import { clientIp } from '@/app/api/client/assets/asset-storage';
import { CURRENT_RIGHTS_STATEMENT_VERSION } from '@/components/flowstarter/rights-statement';
import { requireAuth } from '@/lib/api-auth';
import {
  claimPreview,
  PreviewClaimConflictError,
} from '@/lib/flowstarter/claim';
import { classifyRouting } from '@/lib/flowstarter/routing-rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ClaimSchema = z.object({
  /** The wizard's `demoId` — from POST /api/discovery/preview/live. */
  previewId: z.string().uuid(),
  /** Wizard step 5. The euro figure it maps to is server-owned. */
  tier: z.enum(['starter', 'pro', 'commerce', 'custom']).optional(),
  /** Wizard step 6 — the monthly care plan, by name; the fee is server-owned. */
  subscription: z.enum(['starter', 'pro', 'max']).optional(),
  billingCadence: z.enum(['monthly', 'yearly']).optional(),
  // The step-1/2/3 answers, exactly as the wizard already posts them to the
  // preview endpoint. Optional and bounded: they are provenance and display
  // text, never authorization or price.
  businessName: z.string().max(200).optional().default(''),
  fullName: z.string().max(200).optional().default(''),
  email: z.string().max(320).optional().default(''),
  description: z.string().max(5000).optional().default(''),
  industry: z.string().max(200).optional().default(''),
  targetAudience: z.string().max(500).optional().default(''),
  /**
   * What someone actually buys. Carried into `intakeSummary` so the brief the
   * build reads names the offer rather than inferring it from the description.
   */
  offer: z.string().max(2000).optional().default(''),
  /** A site they already had. Read for a palette and kept as provenance. */
  websiteUrl: z.string().max(300).optional().default(''),
  /**
   * "Use my profile picture on the site", one tap on the claim page.
   *
   * A picture read off a public profile is filed without rights and is
   * unpublishable until this says otherwise. Defaulting to false is the whole
   * safety property: a client that forgets to send the field publishes
   * nothing, rather than publishing somebody's photograph on the strength of
   * a missing key.
   */
  useProfilePicture: z.boolean().optional().default(false),
  goal: z.string().max(400).optional().default(''),
  brandTone: z.string().max(400).optional().default(''),
  // Scope answers. These exist here only so the routing classifier can be
  // re-run server-side; the wizard's own verdict is never trusted.
  pageCount: z
    .enum(['lt-5', '5-7', '8-15', '15+', 'unsure'])
    .optional()
    .default('unsure'),
  timeline: z
    .enum(['asap', '4-weeks', '1-3-months', 'flexible'])
    .optional()
    .default('flexible'),
  commerceMode: z
    .enum(['none', 'few-services', 'digital', 'physical', 'mixed'])
    .optional()
    .default('none'),
  catalogSize: z
    .enum(['na', '1-5', '6-25', '26-100', '100+', 'unsure'])
    .optional()
    .default('na'),
  calComUrl: z.string().max(400).optional().default(''),
  customIntegrations: z.string().max(2000).optional().default(''),
  /**
   * The info-agent conversation from the wizard's step 7. Bounded like every
   * other free-text field here: it becomes corpus evidence the generator may
   * cite, never authorization and never price.
   */
  intakeChat: IntakeChatSchema.optional(),
});

/**
 * Rebuilds the wizard's own data shape so `classifyRouting` can be run here,
 * on the server, against the answers rather than against a decision the
 * browser handed us. /api/discovery/recommend returns a routing object the
 * wizard may already hold; it is deliberately ignored.
 */
function discoveryDataFrom(spec: z.infer<typeof ClaimSchema>): DiscoveryData {
  return {
    fullName: spec.fullName,
    email: spec.email,
    businessName: spec.businessName,
    industry: spec.industry,
    description: spec.description,
    targetAudience: spec.targetAudience,
    offer: spec.offer ?? '',
    instagramUrl: '',
    linkedinUrl: '',
    websiteUrl: spec.websiteUrl ?? '',
    goal: spec.goal,
    secondaryGoals: [],
    brandTone: spec.brandTone,
    pageCount: spec.pageCount as PageCount,
    timeline: spec.timeline as TimelineId,
    commerceMode: spec.commerceMode as CommerceMode,
    catalogSize: spec.catalogSize as CatalogSize,
    calComUrl: spec.calComUrl,
    customIntegrations: spec.customIntegrations,
    selectedTier: spec.tier ?? '',
    subscription: '',
    billingCadence: 'monthly',
    // Routing is classified from the form answers alone; the chat's answers
    // are evidence for the generator, not an input to standard-vs-custom.
    phone: spec.intakeChat?.phone ?? '',
    services: spec.intakeChat?.services ?? [],
    intakeAnswers: spec.intakeChat?.answers ?? [],
    intakeChat: spec.intakeChat?.transcript ?? [],
    intakeChatDocuments: spec.intakeChat?.documents ?? [],
    intakeChatStatus: '',
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ClaimSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid claim request', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const spec = parsed.data;
  // Rebuilt once and read by both the routing classifier and the tier
  // fallback below, so the two never disagree about what the visitor
  // answered.
  const draftData = discoveryDataFrom(spec);
  // Step 6 (the tier confirmation) comes after the preview, so a quick-intake
  // claim — every claim from a visitor who has not been asked yet — arrives
  // with `spec.tier` unset. Falling back to the same deterministic
  // recommendation the wizard's own CTA shows keeps `quoteMinorForTier` (and
  // therefore `final_value_minor` and `/unlock`'s Pay button) from silently
  // going null: an unpriced, unbuildable claim is a worse outcome than a
  // recommended tier the client can still change from their dashboard.
  const tier = spec.tier ?? recommendTier(draftData).tier;

  try {
    const result = await claimPreview({
      previewId: spec.previewId,
      clerkUserId: auth.userId,
      clientEmail: await primaryEmail(),
      clientName: spec.fullName,
      businessName: spec.businessName,
      websiteUrl: spec.websiteUrl,
      tier,
      ...(spec.subscription ? { subscriptionPlan: spec.subscription } : {}),
      ...(spec.billingCadence ? { billingCadence: spec.billingCadence } : {}),
      useProfilePicture: spec.useProfilePicture,
      rightsStatementVersion: CURRENT_RIGHTS_STATEMENT_VERSION,
      clientIp: clientIp(request),
      clientUserAgent: request.headers.get('user-agent'),
      intakeSummary: {
        description: spec.description,
        offer: spec.offer,
        websiteUrl: spec.websiteUrl,
        industry: spec.industry,
        targetAudience: spec.targetAudience,
        goal: spec.goal,
        brandTone: spec.brandTone,
        pageCount: spec.pageCount,
        timeline: spec.timeline,
        commerceMode: spec.commerceMode,
        catalogSize: spec.catalogSize,
        calComUrl: spec.calComUrl,
        customIntegrations: spec.customIntegrations,
      },
      ...(spec.calComUrl ? { calComUrl: spec.calComUrl } : {}),
      ...(spec.intakeChat ? { intakeChat: spec.intakeChat } : {}),
      routing: classifyRouting(draftData),
    });

    return NextResponse.json(
      {
        workspaceId: result.workspaceId,
        unlockUrl: result.unlockUrl,
        alreadyClaimed: result.alreadyClaimed,
        previewReady: result.previewReady,
        quoteMinor: result.quoteMinor,
        // How many of the visitor's own answers are now citable evidence.
        intakeChatDocuments: result.intakeChatDocuments ?? 0,
        // Surfaced, not hidden: the client owns a workspace they cannot open
        // until this is retried, and the UI needs to be able to say so.
        ...(result.membershipError
          ? { membershipError: result.membershipError }
          : {}),
      },
      { status: result.alreadyClaimed ? 200 : 201 }
    );
  } catch (error) {
    if (error instanceof PreviewClaimConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error(
      '[Flowstarter] preview claim failed: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return NextResponse.json(
      { error: 'Could not claim this preview' },
      { status: 500 }
    );
  }
}

/**
 * Clerk owns the verified address; the wizard's typed email is not trusted for
 * billing. A Clerk hiccup must not fail a claim — Stripe Checkout will collect
 * the address itself when the workspace has none.
 */
async function primaryEmail(): Promise<string | null> {
  try {
    const user = await currentUser();
    if (!user) return null;
    const primary = user.emailAddresses?.find(
      (address) => address.id === user.primaryEmailAddressId
    );
    return (
      primary?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? null
    );
  } catch {
    return null;
  }
}
