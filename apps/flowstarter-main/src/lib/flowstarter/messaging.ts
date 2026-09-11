import 'server-only';
/**
 * The concierge conversation: asking a client for what is missing, and taking
 * their answer back into the pipeline.
 *
 * Two rules shape this module.
 *
 * 1. **The thread is the source of truth, email is a rendering of it.** The
 *    row goes in first and the email goes out second; a Resend outage loses a
 *    notification, never a message. `emailed: false` on the result and an
 *    `email_failed` flag on the event say so out loud rather than pretending.
 *
 * 2. **A reply has to become evidence, or it may as well not exist.** The
 *    generator's honesty pass can only assert what it can cite. So every
 *    inbound reply is projected into a `ScrapedTextDocument` with a stable
 *    `sourceId` and appended to
 *    `flowstarter_project_artifacts.client_reply_corpus` — a column of its
 *    own, because `savePreviewArtifacts` rewrites `intake_payload` wholesale
 *    on every preview regeneration and would otherwise delete the answers the
 *    client already gave us.
 *
 * Direction is never taken from a caller here either: `sendProjectMessage`
 * only writes outbound, `recordClientReply` only writes inbound. There is no
 * parameter to get wrong.
 */
import type { ScrapedTextDocument } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import type { Json } from '@/lib/database.types';
import { sendEmail } from '@/lib/email';
import { withTenant } from '@/lib/tenancy';
import { clientDashboardUrl } from './client-notifications';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import type {
  MissingItem,
  SufficiencyInput,
  TemplateImageSlot,
} from './sufficiency';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Long enough for a genuine explanation, short enough that a paste of a whole
 * inbox never lands in a jsonb column or an email body.
 */
export const MAX_MESSAGE_BODY_CHARS = 8_000;

/** Only outbound kinds; `client_reply` is written by `recordClientReply`. */
export type OutboundMessageKind =
  | 'asset_request'
  | 'clarification'
  | 'reminder';

export class MessagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagingError';
  }
}

/**
 * One structured thing a message asks for. Mirrors `MissingItem` so an ask
 * born from the gate keeps its code all the way into the `asks` column, where
 * the client UI can render it and later calibration can key on it.
 */
export interface ProjectMessageAsk {
  code: string;
  severity: 'blocking' | 'degrades';
  message: string;
  affects: string[];
}

export interface ProjectMessage {
  id: string;
  workspaceId: string;
  direction: 'outbound' | 'inbound';
  kind: string;
  body: string | null;
  asks: ProjectMessageAsk[];
  status: 'sent' | 'answered' | 'expired';
  sentAt: string | null;
  answeredAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertWorkspaceId(workspaceId: string): void {
  if (!UUID.test(workspaceId ?? '')) {
    throw new MessagingError('Invalid workspace id');
  }
}

function normalizeBody(body: string): string {
  const trimmed = (body ?? '').trim();
  if (trimmed.length === 0) {
    throw new MessagingError('Message body is empty');
  }
  if (trimmed.length > MAX_MESSAGE_BODY_CHARS) {
    throw new MessagingError(
      `Message body exceeds ${MAX_MESSAGE_BODY_CHARS} characters`
    );
  }
  return trimmed;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The client interface lives here; another agent builds the page itself.
 *
 * Now one definition shared with every other client-facing email, so a change
 * of origin cannot move some of the links in an inbox and not the others.
 */
export function projectDeepLink(workspaceId: string): string {
  return clientDashboardUrl(workspaceId);
}

function rowToMessage(row: {
  id: string;
  workspace_id: string;
  direction: string;
  kind: string;
  body: string | null;
  asks: Json;
  status: string;
  sent_at: string | null;
  answered_at: string | null;
  created_by: string | null;
  created_at: string;
}): ProjectMessage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    direction: row.direction as 'outbound' | 'inbound',
    kind: row.kind,
    body: row.body,
    asks: Array.isArray(row.asks)
      ? (row.asks as unknown as ProjectMessageAsk[])
      : [],
    status: row.status as 'sent' | 'answered' | 'expired',
    sentAt: row.sent_at,
    answeredAt: row.answered_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Events are an audit trail, not a retry queue: a failed event write must not
 * roll back a message that already exists and may already have been emailed.
 */
async function recordEvent(
  workspaceId: string,
  kind: string,
  actor: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const supabase = createSupabaseServiceRoleClient();
    const { error } = await withTenant(supabase, workspaceId)
      .from('project_events')
      .insert({ kind, actor, payload: payload as Json });
    if (error) throw error;
  } catch (error) {
    console.error('[messaging] project_events write failed', {
      workspaceId,
      kind,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}

// ---------------------------------------------------------------------------
// Reading the thread
// ---------------------------------------------------------------------------

/** The whole conversation, oldest first — the order a thread is read in. */
export async function listProjectMessages(
  workspaceId: string,
  limit = 200
): Promise<ProjectMessage[]> {
  assertWorkspaceId(workspaceId);
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await withTenant(supabase, workspaceId)
    .from('project_messages')
    .select(
      'id, workspace_id, direction, kind, body, asks, status, sent_at, answered_at, created_by, created_at'
    )
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => rowToMessage(row as never));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendProjectMessageInput {
  workspaceId: string;
  kind: OutboundMessageKind;
  body: string;
  asks?: readonly ProjectMessageAsk[];
  /** Clerk user id of the operator, or omitted for a machine-sent message. */
  createdBy?: string | null;
}

export interface SendProjectMessageResult {
  messageId: string;
  /** False when there was no client address, or Resend refused it. */
  emailed: boolean;
  emailError?: string;
}

/**
 * Writes one outbound message and tries to notify the client by email.
 *
 * Order matters: row first, email second. If the email fails the message is
 * still in the thread, the client still sees it on the platform, and the
 * caller gets `emailed: false` so an operator can chase it by hand.
 */
export async function sendProjectMessage(
  input: SendProjectMessageInput
): Promise<SendProjectMessageResult> {
  assertWorkspaceId(input.workspaceId);
  const body = normalizeBody(input.body);
  const asks = [...(input.asks ?? [])];

  const supabase = createSupabaseServiceRoleClient();

  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id, name, client_email, client_name')
    .eq('id', input.workspaceId)
    .maybeSingle();
  if (workspaceError) throw workspaceError;
  if (!workspace) throw new MessagingError('Workspace does not exist');

  const now = new Date().toISOString();
  const { data: inserted, error: insertError } = await withTenant(
    supabase,
    input.workspaceId
  )
    .from('project_messages')
    .insert({
      direction: 'outbound',
      kind: input.kind,
      body,
      asks: asks as unknown as Json,
      status: 'sent',
      sent_at: now,
      created_by: input.createdBy ?? null,
    })
    .select('id')
    .maybeSingle<{ id: string }>();
  if (insertError) throw insertError;
  if (!inserted) throw new MessagingError('Message row was not created');

  let emailed = false;
  let emailError: string | undefined;
  const clientEmail = (workspace as { client_email: string | null })
    .client_email;
  if (!clientEmail) {
    emailError = 'Workspace has no client_email';
  } else {
    const email = buildClientEmail({
      workspaceId: input.workspaceId,
      kind: input.kind,
      clientName: (workspace as { client_name: string | null }).client_name,
      body,
      asks,
    });
    try {
      const result = await sendEmail({
        to: clientEmail,
        subject: email.subject,
        html: email.html,
      });
      emailed = result.success;
      if (!result.success) emailError = result.error ?? 'Unknown email failure';
    } catch (error) {
      // sendEmail already swallows most failures, but a thrown error here
      // must not take the message with it.
      emailError =
        error instanceof Error ? error.message : 'Unknown email failure';
    }
  }
  if (!emailed) {
    console.error('[messaging] outbound email not delivered', {
      workspaceId: input.workspaceId,
      messageId: inserted.id,
      reason: emailError,
    });
  }

  await recordEvent(
    input.workspaceId,
    'project_message_sent',
    input.createdBy ?? 'system',
    {
      message_id: inserted.id,
      kind: input.kind,
      ask_codes: asks.map((ask) => ask.code),
      emailed,
      // The reason is ours, not the client's: never echo a provider payload.
      email_failed: !emailed,
    }
  );

  return {
    messageId: inserted.id,
    emailed,
    ...(emailError ? { emailError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Asking for what the gate found missing
// ---------------------------------------------------------------------------

export type RequestMissingAssetsResult =
  | { sent: false; reason: 'nothing_missing' }
  | ({ sent: true } & SendProjectMessageResult);

export interface RequestMissingAssetsInput {
  workspaceId: string;
  missing: readonly MissingItem[];
  createdBy?: string | null;
}

/**
 * Turns a `evaluateSufficiency` result into exactly one asset request.
 *
 * One message, not one per gap: six separate emails is how a client stops
 * reading. The ordering (blocking first, then code, both stable) means the
 * same gap always produces byte-identical copy, so a resend is recognisably
 * the same ask rather than a new one.
 */
export async function requestMissingAssets(
  input: RequestMissingAssetsInput
): Promise<RequestMissingAssetsResult> {
  assertWorkspaceId(input.workspaceId);
  const ordered = orderMissing(input.missing);
  if (ordered.length === 0) return { sent: false, reason: 'nothing_missing' };

  const asks: ProjectMessageAsk[] = ordered.map((item) => ({
    code: item.code,
    severity: item.severity,
    message: item.message,
    affects: [...item.affects],
  }));

  const result = await sendProjectMessage({
    workspaceId: input.workspaceId,
    kind: 'asset_request',
    body: buildAssetRequestBody(ordered),
    asks,
    createdBy: input.createdBy ?? null,
  });
  return { sent: true, ...result };
}

function orderMissing(missing: readonly MissingItem[]): MissingItem[] {
  return [...missing].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'blocking' ? -1 : 1;
    return a.code.localeCompare(b.code);
  });
}

/** The plain-text body. The email is a rendering of this, not the other way round. */
export function buildAssetRequestBody(missing: readonly MissingItem[]): string {
  const ordered = orderMissing(missing);
  const blocking = ordered.filter((item) => item.severity === 'blocking');
  const lines: string[] = [];

  lines.push(
    blocking.length > 0
      ? 'We need a few things from you before we can finish your site. ' +
          'Everything below is something we cannot make up without guessing, ' +
          'and we would rather ask than guess.'
      : 'Your site can go ahead as it is. These would make it noticeably ' +
          'better if you have them to hand.'
  );
  lines.push('');
  for (const item of ordered) {
    const marker = item.severity === 'blocking' ? 'Needed' : 'Nice to have';
    lines.push(`- [${marker}] ${item.message}`);
  }
  lines.push('');
  lines.push(
    'Reply to this email with the files attached, or upload them here:'
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Email rendering
// ---------------------------------------------------------------------------

const SUBJECTS: Record<OutboundMessageKind, string> = {
  asset_request: 'A few things we still need for your site',
  clarification: 'A quick question about your site',
  reminder: 'Still waiting on a couple of things for your site',
};

export function buildClientEmail(input: {
  workspaceId: string;
  kind: OutboundMessageKind;
  clientName?: string | null;
  body: string;
  asks: readonly ProjectMessageAsk[];
}): { subject: string; html: string } {
  const link = projectDeepLink(input.workspaceId);
  const greeting = input.clientName
    ? `Hi ${escapeHtml(input.clientName.split(/\s+/)[0] ?? input.clientName)},`
    : 'Hi,';

  // The body already contains the asks as a list; the email renders the prose
  // paragraphs and the asks as real <li>s so they are scannable on a phone.
  const prose = input.body
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('- ['))
    .map(
      (line) =>
        `<p style="margin:0 0 14px;font-size:15px;">${escapeHtml(
          line.trim()
        )}</p>`
    )
    .join('\n  ');

  const items =
    input.asks.length > 0
      ? `<ul style="margin:0 0 18px;padding-left:20px;font-size:15px;">
    ${input.asks
      .map(
        (ask) =>
          `<li style="margin:0 0 10px;">${escapeHtml(ask.message)}${
            ask.severity === 'degrades'
              ? ' <span style="color:#6b7280;">(optional)</span>'
              : ''
          }</li>`
      )
      .join('\n    ')}
  </ul>`
      : '';

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#111827;line-height:1.55;">
  <p style="margin:0 0 14px;font-size:15px;">${greeting}</p>
  ${prose}
  ${items}
  <p style="margin:0 0 22px;font-size:15px;">
    You can reply straight to this email, or upload everything on your project page:
  </p>
  <p style="margin:0 0 22px;">
    <a href="${escapeHtml(
      link
    )}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;font-size:15px;font-weight:600;">Open your project</a>
  </p>
  <p style="margin:0 0 4px;font-size:15px;">Thanks,</p>
  <p style="margin:0;font-size:15px;font-weight:600;">The Flowstarter team</p>
</div>`;

  return { subject: SUBJECTS[input.kind], html };
}

// ---------------------------------------------------------------------------
// Inbound: the client answers
// ---------------------------------------------------------------------------

/** `sourceId` prefix, so the generator can tell a reply from a scrape. */
export const CLIENT_REPLY_SOURCE_PREFIX = 'client_reply';

/**
 * Projects one reply into the corpus shape the generator already consumes.
 *
 * `platform: 'intake'` / `kind: 'intake_answer'` are deliberate: to the
 * honesty pass a clarification is exactly the same kind of evidence as an
 * intake answer — something the business told us directly — and reusing the
 * existing union means no downstream code has to learn a new case.
 */
export function clientReplyToCorpusDocument(input: {
  messageId: string;
  body: string;
  receivedAt?: string;
}): ScrapedTextDocument {
  return {
    sourceId: `${CLIENT_REPLY_SOURCE_PREFIX}:${input.messageId}`,
    platform: 'intake',
    kind: 'intake_answer',
    text: input.body.trim(),
    ...(input.receivedAt ? { publishedAt: input.receivedAt } : {}),
  };
}

export interface RecordChangeRequestInput {
  workspaceId: string;
  body: string;
  clerkUserId: string;
}

/**
 * Files a client's escalated change request into the thread. Inbound like a
 * reply, but it deliberately does NOT close any open ask — the client asking
 * for a new page has answered nothing — and it lands `status: 'sent'` because
 * a change request waits on the operator, not on the client.
 */
export async function recordChangeRequest(
  input: RecordChangeRequestInput
): Promise<{ messageId: string }> {
  assertWorkspaceId(input.workspaceId);
  const body = normalizeBody(input.body);
  if (!input.clerkUserId) {
    throw new MessagingError('A change request must name its author');
  }

  const supabase = createSupabaseServiceRoleClient();
  const tenant = withTenant(supabase, input.workspaceId);
  const { data: inserted, error: insertError } = await tenant
    .from('project_messages')
    .insert({
      direction: 'inbound',
      kind: 'change_request',
      body,
      asks: [] as unknown as Json,
      status: 'sent',
      sent_at: new Date().toISOString(),
      created_by: input.clerkUserId,
    })
    .select('id')
    .maybeSingle<{ id: string }>();
  if (insertError) throw insertError;
  if (!inserted) throw new MessagingError('Change request row was not created');
  return { messageId: inserted.id };
}

export interface RecordClientReplyInput {
  workspaceId: string;
  body: string;
  clerkUserId: string;
}

export interface RecordClientReplyResult {
  messageId: string;
  /** The outbound ask this reply closed, if one was open. */
  answeredMessageId: string | null;
  document: ScrapedTextDocument;
  /** False when there is no artifacts row yet to attach the evidence to. */
  persistedToCorpus: boolean;
}

/**
 * Records an inbound reply, closes the ask it answers, and files it as
 * evidence.
 */
export async function recordClientReply(
  input: RecordClientReplyInput
): Promise<RecordClientReplyResult> {
  assertWorkspaceId(input.workspaceId);
  const body = normalizeBody(input.body);
  if (!input.clerkUserId) {
    throw new MessagingError('A client reply must name its author');
  }

  const supabase = createSupabaseServiceRoleClient();
  const tenant = withTenant(supabase, input.workspaceId);
  const now = new Date().toISOString();

  // Inbound messages land `answered`: `status` tracks whether a message is
  // still waiting on someone, and nobody is waiting on a reply.
  const { data: inserted, error: insertError } = await tenant
    .from('project_messages')
    .insert({
      direction: 'inbound',
      kind: 'client_reply',
      body,
      asks: [] as unknown as Json,
      status: 'answered',
      answered_at: now,
      created_by: input.clerkUserId,
    })
    .select('id')
    .maybeSingle<{ id: string }>();
  if (insertError) throw insertError;
  if (!inserted) throw new MessagingError('Reply row was not created');

  // Close the newest ask still waiting. Newest rather than oldest: a client
  // answers the thing they were last asked.
  const { data: open, error: openError } = await tenant
    .from('project_messages')
    .select('id')
    .eq('direction', 'outbound')
    .eq('status', 'sent')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (openError) throw openError;

  let answeredMessageId: string | null = null;
  if (open?.id) {
    const { error: updateError } = await tenant
      .from('project_messages')
      .update({ status: 'answered', answered_at: now })
      .eq('id', open.id);
    if (updateError) throw updateError;
    answeredMessageId = open.id;
  }

  const document = clientReplyToCorpusDocument({
    messageId: inserted.id,
    body,
    receivedAt: now,
  });
  const persistedToCorpus = await appendClientReplyToCorpus(
    input.workspaceId,
    document
  );

  await recordEvent(
    input.workspaceId,
    'client_reply_recorded',
    input.clerkUserId,
    {
      message_id: inserted.id,
      answered_message_id: answeredMessageId,
      source_id: document.sourceId,
      persisted_to_corpus: persistedToCorpus,
    }
  );

  return {
    messageId: inserted.id,
    answeredMessageId,
    document,
    persistedToCorpus,
  };
}

/**
 * Appends one document to `flowstarter_project_artifacts.client_reply_corpus`,
 * de-duplicated by `sourceId` so a retried write cannot cite the same reply
 * twice.
 *
 * Returns false when the workspace has no artifacts row yet. A stub row is
 * deliberately NOT created: the build worker treats the presence of that row
 * as "there is an approved preview to build from", and inventing one to hold a
 * message would be a lie told to the worker. The reply is still in the thread,
 * and `readClientReplyCorpus` is called at build time, after the row exists.
 */
export async function appendClientReplyToCorpus(
  workspaceId: string,
  document: ScrapedTextDocument
): Promise<boolean> {
  const supabase = createSupabaseServiceRoleClient();
  const tenant = withTenant(supabase, workspaceId);

  const { data: existing, error: readError } = await tenant
    .from('flowstarter_project_artifacts')
    .select('client_reply_corpus')
    .maybeSingle<{ client_reply_corpus: Json }>();
  if (readError) throw readError;
  if (!existing) return false;

  const current = Array.isArray(existing.client_reply_corpus)
    ? (existing.client_reply_corpus as unknown as ScrapedTextDocument[])
    : [];
  if (current.some((entry) => entry?.sourceId === document.sourceId))
    return true;

  const { error: writeError } = await tenant
    .from('flowstarter_project_artifacts')
    .update({
      client_reply_corpus: [...current, document] as unknown as Json,
      updated_at: new Date().toISOString(),
    });
  if (writeError) throw writeError;
  return true;
}

/**
 * Every client reply filed as evidence for one workspace, oldest first. This
 * is what a build merges into `ScrapeCorpus.documents` so the honesty pass can
 * cite `client_reply:<id>` for a claim.
 */
export async function readClientReplyCorpus(
  workspaceId: string
): Promise<ScrapedTextDocument[]> {
  assertWorkspaceId(workspaceId);
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await withTenant(supabase, workspaceId)
    .from('flowstarter_project_artifacts')
    .select('client_reply_corpus')
    .maybeSingle<{ client_reply_corpus: Json }>();
  if (error) throw error;
  if (!data || !Array.isArray(data.client_reply_corpus)) return [];
  return data.client_reply_corpus as unknown as ScrapedTextDocument[];
}

// ---------------------------------------------------------------------------
// Collecting what the gate needs
// ---------------------------------------------------------------------------

/**
 * Where the built templates live. An env override exists because the repo
 * layout is not guaranteed to survive a deploy bundle, and a gate that cannot
 * find the template must degrade to its defaults rather than throw.
 */
function templateSearchRoots(): string[] {
  const override = process.env.FLOWSTARTER_TEMPLATES_DIR?.trim();
  const cwd = process.cwd();
  return [
    ...(override ? [override] : []),
    `${cwd}/../flowstarter-templates`,
    `${cwd}/apps/flowstarter-templates`,
  ];
}

/**
 * The chosen template's real image slots, or `[]` when the template tree is
 * not on this machine (a serverless bundle, typically). `[]` is not a failure:
 * `evaluateSufficiency` falls back to its default shape — one hero plus two
 * section images — which is what those slots would have asked for anyway.
 */
export async function resolveTemplateImageSlots(
  templateSlug: string | null | undefined
): Promise<TemplateImageSlot[]> {
  if (!templateSlug || !/^[a-z0-9-]+$/.test(templateSlug)) return [];
  try {
    const [{ listSiteImageSlots }, { existsSync }] = await Promise.all([
      import('@flowstarter/agentic-codegen/src/flowstarter/site-media'),
      import('node:fs'),
    ]);
    for (const root of templateSearchRoots()) {
      const dir = `${root}/${templateSlug}`;
      if (!existsSync(dir)) continue;
      return await listSiteImageSlots(dir);
    }
  } catch (error) {
    console.warn('[messaging] template slots unavailable', {
      templateSlug,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
  return [];
}

interface AssetRow {
  id: string;
  kind: string | null;
  width: number | null;
  height: number | null;
  usable_for: string[] | null;
  is_placeholder: boolean;
}

/**
 * Gathers everything the gate needs for one workspace, from the tables that
 * already hold it. Deliberately separate from `evaluateSufficiency`: the
 * decision stays pure and testable, the I/O stays here.
 *
 * `services` is read from the newest intake submission's `services` array, and
 * falls back to the artifacts' intake payload. Both are free-form jsonb owned
 * by the intake flow, so anything non-string is dropped rather than guessed at.
 */
export async function collectSufficiencyInput(
  workspaceId: string
): Promise<SufficiencyInput> {
  assertWorkspaceId(workspaceId);
  const supabase = createSupabaseServiceRoleClient();
  const tenant = withTenant(supabase, workspaceId);

  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id, client_email, client_phone')
    .eq('id', workspaceId)
    .maybeSingle();
  if (workspaceError) throw workspaceError;
  if (!workspace) throw new MessagingError('Workspace does not exist');

  const { data: assetRows, error: assetError } = await tenant
    .from('assets')
    .select('id, kind, width, height, usable_for, is_placeholder')
    .limit(500);
  if (assetError) throw assetError;
  const assets = (assetRows ?? []) as unknown as AssetRow[];

  const { data: artifacts, error: artifactError } = await tenant
    .from('flowstarter_project_artifacts')
    .select('intake_payload, template_slug, client_reply_corpus')
    .maybeSingle<{
      intake_payload: Json;
      template_slug: string | null;
      client_reply_corpus: Json;
    }>();
  if (artifactError) throw artifactError;

  const { data: submission, error: submissionError } = await tenant
    .from('intake_submissions')
    .select('payload')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ payload: Json }>();
  if (submissionError) throw submissionError;

  const intake = asRecord(artifacts?.intake_payload);
  const business = asRecord(intake.business);
  const payload = asRecord(submission?.payload);

  const replies = Array.isArray(artifacts?.client_reply_corpus)
    ? (artifacts.client_reply_corpus as unknown as ScrapedTextDocument[])
    : [];

  const businessText = [
    stringOrNull(business.description),
    stringOrNull(business.targetAudience),
    stringOrNull(business.primaryGoal),
    stringOrNull(payload.description),
    // An answered clarification is real business prose too, and it is the
    // most recent thing the client actually said.
    ...replies.map((doc) => (typeof doc?.text === 'string' ? doc.text : null)),
  ].filter((value): value is string => Boolean(value));

  return {
    slots: await resolveTemplateImageSlots(artifacts?.template_slug),
    images: assets
      .filter((asset) => asset.kind !== 'logo')
      .map((asset) => ({
        id: asset.id,
        width: asset.width,
        height: asset.height,
        usableFor: asset.usable_for,
        isPlaceholder: asset.is_placeholder,
        kind: asset.kind,
      })),
    logo:
      assets
        .filter((asset) => asset.kind === 'logo' && !asset.is_placeholder)
        .map((asset) => ({
          id: asset.id,
          width: asset.width,
          height: asset.height,
          isPlaceholder: asset.is_placeholder,
          kind: asset.kind,
        }))[0] ?? null,
    businessText,
    contact: {
      email: (workspace as { client_email: string | null }).client_email,
      phone: (workspace as { client_phone: string | null }).client_phone,
      bookingUrl: stringOrNull(payload.bookingUrl),
    },
    services: stringList(payload.services ?? intake.services),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
