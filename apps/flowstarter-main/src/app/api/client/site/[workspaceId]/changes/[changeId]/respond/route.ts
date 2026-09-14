import 'server-only';
/**
 * POST /api/client/site/[workspaceId]/changes/[changeId]/respond
 *
 * The client's answer to a quote: accept or decline. Accepting a priced
 * quote opens a Stripe Checkout session and returns its link; the webhook
 * marks the request paid. Accepting a zero quote marks it paid here, because
 * there is nothing to collect.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { publicAppOrigin } from '@flowstarter/platform-config';
import {
  ChangeRequestError,
  acceptFreeChangeRequest,
  declineChangeRequest,
  getChangeRequest,
  toChangeRequestView,
} from '@/lib/flowstarter/change-requests';
import { createChangeRequestCheckout } from '@/lib/flowstarter/change-request-checkout';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  openSiteEditorContext,
  readJsonBody,
  siteEditorFailure,
} from '../../../../site-editor-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RespondSchema = z.object({
  decision: z.enum(['accept', 'decline']),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; changeId: string }> }
) {
  const { workspaceId, changeId } = await params;
  const opened = await openSiteEditorContext(workspaceId);
  if (!opened.ok) return opened.response;
  const { context } = opened;
  if (!UUID.test(changeId)) {
    return NextResponse.json(
      { error: 'Invalid change request id', code: 'INVALID' },
      { status: 400 }
    );
  }

  try {
    const parsed = RespondSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Say whether you accept or decline.', code: 'INVALID' },
        { status: 400 }
      );
    }
    const db = createSupabaseServiceRoleClient();
    const row = await getChangeRequest(db, context.workspaceId, changeId);
    if (!row) {
      return NextResponse.json(
        { error: 'Change request not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }
    if (row.status !== 'quoted' && row.status !== 'accepted') {
      return NextResponse.json(
        {
          error:
            row.status === 'requested'
              ? 'Your team has not quoted this yet.'
              : `This request is already ${row.status}.`,
          code: 'CHANGE_REQUEST_TRANSITION',
        },
        { status: 409 }
      );
    }

    if (parsed.data.decision === 'decline') {
      if (row.status !== 'quoted') {
        return NextResponse.json(
          {
            error: 'A request in checkout cannot be declined here.',
            code: 'CHANGE_REQUEST_TRANSITION',
          },
          { status: 409 }
        );
      }
      const declined = await declineChangeRequest(db, row, 'client');
      await db.from('project_events').insert({
        workspace_id: context.workspaceId,
        kind: 'change_request_declined',
        actor: context.access.actorId,
        payload: { changeRequestId: row.id, by: 'client' },
      });
      return NextResponse.json({ request: toChangeRequestView(declined) });
    }

    if (!row.quote_minor) {
      if (row.status !== 'quoted') {
        return NextResponse.json(
          {
            error: `This request is already ${row.status}.`,
            code: 'CHANGE_REQUEST_TRANSITION',
          },
          { status: 409 }
        );
      }
      const paid = await acceptFreeChangeRequest(db, row);
      await db.from('project_events').insert({
        workspace_id: context.workspaceId,
        kind: 'change_request_paid',
        actor: context.access.actorId,
        payload: { changeRequestId: row.id, amountMinor: 0, free: true },
      });
      return NextResponse.json({ request: toChangeRequestView(paid) });
    }

    const { data: workspace } = await db
      .from('workspaces')
      .select('client_email')
      .eq('id', context.workspaceId)
      .maybeSingle();
    const checkout = await createChangeRequestCheckout({
      row,
      clientEmail: workspace?.client_email ?? null,
      businessName: context.site.workspaceName,
      origin: publicAppOrigin(undefined, request.nextUrl.origin),
    });
    return NextResponse.json({ checkoutUrl: checkout.url }, { status: 201 });
  } catch (error) {
    if (error instanceof ChangeRequestError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    return siteEditorFailure(error);
  }
}
