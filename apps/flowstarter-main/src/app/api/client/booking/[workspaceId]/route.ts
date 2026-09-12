/**
 * GET / POST / PATCH / DELETE /api/client/booking/[workspaceId]
 *
 * One workspace's Cal.com connection, as the client's own booking page sees
 * it. Intake seeds `workspaces.cal_com_url`; this route is where the client
 * confirms it, changes it, or takes it away again. POST is the other way in:
 * it asks the platform to make the client a calendar of their own, which is
 * what the claim already does for them and what the dashboard's "set up my
 * booking page" and "try again" buttons re-run.
 *
 * The route checks the caller and the shape of the request and does nothing
 * else: which links are acceptable, what the canonical form of one is, when a
 * signing secret is minted and when it survives an edit all live in
 * `lib/flowstarter/cal-link.ts` and `lib/flowstarter/cal-integration.ts`, so
 * the page and the API cannot disagree about any of it.
 *
 * THE SECRET IS IN THE RESPONSE, deliberately. The client has to paste it into
 * Cal.com's own webhook settings, so it is theirs to see. It only ever reaches
 * a caller `requireWorkspaceAccess` has already proved is a member of this
 * workspace, which is the same bar as the rest of their project data.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import {
  connectCalCom,
  disconnectCalCom,
  loadCalConnection,
} from '@/lib/flowstarter/cal-integration';
import { notifyClientBookingPageReady } from '@/lib/flowstarter/cal-provisioned-notice';
import { provisionWorkspaceCalendar } from '@/lib/flowstarter/cal-provisioning';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  calComUrl: z.string().max(400),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  const supabase = createSupabaseServiceRoleClient();
  let connection;
  try {
    connection = await loadCalConnection(supabase, access.workspaceId);
  } catch {
    return NextResponse.json(
      { error: 'Could not load booking' },
      { status: 500 }
    );
  }
  if (!connection) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  return NextResponse.json(connection);
}

/**
 * Make this workspace a booking page, or find the one it already has.
 *
 * Every rule is `provisionWorkspaceCalendar`'s: what the username may be, what
 * the hours are, whether this environment can provision at all, what a client
 * is told when it fails, and the fact that re-running is a no-op. The route
 * adds the access check and nothing else, so the claim path and this button
 * cannot produce two different calendars.
 *
 * A FAILURE IS 200 WITH `ok: false`, not a 5xx. Nothing here is broken from
 * the caller's side: the request was valid, it was answered, and the answer is
 * one sentence about why the client has no booking page yet. A 500 would make
 * the browser's own error path swallow that sentence, and the client would be
 * left with "something went wrong" for a thing they can retry. The one case
 * that is genuinely ours to own -- an unexpected throw -- is still a 500
 * below, because then we do not have a sentence to give them.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  const supabase = createSupabaseServiceRoleClient();
  let result;
  try {
    result = await provisionWorkspaceCalendar({
      supabase,
      workspaceId: access.workspaceId,
      // The session, never the body: this row is written to the ledger.
      actor: access.userId,
      notify: notifyClientBookingPageReady,
    });
  } catch {
    return NextResponse.json(
      { error: 'Could not set up your booking page.' },
      { status: 500 }
    );
  }

  return NextResponse.json(result);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid booking update' },
      { status: 400 }
    );
  }

  // An empty string used to mean "remove it". It has its own verb now, so an
  // empty save is a mistake worth naming rather than a silent disconnect.
  if (!parsed.data.calComUrl.trim()) {
    return NextResponse.json(
      { error: 'Paste your Cal.com link first.' },
      { status: 400 }
    );
  }

  const supabase = createSupabaseServiceRoleClient();
  let result;
  try {
    result = await connectCalCom(supabase, {
      workspaceId: access.workspaceId,
      rawLink: parsed.data.calComUrl,
      actor: access.userId,
    });
  } catch {
    return NextResponse.json(
      { error: 'Could not save your booking link.' },
      { status: 500 }
    );
  }

  if (!result.ok) {
    const status =
      result.reason === 'not_found'
        ? 404
        : result.reason === 'write_failed'
        ? 500
        : 400;
    return NextResponse.json({ error: result.message }, { status });
  }

  return NextResponse.json(result.connection);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  const supabase = createSupabaseServiceRoleClient();
  let connection;
  try {
    connection = await disconnectCalCom(supabase, {
      workspaceId: access.workspaceId,
      actor: access.userId,
    });
  } catch {
    return NextResponse.json(
      { error: 'Could not disconnect your calendar.' },
      { status: 500 }
    );
  }
  if (!connection) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  return NextResponse.json(connection);
}
