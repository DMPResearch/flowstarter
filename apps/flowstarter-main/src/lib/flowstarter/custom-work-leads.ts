import 'server-only';

/**
 * Reading and writing `custom_work_leads`.
 *
 * The table is the funnel's other exit: a visitor whose brief is custom work
 * gets a row here instead of a generation run (see `./scope-route` for why, and
 * `supabase/migrations/20260915100000_custom_work_leads.sql` for the schema and
 * its server-only classification).
 *
 * Two rules this module keeps:
 *
 *   The write never fails the visitor. Somebody who has just answered four
 *   questions and been offered a call must see the calendar whether or not the
 *   insert worked. A failed insert is logged and returns null; the offer still
 *   renders. The alternative -- an error page because a lead could not be
 *   filed -- loses the lead twice.
 *
 *   No query filters by workspace, because there is no workspace. That is not
 *   an oversight in a tenant-scoped table, it is the defining property of this
 *   one: a row exists precisely because no workspace will ever be created for
 *   the brief. The protection is RLS with zero policies plus revoked grants,
 *   proved by `scripts/verify-rls-local.mjs`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import type { AcceptableUse, Scope, ScopeRoute } from './scope-route';

type ServiceClient = SupabaseClient<Database>;

/** Where the lead came from. See the column comment in the migration. */
export type CustomWorkLeadSource = 'funnel' | 'contact_form';

export type CustomWorkBookingStatus =
  | 'offered'
  | 'enquiry'
  | 'booked'
  | 'contacted'
  | 'closed';

export interface RecordCustomWorkLeadInput {
  name: string;
  email: string;
  description: string;
  linkUrl?: string | null;
  linkTitle?: string | null;
  clarification?: string | null;
  scope: Scope;
  confidence: number;
  evidence: readonly string[];
  classifier: string;
  route: ScopeRoute;
  routeRule: string;
  acceptableUse?: AcceptableUse | null;
  source: CustomWorkLeadSource;
  bookingStatus: CustomWorkBookingStatus;
  supabase?: ServiceClient;
}

export interface CustomWorkLeadRow {
  id: string;
  name: string;
  email: string;
  description: string;
  link_url: string | null;
  link_title: string | null;
  clarification: string | null;
  scope: string;
  scope_confidence: number;
  scope_evidence: Json;
  classifier: string;
  route: string;
  route_rule: string;
  acceptable_use: string | null;
  source: string;
  booking_status: string;
  booking_reference: string | null;
  contacted_at: string | null;
  contacted_by: string | null;
  confirmation_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  'id, name, email, description, link_url, link_title, clarification, scope, ' +
  'scope_confidence, scope_evidence, classifier, route, route_rule, ' +
  'acceptable_use, source, booking_status, booking_reference, contacted_at, ' +
  'contacted_by, confirmation_sent_at, created_at, updated_at';

/** Longest free text any one column keeps. The columns are text; this is sanity. */
const MAX_TEXT = 5_000;

function capped(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null;
}

/**
 * File one lead. Returns its id, or null when it could not be written.
 *
 * Never throws: see the module doc. The caller is on the visitor's critical
 * path and has something better to do with a database error than show it.
 */
export async function recordCustomWorkLead(
  input: RecordCustomWorkLeadInput
): Promise<string | null> {
  try {
    const supabase = input.supabase ?? createSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('custom_work_leads')
      .insert({
        name: (input.name ?? '').trim().slice(0, MAX_TEXT) || 'Not given',
        email: (input.email ?? '').trim().slice(0, MAX_TEXT),
        description: capped(input.description) ?? '',
        link_url: capped(input.linkUrl),
        link_title: capped(input.linkTitle),
        clarification: capped(input.clarification),
        scope: input.scope,
        scope_confidence: Math.min(1, Math.max(0, input.confidence || 0)),
        scope_evidence: [...input.evidence] as unknown as Json,
        classifier: input.classifier,
        route: input.route,
        route_rule: input.routeRule,
        acceptable_use: input.acceptableUse ?? null,
        source: input.source,
        booking_status: input.bookingStatus,
      })
      .select('id')
      .single<{ id: string }>();
    if (error) throw error;
    return data?.id ?? null;
  } catch (error) {
    console.error(
      '[custom-work] could not file the lead:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return null;
  }
}

/** Note that the branded confirmation actually reached the visitor. */
export async function markConfirmationSent(
  id: string,
  supabase?: ServiceClient
): Promise<void> {
  try {
    const client = supabase ?? createSupabaseServiceRoleClient();
    const { error } = await client
      .from('custom_work_leads')
      .update({ confirmation_sent_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  } catch (error) {
    console.warn(
      '[custom-work] could not record the confirmation send:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }
}

/**
 * How many leads the board loads. Unbounded is how a board OOMs on the one day
 * it matters; this is generous for a studio that takes custom work by the week.
 */
export const CUSTOM_WORK_LEAD_LIMIT = 200;

/** Newest first. The whole lane, including the ones already contacted. */
export async function listCustomWorkLeads(
  supabase?: ServiceClient
): Promise<CustomWorkLeadRow[]> {
  const client = supabase ?? createSupabaseServiceRoleClient();
  const { data, error } = await client
    .from('custom_work_leads')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(CUSTOM_WORK_LEAD_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as CustomWorkLeadRow[];
}

/**
 * The operator's "Mark contacted".
 *
 * `contacted` is deliberately not terminal and does not clear the row from the
 * lane: an operator who has replied still wants to see, next week, that nobody
 * ever booked. `closed` is what ends it, and only the operator sets that.
 */
export async function markCustomWorkLeadContacted(input: {
  id: string;
  by: string;
  supabase?: ServiceClient;
}): Promise<CustomWorkLeadRow | null> {
  const client = input.supabase ?? createSupabaseServiceRoleClient();
  const { data, error } = await client
    .from('custom_work_leads')
    .update({
      booking_status: 'contacted',
      contacted_at: new Date().toISOString(),
      contacted_by: input.by.slice(0, 200),
    })
    .eq('id', input.id)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as CustomWorkLeadRow | null) ?? null;
}
