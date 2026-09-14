import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { isOpenRouterConfigured } from '@/lib/ai/client';
import { funnelBudgetState } from '@/lib/ai/funnel-cost';
import { callLlm } from '@/lib/ai/llm';
import { readJsonCapped } from '@/lib/net/ingress';
import { consumeRateLimit, namedIntEnv } from '@/lib/rate-limit';
import { clientIp } from '@/lib/request-ip';

const SupportChatSchema = z.object({
  message: z.string().min(1).max(600),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().min(1).max(1200),
      })
    )
    .max(12)
    .optional(),
});

const SUPPORT_SYSTEM_PROMPT = `You are Flowstarter support assistant.

Your job:
- Answer questions about Flowstarter pricing, scope, timeline, integrations, support process, and next steps.
- Keep answers concise, helpful, and practical (2-4 short sentences).
- If details are unknown, say that briefly and direct users to hello@flowstarter.net or a discovery call.
- Never invent pricing numbers not provided.
- Do not provide legal, medical, or financial advice.
`;

const COMMON_INTENT_KEYWORDS = [
  'price',
  'pricing',
  'cost',
  'plan',
  'plans',
  'delivery',
  'timeline',
  'how long',
  'turnaround',
  'scope',
  'integrations',
  'stripe',
  'calendly',
  'booking',
  'support',
  'edit',
  'editor',
  'refund',
  'guarantee',
  'what do i get',
  'what is included',
];

const OPERATOR_HANDOFF_REPLY =
  'This looks like a custom request. I am routing this to a human operator now. Please email hello@flowstarter.net and include your goal, timeline, and any links so we can help quickly.';

const BUDGET_UNAVAILABLE_REPLY =
  'Support AI is temporarily unavailable. Please email hello@flowstarter.net and we will help you shortly.';

/**
 * Security audit 2026-09-13 (Claude H4 / Codex F06): "Confirmed reachable
 * unauthenticated... this route reaches callLlm whenever the message
 * contains one of a short keyword list... has no route-level rate limiter
 * at all." Named, env-overridable config, same pattern as every other
 * limiter in the funnel (`capEur()` in funnel-cost.ts, etc.).
 */
const SUPPORT_CHAT_RATE_LIMIT_ENV = 'SUPPORT_CHAT_RATE_LIMIT';
const SUPPORT_CHAT_RATE_LIMIT_DEFAULT = 10;
const SUPPORT_CHAT_RATE_WINDOW_MS = 60_000;

function isCommonSupportQuestion(input: string): boolean {
  const normalized = input.toLowerCase().trim();
  if (!normalized) return false;

  // Keep common support scoped to short practical Q&A.
  if (normalized.length > 280) return false;

  return COMMON_INTENT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  if (
    await consumeRateLimit(`support-chat:${ip}`, {
      limit: namedIntEnv(
        SUPPORT_CHAT_RATE_LIMIT_ENV,
        SUPPORT_CHAT_RATE_LIMIT_DEFAULT
      ),
      windowMs: SUPPORT_CHAT_RATE_WINDOW_MS,
    })
  ) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
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

  const parsed = SupportChatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid message' }, { status: 400 });
  }

  const { message, history = [] } = parsed.data;

  if (!isCommonSupportQuestion(message)) {
    return NextResponse.json({ reply: OPERATOR_HANDOFF_REPLY, handoff: true });
  }

  if (!isOpenRouterConfigured()) {
    return NextResponse.json({ reply: BUDGET_UNAVAILABLE_REPLY });
  }

  // Security audit 2026-09-13 (Claude H4 / Codex F06): "the public
  // support-chat model call is covered by the same anonymous budget" — this
  // used to reach callLlm with no funnel budget check of any kind, so it
  // shared none of the discovery funnel's monthly cap. Same check every
  // other funnel LLM call site makes; the `funnel` option passed to
  // callLlm below records the actual cost against the same ledger once the
  // call completes.
  const budget = await funnelBudgetState();
  if (budget.state === 'blocked') {
    return NextResponse.json({ reply: BUDGET_UNAVAILABLE_REPLY });
  }

  try {
    const historyBlock = history
      .slice(-8)
      .map(
        (entry) =>
          `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`
      )
      .join('\n');

    const prompt = historyBlock
      ? `Conversation so far:\n${historyBlock}\n\nNew user question:\n${message}`
      : message;

    // Budget, ledger row and prompt caching all live in the wrapper; the
    // 220-token completion cap now comes from LLM_BUDGETS.support_chat.
    // A reply clipped at that cap is still a usable answer, so truncation is
    // not treated as a budget breach here.
    const { text } = await callLlm({
      action: 'support_chat',
      system: SUPPORT_SYSTEM_PROMPT,
      prompt,
      temperature: 0.4,
      allowTruncation: true,
      // Records the actual cost against the same anonymous funnel ledger
      // `funnelBudgetState()` (above) reads from, so a burst of support-chat
      // traffic shows up in the same €/month total the rest of the funnel
      // is capped by, rather than spending for free outside it.
      funnel: { kind: 'support_chat', ip },
    });

    return NextResponse.json({ reply: text.trim(), handoff: false });
  } catch (error) {
    console.error('[SupportChat] Failed to generate response', error);
    return NextResponse.json(
      {
        reply: OPERATOR_HANDOFF_REPLY,
        handoff: true,
      },
      { status: 200 }
    );
  }
}
