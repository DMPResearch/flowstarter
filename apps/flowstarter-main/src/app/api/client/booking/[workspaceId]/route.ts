/**
 * GET / PATCH / DELETE /api/client/booking/[workspaceId]
 *
 * One workspace's Cal.com connection, as the client's own booking page sees
 * it. Intake seeds `workspaces.cal_com_url`; this route is where the client
 * confirms it, changes it, or takes it away again.
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
