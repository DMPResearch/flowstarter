/**
 * POST /api/leads/capture/{token}  — the contact form on a client's own site.
 *
 * The only unauthenticated write in the product that creates a tenant row, so
 * the whole of this file is the order the refusals happen in. Every rule it
 * applies lives in `lib/flowstarter/lead-capture.ts`; what is here is which one
 * runs first and what a caller is told.
 *
 *   1. A preview token, refused with 403 and a sentence, before any query. A
 *      funnel preview belongs to no workspace, so there is no tenant a lead
 *      could belong to and nothing to look up.
 *   2. A token that is not base64url, refused with 404, before any query. The
 *      endpoint must not be usable to find out which tokens exist, so a
 *      malformed guess and a wrong guess get the same answer.
 *   3. Rate: per token and per IP, both, because the two abuses are different.
 *      One scraped token hammered from a botnet is caught by the token; one
 *      host walking every token it can find is caught by the IP.
 *   4. Origin: the submission has to come from one of this workspace's own
 *      hostnames. Somebody else's page carrying a scraped token gets a 403,
 *      and the preflight never hands their origin an allow.
 *   5. Body: by rule, with a honeypot that is accepted and discarded.
 *
 * WHAT COMES BACK. `{ ok: true }` and nothing else, with 201. The response is
 * read by a script on a public web page, so every extra field in it is a fact
 * about a tenant published to whoever asked. The lead id is not in it, the
 * workspace is not in it, and a spam classification is not in it: telling a
 * spammer they were classified is telling them what to change.
 *
 * CORS. The allow-origin is the workspace's own origin, echoed only when it
 * matched. `Access-Control-Allow-Origin: *` would make every client's endpoint
 * callable from every page on the internet, which is the thing rule 4 exists
 * to stop.
 */
import { NextRequest, NextResponse } from 'next/server';
import { newEnquiryEmail } from '@/lib/email-templates/client-notices';
import {
  insertLead,
  isPreviewLeadCaptureToken,
  isLeadCaptureToken,
  originAllowed,
  parseLeadCaptureBody,
  recordLeadEvent,
  requestOrigin,
  resolveCaptureTenant,
  type CaptureTenant,
} from '@/lib/flowstarter/lead-capture';
import { notifyClientOnce } from '@/lib/flowstarter/client-notifications';
import { consumeRateLimit } from '@/lib/rate-limit';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

export const dynamic = 'force-dynamic';

/** Per token: a busy small business does not get twenty enquiries a minute. */
const TOKEN_LIMIT = { limit: 10, windowMs: 60_000 };
/** Per IP, across every token: the shape of somebody walking a list. */
const IP_LIMIT = { limit: 20, windowMs: 60_000 };

const PREVIEW_MESSAGE =
  'This is a preview, so the form cannot send anything yet. It starts working on the live site.';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const origin = requestOrigin(request.headers);

  if (isPreviewLeadCaptureToken(token)) {
    return refusal(403, PREVIEW_MESSAGE, null);
  }
  if (!isLeadCaptureToken(token)) {
    return refusal(404, 'This form is not connected yet.', null);
  }

  const ip = clientIp(request);
  const [tokenLimited, ipLimited] = await Promise.all([
    consumeRateLimit(`lead-capture:token:${token}`, TOKEN_LIMIT),
    consumeRateLimit(`lead-capture:ip:${ip}`, IP_LIMIT),
  ]);
  if (tokenLimited || ipLimited) {
    return refusal(
      429,
      'Too many messages just now. Try again in a minute.',
      null
    );
  }

  const supabase = createSupabaseServiceRoleClient();

  let tenant: CaptureTenant | null;
  try {
    tenant = await resolveCaptureTenant(supabase, token);
  } catch (error) {
    console.error('[leads] could not resolve a capture token:', error);
    return refusal(
      503,
      'Could not send that just now. Try again shortly.',
      null
    );
  }
  // The same answer a malformed token gets. A caller must not be able to tell
  // a token that was never real from one that has been rotated away.
  if (!tenant) return refusal(404, 'This form is not connected yet.', null);

  if (!originAllowed(origin, tenant.origins)) {
    return refusal(403, 'This form can only be used on its own website.', null);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return refusal(400, 'Could not read that. Try again.', origin);
  }

  const parsed = parseLeadCaptureBody(payload);
  if (!parsed.ok) return refusal(400, parsed.message, origin);

  // Accepted and dropped. A bot that filled the trap is told the same thing a
  // person is told, because the alternative is telling it which field to leave
  // alone next time.
  if (parsed.body.honeypot) return accepted(origin);

  let lead;
  try {
    lead = await insertLead(supabase, {
      workspaceId: tenant.workspaceId,
      body: parsed.body,
      ip,
      userAgent: request.headers.get('user-agent'),
      referrer: request.headers.get('referer'),
    });
  } catch (error) {
    console.error('[leads] could not store a lead:', error);
    return refusal(
      503,
      'Could not send that just now. Try again shortly.',
      origin
    );
  }

  // Everything past here is about telling somebody, and none of it can fail
  // the request: the enquiry is already in the client's workspace.
  await recordLeadEvent(supabase, tenant.workspaceId, 'lead_captured', {
    leadId: lead.leadId,
    status: lead.status,
    page: parsed.body.page,
    origin,
  });

  if (lead.status === 'new') {
    await notifyClientOnce({
      supabase,
      workspaceId: tenant.workspaceId,
      notification: 'lead_captured',
      dedupeKey: lead.leadId,
      replyTo: parsed.body.email,
      render: (recipient) =>
        newEnquiryEmail({
          enquiriesUrl: `${recipient.dashboardUrl}/enquiries/list`,
          fromName: parsed.body.name,
          fromEmail: parsed.body.email,
          message: parsed.body.message,
          phone: parsed.body.phone,
          page: parsed.body.page,
          businessName: recipient.businessName,
          clientName: recipient.clientName,
        }),
      detail: { leadId: lead.leadId },
    });
  }

  return accepted(origin);
}

/**
 * The preflight. It answers for an origin only when that origin is one the
 * workspace behind the token actually owns, so a browser on anybody else's
 * page never gets past it.
 */
export async function OPTIONS(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const origin = requestOrigin(request.headers);

  if (
    !origin ||
    isPreviewLeadCaptureToken(token) ||
    !isLeadCaptureToken(token)
  ) {
    return new NextResponse(null, { status: 204, headers: baseHeaders() });
  }

  let tenant: CaptureTenant | null = null;
  try {
    tenant = await resolveCaptureTenant(
      createSupabaseServiceRoleClient(),
      token
    );
  } catch {
    tenant = null;
  }

  const allowed =
    tenant && originAllowed(origin, tenant.origins) ? origin : null;
  return new NextResponse(null, { status: 204, headers: baseHeaders(allowed) });
}

// ─── Responses ─────────────────────────────────────────────────────────────

function accepted(origin: string | null): NextResponse {
  return NextResponse.json(
    { ok: true },
    { status: 201, headers: baseHeaders(origin) }
  );
}

/**
 * A refusal carries a sentence the site can show a visitor and nothing else.
 * `origin` is null on every refusal that happens before the origin was
 * accepted, so a caller from the wrong place gets no allow header either.
 */
function refusal(
  status: number,
  message: string,
  origin: string | null
): NextResponse {
  return NextResponse.json(
    { ok: false, message },
    { status, headers: baseHeaders(origin) }
  );
}

function baseHeaders(origin: string | null = null): Record<string, string> {
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

function clientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    'unknown'
  );
}
