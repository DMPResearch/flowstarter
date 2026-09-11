/**
 * Connecting and disconnecting one workspace's Cal.com calendar.
 *
 * The booking page and its API route both need the same four facts: is a
 * calendar connected, what is the canonical link, where does Cal.com post, and
 * what secret does it sign with. Putting that in one module rather than in the
 * page and the route means the preview the client sees and the value the build
 * worker reads cannot drift apart, and it keeps the route to argument checking
 * and status codes.
 *
 * TENANCY. Every function here takes a workspace id the caller has already
 * authorised with `requireWorkspaceAccess`, and filters on it. These run on
 * the service-role client, which bypasses RLS, so that filter is the whole of
 * the isolation.
 *
 * THE SECRET. Generated once, on the connect that first sets a link, and kept
 * across later link edits: the client has already pasted it into Cal.com, and
 * rotating it silently on every save would break their webhook without telling
 * them. Disconnecting clears it, because at that point their Cal.com webhook
 * is pointing at a workspace that no longer wants deliveries, and the next
 * connect should hand them a fresh one.
 */
import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import {
  calEmbedSrc,
  calLinkRejectionMessage,
  parseCalLink,
  type CalLinkRejection,
} from './cal-link';
import { generateCalWebhookSecret } from './cal-webhook';

type SupabaseServiceClient = SupabaseClient<Database>;

export interface CalConnection {
  connected: boolean;
  /** Canonical `https://cal.com/...`, or empty when nothing is connected. */
  calComUrl: string;
  /** What the dashboard preview iframe loads, or null. */
  embedSrc: string | null;
  /** Where Cal.com should post. Stable whether or not anything is connected. */
  webhookUrl: string;
  /** Shown to the client so they can paste it into Cal.com. */
  webhookSecret: string | null;
}

/**
 * The absolute URL Cal.com posts to.
 *
 * Absolute, and falling back to the production origin, for the same reason the
 * dashboard link in an email is: this string is copied into a third party's
 * settings screen, where a relative path is not a degraded link but a broken
 * one.
 */
export function calWebhookUrl(workspaceId: string): string {
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    'https://flowstarter.net'
  ).replace(/\/+$/, '');
  return `${base}/api/integrations/cal/${workspaceId}`;
}

function connectionFrom(
  workspaceId: string,
  row: { cal_com_url: string | null; cal_com_webhook_secret: string | null }
): CalConnection {
  const raw = row.cal_com_url?.trim() ?? '';
  const parsed = raw ? parseCalLink(raw) : null;
  return {
    connected: Boolean(parsed?.ok),
    calComUrl: parsed?.ok ? parsed.link.url : raw,
    embedSrc: parsed?.ok ? calEmbedSrc(parsed.link) : null,
    webhookUrl: calWebhookUrl(workspaceId),
    webhookSecret: row.cal_com_webhook_secret ?? null,
  };
}

/** The connection as it stands, or null when the workspace does not exist. */
export async function loadCalConnection(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<CalConnection | null> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('cal_com_url, cal_com_webhook_secret')
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return connectionFrom(workspaceId, data);
}

export type CalConnectResult =
  | { ok: true; connection: CalConnection }
  | {
      ok: false;
      reason: CalLinkRejection | 'not_found' | 'write_failed';
      message: string;
    };

/**
 * Store a pasted link against the workspace and make sure a secret exists.
 *
 * The stored value is the canonical form, never the raw paste: the build
 * worker and the embed both read this column, and normalising once here is
 * what lets everything downstream treat it as trusted.
 */
export async function connectCalCom(
  supabase: SupabaseServiceClient,
  input: { workspaceId: string; rawLink: string; actor: string }
): Promise<CalConnectResult> {
  const parsed = parseCalLink(input.rawLink);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      message: calLinkRejectionMessage(parsed.reason),
    };
  }

  const { data: existing, error: readError } = await supabase
    .from('workspaces')
    .select('cal_com_url, cal_com_webhook_secret')
    .eq('id', input.workspaceId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing) {
    return { ok: false, reason: 'not_found', message: 'Workspace not found' };
  }

  const secret =
    existing.cal_com_webhook_secret?.trim() ||
    generateCalWebhookSecret(randomBytes);

  const { error: updateError } = await supabase
    .from('workspaces')
    .update({
      cal_com_url: parsed.link.url,
      cal_com_webhook_secret: secret,
    })
    .eq('id', input.workspaceId);
  if (updateError) {
    return {
      ok: false,
      reason: 'write_failed',
      message: 'Could not save your booking link.',
    };
  }

  // The ledger the rest of the concierge flow reads. The secret is never in
  // it: an event payload is read by operators and shown in admin screens.
  await recordEvent(supabase, input.workspaceId, 'booking_cal_connected', {
    calComUrl: parsed.link.url,
    actor: input.actor,
  });

  return {
    ok: true,
    connection: connectionFrom(input.workspaceId, {
      cal_com_url: parsed.link.url,
      cal_com_webhook_secret: secret,
    }),
  };
}

/**
 * Forget the link and the secret.
 *
 * Bookings already recorded stay: they happened, the client may still need to
 * look them up, and deleting a client's own history because they changed
 * calendar tools would be the wrong default. The dashboard list says as much.
 */
export async function disconnectCalCom(
  supabase: SupabaseServiceClient,
  input: { workspaceId: string; actor: string }
): Promise<CalConnection | null> {
  const { data: existing, error: readError } = await supabase
    .from('workspaces')
    .select('id')
    .eq('id', input.workspaceId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing) return null;

  const { error } = await supabase
    .from('workspaces')
    .update({ cal_com_url: null, cal_com_webhook_secret: null })
    .eq('id', input.workspaceId);
  if (error) throw error;

  await recordEvent(supabase, input.workspaceId, 'booking_cal_disconnected', {
    actor: input.actor,
  });

  return connectionFrom(input.workspaceId, {
    cal_com_url: null,
    cal_com_webhook_secret: null,
  });
}

/** Best effort. A missing ledger row must not fail a save that succeeded. */
async function recordEvent(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await supabase.from('project_events').insert({
      workspace_id: workspaceId,
      kind,
      actor: String(payload.actor ?? 'system'),
      payload: payload as Json,
    });
    if (error) throw error;
  } catch (error) {
    console.warn(
      `[cal] could not record ${kind} for workspace ${workspaceId}: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
}
