/**
 * POST /api/discovery/business-names — candidate names, on request only.
 *
 * A product decision, not an implementation detail: a client who already has a
 * name does not want a website tool renaming their business. So nothing here
 * runs unprompted. The endpoint exists purely so the info agent can *offer*
 * suggestions and act on a yes; there is no auto-suggest path, and the body
 * must carry an explicit `requested: true` or the request is refused. Nothing
 * is auto-filled into the wizard either — the visitor picks, or does not.
 *
 * Anonymous, like the rest of `/api/discovery`: IP rate limit, moderation of
 * the visitor's own text, and the funnel budget kill-switch before any model
 * call. Fails open to an empty list so a naming offer can never dead-end the
 * funnel.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { funnelBudgetState } from '@/lib/ai/funnel-cost';
import { llmActionConfig, recordLlmUsage } from '@/lib/ai/llm';
import { aiModerateContent } from '@/lib/ai/moderate';
import { readJsonCapped } from '@/lib/net/ingress';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({
  /**
   * The consent flag. Not decoration: it is the only thing standing between
   * "offered when the visitor asks" and "suggested at everyone".
   */
  requested: z.literal(true),
  niche: z.string().min(1).max(240),
  location: z.string().max(240).optional().default(''),
  audience: z.string().max(500).optional().default(''),
  description: z.string().max(2_000).optional().default(''),
  /** Names the visitor has already rejected. */
  avoid: z.array(z.string().max(60)).max(20).optional().default([]),
  count: z.number().int().min(3).max(5).optional().default(5),
  locale: z.enum(['en', 'ro']).optional().default('en'),
});

const RATE_LIMIT = 6;
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isRateLimited(clientIp(request))) {
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
      { error: 'Name suggestions are only offered when you ask for them' },
      { status: 400 }
    );
  }
  const spec = parsed.data;

  const verdict = await aiModerateContent({
    description: `${spec.description}\n${spec.niche}`,
    industry: spec.niche,
    goals: '',
    services: '',
  }).catch(() => null);
  if (verdict?.isProhibited) {
    return NextResponse.json(
      { error: 'We are not able to suggest names for this kind of business' },
      { status: 422 }
    );
  }

  try {
    const budget = await funnelBudgetState();
    if (budget.state === 'blocked') {
      return NextResponse.json({ names: [] }, { status: 200 });
    }
  } catch {
    // Fail-safe: our own accounting being unavailable never blocks a visitor.
  }

  const piApiKey =
    process.env.PI_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
  if (!piApiKey) {
    return NextResponse.json({ names: [] }, { status: 200 });
  }

  try {
    const { PiSdkFlowstarterAgents } = await import(
      '@flowstarter/agentic-codegen'
    );
    const config = llmActionConfig('business_naming');
    const agents = new PiSdkFlowstarterAgents({
      provider: process.env.PI_PROVIDER?.trim() || 'openrouter',
      modelId: process.env.PI_MODEL?.trim() || 'z-ai/glm-5.2',
      apiKey: piApiKey,
      thinkingLevel: 'low',
      timeoutMs: 45_000,
      maxRunTokens: config.maxTokens,
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
        intake: {
          ...(process.env.PI_INTAKE_MODEL?.trim()
            ? { modelId: process.env.PI_INTAKE_MODEL.trim() }
            : {}),
          ...(config.maxOutputTokens
            ? { maxOutputTokens: config.maxOutputTokens }
            : {}),
          timeoutMs: 45_000,
        },
      },
    });

    const names = await agents.proposeBusinessNames({
      niche: spec.niche,
      location: spec.location || 'Not provided',
      audience: spec.audience || undefined,
      description: spec.description || undefined,
      locale: spec.locale,
      avoid: spec.avoid,
      count: spec.count,
    });
    return NextResponse.json({ names }, { status: 200 });
  } catch (error) {
    console.error(
      '[Flowstarter] business naming failed: ' +
        (error instanceof Error ? error.message : 'unknown error')
    );
    // An empty list is a usable answer here — the visitor keeps their own
    // name, which is the default outcome anyway.
    return NextResponse.json({ names: [] }, { status: 200 });
  }
}
