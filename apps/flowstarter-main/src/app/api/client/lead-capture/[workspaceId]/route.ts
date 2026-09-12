/**
 * GET / POST /api/client/lead-capture/[workspaceId]
 *
 * One workspace's contact form connection, as the client's own page sees it:
 * the public token their site ships, and a POST that replaces it.
 *
 * THE TOKEN IS IN THE RESPONSE, deliberately, the same way the Cal.com signing
 * secret is. It is printed on every page of the client's public website; there
 * is nothing to protect it from here. What the route does protect is rotation,
 * which is a write on somebody's tenant, so it goes through
 * `requireWorkspaceAccess` like every other client write.
 *
 * Rotation is POST rather than PATCH because it takes no body and produces a
 * new value rather than storing a given one. It is not idempotent and must not
 * look it: a retry mints a second token and kills the first.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/api-auth';
import {
  ensureLeadCaptureToken,
  rotateLeadCaptureToken,
} from '@/lib/flowstarter/lead-capture';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  const supabase = createSupabaseServiceRoleClient();
  let capture;
  try {
    capture = await ensureLeadCaptureToken(supabase, access.workspaceId);
  } catch {
    return NextResponse.json(
      { error: 'Could not load your contact form settings.' },
      { status: 500 }
    );
  }
  if (!capture) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  return NextResponse.json({ token: capture.token, slug: capture.slug });
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.authorized) return access.response;

  const supabase = createSupabaseServiceRoleClient();
  let capture;
  try {
    capture = await rotateLeadCaptureToken(supabase, {
      workspaceId: access.workspaceId,
      actor: access.userId,
    });
  } catch {
    return NextResponse.json(
      { error: 'Could not rotate your token.' },
      { status: 500 }
    );
  }
  if (!capture) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  return NextResponse.json({ token: capture.token, slug: capture.slug });
}
