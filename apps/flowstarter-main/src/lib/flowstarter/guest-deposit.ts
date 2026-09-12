/**
 * Guest deposit provisioning: the webhook half of paying before you have an
 * account.
 *
 * The signed-in flow is claim, then pay. This one is pay, then claim, and the
 * inversion is the whole point: a visitor who has decided should meet a card
 * form, not a sign-up form. Everything that used to happen while the visitor
 * waited now happens here, after Stripe tells us the money is real.
 *
 * The order is chosen so that a crash anywhere is recoverable by Stripe simply
 * redelivering the event:
 *
 *   1. has this preview already been provisioned? If yes, stop touching Clerk
 *      and stop sending email. This is the guard that makes redelivery cheap
 *      and, more importantly, stops a retry from resetting a password the
 *      client has already been emailed and may already be typing.
 *   2. find or create the Clerk user for the charged email address.
 *   3. claim the preview into a workspace for that user. `claimPreview` is
 *      idempotent on `workspaces.claimed_preview_id`, which carries a partial
 *      unique index, so two deliveries converge on one workspace.
 *   4. run the same money checks and the same build enqueue the signed-in
 *      deposit runs, via `verifyDepositAndEnqueue`. Idempotent on two unique
 *      constraints: one job per workspace, one job per Stripe event.
 *   5. email the client.
 *   6. record `guest_account_provisioned`, which is what step 1 reads.
 *
 * Step 6 is last on purpose. A crash before it means the next delivery redoes
 * steps 2 to 5, which is exactly right: the password from the abandoned attempt
 * was never emailed, so reissuing it costs nothing and rescues a client who
 * would otherwise be locked out of a project they paid for.
 *
 * Email is best effort. A client with no welcome email is a support ticket. A
 * build that never started because Resend was down is a broken product, so mail
 * failure is recorded and swallowed, never propagated.
 */
import { IntakeChatSchema } from '@/lib/flowstarter/intake-chat-schema';
import { readGuestIntakeChat } from '@/lib/hosting/funnel-previews';
import type Stripe from 'stripe';
import type { Json } from '@/lib/database.types';
import { sendEmail } from '@/lib/email';
import { guestDepositWelcomeEmail } from '@/lib/email-templates/guest-deposit-welcome';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import type { Tier } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import { claimPreview, PreviewClaimConflictError } from './claim';
import { verifyDepositAndEnqueue } from './deposit-workflow';
import { findOrCreateGuestUser, type GuestAccount } from './guest-credentials';

/** Marks a Checkout session and PaymentIntent as belonging to this flow. */
export const GUEST_DEPOSIT_KIND = 'flowstarter_guest_deposit';

/** The event kind that records "this preview is fully provisioned". */
export const GUEST_PROVISIONED_EVENT = 'guest_account_provisioned';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TIERS = new Set<Tier>(['starter', 'pro', 'commerce', 'custom']);
const PLANS = new Set(['starter', 'pro', 'max']);

export interface GuestDepositProvisionResult {
  workspaceId: string;
  clerkUserId: string;
  /** How the account was resolved. Never includes the password itself. */
  accountKind: GuestAccount['kind'];
  jobId: string;
  /** True when this delivery found the work already done and did nothing. */
  alreadyProvisioned: boolean;
  /** False when the client owns the project but was not told about it. */
  emailed: boolean;
}

/**
 * Handles a succeeded PaymentIntent that carries the guest deposit marker.
 *
 * Returns null for every other PaymentIntent, including the signed-in deposit,
 * so the two handlers can both run on `payment_intent.succeeded` without either
 * of them seeing the other's events.
 */
export async function provisionGuestDeposit(
  event: Stripe.Event,
  paymentIntent: Stripe.PaymentIntent
): Promise<GuestDepositProvisionResult | null> {
  const meta = paymentIntent.metadata ?? {};
  if (meta['kind'] !== GUEST_DEPOSIT_KIND) return null;

  const previewId = meta['previewId'] ?? '';
  if (!UUID.test(previewId)) {
    throw new Error('Guest deposit is missing a valid previewId');
  }
  const email = (meta['email'] ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('Guest deposit is missing a usable email address');
  }
  const tier = TIERS.has(meta['tier'] as Tier)
    ? (meta['tier'] as Tier)
    : undefined;
  const subscription = PLANS.has(meta['subscription'] ?? '')
    ? (meta['subscription'] as 'starter' | 'pro' | 'max')
    : undefined;
  const billingCadence =
    meta['billingCadence'] === 'yearly'
      ? ('yearly' as const)
      : meta['billingCadence'] === 'monthly'
      ? ('monthly' as const)
      : undefined;
  const businessName = meta['businessName']?.trim() || null;
  const fullName = meta['fullName']?.trim() || null;

  // ── 1. Redelivery guard ──────────────────────────────────────────────────
  const settled = await findProvisionedWorkspace(previewId);
  if (settled) {
    // Still run the deposit gate: it is idempotent, and this is the one thing
    // worth re-attempting if the earlier delivery recorded provisioning but the
    // build enqueue was the part that failed.
    const enqueued = await verifyDepositAndEnqueue(
      event,
      paymentIntent,
      settled.workspaceId
    );
    return {
      workspaceId: settled.workspaceId,
      clerkUserId: settled.clerkUserId,
      accountKind: 'existing',
      jobId: enqueued.jobId,
      alreadyProvisioned: true,
      emailed: false,
    };
  }

  // ── 2. The account ───────────────────────────────────────────────────────
  const account = await findOrCreateGuestUser(email, fullName);

  // ── 3. The workspace ─────────────────────────────────────────────────────
  // The conversation the info agent had rides in from the durable preview
  // (stashed at checkout; Stripe metadata is too small to carry it), so a
  // guest claim files the same citable evidence a signed-in claim does.
  const stashedChat = IntakeChatSchema.safeParse(
    await readGuestIntakeChat(previewId)
  );
  let claim;
  try {
    claim = await claimPreview({
      previewId,
      clerkUserId: account.clerkUserId,
      clientEmail: email,
      clientName: fullName,
      businessName,
      ...(stashedChat.success ? { intakeChat: stashedChat.data } : {}),
      ...(tier ? { tier } : {}),
      ...(subscription ? { subscriptionPlan: subscription } : {}),
      ...(billingCadence ? { billingCadence } : {}),
    });
  } catch (error) {
    if (error instanceof PreviewClaimConflictError) {
      // Somebody else already owns this preview. Failing the webhook would put
      // Stripe into days of retries over something a retry cannot fix, so this
      // stops here and is loud enough to be found and refunded by hand.
      console.error(
        `[Flowstarter] guest deposit ${paymentIntent.id} paid against preview ` +
          `${previewId}, which is already claimed by another account; ` +
          'the payment needs a manual decision'
      );
      return null;
    }
    throw error;
  }

  // ── 4. The same money checks the signed-in deposit gets ─────────────────
  const enqueued = await verifyDepositAndEnqueue(
    event,
    paymentIntent,
    claim.workspaceId
  );

  // ── 5. Tell the client ───────────────────────────────────────────────────
  const emailed = await sendGuestWelcome({
    workspaceId: claim.workspaceId,
    account,
    businessName,
  });

  // ── 6. Close the door on redelivery ──────────────────────────────────────
  await recordEvent(claim.workspaceId, GUEST_PROVISIONED_EVENT, {
    previewId,
    clerkUserId: account.clerkUserId,
    // The KIND of credential, never the credential.
    accountKind: account.kind,
    emailed,
    jobId: enqueued.jobId,
    paymentIntentId: paymentIntent.id,
    stripeEventId: event.id,
  });

  return {
    workspaceId: claim.workspaceId,
    clerkUserId: account.clerkUserId,
    accountKind: account.kind,
    jobId: enqueued.jobId,
    alreadyProvisioned: false,
    emailed,
  };
}

/**
 * The workspace this preview was already provisioned into, if any.
 *
 * Two reads rather than a join: `workspaces` is keyed by `claimed_preview_id`
 * and the completion marker lives in `project_events`. A workspace with no
 * marker is a half-finished attempt and must be finished, not skipped.
 */
async function findProvisionedWorkspace(
  previewId: string
): Promise<{ workspaceId: string; clerkUserId: string } | null> {
  const supabase = createSupabaseServiceRoleClient();
  const { data: workspace, error } = await supabase
    .from('workspaces')
    .select('id')
    .eq('claimed_preview_id', previewId)
    .maybeSingle();
  if (error) throw error;
  if (!workspace) return null;

  const { data: marker, error: markerError } = await supabase
    .from('project_events')
    .select('payload')
    .eq('workspace_id', workspace.id)
    .eq('kind', GUEST_PROVISIONED_EVENT)
    .maybeSingle();
  if (markerError) throw markerError;
  if (!marker) return null;

  const payload = (marker.payload ?? {}) as { clerkUserId?: string };
  return {
    workspaceId: workspace.id,
    clerkUserId: payload.clerkUserId ?? '',
  };
}

/**
 * Best effort by contract. Returns whether the client was told, so the caller
 * can record it and an operator can find the ones who were not.
 */
async function sendGuestWelcome(input: {
  workspaceId: string;
  account: GuestAccount;
  businessName: string | null;
}): Promise<boolean> {
  const { account } = input;
  const { subject, html, text } = guestDepositWelcomeEmail({
    email: account.email,
    ...(account.tempPassword ? { tempPassword: account.tempPassword } : {}),
    signInUrl: signInUrl(),
    businessName: input.businessName,
  });

  try {
    const result = await sendEmail({
      to: account.email,
      subject,
      html,
      text,
    });
    if (result.success) return true;
    await noteEmailFailure(input.workspaceId, account.kind, result.error);
    return false;
  } catch (error) {
    await noteEmailFailure(
      input.workspaceId,
      account.kind,
      error instanceof Error ? error.message : 'unknown error'
    );
    return false;
  }
}

async function noteEmailFailure(
  workspaceId: string,
  accountKind: GuestAccount['kind'],
  error?: string
): Promise<void> {
  // A client who paid, owns a project, and has no idea how to open it. This has
  // to be findable without reading the build logs.
  console.error(
    `[Flowstarter] guest deposit provisioned workspace ${workspaceId} but the ` +
      `welcome email failed; the client cannot sign in until it is resent: ` +
      (error ?? 'unknown error')
  );
  await recordEvent(workspaceId, 'guest_credentials_email_failed', {
    accountKind,
    error: error ?? 'unknown error',
  });
}

async function recordEvent(
  workspaceId: string,
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const supabase = createSupabaseServiceRoleClient();
    const { error } = await supabase.from('project_events').insert({
      workspace_id: workspaceId,
      kind,
      actor: 'system:guest_deposit',
      payload: payload as Json,
    });
    if (error) throw error;
  } catch (error) {
    console.error(
      `[Flowstarter] could not record ${kind} for workspace ${workspaceId}: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
}

/**
 * Where the email sends people. Falls back to a relative path rather than
 * guessing a hostname: a misconfigured origin should produce an obviously
 * broken link in one email, not a link to somebody else's site.
 */
function signInUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return '/login';
  try {
    const url = new URL(raw);
    const loopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      return '/login';
    }
    return `${url.origin}/login`;
  } catch {
    return '/login';
  }
}
