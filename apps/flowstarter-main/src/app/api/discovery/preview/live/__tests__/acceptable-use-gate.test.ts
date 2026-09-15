/**
 * The acceptable-use gate on the live preview route.
 *
 * This is the first place a stranger's business description reaches our
 * infrastructure, and it sits before `reserveFunnelSpend` on purpose: a
 * refused category must never be charged for, not even against the funnel's
 * own budget. The classifier is mocked (there is no matcher, only a model
 * behind `classifyAcceptableUse`), so what is under test here is the route's
 * own wiring: does it call the gate, does it answer the funnel's own
 * vocabulary on a refusal, and does it never reach the spend reservation.
 *
 * The preamble below is the same one `quick-intake-identity.test.ts` uses in
 * this directory: the generator, Daytona and the funnel-cost module are
 * stubbed so this suite proves the gate rather than paying for a real run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/discovery/generation-availability', () => ({
  missingGenerationPrerequisites: vi.fn(async () => []),
}));

let workspaceRoot = '';

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
    publisher: {
      publish: (input: unknown) => Promise<Record<string, unknown>>;
    };
    constructor(
      _agents: unknown,
      _library: unknown,
      _validator: unknown,
      publisher: {
        publish: (input: unknown) => Promise<Record<string, unknown>>;
      }
    ) {
      this.publisher = publisher;
    }
    async run(input: {
      intake: { projectId: string };
      onPhase?: (p: string) => void;
    }) {
      input.onPhase?.('Publishing your live preview');
      const published = await this.publisher.publish({
        projectId: input.intake.projectId,
        workspaceRoot,
        template: { slug: 'test-template' },
        brandConfig: {},
      });
      return {
        brandConfig: {},
        template: { slug: 'test-template' },
        generatedAssetsCostUsd: 0,
        ...published,
      };
    }
  },
}));

const reserveFunnelSpendMock = vi.hoisted(() =>
  vi.fn(async () => ({
    allowed: true as const,
    reservationId: 'res-test',
    spentEur: 0,
  }))
);
vi.mock('@/lib/ai/funnel-cost', () => ({
  funnelBudgetState: vi.fn(async () => ({ state: 'ok' as const })),
  reserveFunnelSpend: reserveFunnelSpendMock,
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
  publishFunnelPreview: vi.fn(async () => ({ status: 'ready' as const })),
}));

// ── The acceptable-use gate ──────────────────────────────────────────────
// Mocked at the classifier, not at a matcher: there is no matcher, only a
// model behind classifyAcceptableUse. Its confidence and category id are set
// per test; the rule layer (`decide` in acceptable-use.ts) is real, so the
// refuse/review/allow math is exercised for real against these inputs.
const classify = vi.hoisted(() => vi.fn());
vi.mock('@/lib/policy/classifier', () => ({
  classifyAcceptableUse: classify,
  clearAcceptableUseCache: vi.fn(),
  evidenceHashOf: (t: string) => 'hash-' + t.length,
}));

// The review row. Not under test here (this route parks nothing; the four
// quick questions above a refusal never charge, so there is nothing to hold),
// but the gate calls it whenever a verdict blocks, so it must resolve.
vi.mock('@/lib/policy/review', () => ({
  recordPolicyOutcome: vi.fn(async () => ({
    reviewId: 'rev-1',
    recorded: true,
  })),
}));

import { POST } from '../route';

function classification(
  overrides: Partial<Parameters<typeof classify>[0]> = {}
) {
  return {
    categoryId: 'none',
    confidence: 0.95,
    evidence: 'Nothing notable.',
    needsHuman: false,
    tier: 'llm' as const,
    evidenceHash: 'abc123',
    promptVersion: 'test',
    costEstimateUsd: null,
    model: null,
    cached: false,
    ...overrides,
  };
}

function previewRequest(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/discovery/preview/live', {
    method: 'POST',
    body: JSON.stringify({
      businessName: 'Test Business',
      fullName: 'Ana Pop',
      email: 'ana@example.com',
      description: 'A small shop in the neighbourhood.',
      websiteUrl: '',
      ...overrides,
    }),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/discovery/preview/live — acceptable-use gate', () => {
  beforeEach(async () => {
    vi.stubEnv('FLOWSTARTER_PREVIEW_PUBLISHER', 'daytona');
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-test');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('FLOWSTARTER_MCP_URL', 'http://127.0.0.1:3001/mcp');
    vi.stubEnv('FLOWSTARTER_MCP_INTERNAL_TOKEN', 'test-token');
    workspaceRoot = await mkdtemp(join(tmpdir(), 'fs-preview-gate-test-'));
    classify.mockReset();
    reserveFunnelSpendMock.mockClear();
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('answers the funnel s own refusal shape and never reserves spend for a refused category', async () => {
    classify.mockResolvedValue(
      classification({ categoryId: 'illegal_drugs', confidence: 0.95 })
    );

    const res = await POST(previewRequest());

    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as {
      skip?: boolean;
      reason?: string;
      policy?: { termsHref?: string; contactHref?: string };
    };
    expect(responseBody.skip).toBe(true);
    expect(responseBody.reason).toBe('acceptable-use');
    expect(responseBody.policy).toBeTruthy();
    expect(responseBody.policy?.termsHref).toBe('/terms#acceptable-use');
    expect(responseBody.policy?.contactHref).toBe('/contact');

    // The whole point of screening before the reservation: a refused category
    // must not cost the funnel a cent, not even an estimate.
    expect(reserveFunnelSpendMock).not.toHaveBeenCalled();
  });

  it('answers the refusal in Romanian when the intake says locale: ro', async () => {
    classify.mockResolvedValue(
      classification({ categoryId: 'illegal_drugs', confidence: 0.95 })
    );

    const res = await POST(previewRequest({ locale: 'ro' }));

    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as {
      skip?: boolean;
      reason?: string;
      policy?: { title?: string; message?: string; locale?: string };
    };
    expect(responseBody.skip).toBe(true);
    expect(responseBody.policy?.locale).toBe('ro');
    expect(responseBody.policy?.title).toBe('Nu putem construi acest site');
    expect(responseBody.policy?.message).toContain('utilizare acceptabilă');
  });

  it('still answers English when the intake sends no locale at all', async () => {
    classify.mockResolvedValue(
      classification({ categoryId: 'illegal_drugs', confidence: 0.95 })
    );

    const res = await POST(previewRequest());

    const responseBody = (await res.json()) as {
      policy?: { title?: string; locale?: string };
    };
    expect(responseBody.policy?.locale).toBe('en');
    expect(responseBody.policy?.title).toBe('We cannot build this one');
  });

  it('does not answer the acceptable-use skip for a clean classification', async () => {
    classify.mockResolvedValue(
      classification({ categoryId: 'none', confidence: 0.95 })
    );

    const res = await POST(previewRequest());

    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as {
      skip?: boolean;
      reason?: string;
      demoId?: string;
    };
    expect(responseBody.reason).not.toBe('acceptable-use');
    // A clean intake reaches the reservation and gets a real job going.
    expect(reserveFunnelSpendMock).toHaveBeenCalledTimes(1);
    expect(responseBody.demoId).toBeTruthy();
  });
});
