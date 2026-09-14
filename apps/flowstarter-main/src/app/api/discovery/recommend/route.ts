/**
 * POST /api/discovery/recommend
 *
 * Deterministic RULES decide both the build-tier recommendation
 * (`recommendTier`, a price bracket for pricing/UI — unchanged) and the
 * routing decision (`classifyRouting`, standard vs custom — a separate,
 * new output). No LLM is consulted: this used to call `recommendTierLLM`
 * and return its answer whenever it succeeded, with the deterministic
 * result only as a fallback. That call has been removed entirely — see
 * lib/flowstarter/routing-rules.ts for the rule set and threshold, which is
 * the only thing ops need to tune. `recommendTierLLM` (lib/ai/recommend-tier)
 * is left in place and importable but is no longer called from here.
 *
 * Public (under the /api/discovery allowlist), rate-limited. Pure and
 * synchronous once parsed, so the same input always returns the same
 * answer.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  type DiscoveryData,
  EMPTY_DISCOVERY,
  recommendTier,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import { classifyRouting } from '@/lib/flowstarter/routing-rules';
import { readJsonCapped } from '@/lib/net/ingress';
import { clientIp } from '@/lib/request-ip';

const Schema = z.object({
  businessName: z.string().max(200).optional().default(''),
  description: z.string().max(5000).optional().default(''),
  industry: z.string().max(200).optional().default(''),
  targetAudience: z.string().max(500).optional().default(''),
  // Free-form (chips + freetext, comma-joined) — see discovery.logic.
  goal: z.string().max(400).optional().default(''),
  secondaryGoals: z.array(z.string().max(120)).optional().default([]),
  brandTone: z.string().max(400).optional().default(''),
  pageCount: z
    .enum(['lt-5', '5-7', '8-15', '15+', 'unsure', ''])
    .optional()
    .default(''),
  timeline: z
    .enum(['asap', '4-weeks', '1-3-months', 'flexible', ''])
    .optional()
    .default(''),
  commerceMode: z
    .enum(['none', 'few-services', 'digital', 'physical', 'mixed', ''])
    .optional()
    .default(''),
  catalogSize: z
    .enum(['na', '1-5', '6-25', '26-100', '100+', 'unsure'])
    .optional()
    .default('na'),
  customIntegrations: z.string().max(2000).optional().default(''),
});

const RATE_LIMIT = 8;
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

export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  if (isRateLimited(ip)) {
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
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const body: unknown = read.value;

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid payload' },
      { status: 400 }
    );
  }

  const data: DiscoveryData = { ...EMPTY_DISCOVERY, ...parsed.data };

  // The deterministic result IS the answer — not a fallback.
  const deterministic = recommendTier(data);
  const routing = classifyRouting(data);

  return NextResponse.json({ ...deterministic, routing, source: 'rules' });
}
