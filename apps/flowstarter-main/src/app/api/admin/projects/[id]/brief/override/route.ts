import 'server-only';
/**
 * POST /api/admin/projects/[id]/brief/override
 *
 * The only way a site gets built from an incomplete brief.
 *
 * The build worker will not claim a FULL_SITE_BUILD until `workspace_briefs`
 * says the brief is ready, which is correct almost always and wrong in exactly
 * the cases a business actually has: the client sent everything by email, or
 * over the phone, or the offer is two lines and both of them are fine, or they
 * are on holiday and want the site anyway. Without a way through, the operator
 * is left editing a timestamp in psql, which is the same override with none of
 * the record.
 *
 * So this is the override, and everything about it is designed to be
 * attributable afterwards. A `reason` is required, not optional. The actor is
 * the authenticated operator, not a service account. Both land in
 * `project_events` as `brief_override`, next to every other intervention, and
 * `override_by` goes on the brief row itself so the next person reading it
 * does not have to find the event.
 *
 * Shaped after `overrideStateHandler` in `@/lib/flowstarter/pipeline/api`:
 * `requireTeamAuth` first, a syntactically valid workspace id second, the body
 * third, and nothing read from the database before all three have passed.
 * `requireTeamAuth` is the whole tenant boundary here, because everything
 * below it queries with the service role, which bypasses RLS.
 *
 * There is deliberately no un-override. A brief that becomes complete writes
 * its own `ready_at` through the client's form, and an override that was a
 * mistake is a conversation, not a button.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireTeamAuth } from '@/lib/api-auth';
import { loadBriefSnapshot } from '@/lib/flowstarter/brief-data';
import { enqueueBuildOnBriefReady } from '@/lib/flowstarter/deposit-workflow';
import { withTenant } from '@/lib/tenancy';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

/** Writes one tenant's rows; never statically rendered. */
export const dynamic = 'force-dynamic';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Required, and long enough to be a sentence. "ok" is not a reason, and the
 * whole value of this endpoint over a manual UPDATE is that six months later
 * somebody can read why a site was built without a brief.
 */
const BodySchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

/** The audit trail's name for this, alongside `state_overridden`. */
const EVENT_KIND = 'brief_override';

function badRequest(message: string, code = 'BAD_REQUEST', status = 400) {
  return NextResponse.json({ error: message, code }, { status });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const { id } = await params;
  if (!UUID.test(id)) return badRequest('Invalid workspace id');

  const raw = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return badRequest(
      first
        ? `${first.path.join('.') || 'body'}: ${first.message}`
        : 'Invalid body',
      'INVALID_BODY'
    );
  }
  const reason = parsed.data.reason;

  try {
    const db = createSupabaseServiceRoleClient();

    const { data: workspace, error: workspaceError } = await db
      .from('workspaces')
      .select('id, project_state')
      .eq('id', id)
      .maybeSingle();
    if (workspaceError) throw workspaceError;
    if (!workspace) {
      return NextResponse.json(
        { error: 'Workspace not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    const now = new Date().toISOString();
    // Upsert rather than update: the workspace most likely to need an override
    // is the one whose client never opened the brief page, and that workspace
    // has no row at all. An update would report success having changed
    // nothing, and the build would go on waiting.
    const { error: writeError } = await withTenant(db, id)
      .from('workspace_briefs')
      .upsert(
        { override_at: now, override_by: auth.userId, updated_at: now },
        { onConflict: 'workspace_id' }
      );
    if (writeError) throw writeError;

    // The audit trail. Best effort by the same reasoning `recordEvent` in the
    // pipeline API uses: the override has already landed, and losing the note
    // is not a reason to tell an operator their intervention failed. Loud in
    // the logs instead.
    const { error: eventError } = await db.from('project_events').insert({
      workspace_id: id,
      kind: EVENT_KIND,
      actor: auth.userId,
      payload: { reason, overrideAt: now },
    });
    if (eventError) {
      console.error(
        `[brief-override] could not write the ${EVENT_KIND} event for ${id}:`,
        eventError
      );
    }

    // An override that does not start the build is a timestamp, which is the
    // thing this endpoint exists to be better than. `override_at` is one of
    // the two conditions the worker's claim reads, so the moment it is written
    // the parked job may run -- and the same helper the client's own brief
    // save uses is what lets it out of the waiting room, with the material the
    // brief does hold composed onto its payload.
    //
    // Never throws, by its own contract: the override has landed either way,
    // and the worker's reconciliation sweep is the backstop.
    const build = await enqueueBuildOnBriefReady({ workspaceId: id });

    // The readiness the client's own brief page would show, so an operator who
    // overrode a brief can see exactly what they waived. Read through the same
    // loader that page uses, which is the only way the two can never disagree.
    const snapshot = await loadBriefSnapshot(id);

    return NextResponse.json({
      override: { at: now, by: auth.userId, reason },
      readiness: snapshot.readiness,
      build: {
        outcome: build.outcome,
        jobId: build.jobId,
        reason: build.reason,
      },
    });
  } catch (error) {
    console.error('[brief-override] failed', error);
    return NextResponse.json(
      { error: 'Could not override the brief', code: 'DB_ERROR' },
      { status: 500 }
    );
  }
}
