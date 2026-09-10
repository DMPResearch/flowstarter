import 'server-only';
/**
 * POST /api/client/site/[workspaceId]/edit — propose one change.
 *
 * Runs the guardrailed inline agent and returns what it would write. Nothing
 * is applied here: the client sees the old text beside the new one and decides,
 * which is the difference between an editor and a slot machine.
 *
 * The order below is the whole security and cost story:
 *
 *   access → policy over the *requested* target → burst limit → monthly
 *   credits → daily cap → audit row → model.
 *
 * Credits come before the daily cap because they are the thing the client
 * bought: a client with nothing left this month should be told that, not told
 * to come back tomorrow to a wall that will still be there.
 *
 * The audit row is written before the model runs, not after, because the row
 * is what the daily cap counts. Writing it afterwards would mean a run that
 * timed out cost the tenant tokens and bought no quota, and a client hammering
 * a failing edit could spend the month's budget without the cap ever moving.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { llmActionConfig, recordLlmUsage } from '@/lib/ai/llm';
import { SlidingWindowRateLimiter } from '@/lib/rate-limit';
import {
  creditsExhaustedMessage,
  editCreditPosition,
  startOfUtcMonth,
} from '@/lib/flowstarter/edit-credits';
import {
  DAILY_EDIT_CAP,
  EDIT_RATE_LIMIT,
  MAX_INSTRUCTION_CHARS,
  classifyTargetCapability,
  countProposalsSince,
  countProposalsToday,
  findTarget,
  instructionFingerprint,
  recordSiteEditorEvent,
} from '@/lib/flowstarter/site-editor';
import {
  openSiteEditorContext,
  readJsonBody,
  refuseUnlessAllowed,
  siteEditorFailure,
} from '../../site-editor-context';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const EditSchema = z.object({
  targetId: z.string().min(1).max(300),
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_CHARS),
});

/** One workspace, one minute. Module scope so it survives between requests. */
const burst = new SlidingWindowRateLimiter(EDIT_RATE_LIMIT);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const opened = await openSiteEditorContext(workspaceId);
  if (!opened.ok) return opened.response;
  const { context } = opened;

  try {
    const parsed = EditSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: `Send a targetId and an instruction of at most ${MAX_INSTRUCTION_CHARS} characters.`,
          code: 'INVALID',
        },
        { status: 400 }
      );
    }
    const { targetId, instruction } = parsed.data;

    // What this target really is, decided from the site rather than from what
    // the caller says it is. A stylesheet or a component classifies as a
    // capability the client tier does not own, and the policy refuses it.
    const capability = classifyTargetCapability(context.site.files, targetId);
    const refusal = refuseUnlessAllowed(
      context,
      capability,
      'inline_content_agent'
    );
    if (refusal) return refusal;

    const target = findTarget(context.site.files, targetId);
    if (!target) {
      return NextResponse.json(
        { error: 'That block is not part of this site', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    const limited = burst.check(context.workspaceId);
    if (limited.limited) {
      return NextResponse.json(
        {
          error: 'That is a lot of changes at once. Give it a moment.',
          code: 'RATE_LIMITED',
          retryAt: limited.resetAt,
        },
        { status: 429 }
      );
    }

    // One clock for the whole request, so the window a proposal is counted in
    // and the reset date the client is quoted cannot disagree.
    const now = new Date();
    const [used, usedThisMonth] = await Promise.all([
      countProposalsToday(context.workspaceId, now),
      countProposalsSince(context.workspaceId, startOfUtcMonth(now)),
    ]);

    const credits = editCreditPosition({
      tier: context.site.tierName,
      usedThisMonth,
      now,
    });
    if (credits.exhausted) {
      return NextResponse.json(
        {
          error: creditsExhaustedMessage(credits),
          code: 'CREDITS_EXHAUSTED',
          allowance: { used, cap: DAILY_EDIT_CAP, credits },
        },
        { status: 429 }
      );
    }

    if (used >= DAILY_EDIT_CAP) {
      return NextResponse.json(
        {
          error: `You have made ${DAILY_EDIT_CAP} edits today, which is the daily limit. It resets at midnight UTC.`,
          code: 'DAILY_CAP',
          allowance: { used, cap: DAILY_EDIT_CAP, credits },
        },
        { status: 429 }
      );
    }

    // Never the prompt itself: a client's words about their own business can
    // name anyone, and this row is read by operators.
    const fingerprint = instructionFingerprint(instruction);
    await recordSiteEditorEvent({
      workspaceId: context.workspaceId,
      kind: 'site_edit_proposed',
      actor: context.access.actorId,
      payload: { targetId, ...fingerprint, file: target.file },
    });

    const proposal = await proposeReplacement({
      workspaceId: context.workspaceId,
      actorId: context.access.actorId,
      subscriptionStatus: context.access.subscriptionStatus,
      targetId,
      originalContent: target.content,
      instruction,
    });

    return NextResponse.json({
      ...proposal,
      allowance: {
        used: used + 1,
        cap: DAILY_EDIT_CAP,
        // The row this request wrote is already spent, so the client is shown
        // the position they are in now rather than the one they arrived in.
        credits: editCreditPosition({
          tier: context.site.tierName,
          usedThisMonth: usedThisMonth + 1,
          now,
        }),
      },
    });
  } catch (error) {
    if (error instanceof EditorUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: 'EDITOR_UNAVAILABLE' },
        { status: 503 }
      );
    }
    return siteEditorFailure(error);
  }
}

class EditorUnavailableError extends Error {}

/**
 * The inline agent, built exactly as the preview pipeline builds it: usage
 * flows to `recordLlmUsage` so the tokens land on the tenant's ledger rather
 * than nowhere, and the run is capped by the same `preview_edit` budget the
 * rest of the app uses.
 */
async function proposeReplacement(input: {
  workspaceId: string;
  actorId: string;
  subscriptionStatus: import('@flowstarter/agentic-codegen/src/flowstarter/editor-policy').SubscriptionAccessStatus;
  targetId: string;
  originalContent: string;
  instruction: string;
}) {
  const apiKey =
    process.env.PI_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new EditorUnavailableError(
      'The editing assistant is not configured on this environment.'
    );
  }

  const { PiSdkFlowstarterAgents } = await import(
    '@flowstarter/agentic-codegen'
  );
  const agents = new PiSdkFlowstarterAgents({
    provider: process.env.PI_PROVIDER?.trim() || 'openrouter',
    modelId: process.env.PI_MODEL?.trim() || 'z-ai/glm-5.2',
    apiKey,
    thinkingLevel: 'low',
    timeoutMs: 90_000,
    maxRunTokens: llmActionConfig('preview_edit').maxTokens,
    usageSink: (usage) => {
      void recordLlmUsage({
        // The tenant this ran for. Anonymous funnel edits pass null here;
        // an authenticated editor never should.
        workspaceId: input.workspaceId,
        projectId: null,
        action: usage.action,
        model: usage.model,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        cachedTokens: usage.cachedTokens,
      });
    },
  });

  const result = await agents.editInline(
    {
      projectId: input.workspaceId,
      targetId: input.targetId,
      originalContent: input.originalContent,
      instruction: input.instruction,
      requestedBy: input.actorId,
    },
    {
      actorId: input.actorId,
      role: 'client',
      subscriptionStatus: input.subscriptionStatus,
    }
  );

  return {
    targetId: result.targetId,
    originalContent: result.originalContent,
    replacementContent: result.replacementContent,
  };
}
