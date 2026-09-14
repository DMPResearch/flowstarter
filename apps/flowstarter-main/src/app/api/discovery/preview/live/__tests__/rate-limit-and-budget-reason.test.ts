/**
 * MVP readiness review, "Security": `/api/discovery/preview/live` — the
 * funnel's most expensive endpoint, `maxDuration = 300` — had no rate limit
 * at all, and a budget-blocked skip carried no way to tell "over the monthly
 * cap" apart from "the accounting itself is broken" (see
 * `src/lib/ai/funnel-cost.ts` and its own test file for that half).
 *
 * Reuses the same mock boundary as `preview-ready-notification.test.ts` and
 * `live-preview-teardown.test.ts` (the heavy pipeline stubbed at the package
 * boundary), driven through the real POST handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

// The MCP prerequisite is now a real `GET /health` probe (see
// generation-availability.ts) rather than a plain "is the URL set" check;
// this suite is about rate limiting and budget-reason wiring, not that probe,
// so it stubs prerequisites as satisfied instead of hitting the network.
vi.mock('@/lib/discovery/generation-availability', () => ({
  missingGenerationPrerequisites: vi.fn(async () => []),
}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
}));

vi.mock('@flowstarter/daytona-utils', () => ({
  previewInSandbox: vi.fn(async () => ({
    success: true,
    previewUrl: 'https://sandbox.example/preview',
    sandboxId: 'sandbox-123',
    teardown: vi.fn(async () => undefined),
  })),
}));

vi.mock('@flowstarter/agentic-codegen', async () => ({
  ...(await import('@flowstarter/agentic-codegen/src/integrations')),
  FlowstarterMcpTemplateLibrary: class {
    close() {
      return Promise.resolve();
    }
  },
  PiSdkFlowstarterAgents: class {},
  PreviewGenerationPipeline: class {
    async run() {
      return {
        brandConfig: {},
        template: { slug: 'test-template' },
        generatedAssetsCostUsd: 0,
      };
    }
  },
}));

const funnelBudgetState = vi.fn();
const reserveFunnelSpend = vi.fn();
vi.mock('@/lib/ai/funnel-cost', () => ({
  funnelBudgetState: (...args: unknown[]) => funnelBudgetState(...args),
  reserveFunnelSpend: (...args: unknown[]) => reserveFunnelSpend(...args),
  settleFunnelReservation: vi.fn(async () => undefined),
  releaseFunnelReservation: vi.fn(async () => undefined),
  previewLiveEstimatedCostEur: vi.fn(() => 0.5),
  recordGenerationCost: vi.fn(async () => undefined),
}));

vi.mock('@/lib/ai/llm', () => ({
  llmActionConfig: vi.fn(() => ({ maxTokens: 100_000 })),
  recordLlmUsage: vi.fn(async () => undefined),
}));

vi.mock('@/lib/flowstarter/claim', () => ({
  rememberClaimablePreview: vi.fn(async () => undefined),
}));

vi.mock('@/lib/hosting/preview-publisher', () => ({
  publishFunnelPreview: vi.fn(async () => ({ status: 'pending' as const })),
}));

function liveRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/discovery/preview/live', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/discovery/preview/live — per-IP rate limit', () => {
  beforeEach(() => {
    // The publish step is a rule now (`preview-publisher-rule.ts`), and its
    // default is Flowstarter's own platform. These suites stub the Daytona
    // sandbox, so they name that publisher explicitly - which is also the only
    // way it is ever chosen.
    vi.stubEnv('FLOWSTARTER_PREVIEW_PUBLISHER', 'daytona');
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-test');
    vi.resetModules();
    funnelBudgetState.mockClear();
    reserveFunnelSpend.mockClear();
    funnelBudgetState.mockResolvedValue({ state: 'ok' as const });
    reserveFunnelSpend.mockResolvedValue({
      allowed: true,
      reservationId: 'res-test',
      spentEur: 0,
    });
  });

  it('limits a single IP to the configured number of requests per minute', async () => {
    const { POST } = await import('../route');
    // The rate-limit check runs before body parsing, so a body that fails
    // schema validation still proves the limiter counted the request — the
    // response would be `{ skip: true }` at 200, not a 429.
    const limit = 5; // routeLimiter('discovery-preview-live')'s documented default
    for (let i = 0; i < limit; i += 1) {
      const res = await POST(liveRequest());
      expect(res.status).not.toBe(429);
    }

    const limited = await POST(liveRequest());
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body).toEqual({ skip: true, reason: 'rate-limited' });
  });
});

describe('POST /api/discovery/preview/live — budget-blocked reason', () => {
  beforeEach(() => {
    vi.resetModules();
    funnelBudgetState.mockClear();
    reserveFunnelSpend.mockClear();
    funnelBudgetState.mockResolvedValue({ state: 'ok' as const });
    // Past the `missingGenerationPrerequisites` "not-configured" skip, so
    // the request actually reaches the budget check this suite is testing.
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('FLOWSTARTER_MCP_URL', 'http://127.0.0.1:3001/mcp');
    vi.stubEnv('FLOWSTARTER_MCP_INTERNAL_TOKEN', 'test-token');
    vi.stubEnv('DAYTONA_API_KEY', 'test-daytona-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Security audit 2026-09-13 (Claude H4; Codex F06): the blocking decision
  // moved from a read-only funnelBudgetState() check to the atomic
  // reserveFunnelSpend() reservation, so these now exercise that gate
  // instead. funnelBudgetState() still runs (for the 'degrade' signal) but
  // no longer decides whether the request is skipped.
  it('forwards the accounting-error reason distinctly from over-cap', async () => {
    reserveFunnelSpend.mockResolvedValue({
      allowed: false,
      reason: 'accounting-error' as const,
      spentEur: 0,
    });
    const { POST } = await import('../route');

    const res = await POST(
      liveRequest({
        businessName: 'Acme Yoga',
        fullName: 'Ada Lovelace',
        description: 'A small yoga studio in the neighbourhood.',
      })
    );
    const body = await res.json();

    expect(body).toEqual({ skip: true, reason: 'accounting-error' });
  });

  it('reports over-cap when the reservation is refused for exceeding the global cap', async () => {
    reserveFunnelSpend.mockResolvedValue({
      allowed: false,
      reason: 'over-cap' as const,
      spentEur: 60,
    });
    const { POST } = await import('../route');

    const res = await POST(
      liveRequest({
        businessName: 'Acme Yoga',
        fullName: 'Ada Lovelace',
        description: 'A small yoga studio in the neighbourhood.',
      })
    );
    const body = await res.json();

    expect(body).toEqual({ skip: true, reason: 'over-cap' });
  });

  it('reports over-caller-cap distinctly when one caller alone is refused', async () => {
    reserveFunnelSpend.mockResolvedValue({
      allowed: false,
      reason: 'over-caller-cap' as const,
      spentEur: 1,
    });
    const { POST } = await import('../route');

    const res = await POST(
      liveRequest({
        businessName: 'Acme Yoga',
        fullName: 'Ada Lovelace',
        description: 'A small yoga studio in the neighbourhood.',
      })
    );
    const body = await res.json();

    expect(body).toEqual({ skip: true, reason: 'over-caller-cap' });
  });
});
