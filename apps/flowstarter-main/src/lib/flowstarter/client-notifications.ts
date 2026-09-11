/**
 * Send a client one email per thing that happened, and never more than one.
 *
 * The product has had a working mailer and a set of templates for months and
 * still emailed a paying client nothing between paying and asking us where
 * their site was. The missing piece was never the transport. It was that every
 * moment worth telling somebody about lives inside a Stripe webhook, a build
 * callback or a detached generator, and in all three places an email is both
 * easy to forget and dangerous to add: a throw inside a webhook handler makes
 * Stripe retry for days, and a retry that resends is worse than no email.
 *
 * So this module owns both halves of that problem for every workspace-scoped
 * notice:
 *
 *   - It cannot throw. Every failure, including "there is no address on the
 *     workspace" and "RESEND_API_KEY is not set", comes back as a reason on the
 *     result and a line in the log. A caller inside a webhook can await it
 *     without a try/catch and be sure the webhook still returns 200.
 *   - It sends once. `project_events` is the ledger the rest of the concierge
 *     flow already uses for "this has been done" (see `guest_account_provisioned`
 *     in guest-deposit.ts), so a redelivered Stripe event or a re-run deploy
 *     finds the marker and stops. The marker is written only after a genuinely
 *     successful send, which is the important asymmetry: a send that failed
 *     because the mailer was unconfigured must be retryable once it is.
 *
 * `dedupeKey` is for the notices that legitimately repeat. "Your site is live"
 * is true again for every new deploy version, so it keys on the version; "your
 * deposit is in" happens once per workspace and keys on nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { sendEmail } from '@/lib/email';
import type { RenderedEmail } from '@/lib/email-templates/client-notices';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

type SupabaseServiceClient = SupabaseClient<Database>;

/** One `project_events.kind` for all of them; the notice is in the payload. */
export const CLIENT_EMAIL_EVENT = 'client_email_sent';

/**
 * Kept as a closed union rather than a free string so the ledger stays
 * greppable and a typo cannot silently create a second notice that never
 * dedupes against the first.
 */
export type ClientNotification =
  | 'deposit_paid'
  | 'balance_invoice'
  | 'site_live'
  // Keys on the build job's id, so a client hears once per stopped build and
  // a retry that stops again is a new thing worth saying.
  | 'build_failed'
  // Keys on the Cal.com booking uid, so a client hears about each booking
  // once and a redelivered webhook is silent.
  | 'booking_created';

export type ClientNotifySkipReason =
  | 'already_sent'
  | 'no_recipient'
  | 'workspace_missing'
  | 'lookup_failed'
  | 'send_failed';

export interface ClientNotifyResult {
  sent: boolean;
  reason?: ClientNotifySkipReason;
}

/** What a template gets to work with, resolved once from the workspace row. */
export interface ClientRecipient {
  workspaceId: string;
  email: string;
  clientName: string | null;
  businessName: string | null;
  dashboardUrl: string;
}

/**
 * Where the client's own view of the project lives.
 *
 * Falls back to the public production origin rather than a relative path: an
 * email is read outside any browser tab we control, so a relative link is not
 * a degraded link, it is a broken one.
 */
export function clientDashboardUrl(workspaceId: string): string {
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    'https://flowstarter.net'
  ).replace(/\/+$/, '');
  return `${base}/dashboard/projects/${workspaceId}`;
}

/**
 * True when this workspace has already been told this exact thing.
 *
 * A select rather than a unique index because `project_events` has none, and
 * adding one would mean a migration for a guard the rest of this table's
 * users already do by reading. The window between the read and the insert is
 * real; the cost of losing that race is one duplicate email, which is the
 * cheapest failure in this module by a wide margin.
 */
async function alreadySent(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  notification: ClientNotification,
  dedupeKey: string | undefined
): Promise<boolean> {
  const { data, error } = await supabase
    .from('project_events')
    .select('payload')
    .eq('workspace_id', workspaceId)
    .eq('kind', CLIENT_EMAIL_EVENT);
  if (error) throw error;
  return (data ?? []).some((row) => {
    const payload = (row.payload ?? {}) as {
      notification?: string;
      dedupeKey?: string | null;
    };
    if (payload.notification !== notification) return false;
    return (payload.dedupeKey ?? null) === (dedupeKey ?? null);
  });
}

/**
 * Sends one notice to the workspace's client, at most once.
 *
 * `render` is a callback rather than a rendered email so nothing is composed
 * for a workspace that has no address or has already been written to, and so
 * the template can use the client's own name without every caller having to
 * fetch the workspace row for itself.
 */
export async function notifyClientOnce(input: {
  supabase?: SupabaseServiceClient;
  workspaceId: string;
  notification: ClientNotification;
  /** Set when the same notice may legitimately happen again later. */
  dedupeKey?: string;
  render: (recipient: ClientRecipient) => RenderedEmail;
  /** Extra context written to the ledger row, for an operator reading it. */
  detail?: Record<string, unknown>;
}): Promise<ClientNotifyResult> {
  const { workspaceId, notification, dedupeKey } = input;
  const label = `${notification}${dedupeKey ? `/${dedupeKey}` : ''}`;
  try {
    const supabase = input.supabase ?? createSupabaseServiceRoleClient();

    const { data: workspace, error } = await supabase
      .from('workspaces')
      .select('id, client_email, client_name, client_business_name, name')
      .eq('id', workspaceId)
      .maybeSingle();
    if (error) throw error;
    if (!workspace) {
      console.warn(
        `[client-email] ${label}: workspace ${workspaceId} no longer exists`
      );
      return { sent: false, reason: 'workspace_missing' };
    }

    const to = workspace.client_email?.trim();
    if (!to) {
      // Loud, because it is a data gap an operator can close in one edit and
      // the client is otherwise silently getting nothing.
      console.warn(
        `[client-email] ${label}: workspace ${workspaceId} has no client_email, ` +
          'so the client cannot be told'
      );
      return { sent: false, reason: 'no_recipient' };
    }

    if (await alreadySent(supabase, workspaceId, notification, dedupeKey)) {
      console.info(
        `[client-email] ${label}: already sent for workspace ${workspaceId}, skipping`
      );
      return { sent: false, reason: 'already_sent' };
    }

    const { subject, html } = input.render({
      workspaceId,
      email: to,
      clientName: workspace.client_name,
      businessName: workspace.client_business_name ?? workspace.name,
      dashboardUrl: clientDashboardUrl(workspaceId),
    });

    const result = await sendEmail({ to, subject, html });
    if (!result.success) {
      // Not recorded: an unconfigured or briefly unavailable mailer must not
      // be able to permanently consume this notice.
      console.error(
        `[client-email] ${label}: send failed for workspace ${workspaceId}: ` +
          (result.error ?? 'unknown error')
      );
      return { sent: false, reason: 'send_failed' };
    }

    await recordSent(supabase, {
      workspaceId,
      notification,
      dedupeKey,
      subject,
      detail: input.detail,
    });
    return { sent: true };
  } catch (error) {
    // The contract: a caller inside a Stripe webhook or a deploy can await
    // this without guarding it.
    console.error(
      `[client-email] ${label}: could not notify workspace ${workspaceId}: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return { sent: false, reason: 'lookup_failed' };
  }
}

/**
 * The marker the next delivery reads. Best effort by necessity: the email is
 * already gone, so failing here would turn one lost ledger row into a second
 * copy of an email the client has read.
 */
async function recordSent(
  supabase: SupabaseServiceClient,
  row: {
    workspaceId: string;
    notification: ClientNotification;
    dedupeKey: string | undefined;
    subject: string;
    detail: Record<string, unknown> | undefined;
  }
): Promise<void> {
  try {
    const { error } = await supabase.from('project_events').insert({
      workspace_id: row.workspaceId,
      kind: CLIENT_EMAIL_EVENT,
      actor: 'system:client_email',
      payload: {
        notification: row.notification,
        dedupeKey: row.dedupeKey ?? null,
        subject: row.subject,
        ...(row.detail ?? {}),
      } as Json,
    });
    if (error) throw error;
  } catch (error) {
    console.error(
      `[client-email] sent ${row.notification} to workspace ${row.workspaceId} ` +
        'but could not record it; a retry may send it again: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
}
