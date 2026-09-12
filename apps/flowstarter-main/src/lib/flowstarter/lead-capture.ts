/**
 * Every rule behind "a contact form on a client's site creates a lead in that
 * client's workspace, and in nobody else's".
 *
 * The storage half of this has existed for months: a `leads` table keyed by
 * `workspace_id`, RLS on, proved by the tenant isolation lane. The site half
 * did not. Generated sites posted nowhere, and the templates' contact forms
 * were `mailto:` links, so the enquiries tile on a client's dashboard could
 * only ever show zero.
 *
 * WHAT IDENTIFIES THE TENANT. Not the workspace id. The value has to ship in
 * static HTML that any visitor can read, and an id is the key half the schema
 * is addressed by, appears in dashboard URLs, and cannot be changed. So each
 * workspace carries `lead_capture_token`: 32 random bytes in base64url, unique,
 * rotatable, and worth exactly one capability - create one lead for this
 * workspace. It reads nothing. It is accepted on one endpoint. Losing it costs
 * the client a rotation and a rebuild, not a workspace.
 *
 * WHAT STOPS A TOKEN FROM BEING USEFUL TO ANYBODY ELSE. Four rules, in this
 * order, all of them here rather than in the route so they can be read and
 * tested without a request:
 *
 *   1. Shape. A preview token is refused before any query runs, and anything
 *      that is not base64url is refused before any query runs, so the endpoint
 *      cannot be used as an oracle for which tokens exist.
 *   2. Origin. The submission has to come from one of this workspace's own
 *      hostnames - the final site, the preview it was claimed from, or a custom
 *      domain on `workspace_hosts`. Somebody else's page carrying a scraped
 *      token gets a 403, and the CORS preflight never allows their origin.
 *   3. Rate. Per token and per IP.
 *   4. Content. Lengths by rule, a honeypot that is silently accepted and
 *      discarded, and the spam classifier that has always decided `new` from
 *      `spam`.
 *
 * PREVIEWS CANNOT SEND. A funnel preview belongs to nobody: there is no
 * workspace behind it and therefore no tenant a lead could belong to. It gets a
 * token of a shape a real one can never have (see `PREVIEW_TOKEN_PREFIX`) and
 * the endpoint answers it with a friendly 403 rather than a 404, so the form on
 * the preview can say why instead of looking broken.
 */
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import {
  finalHostname,
  previewHostname,
  type HostnameOptions,
} from '@/lib/hosting/site-hostnames';
import { withTenant } from '@/lib/tenancy';

type SupabaseServiceClient = SupabaseClient<Database>;

// ─── The token ─────────────────────────────────────────────────────────────

/** 32 bytes, as the column comment and the migration both say. */
export const LEAD_CAPTURE_TOKEN_BYTES = 32;

/**
 * base64url, and at least as long as a minted one. The same expression is the
 * check constraint on `workspaces.lead_capture_token`, so a value that fails
 * here could not have been stored either.
 *
 * The floor is 43 rather than 32 for one specific reason: a canonical UUID is
 * 36 characters of hex and hyphens, which is base64url, so a lower floor would
 * make a workspace id a syntactically valid token and let the endpoint be
 * probed with one. The whole point of this column is that the id is not the
 * key, and the shape should say so before any query does.
 */
export const LEAD_CAPTURE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * The shape a funnel preview's token has, and a real one provably cannot.
 *
 * The dot is the load-bearing character: it is outside base64url, so the
 * column's check constraint refuses it, so no minted token can ever collide
 * with a preview token however unlucky the random bytes are. A prefix inside
 * the alphabet would have made "previews cannot send" a probability rather
 * than a fact.
 */
export const PREVIEW_TOKEN_PREFIX = 'preview.';

/** A fresh token. The database mints its own by default; this is for rotation. */
export function mintLeadCaptureToken(): string {
  return randomBytes(LEAD_CAPTURE_TOKEN_BYTES).toString('base64url');
}

/** The token a funnel preview's contact form is built with. */
export function previewLeadCaptureToken(previewId: string): string {
  return `${PREVIEW_TOKEN_PREFIX}${previewId}`;
}

export function isPreviewLeadCaptureToken(value: string): boolean {
  return value.startsWith(PREVIEW_TOKEN_PREFIX);
}

export function isLeadCaptureToken(value: unknown): value is string {
  return typeof value === 'string' && LEAD_CAPTURE_TOKEN_PATTERN.test(value);
}

/**
 * Where a site posts. One builder, used by the codegen injector through the
 * site config it writes and by the dashboard's embed snippet, so the path can
 * never be spelled two ways.
 */
export function leadCaptureEndpoint(
  platformHost: string,
  token: string
): string {
  return `https://${platformHost
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')}/api/leads/capture/${token}`;
}

// ─── Minting, on demand and on rotation ────────────────────────────────────

export interface WorkspaceLeadCapture {
  workspaceId: string;
  token: string;
  slug: string;
}

/**
 * This workspace's token, minting one if the row somehow has none.
 *
 * The column is `not null` with a default, so the mint branch is for a row
 * written before the migration by a database that has since been restored, not
 * for the normal path. It is here because the build reads this and a build that
 * silently emits a site with no token is worse than one that writes a token.
 */
export async function ensureLeadCaptureToken(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<WorkspaceLeadCapture | null> {
  const { data, error } = await supabase
    .from('workspaces')
    .select('id, slug, lead_capture_token')
    .eq('id', workspaceId)
    .maybeSingle<{
      id: string;
      slug: string;
      lead_capture_token: string | null;
    }>();
  if (error) throw error;
  if (!data) return null;

  if (isLeadCaptureToken(data.lead_capture_token)) {
    return {
      workspaceId: data.id,
      slug: data.slug,
      token: data.lead_capture_token,
    };
  }

  const token = mintLeadCaptureToken();
  const { error: writeError } = await supabase
    .from('workspaces')
    .update({ lead_capture_token: token })
    .eq('id', workspaceId);
  if (writeError) throw writeError;
  return { workspaceId: data.id, slug: data.slug, token };
}

/**
 * A new token for this workspace, and the old one dead from that moment.
 *
 * The client's site keeps posting the old token until it is rebuilt, and those
 * posts are refused. That is the honest behaviour and the page says so before
 * asking for confirmation: rotation is for a token that got somewhere it should
 * not have been, and a rotation that left the old one working would not be one.
 */
export async function rotateLeadCaptureToken(
  supabase: SupabaseServiceClient,
  input: { workspaceId: string; actor: string }
): Promise<WorkspaceLeadCapture | null> {
  const token = mintLeadCaptureToken();
  const { data, error } = await supabase
    .from('workspaces')
    .update({ lead_capture_token: token })
    .eq('id', input.workspaceId)
    .select('id, slug, lead_capture_token')
    .maybeSingle<{ id: string; slug: string; lead_capture_token: string }>();
  if (error) throw error;
  if (!data) return null;

  // The ledger records that it happened and by whom. It never records the
  // token: a public value is still not something to leave in an event payload
  // that operators read.
  await recordLeadEvent(supabase, input.workspaceId, 'lead_capture_rotated', {
    actor: input.actor,
  });

  return {
    workspaceId: data.id,
    slug: data.slug,
    token: data.lead_capture_token,
  };
}

// ─── Resolving a tenant from a token ───────────────────────────────────────

export interface CaptureTenant {
  workspaceId: string;
  slug: string;
  clientEmail: string | null;
  /** Every hostname this workspace answers to, as origins. */
  origins: string[];
}

/**
 * The workspace a token belongs to, with the origins its site is served from,
 * or null.
 *
 * Null covers both "no such token" and "a token whose workspace has since been
 * deleted", and the endpoint answers both the same way, so a caller cannot tell
 * a wrong guess from a retired one.
 */
export async function resolveCaptureTenant(
  supabase: SupabaseServiceClient,
  token: string,
  options?: HostnameOptions
): Promise<CaptureTenant | null> {
  if (!isLeadCaptureToken(token)) return null;

  const { data, error } = await supabase
    .from('workspaces')
    .select('id, slug, client_email, claimed_preview_id')
    .eq('lead_capture_token', token)
    .maybeSingle<{
      id: string;
      slug: string;
      client_email: string | null;
      claimed_preview_id: string | null;
    }>();
  if (error) throw error;
  if (!data) return null;

  // `withTenant` is what keeps the host lookup pinned to this workspace: the
  // token resolved one id and every further read is filtered by it, so a
  // second workspace's hostname can never end up on this one's allow list.
  const { data: hosts, error: hostsError } = await withTenant(supabase, data.id)
    .from('workspace_hosts')
    .select('hostname');
  if (hostsError) throw hostsError;

  return {
    workspaceId: data.id,
    slug: data.slug,
    clientEmail: data.client_email,
    origins: leadCaptureOrigins(
      {
        slug: data.slug,
        previewId: data.claimed_preview_id,
        customHostnames: (
          (hosts ?? []) as unknown as {
            hostname: string;
          }[]
        ).map((row) => row.hostname),
      },
      options
    ),
  };
}

// ─── The origin rule ───────────────────────────────────────────────────────

/**
 * Every origin this workspace's own site can be served from, and nothing else.
 *
 * Three sources, all of them derived rather than configured: the final hostname
 * the slug mints, the preview hostname the workspace was claimed from (a paid
 * site and its preview both exist for a while, and a form submitted from the
 * preview of a claimed project is still this client's enquiry), and whatever
 * custom domains `workspace_hosts` carries.
 *
 * https only. A site we deploy is behind Caddy with a certificate; an http
 * origin claiming to be that hostname is not it.
 */
export function leadCaptureOrigins(
  input: {
    slug: string;
    previewId?: string | null;
    customHostnames?: string[];
  },
  options?: HostnameOptions
): string[] {
  const hostnames: string[] = [];

  try {
    hostnames.push(finalHostname(input.slug, options));
  } catch {
    // A slug that cannot make a hostname makes no origin either. The endpoint
    // then refuses every submission for this workspace, which is the correct
    // failure: there is no site it could legitimately have come from.
  }

  if (input.previewId) {
    try {
      hostnames.push(previewHostname(input.previewId, options));
    } catch {
      // Same reasoning.
    }
  }

  for (const hostname of input.customHostnames ?? []) {
    const clean = hostname.trim().toLowerCase();
    if (clean) hostnames.push(clean);
  }

  return Array.from(new Set(hostnames.map((host) => `https://${host}`)));
}

/**
 * The origin a request is actually from, or null.
 *
 * `Origin` first, because a browser sets it on every cross-origin POST and
 * cannot be talked out of it by the page. `Referer` is the fallback for the
 * handful of privacy setups that strip `Origin` on a form post; it is reduced
 * to its origin, so a path can never widen what matched.
 */
export function requestOrigin(headers: {
  get(name: string): string | null;
}): string | null {
  const origin = headers.get('origin')?.trim();
  if (origin && origin !== 'null') return normaliseOrigin(origin);

  const referer = headers.get('referer')?.trim();
  if (referer) return normaliseOrigin(referer);

  return null;
}

function normaliseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** True when this origin is one of the workspace's own. */
export function originAllowed(
  origin: string | null,
  allowed: string[]
): boolean {
  if (!origin) return false;
  return allowed.some((candidate) => candidate.toLowerCase() === origin);
}

// ─── The body ──────────────────────────────────────────────────────────────

/**
 * The field no human ever fills in.
 *
 * Named for what a bot's autofill heuristics look for rather than for what it
 * is, and hidden in the markup the injector writes. A submission carrying it is
 * accepted with the same 201 as any other and then dropped: telling a bot it
 * was caught is telling it what to change.
 */
export const HONEYPOT_FIELD = 'company_website';

export const LEAD_FIELD_LIMITS = {
  name: 200,
  email: 320,
  phone: 50,
  message: 5000,
  page: 300,
} as const;

export interface LeadCaptureBody {
  name: string;
  email: string;
  message: string;
  phone: string | null;
  page: string | null;
  honeypot: boolean;
}

export type LeadCaptureParse =
  | { ok: true; body: LeadCaptureBody }
  | { ok: false; message: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The body, by rule.
 *
 * Deliberately hand-rolled rather than a Zod schema: every message here is read
 * by a visitor on somebody's small business website, in a box the template
 * renders, so they are sentences rather than validator output.
 */
export function parseLeadCaptureBody(input: unknown): LeadCaptureParse {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Send a name, an email and a message.' };
  }
  const raw = input as Record<string, unknown>;

  const honeypot = Boolean(text(raw[HONEYPOT_FIELD]));

  const name = text(raw.name);
  const email = text(raw.email);
  const message = text(raw.message);
  const phone = text(raw.phone);
  const page = text(raw.page);

  if (!name) return { ok: false, message: 'Add your name.' };
  if (name.length > LEAD_FIELD_LIMITS.name) {
    return { ok: false, message: 'That name is too long.' };
  }
  if (!email) return { ok: false, message: 'Add an email address.' };
  if (email.length > LEAD_FIELD_LIMITS.email || !EMAIL_PATTERN.test(email)) {
    return { ok: false, message: 'That email address does not look right.' };
  }
  if (!message) return { ok: false, message: 'Add a message.' };
  if (message.length > LEAD_FIELD_LIMITS.message) {
    return { ok: false, message: 'That message is too long.' };
  }
  if (phone && phone.length > LEAD_FIELD_LIMITS.phone) {
    return { ok: false, message: 'That phone number is too long.' };
  }

  return {
    ok: true,
    body: {
      name,
      email,
      message,
      phone: phone || null,
      page: page ? page.slice(0, LEAD_FIELD_LIMITS.page) : null,
      honeypot,
    },
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// ─── Spam ──────────────────────────────────────────────────────────────────

/**
 * The classifier that has always decided `new` from `spam`, moved here
 * unchanged so the route has no rules left in it.
 *
 * Two patterns, not one: a Romanian salon asking about a treatment uses the
 * word "free" and a legitimate enquiry can carry a link, and a client told they
 * had forty enquiries who finds thirty-eight of them are casino spam stops
 * opening the tile at all.
 */
const SPAM_PATTERNS = [
  /\bviagra\b/,
  /\bcasino\b/,
  /\bsex\b/,
  /\bporn\b/,
  /https?:\/\/[^\s]+\.[^\s]+/,
  /\b(buy now|cheap|click here|free money|you've won)\b/,
];

export function detectSpam(
  name: string,
  email: string,
  message: string
): boolean {
  const combined = `${name} ${email} ${message}`.toLowerCase();
  return SPAM_PATTERNS.filter((pattern) => pattern.test(combined)).length >= 2;
}

// ─── The write ─────────────────────────────────────────────────────────────

export interface CapturedLead {
  leadId: string;
  status: 'new' | 'spam';
}

/**
 * One lead, in one workspace.
 *
 * Through `withTenant`, so `workspace_id` is put on the row structurally rather
 * than remembered: this is a service-role insert, RLS is not in the way, and
 * the filter is the whole of the isolation.
 */
export async function insertLead(
  supabase: SupabaseServiceClient,
  input: {
    workspaceId: string;
    body: LeadCaptureBody;
    ip: string | null;
    userAgent: string | null;
    referrer: string | null;
  }
): Promise<CapturedLead> {
  const status = detectSpam(
    input.body.name,
    input.body.email,
    input.body.message
  )
    ? 'spam'
    : 'new';

  const { data, error } = await withTenant(supabase, input.workspaceId)
    .from('leads')
    .insert({
      name: input.body.name,
      email: input.body.email,
      phone: input.body.phone,
      message: input.body.message,
      source: input.body.page,
      ip_address: input.ip,
      user_agent: input.userAgent,
      referrer: input.referrer,
      status,
    })
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw error;
  if (!data) throw new Error('the lead insert returned no row');

  return { leadId: data.id, status };
}

// ─── Reading them back ─────────────────────────────────────────────────────

export interface WorkspaceLead {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  source: string | null;
  status: string;
  createdAt: string;
}

/**
 * This workspace's enquiries, newest first, spam last of all.
 *
 * Through `withTenant`, so the filter is structural: this is a service-role
 * read and nothing else stands between one client's list and another's.
 *
 * `includeSpam` is off by default. Spam is kept rather than deleted - a
 * classifier that is wrong about a real customer must be recoverable from -
 * but a client opening their enquiries should see the people, and find the
 * rest behind a toggle they asked for.
 */
export async function listWorkspaceLeads(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  options: { includeSpam?: boolean; limit?: number } = {}
): Promise<WorkspaceLead[]> {
  let query = withTenant(supabase, workspaceId)
    .from('leads')
    .select('id, name, email, phone, message, source, status, created_at');
  if (!options.includeSpam) query = query.neq('status', 'spam');

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(options.limit ?? 100);
  if (error) throw error;

  return ((data ?? []) as unknown as LeadRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
  }));
}

interface LeadRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  source: string | null;
  status: string;
  created_at: string;
}

/** Best effort. A missing ledger row must not fail a lead that was stored. */
export async function recordLeadEvent(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await supabase.from('project_events').insert({
      workspace_id: workspaceId,
      kind,
      actor: String(payload.actor ?? 'system:lead_capture'),
      payload: payload as Json,
    });
    if (error) throw error;
  } catch (error) {
    console.warn(
      `[leads] could not record ${kind} for workspace ${workspaceId}: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
  }
}
