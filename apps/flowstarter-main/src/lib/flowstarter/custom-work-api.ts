import 'server-only';

/**
 * The operator's custom work lane, as two handlers.
 *
 * Written once and re-exported by both `/api/admin/custom-work-leads` and
 * `/api/team/custom-work-leads`, for the reason given at the top of
 * `./pipeline/api.ts`: every existing pair in this tree was copy-pasted, and a
 * copy-pasted pair is a pair where only one half gets the fix.
 *
 * Operator-only via `requireTeamAuth`. These rows have no workspace and no
 * membership, so there is no per-tenant check to make beyond that one: the
 * lane is cross-tenant by definition, which is what the operator dashboards
 * are for.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireTeamAuth } from '@/lib/api-auth';
import {
  listCustomWorkLeads,
  markCustomWorkLeadContacted,
} from './custom-work-leads';
import { buildCustomWorkLane } from './pipeline/custom-work-lane';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** GET: the whole lane, newest first. */
export async function customWorkLaneHandler(): Promise<NextResponse> {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  try {
    const leads = await listCustomWorkLeads();
    return NextResponse.json(buildCustomWorkLane({ leads }), {
      headers: NO_STORE,
    });
  } catch (error) {
    console.error(
      '[custom-work] could not load the lane:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json(
      { error: 'Could not load the custom work lane.' },
      { status: 500 }
    );
  }
}

type Ctx = { params: Promise<{ id: string }> };

/** POST: "Mark contacted", stamped with the operator who pressed it. */
export async function markContactedHandler(
  _req: NextRequest,
  ctx: Ctx
): Promise<NextResponse> {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const { id } = await ctx.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'Invalid lead id' }, { status: 400 });
  }

  try {
    const row = await markCustomWorkLeadContacted({ id, by: auth.userId });
    if (!row) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }
    return NextResponse.json(
      { lead: buildCustomWorkLane({ leads: [row] }).cards[0] },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error(
      '[custom-work] could not mark the lead contacted:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json(
      { error: 'Could not update the lead.' },
      { status: 500 }
    );
  }
}
