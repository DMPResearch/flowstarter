/**
 * POST /api/integrations/cal/[workspaceId]
 *
 * Cal.com posts here when a booking is made, moved or cancelled on one
 * workspace's calendar. Public in the sense that nobody signs in: the proof of
 * who is calling is the HMAC, not a session.
 *
 * THE ORDER OF THE CHECKS IS THE SECURITY PROPERTY, so it is written out
 * rather than left to be inferred:
 *
 *   1. No `X-Cal-Signature-256` header at all -> 401, and not one row is read.
 *      This is what keeps an unsigned caller from using the endpoint as an
 *      oracle: whatever workspace id they put in the path, signed or invented,
 *      existing or not, they get the same 401 and the database is never asked
 *      about it.
 *   2. A signature was offered, so the caller is claiming to be Cal.com, and
 *      the workspace's secret is looked up to check it against. This lookup
 *      does NOT branch the response on whether the workspace exists: Cal.com's
 *      HMAC is per workspace, so a request against an unknown or malformed
 *      workspace id can never carry a valid signature for it (there is no
 *      secret to have signed with) — a caller with a real secret for their own
 *      workspace and a made-up header for someone else's both land on the
 *      same "signature does not match" outcome. A distinct 404 for "no such
 *      workspace" would tell an unauthenticated caller which workspace ids
 *      exist before their signature was ever checked; there is no answer this
 *      route can give here that is allowed to depend on that.
 *   3. The signature does not verify -> 401, whether that is because the
 *      workspace does not exist, has no calendar connected, or the bytes were
 *      signed with the wrong secret. Which of those it was is in our logs,
 *      not in the response.
 *
 * RAW BODY. The HMAC covers the exact bytes Cal.com sent. `request.text()` is
 * read once, before anything parses it, and the parsed object is never
 * re-serialised for verification: `JSON.stringify(JSON.parse(body))` is a
 * different string for the same JSON and would fail every real delivery.
 *
 * A VERIFIED DELIVERY THAT IS HANDLED CLEANLY RETURNS 200. A verified delivery
 * whose write genuinely failed (not the expected duplicate-delivery race)
 * returns 500 so Cal.com retries it — see `recordCalBooking`'s doc comment.
 * The one thing a retry must never do is double-count a booking, and that is
 * the unique index plus `bookingWriteAction`, not the status code.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  recordCalBooking,
  type RecordedBooking,
} from '@/lib/flowstarter/bookings-data';
import { formatBookingWhen } from '@/lib/flowstarter/bookings';
import {
  CAL_SIGNATURE_HEADER,
  parseCalBookingEvent,
  shouldNotifyClient,
  verifyCalSignature,
  type CalBookingEvent,
} from '@/lib/flowstarter/cal-webhook';
import { notifyClientOnce } from '@/lib/flowstarter/client-notifications';
import { newBookingEmail } from '@/lib/email-templates/client-notices';

export const dynamic = 'force-dynamic';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One body for every refusal, so the response never says which check failed. */
const unauthorized = () =>
  NextResponse.json({ error: 'Invalid signature' }, { status: 401 });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;

  const signature = request.headers.get(CAL_SIGNATURE_HEADER);
  if (!signature) {
    // Step 1. Nothing is read, so nothing can be learned.
    return unauthorized();
  }

  const rawBody = await request.text();
  const supabase = createSupabaseServiceRoleClient();

  // Only a syntactically valid uuid can possibly have a row (and therefore a
  // secret) behind it — skip the query for anything else rather than asking
  // Postgres to compare a non-uuid string to a uuid column. Either way,
  // `secret` staying null takes the exact same path through
  // `verifyCalSignature` below: 401, indistinguishable from a wrong signature
  // for a real workspace.
  let secret: string | null = null;
  if (UUID_PATTERN.test(workspaceId)) {
    try {
      const { data, error } = await supabase
        .from('workspaces')
        .select('id, cal_com_webhook_secret')
        .eq('id', workspaceId)
        .maybeSingle();
      if (error) throw error;
      secret = data?.cal_com_webhook_secret ?? null;
    } catch (error) {
      console.error(
        `[cal] could not load workspace ${workspaceId}: ` +
          (error instanceof Error ? error.message : 'unknown error')
      );
      return NextResponse.json({ error: 'Unavailable' }, { status: 503 });
    }
  }

  if (!verifyCalSignature(rawBody, signature, secret)) {
    console.warn(
      `[cal] rejected a delivery claiming workspace ${workspaceId}: ` +
        (secret ? 'signature did not match' : 'no matching workspace/secret')
    );
    return unauthorized();
  }

  const parsed = parseCalBookingEvent(rawBody);
  if (!parsed.ok) {
    // Signed by us, so it is genuinely Cal.com, and a trigger we do not handle
    // is not an error. 200 stops the retries for a body that will never
    // become handleable.
    console.info(
      `[cal] ignoring a delivery for workspace ${workspaceId}: ${parsed.reason}`
    );
    return NextResponse.json({ ok: true, ignored: parsed.reason });
  }

  const event = parsed.event;
  let recorded: RecordedBooking;
  try {
    recorded = await recordCalBooking(supabase, {
      workspaceId,
      event,
      payload: JSON.parse(rawBody) as unknown,
    });
  } catch (error) {
    // A genuine storage failure, not the expected duplicate-delivery race
    // (that comes back as a normal `skip` from `recordCalBooking`, not a
    // throw). 500 tells Cal.com to retry; a 200 here would acknowledge a
    // delivery that was never actually saved.
    console.error(
      `[cal] could not record ${event.trigger} for workspace ${workspaceId}: ` +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return NextResponse.json(
      { ok: false, error: 'storage failure' },
      { status: 500 }
    );
  }

  if (shouldNotifyClient(recorded.action, event.trigger)) {
    await tellTheClient(workspaceId, event);
  }

  return NextResponse.json({
    ok: true,
    action: recorded.action.kind,
    ...(recorded.action.kind === 'skip'
      ? { reason: recorded.action.reason }
      : {}),
  });
}

/**
 * One email per booking, and never one the mailer could not send.
 *
 * The `RESEND_API_KEY` check is here rather than left to `sendEmail` because
 * an unconfigured mailer on a local stack would otherwise log an error on
 * every delivery and make a working webhook look broken. `notifyClientOnce`
 * handles the rest, including the case where the workspace has no address, and
 * cannot throw, so a webhook that has already saved the booking returns 200
 * whatever the mailer does.
 */
async function tellTheClient(
  workspaceId: string,
  event: CalBookingEvent
): Promise<void> {
  if (!process.env.RESEND_API_KEY) return;
  await notifyClientOnce({
    workspaceId,
    notification: 'booking_created',
    dedupeKey: event.uid,
    detail: { eventTypeSlug: event.eventTypeSlug, startAt: event.startAt },
    render: (recipient) =>
      newBookingEmail({
        bookingsUrl: `${recipient.dashboardUrl}/booking/list`,
        when: formatBookingWhen(event.startAt),
        attendeeName: event.attendeeName,
        eventName: event.title ?? event.eventTypeSlug,
        businessName: recipient.businessName,
        clientName: recipient.clientName,
      }),
  });
}
