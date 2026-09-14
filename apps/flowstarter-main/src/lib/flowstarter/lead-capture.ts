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
 *      token gets the SAME refusal an unknown token gets, byte for byte, and
 *      the CORS preflight never allows their origin. See `NOT_CONNECTED` in
 *      the route: an endpoint that said "wrong website" for a real token and
 *      "no such form" for an invented one is an endpoint that tells an
 *      attacker which of the tokens they scraped are still live.
 *   3. Rate. Per token and per IP, and once more per identical payload, which
 *      is what turns a replayed submission into one row instead of a thousand.
 *   4. Content. Every field through `sanitiseInbound` - NUL refused, control
 *      and invisible characters stripped, unicode normalised, lengths from
 *      configuration, markup refused in the fields it can only ever be an
 *      attack in - then a honeypot that is silently accepted and discarded,
 *      and the spam classifier that has always decided `new` from `spam`.
 *
 * PREVIEWS CANNOT SEND. A funnel preview belongs to nobody: there is no
 * workspace behind it and therefore no tenant a lead could belong to. It gets a
 * token of a shape a real one can never have (see `PREVIEW_TOKEN_PREFIX`) and
 * the endpoint answers it with a friendly 403 rather than a 404, so the form on
 * the preview can say why instead of looking broken.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import {
  finalHostname,
  previewHostname,
  type HostnameOptions,
} from '@/lib/hosting/site-hostnames';
import {
  inboundLimits,
  sanitiseInbound,
  type InboundLimits,
} from '@/lib/flowstarter/inbound-content';
import { positiveIntFromEnv } from '@/lib/net/net-config';
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
 *
 * `platformOrigin` is where the *app* answers -- `publicAppOrigin()` from
 * `@flowstarter/platform-config`, never `siteRootDomain()`. The two agree in
 * production, where the app is the domain's apex, and disagree everywhere
 * else: `siteRootDomain()` names the zone client sites are hosted under
 * (`flowstarter.dev` in development and on the shared staging box), and
 * nothing answers at that bare apex there. A site built from a dev or staging
 * stack that posted to it was posting every enquiry into a 404.
 *
 * A scheme on `platformOrigin` is kept rather than forced to `https`, so a
 * bare host (`flowstarter.net`) still defaults to `https` the way callers
 * have always been able to pass it, and an explicit `http://localhost:3000`
 * -- the honest answer in development -- is not silently upgraded to a
 * scheme nothing is listening on.
 */
export function leadCaptureEndpoint(
  platformOrigin: string,
  token: string
): string {
  const trimmed = platformOrigin.trim();
  const lower = trimmed.toLowerCase();
  const hasScheme = lower.startsWith('http://') || lower.startsWith('https://');
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  const origin = stripTrailingSlashes(withScheme);
  return `${origin}/api/leads/capture/${token}`;
}

const SLASH_CHAR_CODE = '/'.charCodeAt(0);

/**
 * A plain index walk, not a `/\/+$/`-shaped regex: `platformOrigin` above is
 * a parameter of an exported function, which CodeQL's polynomial-redos query
 * (js/polynomial-redos) treats as library input regardless of how trusted the
 * one caller in this codebase happens to be, and flagged the identically
 * shaped pattern in `@flowstarter/platform-config`'s `stripTrailingSlash`.
 * The loop settles the question instead of arguing the input is short.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) {
    end -= 1;
  }
  return value.slice(0, end);
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
    .select('id, slug, client_email, claimed_preview_id, lead_capture_token')
    .eq('lead_capture_token', token)
    .maybeSingle<{
      id: string;
      slug: string;
      client_email: string | null;
      claimed_preview_id: string | null;
      lead_capture_token: string | null;
    }>();
  if (error) throw error;
  if (!data) return null;

  // The row was already selected by an equality filter, so this can only fail
  // if the database ever compared the two values by something other than their
  // bytes - a collation, a trailing space, a case-insensitive column somebody
  // changed. It is here to make the comparison this endpoint's answer depends
  // on one we perform, in a time that does not depend on how many leading
  // characters a guess got right, rather than one we inherit from an index.
  if (
    typeof data.lead_capture_token !== 'string' ||
    !constantTimeEquals(data.lead_capture_token, token)
  ) {
    return null;
  }

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
    // Through the same normalisation a request's own Origin goes through, or
    // a custom domain stored as `Shop.Example.` would never match the
    // `https://shop.example` a browser actually sends.
    const clean = stripTrailingDots(hostname.trim().toLowerCase());
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

/**
 * An origin reduced to the only two things that identify it, lowercased.
 *
 * `new URL` does the work that matters: a homoglyph domain
 * (`sаlon.example`, Cyrillic а) comes back as its punycode, which is not the
 * ASCII hostname on the allow list, and userinfo (`https://mysite@evil.test`)
 * comes back as `evil.test` rather than as the name in front of the `@`.
 * Neither can be matched by accident because neither survives parsing.
 *
 * The trailing dot is removed because `site.example.` and `site.example` are
 * the same host to DNS and to Caddy, so a visitor who reached the site by the
 * fully qualified name would otherwise have their enquiry refused for a
 * character they never typed.
 */
function normaliseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const port = url.port ? `:${url.port}` : '';
    const host = stripTrailingDots(url.hostname.toLowerCase());
    return `${url.protocol.toLowerCase()}//${host}${port}`;
  } catch {
    return null;
  }
}

/** An index walk rather than a regex, for the reason `stripTrailingSlashes` is. */
function stripTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === DOT_CHAR_CODE) end -= 1;
  return value.slice(0, end);
}

const DOT_CHAR_CODE = '.'.charCodeAt(0);

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
 * Which rule each field of the contact form is read under.
 *
 * Markup is refused everywhere except the message. A name, an address, a phone
 * number and a page path have no legitimate angle bracket in them, so one is a
 * payload and nothing is lost by saying so; a message is prose a person wrote
 * to a business, `a < b` included, and it is escaped at every render.
 */
function leadFieldRules(limits: InboundLimits) {
  return {
    name: { limit: limits.name, markup: 'reject' as const },
    email: { limit: limits.email, markup: 'reject' as const },
    phone: { limit: limits.phone, markup: 'reject' as const },
    message: {
      limit: limits.message,
      markup: 'text' as const,
      multiline: true,
    },
    page: {
      limit: limits.page,
      markup: 'reject' as const,
      onOverflow: 'truncate' as const,
    },
  };
}

/**
 * The body, by rule.
 *
 * Deliberately hand-rolled rather than a Zod schema: every message here is read
 * by a visitor on somebody's small business website, in a box the template
 * renders, so they are sentences rather than validator output.
 *
 * Closed, not open: the object is read field by field and nothing else in it is
 * carried anywhere. A caller that posts `{ name, email, message, status: 'x',
 * workspace_id: '...' }` gets a lead with a name, an email and a message, and
 * the two extra keys reach no column.
 *
 * A field that fails `sanitiseInbound` is refused with the same kind of
 * sentence a missing one gets. A bot reading the refusal learns nothing about
 * which character it was, and a person will never see it.
 */
export function parseLeadCaptureBody(
  input: unknown,
  limits: InboundLimits = inboundLimits()
): LeadCaptureParse {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Send a name, an email and a message.' };
  }
  const raw = input as Record<string, unknown>;
  const rules = leadFieldRules(limits);

  // The trap is read for presence only, so nothing a bot puts in it is
  // sanitised, measured or stored. It never leaves this function.
  const honeypot =
    typeof raw[HONEYPOT_FIELD] === 'string' &&
    (raw[HONEYPOT_FIELD] as string).trim().length > 0;

  const name = sanitiseInbound(raw.name, rules.name);
  if (!name.ok)
    return { ok: false, message: 'That name is not one we can send.' };
  if (!name.value) return { ok: false, message: 'Add your name.' };

  const email = sanitiseInbound(raw.email, rules.email);
  if (!email.ok) {
    return { ok: false, message: 'That email address does not look right.' };
  }
  if (!email.value) return { ok: false, message: 'Add an email address.' };
  if (!EMAIL_PATTERN.test(email.value)) {
    return { ok: false, message: 'That email address does not look right.' };
  }

  const message = sanitiseInbound(raw.message, rules.message);
  if (!message.ok) return { ok: false, message: 'That message is too long.' };
  if (!message.value) return { ok: false, message: 'Add a message.' };

  const phone = sanitiseInbound(raw.phone, rules.phone);
  if (!phone.ok) {
    return { ok: false, message: 'That phone number is not one we can send.' };
  }

  // Truncated rather than refused, and never allowed to fail the enquiry: the
  // page is telemetry the form fills in, not something the visitor typed.
  const page = sanitiseInbound(raw.page, rules.page);

  return {
    ok: true,
    body: {
      name: name.value,
      email: email.value,
      message: message.value,
      phone: phone.value || null,
      page: (page.ok && page.value) || null,
      honeypot,
    },
  };
}

// ─── What the endpoint will spend on a stranger ────────────────────────────

/**
 * The four numbers the public endpoint is bounded by, in one place and out of
 * the route, so a change to any of them is a change to a rule rather than to a
 * handler.
 *
 * Each default is a statement about a small business rather than a round
 * number that felt safe:
 *
 *   - Ten a minute per token, because a busy salon does not receive twenty
 *     enquiries a minute and a form that did is a form being abused.
 *   - Twenty a minute per address, across every token. One scraped token
 *     hammered from a botnet is caught by the first; one host walking a list
 *     of tokens it found in page source is caught by this.
 *   - Ten minutes of memory for an identical payload, which is longer than
 *     any double-click and any retry, and short enough that somebody sending
 *     the same short message twice in an afternoon still gets two enquiries.
 *   - Sixty-four kilobytes of body. The fields add up to under six kilobytes
 *     at their configured maxima; the rest is the room JSON overhead and a
 *     long page path need. A megabyte would be a megabyte an anonymous caller
 *     can make this process hold.
 */
export const DEFAULT_LEAD_CAPTURE_LIMITS = {
  tokenPerMinute: 10,
  ipPerMinute: 20,
  replayWindowMs: 600_000,
  maxBodyBytes: 64 * 1024,
} as const;

export const LEAD_CAPTURE_LIMIT_ENV_VARS = {
  tokenPerMinute: 'FLOWSTARTER_LEAD_CAPTURE_TOKEN_PER_MINUTE',
  ipPerMinute: 'FLOWSTARTER_LEAD_CAPTURE_IP_PER_MINUTE',
  replayWindowMs: 'FLOWSTARTER_LEAD_CAPTURE_REPLAY_WINDOW_MS',
  maxBodyBytes: 'FLOWSTARTER_LEAD_CAPTURE_MAX_BODY_BYTES',
} as const;

export type LeadCaptureLimits = Record<
  keyof typeof DEFAULT_LEAD_CAPTURE_LIMITS,
  number
>;

/** The endpoint's budget, read from the environment it is handed. */
export function leadCaptureLimits(
  env: Record<string, string | undefined> = process.env
): LeadCaptureLimits {
  const out = {} as LeadCaptureLimits;
  for (const key of Object.keys(DEFAULT_LEAD_CAPTURE_LIMITS) as Array<
    keyof LeadCaptureLimits
  >) {
    out[key] = positiveIntFromEnv(
      env[LEAD_CAPTURE_LIMIT_ENV_VARS[key]],
      DEFAULT_LEAD_CAPTURE_LIMITS[key]
    );
  }
  return out;
}

// -- Comparing without saying how far you got -------------------------------

/**
 * Two strings compared in a time that does not depend on where they differ.
 *
 * The lengths are compared first and that comparison is not constant time,
 * which is deliberate: `LEAD_CAPTURE_TOKEN_PATTERN` publishes the length range
 * a token can have, so it is not a secret, and `timingSafeEqual` throws rather
 * than returning false when the two buffers differ in length.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

// -- Replay -----------------------------------------------------------------

/**
 * What makes two submissions the same submission.
 *
 * A visitor who double-clicks send, a form that retries on a flaky connection
 * and a script replaying a captured request are indistinguishable at the
 * endpoint, and they should be: all three want the same outcome, which is one
 * enquiry. The digest covers the workspace and the fields a client reads, so a
 * genuine second enquiry - anything the sender actually changed - is a
 * different fingerprint and lands as its own row.
 *
 * Hashed rather than kept whole, because the value becomes a rate-limit key
 * and a key is a thing that ends up in a Redis dump or a log line. A digest of
 * somebody's message is not their message.
 */
export function leadFingerprint(
  workspaceId: string,
  body: LeadCaptureBody
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        workspaceId,
        body.name,
        body.email,
        body.message,
        body.phone,
        body.page,
      ])
    )
    .digest('hex');
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
