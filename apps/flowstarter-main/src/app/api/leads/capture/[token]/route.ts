/**
 * POST /api/leads/capture/{token}  — the contact form on a client's own site.
 *
 * The only unauthenticated write in the product that creates a tenant row, so
 * the whole of this file is the order the refusals happen in. Every rule it
 * applies lives in `lib/flowstarter/lead-capture.ts` and
 * `lib/flowstarter/inbound-content.ts`; what is here is which one runs first
 * and what a caller is told.
 *
 *   1. A preview token, refused with 403 and a sentence, before any query. A
 *      funnel preview belongs to no workspace, so there is no tenant a lead
 *      could belong to and nothing to look up. Safe to answer distinctly
 *      because a preview token has a shape (`preview.`) that no minted token
 *      can ever have, so the answer is a fact about the URL, not about us.
 *   2. Anything that is not a token by shape, refused before any query.
 *   3. Rate: per token and per address, both, because the two abuses are
 *      different. One scraped token hammered from a botnet is caught by the
 *      token; one host walking every token it can find is caught by the
 *      address — which is `clientIp` from `lib/request-ip.ts` (#141): the
 *      rightmost `X-Forwarded-For` entry outside a trusted-proxy range,
 *      never the front of a header the caller writes.
 *   4. The token resolves to a workspace, and the submission came from one of
 *      that workspace's own hostnames.
 *   5. Body: capped on the stream, then by rule, with a honeypot that is
 *      accepted and discarded.
 *   6. Replay: the same payload for the same workspace inside the window is
 *      answered exactly like the first one and stored once.
 *
 * ONE REFUSAL FOR FOUR DIFFERENT FAILURES, and this is the part worth being
 * explicit about. A token that never existed, a token that has been rotated
 * away, a token belonging to another workspace, and a real token submitted
 * from somebody else's page all get `NOT_CONNECTED`: same status, same body,
 * same headers, byte for byte. The distinction is real and it is in the log,
 * where the operator who needs it can see it. Putting it in the response would
 * publish, to an anonymous caller, which of the tokens they scraped out of
 * page source are still live — which is the entire question an attacker with a
 * list of tokens is trying to answer.
 *
 * WHAT COMES BACK ON SUCCESS. `{ ok: true }` and nothing else, with 201. The
 * response is read by a script on a public web page, so every extra field in
 * it is a fact about a tenant published to whoever asked. The lead id is not
 * in it, the workspace is not in it, and a spam classification is not in it:
 * telling a spammer they were classified is telling them what to change.
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
  leadCaptureLimits,
  leadFingerprint,
  originAllowed,
  parseLeadCaptureBody,
  recordLeadEvent,
  requestOrigin,
  resolveCaptureTenant,
  type CaptureTenant,
} from '@/lib/flowstarter/lead-capture';
import { notifyClientOnce } from '@/lib/flowstarter/client-notifications';
import { readJsonCapped } from '@/lib/net/ingress';
import { consumeRateLimit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/request-ip';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

export const dynamic = 'force-dynamic';

const MINUTE_MS = 60_000;

/**
 * The one sentence four different failures share. A constant rather than four
 * string literals, because the property the tests assert - that the responses
 * are byte-identical - is one somebody could break with a typo.
 */
const NOT_CONNECTED = 'This form is not connected yet.';

const PREVIEW_MESSAGE =
  'This is a preview, so the form cannot send anything yet. It starts working on the live site.';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const origin = requestOrigin(request.headers);
  const limits = leadCaptureLimits();

  if (isPreviewLeadCaptureToken(token)) {
    return refusal(403, PREVIEW_MESSAGE, null);
  }
  if (!isLeadCaptureToken(token)) {
    return notConnected();
  }

  const ip = clientIp(request.headers);
  const [tokenLimited, ipLimited] = await Promise.all([
    consumeRateLimit(`lead-capture:token:${token}`, {
      limit: limits.tokenPerMinute,
      windowMs: MINUTE_MS,
    }),
    consumeRateLimit(`lead-capture:ip:${ip}`, {
      limit: limits.ipPerMinute,
      windowMs: MINUTE_MS,
    }),
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

  if (!tenant) {
    // Which of "never existed" and "rotated away" this was is not knowable
    // from here and does not need to be: both mean no workspace owns it.
    console.warn('[leads] refused a submission: the token resolves to nothing');
    return notConnected();
  }

  if (!originAllowed(origin, tenant.origins)) {
    // The log is where the distinction lives. An operator debugging a client's
    // new custom domain needs to see this line; an anonymous caller holding a
    // scraped token must not be able to tell it apart from the line above.
    console.warn(
      `[leads] refused a submission for workspace ${tenant.workspaceId}: ` +
        `origin ${origin ?? 'absent'} is not one of its own`
    );
    return notConnected();
  }

  // A contact form on somebody else's website, so the body is a stranger's
  // twice over. Capped on the stream. Codex F07.
  const read = await readJsonCapped(request, limits.maxBodyBytes);
  if (read.status === 'too_large') {
    return refusal(413, 'That message is too long to send.', origin);
  }
  if (read.status === 'invalid') {
    return refusal(400, 'Could not read that. Try again.', origin);
  }
  const payload: unknown = read.value;

  const parsed = parseLeadCaptureBody(payload);
  if (!parsed.ok) return refusal(400, parsed.message, origin);

  // Accepted and dropped. A bot that filled the trap is told the same thing a
  // person is told, because the alternative is telling it which field to leave
  // alone next time.
  if (parsed.body.honeypot) return accepted(origin);

  // The same enquiry, again. A limit of one over the replay window makes the
  // second delivery of an identical payload a no-op, and it is answered with
  // the same 201 the first one got: a replayer that could tell the difference
  // would know its first attempt had landed.
  const replayed = await consumeRateLimit(
    `lead-capture:replay:${leadFingerprint(tenant.workspaceId, parsed.body)}`,
    { limit: 1, windowMs: limits.replayWindowMs }
  );
  if (replayed) {
    console.info(
      `[leads] dropped a replayed submission for workspace ${tenant.workspaceId}`
    );
    return accepted(origin);
  }

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
 *
 * Rate limited on the address for the same reason the POST is: this is the
 * cheaper half of the endpoint to call and the more useful one to a caller
 * walking a list of tokens, because a preflight that came back with an
 * allow-origin would confirm a token without ever sending a body. The refusal
 * and the allowance are both a 204, so being limited is indistinguishable from
 * being refused.
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

  const limits = leadCaptureLimits();
  const limited = await consumeRateLimit(
    `lead-capture:ip:${clientIp(request.headers)}`,
    { limit: limits.ipPerMinute, windowMs: MINUTE_MS }
  );
  if (limited) {
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
 * The one answer an unknown token, a rotated token, another workspace's token
 * and a foreign origin all get. No allow-origin header on any of them, so the
 * four are identical down to the bytes — which is a property the adversarial
 * suite asserts rather than trusts.
 */
function notConnected(): NextResponse {
  return refusal(404, NOT_CONNECTED, null);
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
