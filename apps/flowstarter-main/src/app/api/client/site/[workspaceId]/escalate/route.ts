import 'server-only';
/**
 * POST /api/client/site/[workspaceId]/escalate — "I want something bigger."
 *
 * The editor changes words and pictures; everything else is our work. The
 * client describes what they want, deterministic rules classify it
 * (change-request.ts — no model decides), and:
 *
 *   - structural  → filed into the project thread as a `change_request` the
 *                   team sees and answers; the client is told it reached us.
 *   - content/image → pointed back at the tab that already does it, with no
 *                   ticket — unless they insist (`force`), because a client
 *                   who says "no, really, I want you to do it" is right.
 *
 * Policy: the only refusal is a genuine `deny` (lapsed plan). A
 * `maintenance_request` decision is not a refusal here — it is precisely the
 * case this endpoint exists for.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  classifyChangeRequest,
  formatChangeRequestBody,
} from '@/lib/flowstarter/change-request';
import { recordChangeRequest } from '@/lib/flowstarter/messaging';
import { createChangeRequest } from '@/lib/flowstarter/change-requests';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  policyErrorBody,
  policyStatusFor,
  screenAcceptableUse,
} from '@/lib/policy/gate';
import { changeRequestSubject } from '@/lib/policy/subject';
import {
  decideEditorAction,
  policyStatus,
} from '@/lib/flowstarter/site-editor';
import {
  openSiteEditorContext,
  readJsonBody,
  siteEditorFailure,
} from '../../site-editor-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EscalateSchema = z.object({
  request: z.string().trim().min(10).max(2_000),
  /** The client read the "you can do this yourself" answer and insists. */
  force: z.boolean().optional().default(false),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const opened = await openSiteEditorContext(workspaceId);
  if (!opened.ok) return opened.response;
  const { context } = opened;

  try {
    const parsed = EscalateSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            'Describe the change in 10 to 2000 characters so the team can act on it.',
          code: 'INVALID',
        },
        { status: 400 }
      );
    }

    const decision = decideEditorAction(context.access, 'layout');
    if (decision.action === 'deny') {
      return NextResponse.json(
        {
          error: decision.reason,
          code: 'EDITOR_POLICY',
          policy: {
            action: decision.action,
            reason: decision.reason,
            capability: 'layout',
          },
        },
        { status: policyStatus(decision) }
      );
    }

    // The acceptable-use gate on the client's own words. A change request is
    // the one surface where a site that passed every gate can be asked to
    // become something else: "add a page where people can book an escort", or
    // "put the price list for the pills on the home page". It is screened
    // before a ticket exists, so the request never reaches a quote form.
    //
    // Post-deposit surface, so a refusal is held for a person rather than
    // written by a threshold. The client is told the same sentence either way.
    const screening = await screenAcceptableUse({
      surface: 'change_request',
      text: changeRequestSubject({ request: parsed.data.request }),
      workspaceId: context.workspaceId,
      actor: context.access.actorId,
      refusalBecomesReview: true,
    });
    if (screening.blocked && screening.notice) {
      return NextResponse.json(policyErrorBody(screening.notice), {
        status: policyStatusFor(screening.verdict),
      });
    }

    const classification = classifyChangeRequest(parsed.data.request);
    if (classification.capability !== 'structural' && !parsed.data.force) {
      return NextResponse.json(
        {
          classification: classification.capability,
          escalated: false,
        },
        { status: 200 }
      );
    }

    const { messageId } = await recordChangeRequest({
      workspaceId: context.workspaceId,
      body: formatChangeRequestBody({
        request: parsed.data.request,
        classification,
      }),
      clerkUserId: context.access.actorId,
    });
    // The same ask, as a piece of work the team can price and the client can
    // accept and pay. The thread message is the record; this row is the
    // quote's home.
    const changeRequest = await createChangeRequest(
      createSupabaseServiceRoleClient(),
      {
        workspaceId: context.workspaceId,
        request: parsed.data.request,
        classification,
        messageId,
        createdBy: context.access.actorId,
      }
    );
    return NextResponse.json(
      {
        classification: classification.capability,
        escalated: true,
        messageId,
        changeRequestId: changeRequest.id,
      },
      { status: 201 }
    );
  } catch (error) {
    return siteEditorFailure(error);
  }
}
