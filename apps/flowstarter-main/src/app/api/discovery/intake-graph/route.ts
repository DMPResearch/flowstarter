/**
 * POST /api/discovery/intake-graph — LangGraph HITL intake.
 *
 * Owns phrasing + multi-field extract. Hard gates (order, validation, done)
 * stay in `intake-script.ts`. Anonymous, rate-limited, fails open — same
 * doors as `/api/discovery/intake-chat`.
 *
 * Body:
 *   { action: 'start', data?, answered?, locale? }
 *   { action: 'resume', threadId, resume, data?, answered?, locale? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { funnelBudgetState } from '@/lib/ai/funnel-cost';
import { aiModerateContent } from '@/lib/ai/moderate';
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

function clientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
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
  if (isRateLimited(clientIp(request))) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

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

    const latest =
      parsed.data.resume.kind === 'text' ? parsed.data.resume.text : '';
    // Only moderate substantial prose — a name or chip value is not a brief,
    // and the business-site moderator will false-positive on short strings.
    if (latest.trim().length >= 80) {
      const verdict = await aiModerateContent({
        description: latest,
        industry: '',
        goals: '',
        services: '',
      }).catch(() => null);
      if (verdict?.isProhibited) {
        return NextResponse.json(
          {
            threadId: parsed.data.threadId,
            status: 'complete',
            ask: null,
            data: shared.data,
            answered: shared.answered,
            progress: { done: 0, total: 0 },
            skipped: true,
            reason: 'error',
            errorKey: null,
          } as IntakeGraphTurnResult,
          { status: 200 }
        );
      }
    }

    const result = await resumeIntakeGraph({
      threadId: parsed.data.threadId,
      resume: parsed.data.resume,
      ...shared,
    });
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
