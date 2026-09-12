import 'server-only';
/**
 * Tells an operator something broke, at most once per dedupe window.
 *
 * The decision of whether this occurrence is worth a fresh email lives in
 * `alerts.ts`; this module only does what that decision says: read the last
 * time this exact dedupe key fired from `ops_alerts`, send through Resend
 * when the window has elapsed, and write the row back so the next occurrence
 * can make the same check.
 *
 * Same contract as `notifyClientOnce`: this cannot throw. Every caller is
 * inside a build worker's failure path, a client-email failure branch, or a
 * CI health check, and none of them may fail *because the alert itself*
 * failed to send.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { sendEmail } from '@/lib/email';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  alertSeverity,
  buildDedupeKey,
  shouldSendAlert,
  type AlertEvent,
} from './alerts';

type SupabaseServiceClient = SupabaseClient<Database>;

export type OpsAlertSkipReason =
  | 'suppressed'
  | 'no_operator_email'
  | 'send_failed'
  | 'error';

export interface OpsAlertResult {
  sent: boolean;
  reason?: OpsAlertSkipReason;
}

export interface SendOpsAlertInput {
  supabase?: SupabaseServiceClient;
  event: AlertEvent;
  /** Identifies "the same thing happening again", see `alerts.ts`. */
  discriminator: string;
  title: string;
  detail?: Record<string, unknown>;
  /** Set when the alert is about one tenant's workspace. */
  workspaceId?: string | null;
  now?: Date;
}

function operatorEmail(): string | null {
  const value = process.env.OPERATOR_ALERT_EMAIL?.trim();
  return value ? value : null;
}

interface OpsAlertRow {
  id: string;
  dedupe_key: string;
  occurrence_count: number;
  last_sent_at: string;
}

export async function sendOpsAlert(
  input: SendOpsAlertInput
): Promise<OpsAlertResult> {
  const dedupeKey = buildDedupeKey(input.event, input.discriminator);
  const now = input.now ?? new Date();
  const detail = input.detail ?? {};

  try {
    const supabase = input.supabase ?? createSupabaseServiceRoleClient();

    const { data: existing, error: selectError } = await supabase
      .from('ops_alerts')
      .select('id, dedupe_key, occurrence_count, last_sent_at')
      .eq('dedupe_key', dedupeKey)
      .maybeSingle<OpsAlertRow>();
    if (selectError) throw selectError;

    const lastSentAt = existing?.last_sent_at
      ? new Date(existing.last_sent_at)
      : null;

    if (!shouldSendAlert(input.event, lastSentAt, now)) {
      // Still real information for whoever reads the ledger later: bump the
      // count without sending. Best effort, same reasoning as
      // notifyClientOnce's marker write: a failure to record a suppressed
      // occurrence must not turn into a second email.
      await bumpOccurrence(supabase, existing);
      console.info(
        `[ops-alert] ${dedupeKey}: suppressed, last sent ${lastSentAt?.toISOString()}`
      );
      return { sent: false, reason: 'suppressed' };
    }

    const to = operatorEmail();
    if (!to) {
      console.error(
        `[ops-alert] ${dedupeKey}: OPERATOR_ALERT_EMAIL is not set, cannot notify an operator`
      );
      return { sent: false, reason: 'no_operator_email' };
    }

    const severity = alertSeverity(input.event);
    const result = await sendEmail({
      to,
      subject: `[Flowstarter ${severity}] ${input.title}`,
      html: renderAlertEmail({ severity, title: input.title, detail }),
    });
    if (!result.success) {
      console.error(
        `[ops-alert] ${dedupeKey}: send failed: ${
          result.error ?? 'unknown error'
        }`
      );
      return { sent: false, reason: 'send_failed' };
    }

    await recordSent(supabase, {
      dedupeKey,
      event: input.event,
      severity,
      title: input.title,
      detail,
      workspaceId: input.workspaceId ?? null,
      now,
      previousOccurrenceCount: existing?.occurrence_count ?? 0,
      existingId: existing?.id ?? null,
    });
    return { sent: true };
  } catch (error) {
    console.error(
      `[ops-alert] ${dedupeKey}: could not send: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return { sent: false, reason: 'error' };
  }
}

async function bumpOccurrence(
  supabase: SupabaseServiceClient,
  existing: OpsAlertRow | null
): Promise<void> {
  if (!existing) return;
  try {
    const { error } = await supabase
      .from('ops_alerts')
      .update({ occurrence_count: existing.occurrence_count + 1 })
      .eq('id', existing.id);
    if (error) throw error;
  } catch (error) {
    console.error(
      `[ops-alert] ${existing.dedupe_key}: could not bump the occurrence count: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
}

async function recordSent(
  supabase: SupabaseServiceClient,
  row: {
    dedupeKey: string;
    event: AlertEvent;
    severity: string;
    title: string;
    detail: Record<string, unknown>;
    workspaceId: string | null;
    now: Date;
    previousOccurrenceCount: number;
    existingId: string | null;
  }
): Promise<void> {
  try {
    const nowIso = row.now.toISOString();
    if (row.existingId) {
      const { error } = await supabase
        .from('ops_alerts')
        .update({
          occurrence_count: row.previousOccurrenceCount + 1,
          last_sent_at: nowIso,
          title: row.title,
          detail: row.detail as Json,
        })
        .eq('id', row.existingId);
      if (error) throw error;
      return;
    }
    const { error } = await supabase.from('ops_alerts').insert({
      dedupe_key: row.dedupeKey,
      event: row.event,
      severity: row.severity,
      title: row.title,
      detail: row.detail as Json,
      workspace_id: row.workspaceId,
      occurrence_count: 1,
      last_sent_at: nowIso,
    });
    if (error) throw error;
  } catch (error) {
    // The email is already gone. Failing here must not look like the alert
    // never fired, so it is logged, not thrown.
    console.error(
      `[ops-alert] ${row.dedupeKey}: sent but could not record it: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
}

function renderAlertEmail(input: {
  severity: string;
  title: string;
  detail: Record<string, unknown>;
}): string {
  const rows = Object.entries(input.detail)
    .map(
      ([key, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#666;">${escapeHtml(
          key
        )}</td><td style="padding:4px 0;"><code>${escapeHtml(
          formatDetailValue(value)
        )}</code></td></tr>`
    )
    .join('');
  return `
    <div style="font-family:system-ui,sans-serif;max-width:560px;">
      <p style="text-transform:uppercase;letter-spacing:0.05em;color:${
        input.severity === 'critical' ? '#b91c1c' : '#b45309'
      };font-size:12px;margin:0 0 8px;">${escapeHtml(input.severity)}</p>
      <h1 style="font-size:18px;margin:0 0 16px;">${escapeHtml(
        input.title
      )}</h1>
      ${rows ? `<table>${rows}</table>` : ''}
    </div>
  `;
}

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
