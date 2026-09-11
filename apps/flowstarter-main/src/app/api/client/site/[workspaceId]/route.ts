import 'server-only';
/**
 * GET — everything the editor panel needs to draw itself for one workspace:
 * the blocks that can be edited, the version history, how much of the day's
 * burst cap and of the month's plan allowance is left, and the policy's
 * verdict on each capability.
 *
 * The policy decisions are returned rather than inferred client-side so the UI
 * can show the reason a control is unavailable in the policy's own words. They
 * are a mirror, never a gate: every mutating route re-runs the same check.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  editCreditPosition,
  startOfUtcMonth,
} from '@/lib/flowstarter/edit-credits';
import {
  DAILY_EDIT_CAP,
  MAX_INSTRUCTION_CHARS,
  countProposalsSince,
  countProposalsToday,
  decideEditorAction,
  listEditableTargets,
  listSiteVersions,
} from '@/lib/flowstarter/site-editor';
import { findBuiltIndex } from '@/lib/flowstarter/site-preview';
import {
  openSiteEditorContext,
  siteEditorFailure,
} from '../site-editor-context';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const opened = await openSiteEditorContext(workspaceId);
  if (!opened.ok) return opened.response;
  const { context } = opened;

  try {
    // One clock, so the day window, the month window and the reset date the
    // client is quoted all come from the same instant.
    const now = new Date();
    const [versions, used, usedThisMonth] = await Promise.all([
      listSiteVersions(context.workspaceId),
      countProposalsToday(context.workspaceId, now),
      countProposalsSince(context.workspaceId, startOfUtcMonth(now)),
    ]);

    return NextResponse.json({
      site: {
        name: context.site.workspaceName,
        version: context.site.version,
        templateSlug: context.site.templateSlug,
        /** False when the preview is the content view rather than the page. */
        rendersBuiltHtml: Boolean(findBuiltIndex(context.site.files)),
      },
      targets: listEditableTargets(context.site.files).map((target) => ({
        id: target.id,
        key: target.key,
        section: target.section,
        content: target.content,
        file: target.file,
        line: target.line,
      })),
      versions,
      allowance: {
        used,
        cap: DAILY_EDIT_CAP,
        maxInstructionChars: MAX_INSTRUCTION_CHARS,
        credits: editCreditPosition({
          tier: context.site.tierName,
          usedThisMonth,
          now,
        }),
      },
      policy: {
        content: decideEditorAction(context.access, 'content'),
        image: decideEditorAction(context.access, 'image'),
        structural: decideEditorAction(context.access, 'layout'),
      },
    });
  } catch (error) {
    return siteEditorFailure(error);
  }
}
