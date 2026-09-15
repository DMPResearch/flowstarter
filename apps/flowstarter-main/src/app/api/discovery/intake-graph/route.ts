/**
 * POST /api/discovery/intake-graph — LangGraph HITL intake.
 *
 * Owns phrasing + multi-field extract. Hard gates (order, validation, done)
 * stay in `intake-script.ts`. Anonymous, rate-limited, fails open — same
 * doors as `/api/discovery/intake-chat`.
 *
 * Acceptable use is NOT one of the things this route decides. The moment the
 * graph settles a description, `screenIntakeDescription` asks the one gate
 * (`@/lib/policy/gate`, the classifier from #158/#185/#193) and the funnel's
 * one routing rule what that means; a `refuse` or a `hold` ends the intake
 * carrying the notice `@/lib/policy/copy` wrote, in the visitor's own
 * language. See `@/lib/flowstarter/intake-guardrail` for what this replaced
 * and why.
 *
 * Body:
 *   { action: 'start', data?, answered?, locale? }
 *   { action: 'resume', threadId, resume, data?, answered?, locale? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { funnelBudgetState } from '@/lib/ai/funnel-cost';
import { screenIntakeDescription } from '@/lib/flowstarter/intake-guardrail';
import { readJsonCapped } from '@/lib/net/ingress';
import { clientIp } from '@/lib/request-ip';
import {
  resetIntakeGraphDeps,
  resumeIntakeGraph,
  setIntakeGraphDeps,
  startIntakeGraph,
  type IntakeGraphTurnResult,
} from '@/lib/flowstarter/intake-graph';
import { EMPTY_DISCOVERY } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ResumeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(2000) }),
  z.object({ kind: z.literal('skip') }),
  z.object({ kind: z.literal('panel'), value: z.string().max(200) }),
]);

const DiscoveryPartialSchema = z.record(z.unknown()).optional();

const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    data: DiscoveryPartialSchema,
    answered: z.array(z.string().max(40)).max(40).optional().default([]),
    locale: z.enum(['en', 'ro']).optional().default('en'),
  }),
  z.object({
    action: z.literal('resume'),
    threadId: z.string().uuid(),
    resume: ResumeSchema,
    data: DiscoveryPartialSchema,
    answered: z.array(z.string().max(40)).max(40).optional().default([]),
    locale: z.enum(['en', 'ro']).optional().default('en'),
  }),
]);

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

async function withScriptedOnly<T>(run: () => Promise<T>): Promise<T> {
  setIntakeGraphDeps({
    phraseAsk: async ({ scriptedPrompt }) => scriptedPrompt,
    extractAnswers: async () => [],
    // No model budget left: a question goes unanswered rather than guessed,
    // and a failed answer shows the scripted error instead of a rephrase.
    answerVisitorQuestion: async () => {
      throw new Error('scripted-only: no model budget');
    },
    phraseClarification: async () => {
      throw new Error('scripted-only: no model budget');
    },
  });
  try {
    return await run();
  } finally {
    resetIntakeGraphDeps();
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isRateLimited(clientIp(request.headers))) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
  }

  // Capped as it streams rather than buffered and measured afterwards: an
  // anonymous body arrives in whatever size the sender chooses, and a chunked
  // one advertises no size at all. Codex F07.
  const read = await readJsonCapped(request);
  if (read.status === 'too_large') {
    return NextResponse.json(
      { error: 'That request is too large.' },
      { status: 413 }
    );
  }
  if (read.status === 'invalid') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const body: unknown = read.value;

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid intake graph request' },
      { status: 400 }
    );
  }

  const shared = {
    data: {
      ...EMPTY_DISCOVERY,
      ...((parsed.data.data as object) ?? {}),
    },
    answered: parsed.data.answered,
    locale: parsed.data.locale,
  };

  // Kill-switch before any model work. Fail open if accounting is down.
  try {
    const budget = await funnelBudgetState();
    if (budget.state === 'blocked') {
      const fallback = await withScriptedOnly(() => startIntakeGraph(shared));
      return NextResponse.json(
        {
          ...fallback,
          skipped: true,
          reason: 'budget',
        } satisfies IntakeGraphTurnResult,
        { status: 200 }
      );
    }
  } catch {
    // accounting unavailable — continue
  }

  try {
    if (parsed.data.action === 'start') {
      const result = await startIntakeGraph(shared);
      return NextResponse.json(result, { status: 200 });
    }

    const result = await resumeIntakeGraph({
      threadId: parsed.data.threadId,
      resume: parsed.data.resume,
      ...shared,
    });

    // ── The acceptable-use gate, and the only one ──────────────────────────
    // The turn runs FIRST, always, and its result is what gets screened. That
    // ordering is deliberate and it is half the fix: the description is a
    // field the graph EXTRACTS -- a visitor answering "what do you do" in
    // passing while answering something else still ends up with a
    // `description`, and a screen that read the raw resume text would miss
    // it. Screening what the graph settled means screening the same string
    // the scope gate and the preview route will screen later.
    //
    // It also means the visitor's answer is already recorded before any
    // verdict is reached, which is the other half. The moderator this
    // replaced returned `shared.data` -- the state from BEFORE the turn, with
    // the description still empty -- so a refused brief was also a discarded
    // one, and the pane went on reading "You do: Not yet".
    // Merged over EMPTY so a turn result built by a caller with a partial
    // `data` cannot make this throw on the way to a policy decision.
    const settled = { ...EMPTY_DISCOVERY, ...result.data };
    const answeredDescription =
      settled.description.trim().length > 0 &&
      settled.description !== shared.data.description;
    if (answeredDescription) {
      const screened = await screenIntakeDescription({
        description: settled.description,
        websiteUrl: settled.websiteUrl,
        instagramUrl: settled.instagramUrl,
        linkedinUrl: settled.linkedinUrl,
        locale: parsed.data.locale,
      });
      if (screened.stop) {
        return NextResponse.json(
          {
            ...result,
            // The conversation is over, but it is over for a reason the
            // visitor can read. `ask: null` alone is what the old moderator
            // sent, and `ask: null` alone is a dead end.
            status: 'complete',
            ask: null,
            skipped: true,
            reason: 'policy',
            errorKey: null,
            policyStop: screened.stop,
            policy: screened.notice,
          } satisfies IntakeGraphTurnResult,
          { status: 200 }
        );
      }
    }

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error(
      '[Flowstarter] intake graph failed: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
    const result = await withScriptedOnly(() => startIntakeGraph(shared));
    return NextResponse.json(
      {
        ...result,
        skipped: true,
        reason: 'error',
      } satisfies IntakeGraphTurnResult,
      { status: 200 }
    );
  }
}
