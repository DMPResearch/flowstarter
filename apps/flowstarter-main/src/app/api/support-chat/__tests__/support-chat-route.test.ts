/**
 * POST /api/support-chat.
 *
 * Security audit 2026-09-13 (Claude H4 / Codex F06): "Confirmed reachable
 * unauthenticated... reaches callLlm whenever the message contains one of a
 * short keyword list... has no route-level rate limiter at all" and is not
 * covered by the discovery funnel's monthly spend cap at all. This is the
 * regression suite for all three fixes: a per-IP rate limiter, a
 * funnelBudgetState() gate before the model is ever called, and the `funnel`
 * option that makes a real call count against that same budget.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { __resetRouteLimitersForTest } from '@/lib/security/route-limits';

vi.mock('server-only', () => ({}));

const isOpenRouterConfigured = vi.fn(() => true);
vi.mock('@/lib/ai/client', () => ({
  isOpenRouterConfigured: () => isOpenRouterConfigured(),
}));

const funnelBudgetState = vi.fn();
vi.mock('@/lib/ai/funnel-cost', () => ({
  funnelBudgetState: (...args: unknown[]) => funnelBudgetState(...args),
}));

const callLlm = vi.fn();
vi.mock('@/lib/ai/llm', () => ({
  callLlm: (...args: unknown[]) => callLlm(...args),
}));

function chatRequest(body: Record<string, unknown>, ip = '203.0.113.7') {
  return new NextRequest('http://localhost:3000/api/support-chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

const PRICING_QUESTION = { message: 'What is your pricing?' };

beforeEach(() => {
  isOpenRouterConfigured.mockReturnValue(true);
  funnelBudgetState.mockReset();
  funnelBudgetState.mockResolvedValue({ state: 'ok' as const });
  callLlm.mockReset();
  callLlm.mockResolvedValue({ text: 'A helpful reply.' });
  __resetRouteLimitersForTest();
});

describe('POST /api/support-chat', () => {
  it('answers a common support question and records the call against the funnel budget', async () => {
    const res = await POST(chatRequest(PRICING_QUESTION));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ reply: 'A helpful reply.', handoff: false });

    expect(callLlm).toHaveBeenCalledTimes(1);
    const call = callLlm.mock.calls[0][0] as { funnel?: { kind: string } };
    expect(call.funnel).toEqual({ kind: 'support_chat', ip: '203.0.113.7' });
  });

  it('hands off a non-common question without ever calling the model', async () => {
    const res = await POST(
      chatRequest({ message: 'Can you write me a poem?' })
    );
    const body = await res.json();
    expect(body.handoff).toBe(true);
    expect(callLlm).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload with 400', async () => {
    const res = await POST(chatRequest({ message: '' }));
    expect(res.status).toBe(400);
    expect(callLlm).not.toHaveBeenCalled();
  });

  it('falls back to the unavailable reply, without calling the model, when OpenRouter is not configured', async () => {
    isOpenRouterConfigured.mockReturnValue(false);
    const res = await POST(chatRequest(PRICING_QUESTION));
    const body = await res.json();
    expect(body.reply).toMatch(/temporarily unavailable/);
    expect(callLlm).not.toHaveBeenCalled();
  });

  it('falls back to the unavailable reply, without calling the model, when the funnel budget is blocked', async () => {
    funnelBudgetState.mockResolvedValue({
      state: 'blocked' as const,
      spentEur: 60,
      capEur: 50,
      reason: 'over-cap' as const,
    });
    const res = await POST(chatRequest(PRICING_QUESTION));
    const body = await res.json();
    expect(body.reply).toMatch(/temporarily unavailable/);
    expect(callLlm).not.toHaveBeenCalled();
  });

  it('rate limits one IP after the configured number of requests per minute', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(chatRequest(PRICING_QUESTION));
      expect(res.status).toBe(200);
    }
    const blocked = await POST(chatRequest(PRICING_QUESTION));
    expect(blocked.status).toBe(429);

    // A different IP is unaffected.
    const other = await POST(chatRequest(PRICING_QUESTION, '198.51.100.4'));
    expect(other.status).toBe(200);
  });

  it('falls back to the operator handoff, not a 500, when the model call throws', async () => {
    callLlm.mockRejectedValueOnce(new Error('provider timeout'));
    const res = await POST(chatRequest(PRICING_QUESTION));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handoff).toBe(true);
  });
});
