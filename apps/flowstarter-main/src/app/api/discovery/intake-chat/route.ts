/**
 * POST /api/discovery/intake-chat — the info agent.
 *
 * The step between the form and the preview: the form holds the hard fields,
 * this asks about the two or three things a form answers badly, in the
 * visitor's own words, and hands those words back so the preview is generated
 * from evidence instead of from guesses.
 *
 * Three rules shape this route.
 *
 * 1. **The gate decides what is missing; the model only phrases the ask.**
 *    `evaluateSufficiency` runs here, server-side, over the answers as they
 *    stand. Only the gaps it found — and only the ones a conversation can
 *    actually close — are handed to `interviewIntake`. When the gate finds
 *    nothing, no model call is made at all: an answered intake costs zero
 *    tokens and asks zero questions.
 *
 * 2. **Anonymous, so every door is bolted.** There is no workspace at this
 *    point in the funnel, so there is nothing to authorize against and no
 *    tenant row to write. What is left is spend: an IP rate limit, a turn cap,
 *    an input-size cap, moderation of the visitor's own text, and the funnel
 *    budget kill-switch — the same one `/api/discovery/preview/live` checks —
 *    so this cannot be farmed for tokens.
 *
 * 3. **It fails open, never closed.** Budget blocked, Pi unconfigured, model
 *    error: all return 200 with `status: 'complete', skipped: true`. The
 *    visitor moves on to their preview. A gap-filler that dead-ends the funnel
 *    is worse than no gap-filler.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  MAX_INTAKE_INPUT_CHARS,
  MAX_INTAKE_QUESTIONS,
  MAX_TRANSCRIPT_TURNS,
  MAX_TURN_CHARS,
  assetGaps,
  conversationalGaps,
  extractIntakeAnswers,
  intakeInputSize,
  sufficiencyInputFromAnswers,
  type IntakeChatResponse,
  type IntakeChatSkipReason,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/intake-chat.shared';
import { funnelBudgetState } from '@/lib/ai/funnel-cost';
import { llmActionConfig, recordLlmUsage } from '@/lib/ai/llm';
import { aiModerateContent } from '@/lib/ai/moderate';
import { evaluateSufficiency } from '@/lib/flowstarter/sufficiency';
import { readJsonCapped } from '@/lib/net/ingress';
import { clientIp } from '@/lib/request-ip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Two model turns at worst; nowhere near the preview pipeline's budget. */
export const maxDuration = 60;

const TurnSchema = z.object({
  role: z.enum(['agent', 'client']),
  text: z.string().min(1).max(MAX_TURN_CHARS),
});

const AnswersSchema = z.object({
  businessName: z.string().max(200).optional().default(''),
  description: z.string().max(5_000).optional().default(''),
  industry: z.string().max(200).optional().default(''),
  targetAudience: z.string().max(500).optional().default(''),
  goal: z.string().max(400).optional().default(''),
  email: z.string().max(320).optional().default(''),
  phone: z.string().max(40).optional().default(''),
  services: z.array(z.string().max(120)).max(20).optional().default([]),
  intakeAnswers: z
    .array(z.string().max(MAX_TURN_CHARS))
    .max(MAX_TRANSCRIPT_TURNS)
    .optional()
    .default([]),
});

const Schema = z.object({
  answers: AnswersSchema,
  transcript: z
    .array(TurnSchema)
    .max(MAX_TRANSCRIPT_TURNS)
    .optional()
    .default([]),
  locale: z.enum(['en', 'ro']).optional().default('en'),
});

// ─── Rate limiting ─────────────────────────────────────────────────────────
//
// Same shape as /api/discovery/recommend: process-local, which is the honest
// bound for a single-instance deployment and is not the only protection —
// the turn cap and the funnel budget sit behind it.

const RATE_LIMIT = 12;
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

// ─── The route ─────────────────────────────────────────────────────────────

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
      { error: 'Invalid intake chat request' },
      { status: 400 }
    );
  }
  const { answers, transcript, locale } = parsed.data;

  if (intakeInputSize({ answers, transcript }) > MAX_INTAKE_INPUT_CHARS) {
    return NextResponse.json(
      { error: 'That is more than this step can take in one go' },
      { status: 413 }
    );
  }

  // Answers extracted from the conversation count towards the gate: an answer
  // the visitor already gave must not be asked for a second time.
  const extracted = extractIntakeAnswers({ transcript });
  const gate = evaluateSufficiency(
    sufficiencyInputFromAnswers({
      ...answers,
      services:
        extracted.services && extracted.services.length > 0
          ? extracted.services
          : answers.services,
      phone: answers.phone || (extracted.phone ?? ''),
      intakeAnswers: [...answers.intakeAnswers, ...extracted.answers],
    })
  );

  const gaps = conversationalGaps(gate.missing);
  const questionsAsked = transcript.filter(
    (turn) => turn.role === 'agent'
  ).length;

  const base = (
    over: Partial<IntakeChatResponse> = {}
  ): IntakeChatResponse => ({
    status: 'complete',
    question: null,
    missing: gate.missing,
    asks: {
      conversational: gaps.map((item) => item.code),
      assets: assetGaps(gate.missing).map((item) => item.code),
    },
    extracted,
    documents: [],
    questionsAsked,
    maxQuestions: MAX_INTAKE_QUESTIONS,
    ...over,
  });

  // Nothing a conversation can fix, or the cap is spent. Either way: no model.
  if (gaps.length === 0 || questionsAsked >= MAX_INTAKE_QUESTIONS) {
    return NextResponse.json(base(), { status: 200 });
  }

  // The visitor's own words are about to reach a model and, through the
  // generated copy, the public site. Same screen support-chat's inputs get.
  const latestClientTurn = [...transcript]
    .reverse()
    .find((turn) => turn.role === 'client');
  if (latestClientTurn) {
    const verdict = await aiModerateContent({
      description: `${answers.description}\n${latestClientTurn.text}`,
      industry: answers.industry,
      goals: answers.goal,
      services: answers.services.join(', '),
    }).catch(() => null);
    if (verdict?.isProhibited) {
      return NextResponse.json(
        base({
          question:
            'We are not able to build sites for this kind of business. ' +
            'If you think that is wrong, email hello@flowstarter.net.',
          skipped: true,
          reason: 'error',
        }),
        { status: 200 }
      );
    }
  }

  // The kill-switch. An unauthenticated endpoint that calls a model must be
  // able to stop calling it.
  try {
    const budget = await funnelBudgetState();
    if (budget.state === 'blocked') {
      return NextResponse.json(base(skipped('budget')), { status: 200 });
    }
  } catch {
    // Fail-safe: our own accounting being unavailable never blocks a visitor.
  }

  const piApiKey =
    process.env.PI_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
  if (!piApiKey) {
    return NextResponse.json(base(skipped('unconfigured')), { status: 200 });
  }

  try {
    const { PiSdkFlowstarterAgents } = await import(
      '@flowstarter/agentic-codegen'
    );
    const budget = llmActionConfig('intake_interview');
    const agents = new PiSdkFlowstarterAgents({
      provider: process.env.PI_PROVIDER?.trim() || 'openrouter',
      modelId: process.env.PI_MODEL?.trim() || 'z-ai/glm-5.2',
      apiKey: piApiKey,
      thinkingLevel: 'low',
      timeoutMs: 25_000,
      // Two short attempts fit inside this route's 60s ceiling; the session
      // runner's default of three would not, and a chat turn that fails open
      // is better than one the platform cuts off mid-retry.
      maxSessionAttempts: 2,
      retryBaseDelayMs: 500,
      // Whole-run ceiling from the same budget table the AI-SDK wrapper uses.
      maxRunTokens: budget.maxTokens,
      // Anonymous funnel traffic: no workspace, no project, so the ledger row
      // carries nulls. Never awaited — accounting must not slow a reply.
      usageSink: (usage) => {
        void recordLlmUsage({
          workspaceId: null,
          projectId: null,
          action: usage.action,
          model: usage.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          cachedTokens: usage.cachedTokens,
        });
      },
      roles: {
        // 'intake' exists for exactly this: short, cheap, conversational.
        intake: {
          ...(process.env.PI_INTAKE_MODEL?.trim()
            ? { modelId: process.env.PI_INTAKE_MODEL.trim() }
            : {}),
          ...(budget.maxOutputTokens
            ? { maxOutputTokens: budget.maxOutputTokens }
            : {}),
          timeoutMs: 25_000,
        },
      },
    });

    const result = await agents.interviewIntake({
      // `known` is what the agent must NOT ask about, plus the gate's verdict
      // on what it should. The gate's own message is passed through so the
      // agent rephrases a real ask rather than inventing one.
      known: {
        form: {
          businessName: answers.businessName,
          industry: answers.industry,
          description: answers.description,
          targetAudience: answers.targetAudience,
          goal: answers.goal,
          services: answers.services,
          hasContact: Boolean(answers.email || answers.phone),
        },
        stillMissing: gaps.map((item) => ({
          code: item.code,
          severity: item.severity,
          weNeed: item.message,
        })),
        note:
          'Ask only about the entries in stillMissing, in this order, one at ' +
          'a time. They were decided by a deterministic gate, not by you: do ' +
          'not add asks of your own and do not skip ahead.',
      },
      transcript,
      maxQuestions: MAX_INTAKE_QUESTIONS,
      locale,
    });

    if (result.status === 'ask') {
      return NextResponse.json(
        base({ status: 'ask', question: result.question }),
        { status: 200 }
      );
    }

    const withDocuments = extractIntakeAnswers({
      transcript,
      documents: result.documents,
    });
    return NextResponse.json(
      base({
        status: 'complete',
        documents: result.documents,
        extracted: withDocuments,
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error(
      '[Flowstarter] intake chat turn failed: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
    return NextResponse.json(base(skipped('error')), { status: 200 });
  }
}

/** The three ways this step bows out without asking anything. */
function skipped(reason: IntakeChatSkipReason): Partial<IntakeChatResponse> {
  return { status: 'complete', skipped: true, reason };
}
