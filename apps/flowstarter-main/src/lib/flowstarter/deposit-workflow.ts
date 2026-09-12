import type Stripe from 'stripe';
import { dispatchAgentJob, DispatchError } from './pipeline/dispatch';
import { depositAmountMinor } from '@flowstarter/agentic-codegen/src/flowstarter/state-machine';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { loadFunnelPreview } from '@/lib/hosting/funnel-previews';
import type { Json } from '@/lib/database.types';
import { depositReceivedEmail } from '@/lib/email-templates/client-notices';
import { notifyClientOnce } from './client-notifications';
import { depositBuildPayload, derivePreviewIntent } from './preview-intent';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DepositBuildEnqueueResult {
  workspaceId: string;
  jobId: string;
  duplicate: boolean;
}

/** States a deposit may advance the concierge lifecycle from. */
const DEPOSIT_READY_STATES = [
  ProjectState.PREVIEW_READY,
  ProjectState.DEPOSIT_PAID,
];

/**
 * Verifies the signed Stripe deposit event against the server-owned quote,
 * advances PREVIEW_READY -> DEPOSIT_PAID, and durably enqueues one full build.
 * Stripe may redeliver events: unique database constraints make this idempotent.
 */
export async function enqueueFullBuildFromDeposit(
  event: Stripe.Event,
  paymentIntent: Stripe.PaymentIntent
): Promise<DepositBuildEnqueueResult | null> {
  if (paymentIntent.metadata['kind'] !== 'flowstarter_deposit') return null;

  const workspaceId = paymentIntent.metadata['workspaceId'];
  if (!workspaceId || !UUID.test(workspaceId))
    throw new Error('Deposit is missing a valid workspaceId');

  const enqueued = await verifyDepositAndEnqueue(
    event,
    paymentIntent,
    workspaceId
  );
  await notifyDepositPaid(workspaceId);
  return enqueued;
}

/**
 * "Your deposit is in and your build has started", to the client.
 *
 * It lives on the two concierge entry points rather than in the shared
 * `enqueueBuildAndAdvance` below on purpose: the guest-checkout path goes
 * through that same function and sends its own, richer welcome (it has to
 * carry credentials for an account that did not exist a second ago). Hanging
 * this off the shared helper would mail a guest twice.
 *
 * Never throws, by `notifyClientOnce`'s contract, so a mail problem cannot
 * fail a webhook whose money side has already succeeded.
 */
async function notifyDepositPaid(workspaceId: string): Promise<void> {
  await notifyClientOnce({
    workspaceId,
    notification: 'deposit_paid',
    render: (client) =>
      depositReceivedEmail({
        dashboardUrl: client.dashboardUrl,
        // The in-depth brief lives one level under the client's own project
        // page, and the build waits on it, so the email that says the build
        // has started is also the email that has to say what it is waiting
        // for. Built from `dashboardUrl` rather than composed again here:
        // that value already resolves the public origin correctly for an
        // address read outside any tab we control.
        briefUrl: `${client.dashboardUrl}/brief`,
        clientName: client.clientName,
        businessName: client.businessName,
      }),
  });
}

/**
 * The money checks, shared by every Checkout deposit however the workspace was
 * found.
 *
 * The signed-in path reads the workspace id straight off the PaymentIntent
 * metadata, because the workspace existed before the Checkout session did. The
 * guest path has no workspace at Checkout time: it creates one from the preview
 * when the payment lands and then brings it here, so the amount, the currency
 * and the lifecycle state are held to exactly the same standard on both. There
 * is deliberately no second, laxer copy of these checks for guests.
 *
 * `workspaceId` is server-derived on both paths and is never read from a
 * browser.
 */
export async function verifyDepositAndEnqueue(
  event: Stripe.Event,
  paymentIntent: Stripe.PaymentIntent,
  workspaceId: string
): Promise<DepositBuildEnqueueResult> {
  if (paymentIntent.status !== 'succeeded')
    throw new Error('Deposit PaymentIntent is not succeeded');
  if (!UUID.test(workspaceId))
    throw new Error('Deposit is missing a valid workspaceId');

  const supabase = createSupabaseServiceRoleClient();
  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select(
      'id, project_state, final_value_minor, billing_currency, deposit_payment_intent_id'
    )
    .eq('id', workspaceId)
    .maybeSingle();
  if (workspaceError) throw workspaceError;
  if (!workspace) throw new Error('Deposit workspace does not exist');
  if (!DEPOSIT_READY_STATES.includes(workspace.project_state as ProjectState)) {
    throw new Error(
      `Deposit cannot start a build from state ${workspace.project_state}`
    );
  }
  if (!workspace.final_value_minor)
    throw new Error('Workspace final value is not configured');
  if (
    workspace.billing_currency.toLowerCase() !==
    paymentIntent.currency.toLowerCase()
  ) {
    throw new Error('Deposit currency does not match the workspace quote');
  }

  const expectedAmount = depositAmountMinor(workspace.final_value_minor);
  if (paymentIntent.amount_received !== expectedAmount) {
    throw new Error(`Deposit amount mismatch: expected ${expectedAmount}`);
  }
  if (
    workspace.deposit_payment_intent_id &&
    workspace.deposit_payment_intent_id !== paymentIntent.id
  ) {
    throw new Error(
      'Workspace is already associated with a different deposit payment'
    );
  }

  return enqueueBuildAndAdvance({
    supabase,
    workspaceId,
    eventId: event.id,
    paymentIntentId: paymentIntent.id,
    source: 'payment_intent',
    workspaceUpdate: { deposit_payment_intent_id: paymentIntent.id },
  });
}

/**
 * The operator-invoiced half of the same gate.
 *
 * `deposit-invoice` prices off `setup_fee` (or an explicit operator override),
 * so the 20%-of-`final_value_minor` check that guards the self-serve Checkout
 * path cannot authorize these. What authorizes them instead is the invoice ID
 * the server itself recorded on the workspace when it created the invoice —
 * a client cannot mint one, and it is written before any money moves.
 *
 * Returns null (rather than throwing) for invoices that are not a concierge
 * deposit. Those are ordinary billing invoices and must not fail the webhook,
 * or Stripe would retry them forever.
 */
export async function enqueueFullBuildFromDepositInvoice(
  event: Stripe.Event,
  invoice: Stripe.Invoice
): Promise<DepositBuildEnqueueResult | null> {
  if (invoice.metadata?.['invoiceType'] !== 'deposit') return null;
  if (typeof invoice.id !== 'string' || invoice.id.length === 0) return null;

  const workspaceId =
    invoice.metadata['workspaceId'] || invoice.metadata['projectId'];
  if (!workspaceId || !UUID.test(workspaceId)) return null;

  const supabase = createSupabaseServiceRoleClient();
  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id, project_state, billing_currency, deposit_invoice_id')
    .eq('id', workspaceId)
    .maybeSingle();
  if (workspaceError) throw workspaceError;
  if (!workspace) return null;

  // A workspace outside the concierge lifecycle still gets its billing fields
  // updated by the caller; it just has no preview to build from.
  if (!DEPOSIT_READY_STATES.includes(workspace.project_state as ProjectState)) {
    console.info(
      `[Flowstarter] deposit invoice ${invoice.id} paid for workspace ${workspaceId} ` +
        `in state ${workspace.project_state}; no build enqueued`
    );
    return null;
  }

  if (workspace.deposit_invoice_id !== invoice.id) {
    throw new Error(
      'Paid deposit invoice does not match the invoice recorded on the workspace'
    );
  }
  if (
    workspace.billing_currency.toLowerCase() !== invoice.currency.toLowerCase()
  ) {
    throw new Error('Deposit currency does not match the workspace quote');
  }
  if (!invoice.amount_paid || invoice.amount_paid <= 0) {
    throw new Error('Deposit invoice reports no amount paid');
  }

  const enqueued = await enqueueBuildAndAdvance({
    supabase,
    workspaceId,
    eventId: event.id,
    source: 'deposit_invoice',
    workspaceUpdate: {},
  });
  await notifyDepositPaid(workspaceId);
  return enqueued;
}

type SupabaseServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * What the client approved, for the build that is about to start.
 *
 * The deposit is the moment the preview stops being a demo and becomes the
 * thing somebody paid for, so it is the right place to freeze what "approved"
 * meant. `workspaces.claimed_preview_id` is written by the claim and is the
 * only link between an owned workspace and the preview behind it; everything
 * else is read from the preview's own row, never from Stripe metadata or a
 * request body.
 *
 * `includeExpired` is true on purpose. A claimed preview is never expired by
 * `isExpired`, but the flag also covers the case where the TTL sweep has
 * already been through: the visitor has now paid, and the record of what they
 * were sold must not depend on how long the site stayed hosted.
 *
 * Never throws, and returns nothing for an operator-created workspace with no
 * claimed preview. A deposit that has already been taken must not be failed
 * over a missing provenance record — the payload simply omits the keys and the
 * worker behaves exactly as it did before they existed.
 */
async function approvedPreviewForWorkspace(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<{
  claimedPreviewId: string | null;
  previewIntent: ReturnType<typeof derivePreviewIntent>;
}> {
  try {
    const { data, error } = await supabase
      .from('workspaces')
      .select('claimed_preview_id')
      .eq('id', workspaceId)
      .maybeSingle();
    if (error) throw error;
    const claimedPreviewId = data?.claimed_preview_id ?? null;
    if (!claimedPreviewId)
      return { claimedPreviewId: null, previewIntent: null };

    const row = await loadFunnelPreview(claimedPreviewId, {
      includeExpired: true,
    });
    if (!row) return { claimedPreviewId, previewIntent: null };
    return {
      claimedPreviewId,
      previewIntent: derivePreviewIntent({
        previewId: row.previewId,
        manifest: row.manifest,
        artifactPath: row.artifactPath,
        templateSlug: row.templateSlug,
      }),
    };
  } catch (error) {
    console.warn(
      `[Flowstarter] deposit for ${workspaceId} could not read the approved ` +
        'preview; the build payload will not carry it: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return { claimedPreviewId: null, previewIntent: null };
  }
}

/**
 * The shared, idempotent half of both deposit paths: enqueue exactly one
 * FULL_SITE_BUILD, advance the workspace, and dispatch to the build worker.
 *
 * Two unique constraints make redelivery safe — one job per workspace, and one
 * job per Stripe event — so a retried webhook converges on the same job rather
 * than starting a second build.
 */
async function enqueueBuildAndAdvance(input: {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  eventId: string;
  paymentIntentId?: string;
  source: 'payment_intent' | 'deposit_invoice';
  workspaceUpdate: Record<string, unknown>;
}): Promise<DepositBuildEnqueueResult> {
  const { supabase, workspaceId } = input;
  const now = new Date().toISOString();

  const approved = await approvedPreviewForWorkspace(supabase, workspaceId);

  const insert = await supabase
    .from('flowstarter_agent_jobs')
    .insert({
      workspace_id: workspaceId,
      kind: 'FULL_SITE_BUILD',
      status: 'queued',
      stripe_event_id: input.eventId,
      stripe_payment_intent_id: input.paymentIntentId ?? null,
      payload: depositBuildPayload({
        source: input.source,
        claimedPreviewId: approved.claimedPreviewId,
        previewIntent: approved.previewIntent,
      }) as unknown as Json,
      updated_at: now,
    })
    .select('id, status')
    .single();

  let jobId: string;
  let duplicate = false;
  if (insert.error?.code === '23505') {
    duplicate = true;
    const existing = await supabase
      .from('flowstarter_agent_jobs')
      .select('id, status')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'FULL_SITE_BUILD')
      .single();
    if (existing.error || !existing.data)
      throw existing.error ?? new Error('Existing build job was not found');
    jobId = existing.data.id;
    if (
      existing.data.status === 'succeeded' ||
      existing.data.status === 'canceled'
    ) {
      return { workspaceId, jobId, duplicate: true };
    }
  } else if (insert.error || !insert.data) {
    throw insert.error ?? new Error('Could not enqueue full site build');
  } else {
    jobId = insert.data.id;
  }

  const stateUpdate = await supabase
    .from('workspaces')
    .update({
      project_state: ProjectState.DEPOSIT_PAID,
      deposit_status: 'paid',
      deposit_paid_at: now,
      outstanding_payment: false,
      ...input.workspaceUpdate,
    })
    .eq('id', workspaceId)
    .in('project_state', DEPOSIT_READY_STATES)
    .select('id')
    .single();
  if (stateUpdate.error) throw stateUpdate.error;

  // The ledger row is the commitment; dispatch is only a nudge to start it
  // sooner. Letting a failed nudge throw would fail the webhook *after* the
  // deposit is recorded and the job is queued, and Stripe would then retry for
  // days over something a retry cannot fix — an unreachable or unconfigured
  // worker. dispatchBuildJob never throws: it reports success for the work
  // that did happen and leaves an operator-visible trail for the nudge that
  // did not.
  await dispatchBuildJob({ supabase, workspaceId, jobId });
  return { workspaceId, jobId, duplicate };
}

/**
 * Nudges the build worker for a job the ledger already holds, and makes sure
 * a failed nudge is impossible to miss.
 *
 * The transport lives in `pipeline/dispatch.ts` so the operator's manual
 * re-dispatch (`pipeline/api.ts`) and this automatic one cannot disagree about
 * what dispatch means or what "unconfigured" looks like. This never throws —
 * the deposit must land either way — but it never merely warns into a log
 * nobody is tailing either: every failure, including "the worker is simply
 * not configured", is written to `project_events` as `build_dispatch_failed`
 * before returning, so it shows up on the project's timeline (and therefore
 * the pipeline board) the moment it happens rather than after the 15-minute
 * stall window in `board.ts` finally notices a job nobody picked up.
 */
async function dispatchBuildJob(input: {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  jobId: string;
}): Promise<void> {
  const { supabase, workspaceId, jobId } = input;
  try {
    await dispatchAgentJob(jobId);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'unknown dispatch error';
    // An unconfigured worker outside production is a normal local setup and
    // gets a quieter log level; everything else (production, or a configured
    // worker that actually rejected the call) is a real operator problem.
    const isExpectedLocalGap =
      error instanceof DispatchError &&
      process.env.NODE_ENV !== 'production' &&
      /not configured/.test(detail);
    const log = isExpectedLocalGap ? console.warn : console.error;
    log(
      `[Flowstarter] build job ${jobId} is queued for workspace ${workspaceId} ` +
        `but could not be dispatched; it needs picking up: ${detail}`
    );
    await recordDispatchFailure({ supabase, workspaceId, jobId, detail });
  }
}

/**
 * Best-effort audit trail for a dispatch nudge that did not happen. Never
 * throws: losing this note is not a reason to make the deposit itself fail,
 * it just means the operator falls back to the stall detector and the logs.
 */
async function recordDispatchFailure(input: {
  supabase: SupabaseServiceClient;
  workspaceId: string;
  jobId: string;
  detail: string;
}): Promise<void> {
  const { supabase, workspaceId, jobId, detail } = input;
  try {
    const { error } = await supabase.from('project_events').insert({
      workspace_id: workspaceId,
      kind: 'build_dispatch_failed',
      actor: 'system',
      payload: { jobId, detail } as Json,
    });
    if (error) {
      console.error(
        `[Flowstarter] could not record build_dispatch_failed for workspace ${workspaceId}: ${error.message}`
      );
    }
  } catch (error) {
    console.error(
      `[Flowstarter] could not record build_dispatch_failed for workspace ${workspaceId}:`,
      error
    );
  }
}

export function productionActivationAllowed(input: {
  projectState: string;
  finalStatus: string;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
}): boolean {
  return (
    input.projectState === ProjectState.HUMAN_QA &&
    input.finalStatus === 'paid' &&
    Boolean(input.stripeSubscriptionId) &&
    (input.subscriptionStatus === 'active' ||
      input.subscriptionStatus === 'trialing' ||
      input.subscriptionStatus === 'trial')
  );
}
