/**
 * POST /api/discovery/preview/[demoId]/guest-deposit-checkout
 *
 * The deposit, for a visitor who has not signed in and is not going to be asked
 * to. It creates the Stripe Checkout session directly against the anonymous
 * preview; the workspace, the account and the build all come later, from the
 * webhook, once the money is real.
 *
 * Public by design, and therefore paranoid about two things:
 *
 *   - the money. The body carries a tier NAME. The euro figure comes from
 *     `quoteMinorForTier`, the same published price table `claim.ts` uses, and
 *     the charged amount is `depositAmountMinor` of it. No monetary value is
 *     read from the browser, so the worst a crafted request can do is buy a
 *     different tier at that tier's real price.
 *   - the preview. `getClaimablePreview` has to find a live, unexpired preview
 *     for this demo id, or there is nothing to build and we refuse to charge.
 *     A preview id is not a secret (it travels inside the generated site), so
 *     this is a liveness check, not authorization; ownership is settled later
 *     by `workspaces.claimed_preview_id`, which is unique.
 *
 * The email is the one thing here that must be right: it is what Stripe charges
 * and what the account gets created against. It is validated, normalized, and
 * pinned to the session as `customer_email` so the payer cannot end up with an
 * account at an address they never confirmed.
 */
import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { publicAppOrigin } from '@flowstarter/platform-config';
import { IntakeChatSchema } from '@/lib/flowstarter/intake-chat-schema';
import { stashGuestIntakeChat } from '@/lib/hosting/funnel-previews';
import { depositAmountMinor } from '@flowstarter/agentic-codegen/src/flowstarter/state-machine';
import { STRIPE_API_VERSION } from '@/lib/billing/stripe';
import {
  EMPTY_DISCOVERY,
  recommendTier,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import {
  getClaimablePreview,
  quoteMinorForTier,
} from '@/lib/flowstarter/claim';
import { GUEST_DEPOSIT_KIND } from '@/lib/flowstarter/guest-deposit';
import { readJsonCapped } from '@/lib/net/ingress';
import { clientIp } from '@/lib/request-ip';
import { routeLimiter } from '@/lib/security/route-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The recommendation rule's own answer to "no signal at all" — every field
 * `recommendTier` reads (`commerceMode`, `catalogSize`, `pageCount`, `goal`,
 * `customIntegrations`, `timeline`) is one this public, deliberately minimal
 * endpoint never collects. Computed once from the rule itself, rather than
 * hardcoded as `'starter'`, so this stays correct if the rule's own default
 * branch ever changes.
 */
const RECOMMENDATION_WITH_NO_SIGNAL = recommendTier(EMPTY_DISCOVERY).tier;

const GuestDepositSchema = z.object({
  /**
   * Wizard step 5 — but step 6 comes after the preview, so a quick-intake
   * guest reaches this endpoint having never seen it. Optional for exactly
   * that reason: PR #108 made `tier` unreachable for a visitor going straight
   * from preview to guest checkout, and a required enum 400'd every one of
   * them. Missing tier is priced server-side; see `RECOMMENDATION_WITH_NO_SIGNAL`.
   */
  tier: z.enum(['starter', 'pro', 'commerce', 'custom']).optional(),
  /** Wizard step 6, by name. The monthly fee is server-owned too. */
  subscription: z.enum(['starter', 'pro', 'max']).optional(),
  billingCadence: z.enum(['monthly', 'yearly']).optional(),
  /** Prefilled from the intake answers, but never trusted unvalidated. */
  email: z.string().email().max(320),
  fullName: z.string().max(200).optional().default(''),
  businessName: z.string().max(200).optional().default(''),
  /**
   * A site they already have. Carried through to the eventual claim so the
   * business-name rule there can name the workspace after its own website
   * rather than the guest paying for it (see `claimPreview`'s `deriveBusinessName`
   * use).
   */
  websiteUrl: z.string().max(300).optional().default(''),
  /**
   * The info-agent conversation. Too big for Stripe metadata, so it is
   * stashed onto the durable preview at checkout time and the webhook reads
   * it back when it claims (see stashGuestIntakeChat).
   */
  intakeChat: IntakeChatSchema.optional(),
});

// Same shape as /api/discovery/deposit: this is an unauthenticated endpoint
// that creates Stripe objects, so a single IP cannot be allowed to mint them
// in a loop. Backed by Arcjet (see `routeLimiter` / docs/security/rate-limits.md
// for the backend order); an Arcjet error fails closed here in production —
// a checkout route is one of the documented exceptions. A second limiter,
// keyed by the email address once the body is validated, catches the case of
// an attacker spreading the same email across many IPs. Suites reset both via
// `__resetRouteLimitersForTest` in `@/lib/security/route-limits`.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ demoId: string }> }
): Promise<NextResponse> {
  const ip = clientIp(request.headers);
  const ipLimit = await routeLimiter('guest-deposit-checkout-ip').check(
    request,
    ip
  );
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfter) } }
    );
  }

  const { demoId } = await params;
  if (!UUID.test(demoId)) {
    return NextResponse.json({ error: 'Invalid preview id' }, { status: 400 });
  }

  // Capped as it streams rather than buffered and measured afterwards: an
  // anonymous body arrives in whatever size the sender chooses, and a chunked
  // one advertises no size at all. Codex F07.
  const read = await readJsonCapped(request);
  if (read.status === 'too_large') {
    return NextResponse.json(
      { error: 'That request is too large.' },
      { status: 413 }
    );
  }
  if (read.status === 'invalid') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const body: unknown = read.value;

  const parsed = GuestDepositSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid deposit request', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const spec = parsed.data;
  const email = spec.email.trim().toLowerCase();

  // Same email, many IPs is the other half of this abuse shape the IP
  // limiter above cannot see on its own.
  const emailLimit = await routeLimiter('guest-deposit-checkout-email').check(
    request,
    email
  );
  if (!emailLimit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts' },
      {
        status: 429,
        headers: { 'Retry-After': String(emailLimit.retryAfter) },
      }
    );
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return NextResponse.json(
      { error: 'Stripe is not configured' },
      { status: 503 }
    );
  }

  // The preview has to still exist. Charging for a build with no source is the
  // one failure mode this endpoint exists to prevent.
  const preview = await getClaimablePreview(demoId);
  if (!preview) {
    return NextResponse.json(
      { error: 'This preview is no longer available' },
      { status: 404 }
    );
  }

  // Best-effort: a failed stash costs the build its citable conversation,
  // not the visitor their checkout.
  if (spec.intakeChat) {
    await stashGuestIntakeChat(demoId, spec.intakeChat);
  }

  // Applying the same recommendation rule the wizard's own CTA label and the
  // signed-in claim now fall back to (see `withQuickDefaults`), just with
  // less signal than either of those has: this endpoint never collects
  // `commerceMode`/`pageCount`/etc, so the rule has nothing to read and
  // resolves to its own no-signal default rather than 400ing the checkout.
  const tier = spec.tier ?? RECOMMENDATION_WITH_NO_SIGNAL;
  const quoteMinor = quoteMinorForTier(tier);
  if (!quoteMinor) {
    return NextResponse.json(
      { error: 'That build tier is not priced' },
      { status: 409 }
    );
  }
  const amountMinor = depositAmountMinor(quoteMinor);

  const origin = publicAppOrigin(undefined, request.nextUrl.origin);
  // Stripe metadata is a flat string map, so this is the entire contract
  // between the two halves of the flow. Everything the webhook needs to mint an
  // account and claim the preview is here, and nothing that is a price is.
  const metadata: Record<string, string> = {
    kind: GUEST_DEPOSIT_KIND,
    previewId: demoId,
    email,
    tier,
    ...(spec.subscription ? { subscription: spec.subscription } : {}),
    ...(spec.billingCadence ? { billingCadence: spec.billingCadence } : {}),
    ...(spec.fullName ? { fullName: spec.fullName.slice(0, 200) } : {}),
    ...(spec.businessName
      ? { businessName: spec.businessName.slice(0, 200) }
      : {}),
    // Carried to the webhook's eventual `claimPreview` call so a dental
    // practice's workspace is named and slugged after its own website
    // rather than the guest who paid for it.
    ...(spec.websiteUrl ? { websiteUrl: spec.websiteUrl.slice(0, 300) } : {}),
  };

  try {
    const stripe = new Stripe(secret, { apiVersion: STRIPE_API_VERSION });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: amountMinor,
            product_data: {
              name: `${
                spec.businessName || 'Flowstarter website'
              }: 20% build deposit`,
              description:
                'Locks the preview you approved and starts the full website build.',
            },
          },
        },
      ],
      metadata,
      // The webhook reads the PaymentIntent, not the session, so the contract
      // has to be on both. `payment_intent.succeeded` is the event that carries
      // a confirmed `amount_received` to check the quote against.
      payment_intent_data: { metadata },
      success_url: `${origin}/welcome/${demoId}`,
      cancel_url: `${origin}/?deposit=cancelled`,
    });

    if (!session.url) throw new Error('Stripe returned no Checkout URL');
    return NextResponse.json({
      url: session.url,
      amountMinor,
      currency: 'eur',
      depositPercent: 20,
    });
  } catch (error) {
    console.error(
      '[Flowstarter] guest deposit checkout failed: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return NextResponse.json(
      { error: 'We could not open checkout. Try again.' },
      { status: 502 }
    );
  }
}
